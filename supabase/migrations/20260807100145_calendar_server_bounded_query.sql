begin;

create schema if not exists calendar_private authorization postgres;
revoke all on schema calendar_private from public, anon, authenticated;
grant usage on schema calendar_private to authenticated, service_role;

create or replace function calendar_private.subscription_occurrences(
  anchor_date date,
  next_occurrence_date date,
  recurrence_unit text,
  recurrence_interval integer,
  range_start date,
  range_end date
)
returns table(occurrence date)
language plpgsql
immutable
strict
security invoker
set search_path = ''
as $$
declare
  lower_bound date;
  step_days integer;
  step_months integer;
  month_distance integer;
  occurrence_ordinal integer;
  occurrence_month date;
  candidate date;
  candidate_year integer;
  candidate_month integer;
  candidate_day integer;
begin
  if range_end < range_start
    or recurrence_interval < 1
    or recurrence_interval > 1200
    or recurrence_unit not in ('day', 'week', 'month', 'year')
  then
    return;
  end if;

  lower_bound := greatest(anchor_date, next_occurrence_date, range_start);
  if lower_bound > range_end then
    return;
  end if;

  if recurrence_unit in ('day', 'week') then
    step_days := recurrence_interval * (
      case when recurrence_unit = 'week' then 7 else 1 end
    );
    occurrence_ordinal := (
      (lower_bound - anchor_date) + step_days - 1
    ) / step_days;
    candidate := anchor_date + (occurrence_ordinal * step_days);
    return query
      select generated_date::date
      from pg_catalog.generate_series(
        candidate::timestamp,
        range_end::timestamp,
        pg_catalog.make_interval(days => step_days)
      ) generated_date;
    return;
  end if;

  step_months := recurrence_interval * (
    case when recurrence_unit = 'year' then 12 else 1 end
  );
  month_distance := (
    extract(year from lower_bound)::integer
    - extract(year from anchor_date)::integer
  ) * 12 + (
    extract(month from lower_bound)::integer
    - extract(month from anchor_date)::integer
  );
  occurrence_ordinal := (month_distance + step_months - 1) / step_months;

  loop
    occurrence_month := (
      pg_catalog.date_trunc('month', anchor_date::timestamp)
      + pg_catalog.make_interval(months => occurrence_ordinal * step_months)
    )::date;
    candidate_year := extract(year from occurrence_month)::integer;
    candidate_month := extract(month from occurrence_month)::integer;
    candidate_day := least(
      extract(day from anchor_date)::integer,
      extract(
        day from (
          pg_catalog.date_trunc('month', occurrence_month::timestamp)
          + interval '1 month - 1 day'
        )
      )::integer
    );
    candidate := pg_catalog.make_date(
      candidate_year,
      candidate_month,
      candidate_day
    );
    exit when candidate > range_end;
    if candidate >= lower_bound then
      occurrence := candidate;
      return next;
    end if;
    occurrence_ordinal := occurrence_ordinal + 1;
  end loop;
end;
$$;

alter function calendar_private.subscription_occurrences(date, date, text, integer, date, date)
  owner to postgres;
revoke all on function calendar_private.subscription_occurrences(date, date, text, integer, date, date)
  from public, anon;
grant execute on function calendar_private.subscription_occurrences(date, date, text, integer, date, date)
  to authenticated, service_role;

create index if not exists subscriptions_ledger_owner_idx
  on public.subscriptions(owner_user_id, created_at, id);

create index if not exists renewal_events_history_owner_idx
  on public.renewal_events(
    owner_user_id, subscription_id, created_at, idempotency_key
  );

create index if not exists subscriptions_calendar_owner_idx
  on public.subscriptions(
    owner_user_id, lifecycle_status, kind, next_renewal_date, id
  ) include (
    start_date, recurrence_unit, recurrence_interval, service_name,
    plan_name, category, purchased_on, access_ends_on, lifecycle_since,
    trial_ends_on, lifecycle_access_ends_on, updated_at, version
  );

create index if not exists renewal_events_calendar_identity_idx
  on public.renewal_events(
    owner_user_id, subscription_id, state, original_occurrence_date,
    occurrence_date, idempotency_key
  ) include (updated_at, version);

create or replace function public.calendar_events_page(
  p_range_start date,
  p_range_end date,
  p_filter text,
  p_query text,
  p_page_size integer,
  p_cursor text
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  jwt_claims jsonb := auth.jwt();
  clerk_subject text := nullif(jwt_claims->>'sub', '');
  normalized_query text := pg_catalog.lower(pg_catalog.btrim(p_query));
  request_identity text;
  snapshot_identity text;
  decoded_cursor jsonb;
  normalized_cursor text;
  cursor_request_identity text;
  cursor_snapshot_identity text;
  cursor_date date;
  cursor_service_name text;
  cursor_event_kind text;
  cursor_subscription_id text;
  cursor_event_id text;
  all_events jsonb;
  returned_events jsonb;
  returned_count integer;
  has_more boolean;
  last_event jsonb;
  next_cursor text;
begin
  if clerk_subject is null
    or pg_catalog.char_length(clerk_subject) > 512
    or jwt_claims->>'role' <> 'authenticated'
    or coalesce(jwt_claims->>'exp', '') !~ '^[0-9]+$'
    or p_range_start is null
    or p_range_end is null
    or p_range_end < p_range_start
    or p_range_end - p_range_start > 185
    or p_filter not in ('all', 'trials', 'charges', 'access', 'changes')
    or p_query is null
    or pg_catalog.char_length(p_query) > 160
    or p_page_size is null
    or p_page_size < 1
    or p_page_size > 256
    or (p_cursor is not null and pg_catalog.char_length(p_cursor) > 4096)
  then
    raise exception 'invalid calendar page request' using errcode = '22023';
  end if;
  if (jwt_claims->>'exp')::numeric <= extract(
    epoch from pg_catalog.statement_timestamp()
  ) then
    raise exception 'invalid calendar page request' using errcode = '22023';
  end if;

  request_identity := pg_catalog.md5(
    clerk_subject || '|' || p_range_start::text || '|' || p_range_end::text
    || '|' || p_filter || '|' || normalized_query
  );

  select pg_catalog.md5(
    's|' || pg_catalog.count(*)::text
    || '|' || coalesce(pg_catalog.max(subscription.updated_at)::text, '')
    || '|' || coalesce(pg_catalog.sum(subscription.version)::text, '')
    || '|r|' || (
      select pg_catalog.count(*)::text
        || '|' || coalesce(pg_catalog.max(renewal.updated_at)::text, '')
        || '|' || coalesce(pg_catalog.sum(renewal.version)::text, '')
      from public.renewal_events renewal
      where renewal.owner_user_id = clerk_subject
    )
  )
  into snapshot_identity
  from public.subscriptions subscription
  where subscription.owner_user_id = clerk_subject;

  if p_cursor is not null then
    begin
      if p_cursor !~ '^[A-Za-z0-9_-]+$' then
        raise data_exception;
      end if;
      normalized_cursor := pg_catalog.translate(p_cursor, '-_', '+/');
      normalized_cursor := normalized_cursor || pg_catalog.repeat(
        '=',
        (4 - pg_catalog.length(normalized_cursor) % 4) % 4
      );
      decoded_cursor := pg_catalog.convert_from(
        pg_catalog.decode(normalized_cursor, 'base64'),
        'UTF8'
      )::jsonb;
      if decoded_cursor->>'v' <> '1'
        or (
          select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(decoded_cursor)
        ) <> 8
      then
        raise data_exception;
      end if;
      cursor_request_identity := decoded_cursor->>'r';
      cursor_snapshot_identity := decoded_cursor->>'s';
      cursor_date := (decoded_cursor->>'d')::date;
      cursor_service_name := decoded_cursor->>'n';
      cursor_event_kind := decoded_cursor->>'k';
      cursor_subscription_id := decoded_cursor->>'u';
      cursor_event_id := decoded_cursor->>'i';
      if cursor_request_identity is null
        or cursor_snapshot_identity is null
        or cursor_service_name is null
        or cursor_event_kind is null
        or cursor_subscription_id is null
        or cursor_event_id is null
      then
        raise data_exception;
      end if;
    exception when others then
      raise exception 'invalid calendar page cursor' using errcode = '22023';
    end;
    if cursor_request_identity <> request_identity then
      raise exception 'calendar cursor request mismatch' using errcode = '22023';
    end if;
    if cursor_snapshot_identity <> snapshot_identity then
      raise exception 'calendar cursor snapshot changed' using errcode = '40001';
    end if;
  end if;

  with owned_subscriptions as materialized (
    select subscription.*
    from public.subscriptions subscription
    where subscription.owner_user_id = clerk_subject
      and (
        normalized_query = ''
        or pg_catalog.lower(subscription.service_name) like '%' || normalized_query || '%'
        or pg_catalog.lower(coalesce(subscription.plan_name, '')) like '%' || normalized_query || '%'
        or pg_catalog.lower(coalesce(subscription.category, '')) like '%' || normalized_query || '%'
      )
  ), raw_candidates as (
    select
      subscription.id || ':one_time_purchase:' || subscription.purchased_on::text as id,
      subscription.id as subscription_id,
      subscription.service_name,
      subscription.plan_name,
      subscription.category,
      subscription.purchased_on as event_date,
      'one_time_purchase'::text as event_kind,
      null::date as original_date
    from owned_subscriptions subscription
    where subscription.kind = 'one_time'
      and subscription.purchased_on between p_range_start and p_range_end

    union all

    select
      subscription.id || ':access_expiry:' || subscription.access_ends_on::text,
      subscription.id, subscription.service_name, subscription.plan_name,
      subscription.category, subscription.access_ends_on, 'access_expiry', null::date
    from owned_subscriptions subscription
    where subscription.kind = 'one_time'
      and subscription.access_ends_on between p_range_start and p_range_end

    union all

    select
      subscription.id || ':trial_deadline:' || subscription.trial_ends_on::text,
      subscription.id, subscription.service_name, subscription.plan_name,
      subscription.category, subscription.trial_ends_on, 'trial_deadline', null::date
    from owned_subscriptions subscription
    where subscription.lifecycle_status = 'trial'
      and subscription.trial_ends_on between p_range_start and p_range_end

    union all

    select
      subscription.id || ':paused:' || subscription.lifecycle_since::text,
      subscription.id, subscription.service_name, subscription.plan_name,
      subscription.category, subscription.lifecycle_since, 'paused', null::date
    from owned_subscriptions subscription
    where subscription.lifecycle_status = 'paused'
      and subscription.lifecycle_since between p_range_start and p_range_end

    union all

    select
      subscription.id || ':canceled:' || subscription.lifecycle_since::text,
      subscription.id, subscription.service_name, subscription.plan_name,
      subscription.category, subscription.lifecycle_since, 'canceled', null::date
    from owned_subscriptions subscription
    where subscription.lifecycle_status = 'canceled'
      and subscription.lifecycle_since between p_range_start and p_range_end

    union all

    select
      subscription.id || ':access_expiry:' || subscription.lifecycle_access_ends_on::text,
      subscription.id, subscription.service_name, subscription.plan_name,
      subscription.category, subscription.lifecycle_access_ends_on,
      'access_expiry', null::date
    from owned_subscriptions subscription
    where subscription.lifecycle_status = 'canceled'
      and subscription.lifecycle_access_ends_on between p_range_start and p_range_end
      and not (
        subscription.kind = 'one_time'
        and subscription.access_ends_on = subscription.lifecycle_access_ends_on
      )

    union all

    select
      subscription.id || ':access_expiry:' || subscription.lifecycle_since::text,
      subscription.id, subscription.service_name, subscription.plan_name,
      subscription.category, subscription.lifecycle_since,
      'access_expiry', null::date
    from owned_subscriptions subscription
    where subscription.lifecycle_status = 'expired'
      and subscription.lifecycle_since between p_range_start and p_range_end
      and not (
        subscription.kind = 'one_time'
        and subscription.access_ends_on = subscription.lifecycle_since
      )

    union all

    select
      subscription.id || ':expected_charge:' || occurrence.occurrence::text,
      subscription.id, subscription.service_name, subscription.plan_name,
      subscription.category, occurrence.occurrence,
      'expected_charge', null::date
    from owned_subscriptions subscription
    cross join lateral calendar_private.subscription_occurrences(
      subscription.start_date,
      subscription.next_renewal_date,
      subscription.recurrence_unit,
      subscription.recurrence_interval,
      p_range_start,
      p_range_end
    ) occurrence
    where subscription.kind = 'recurring'
      and subscription.lifecycle_status = 'active'
      and not exists (
        select 1
        from public.renewal_events renewal
        where renewal.owner_user_id = clerk_subject
          and renewal.subscription_id = subscription.id
          and (
            case when renewal.state = 'corrected'
              then renewal.original_occurrence_date
              else renewal.occurrence_date
            end
          ) = occurrence.occurrence
      )

    union all

    select
      subscription.id || ':corrected_charge:' || renewal.occurrence_date::text
        || ':' || renewal.idempotency_key,
      subscription.id, subscription.service_name, subscription.plan_name,
      subscription.category, renewal.occurrence_date,
      'corrected_charge', renewal.original_occurrence_date
    from owned_subscriptions subscription
    join public.renewal_events renewal
      on renewal.owner_user_id = clerk_subject
      and renewal.subscription_id = subscription.id
    where renewal.state = 'corrected'
      and renewal.occurrence_date between p_range_start and p_range_end
  ), candidates as (
    select candidate.*
    from raw_candidates candidate
    where case p_filter
      when 'all' then true
      when 'trials' then candidate.event_kind = 'trial_deadline'
      when 'charges' then candidate.event_kind in (
        'expected_charge', 'corrected_charge', 'one_time_purchase'
      )
      when 'access' then candidate.event_kind = 'access_expiry'
      when 'changes' then candidate.event_kind in (
        'paused', 'canceled', 'corrected_charge'
      )
      else false
    end
  ), ordered_page as (
    select candidate.*
    from candidates candidate
    where p_cursor is null
      or row(
        candidate.event_date,
        candidate.service_name collate "C",
        candidate.event_kind,
        candidate.subscription_id,
        candidate.id
      ) > row(
        cursor_date,
        cursor_service_name collate "C",
        cursor_event_kind,
        cursor_subscription_id,
        cursor_event_id
      )
    order by
      candidate.event_date,
      candidate.service_name collate "C",
      candidate.event_kind,
      candidate.subscription_id,
      candidate.id
    limit p_page_size + 1
  )
  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', page.id,
          'subscription_id', page.subscription_id,
          'service_name', page.service_name,
          'plan_name', page.plan_name,
          'category', page.category,
          'event_date', page.event_date,
          'event_kind', page.event_kind,
          'original_date', page.original_date
        ) order by
          page.event_date,
          page.service_name collate "C",
          page.event_kind,
          page.subscription_id,
          page.id
      ),
      '[]'::jsonb
    ),
    pg_catalog.count(*)::integer
  into all_events, returned_count
  from ordered_page page;

  has_more := returned_count > p_page_size;
  select coalesce(pg_catalog.jsonb_agg(element.value order by element.ordinality), '[]'::jsonb)
  into returned_events
  from pg_catalog.jsonb_array_elements(all_events) with ordinality element(value, ordinality)
  where element.ordinality <= p_page_size;

  if has_more then
    last_event := returned_events->(p_page_size - 1);
    next_cursor := pg_catalog.rtrim(
      pg_catalog.translate(
        pg_catalog.replace(
          pg_catalog.encode(
            pg_catalog.convert_to(
              pg_catalog.jsonb_build_object(
                'v', 1,
                'r', request_identity,
                's', snapshot_identity,
                'd', last_event->>'event_date',
                'n', last_event->>'service_name',
                'k', last_event->>'event_kind',
                'u', last_event->>'subscription_id',
                'i', last_event->>'id'
              )::text,
              'UTF8'
            ),
            'base64'
          ),
          E'\n',
          ''
        ),
        '+/',
        '-_'
      ),
      '='
    );
  else
    next_cursor := null;
  end if;

  return pg_catalog.jsonb_build_object(
    'events', returned_events,
    'next_cursor', next_cursor,
    'complete', not has_more,
    'truncated', has_more
  );
end;
$$;

alter function public.calendar_events_page(date, date, text, text, integer, text)
  owner to postgres;
revoke all on function public.calendar_events_page(date, date, text, text, integer, text)
  from public, anon;
grant execute on function public.calendar_events_page(date, date, text, text, integer, text)
  to authenticated, service_role;

comment on function public.calendar_events_page(date, date, text, text, integer, text) is
  'Returns an authenticated, predicate-aware calendar page for at most 185 days and 256 events; cursors bind request and data snapshot identity.';
comment on function calendar_private.subscription_occurrences(date, date, text, integer, date, date) is
  'Direct-seeks anchored recurrence occurrences inside a bounded date range without scanning historical dates.';

commit;
