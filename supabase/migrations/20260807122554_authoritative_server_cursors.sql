begin;

create table calendar_private.account_revisions (
  owner_user_id text primary key,
  revision bigint not null default 1,
  updated_at timestamptz not null default statement_timestamp(),
  constraint account_revisions_owner_valid check (
    char_length(owner_user_id) between 1 and 512
    and owner_user_id = btrim(owner_user_id)
  ),
  constraint account_revisions_revision_valid check (revision > 0)
);

create table calendar_private.cursor_states (
  token uuid primary key default gen_random_uuid(),
  owner_user_id text not null,
  cursor_kind text not null,
  request_hash text not null,
  account_revision bigint,
  cursor_state jsonb not null,
  cached_response jsonb,
  created_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz not null default statement_timestamp() + interval '10 minutes',
  constraint cursor_states_owner_valid check (
    char_length(owner_user_id) between 1 and 512
    and owner_user_id = btrim(owner_user_id)
  ),
  constraint cursor_states_kind_valid check (
    cursor_kind in ('calendar', 'subscriptions', 'renewal_history')
  ),
  constraint cursor_states_hash_valid check (request_hash ~ '^[a-f0-9]{32}$'),
  constraint cursor_states_revision_valid check (
    account_revision is null or account_revision > 0
  ),
  constraint cursor_states_expiry_valid check (expires_at > created_at)
);

create index cursor_states_owner_expiry_idx
  on calendar_private.cursor_states(owner_user_id, expires_at, created_at);

alter table calendar_private.account_revisions owner to postgres;
alter table calendar_private.cursor_states owner to postgres;

revoke all on table calendar_private.account_revisions
  from public, anon, authenticated, service_role;
revoke all on table calendar_private.cursor_states
  from public, anon, authenticated, service_role;

create or replace function calendar_private.bump_account_revisions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into calendar_private.account_revisions(owner_user_id)
    select distinct changed.owner_user_id from new_rows changed
    on conflict (owner_user_id) do update
      set revision = calendar_private.account_revisions.revision + 1,
          updated_at = statement_timestamp();
  elsif tg_op = 'DELETE' then
    insert into calendar_private.account_revisions(owner_user_id)
    select distinct changed.owner_user_id from old_rows changed
    on conflict (owner_user_id) do update
      set revision = calendar_private.account_revisions.revision + 1,
          updated_at = statement_timestamp();
  else
    insert into calendar_private.account_revisions(owner_user_id)
    select distinct owners.owner_user_id
    from (
      select changed.owner_user_id from old_rows changed
      union
      select changed.owner_user_id from new_rows changed
    ) owners
    on conflict (owner_user_id) do update
      set revision = calendar_private.account_revisions.revision + 1,
          updated_at = statement_timestamp();
  end if;
  return null;
end;
$$;

alter function calendar_private.bump_account_revisions() owner to postgres;
revoke all on function calendar_private.bump_account_revisions()
  from public, anon, authenticated, service_role;

create trigger subscriptions_revision_insert
after insert on public.subscriptions
referencing new table as new_rows
for each statement execute function calendar_private.bump_account_revisions();
create trigger subscriptions_revision_update
after update on public.subscriptions
referencing old table as old_rows new table as new_rows
for each statement execute function calendar_private.bump_account_revisions();
create trigger subscriptions_revision_delete
after delete on public.subscriptions
referencing old table as old_rows
for each statement execute function calendar_private.bump_account_revisions();

create trigger renewal_events_revision_insert
after insert on public.renewal_events
referencing new table as new_rows
for each statement execute function calendar_private.bump_account_revisions();
create trigger renewal_events_revision_update
after update on public.renewal_events
referencing old table as old_rows new table as new_rows
for each statement execute function calendar_private.bump_account_revisions();
create trigger renewal_events_revision_delete
after delete on public.renewal_events
referencing old table as old_rows
for each statement execute function calendar_private.bump_account_revisions();

create index if not exists renewal_events_calendar_original_idx
  on public.renewal_events(
    owner_user_id,
    subscription_id,
    (case when state = 'corrected' then original_occurrence_date else occurrence_date end)
  );

create index if not exists renewal_events_calendar_corrected_idx
  on public.renewal_events(owner_user_id, occurrence_date, idempotency_key)
  include (subscription_id, original_occurrence_date)
  where state = 'corrected';

create or replace function calendar_private.cursor_uuid(cursor_text text)
returns uuid
language sql
immutable
strict
security invoker
set search_path = ''
as $$
  select (
    pg_catalog.substr(cursor_text, 1, 8) || '-' ||
    pg_catalog.substr(cursor_text, 9, 4) || '-' ||
    pg_catalog.substr(cursor_text, 13, 4) || '-' ||
    pg_catalog.substr(cursor_text, 17, 4) || '-' ||
    pg_catalog.substr(cursor_text, 21, 12)
  )::uuid
$$;

create or replace function calendar_private.issue_cursor(
  p_owner_user_id text,
  p_cursor_kind text,
  p_request_hash text,
  p_account_revision bigint,
  p_cursor_state jsonb
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  issued_token uuid;
begin
  delete from calendar_private.cursor_states expired
  where expired.token in (
    select candidate.token
    from calendar_private.cursor_states candidate
    where candidate.expires_at <= statement_timestamp()
    order by candidate.expires_at
    limit 256
  );

  if (
    select count(*)
    from calendar_private.cursor_states active
    where active.owner_user_id = p_owner_user_id
      and active.expires_at > statement_timestamp()
      and active.cached_response is null
  ) >= 512 then
    raise exception 'cursor capacity reached' using errcode = '54000';
  end if;

  insert into calendar_private.cursor_states(
    owner_user_id, cursor_kind, request_hash, account_revision, cursor_state
  ) values (
    p_owner_user_id, p_cursor_kind, p_request_hash,
    p_account_revision, p_cursor_state
  ) returning token into issued_token;

  return pg_catalog.replace(issued_token::text, '-', '');
end;
$$;

create or replace function calendar_private.merge_calendar_events(
  existing_events jsonb,
  additional_events jsonb,
  page_size integer
)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $$
  select coalesce(
    pg_catalog.jsonb_agg(ordered.value order by
      ordered.value->>'event_date',
      (ordered.value->>'service_name') collate "C",
      ordered.value->>'event_kind',
      ordered.value->>'subscription_id',
      ordered.value->>'id'
    ),
    '[]'::jsonb
  )
  from (
    select combined.value
    from (
      select value from pg_catalog.jsonb_array_elements(coalesce(existing_events, '[]'::jsonb)) value
      union all
      select value from pg_catalog.jsonb_array_elements(coalesce(additional_events, '[]'::jsonb)) value
    ) combined
    order by
      combined.value->>'event_date',
      (combined.value->>'service_name') collate "C",
      combined.value->>'event_kind',
      combined.value->>'subscription_id',
      combined.value->>'id'
    limit page_size + 1
  ) ordered
$$;

alter function calendar_private.cursor_uuid(text) owner to postgres;
alter function calendar_private.issue_cursor(text, text, text, bigint, jsonb)
  owner to postgres;
alter function calendar_private.merge_calendar_events(jsonb, jsonb, integer)
  owner to postgres;
revoke all on function calendar_private.cursor_uuid(text)
  from public, anon, authenticated, service_role;
revoke all on function calendar_private.issue_cursor(text, text, text, bigint, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function calendar_private.merge_calendar_events(jsonb, jsonb, integer)
  from public, anon, authenticated, service_role;

create or replace function calendar_private.subscriptions_page(
  p_page_size integer,
  p_cursor text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set work_mem = '4MB'
as $$
declare
  clerk_subject text := private.current_clerk_subject();
  request_identity text;
  input_token uuid;
  saved calendar_private.cursor_states%rowtype;
  snapshot_at timestamptz;
  after_created_at timestamptz;
  after_id text;
  page_rows jsonb;
  returned_items jsonb;
  returned_count integer;
  has_more boolean;
  last_item jsonb;
  next_cursor text;
  response jsonb;
begin
  if clerk_subject is null
    or p_page_size is null or p_page_size < 1 or p_page_size > 100
    or (p_cursor is not null and p_cursor !~ '^[a-f0-9]{32}$')
  then
    raise exception 'invalid subscription page request' using errcode = '22023';
  end if;
  request_identity := pg_catalog.md5(
    'subscriptions|' || clerk_subject || '|' || p_page_size::text
  );

  if p_cursor is null then
    snapshot_at := statement_timestamp();
    after_created_at := null;
    after_id := null;
  else
    input_token := calendar_private.cursor_uuid(p_cursor);
    select * into saved
    from calendar_private.cursor_states state
    where state.token = input_token
    for update;
    if not found
      or saved.owner_user_id <> clerk_subject
      or saved.cursor_kind <> 'subscriptions'
      or saved.request_hash <> request_identity
      or saved.expires_at <= statement_timestamp()
    then
      raise exception 'invalid subscription page cursor' using errcode = '22023';
    end if;
    if saved.cached_response is not null then
      return saved.cached_response;
    end if;
    snapshot_at := (saved.cursor_state->>'snapshot_at')::timestamptz;
    after_created_at := (saved.cursor_state->>'after_created_at')::timestamptz;
    after_id := saved.cursor_state->>'after_id';
  end if;

  with selected as (
    select subscription.*
    from public.subscriptions subscription
    where subscription.owner_user_id = clerk_subject
      and subscription.created_at <= snapshot_at
      and (
        after_created_at is null
        or row(subscription.created_at, subscription.id)
          > row(after_created_at, after_id)
      )
    order by subscription.created_at, subscription.id
    limit p_page_size + 1
  )
  select coalesce(
    pg_catalog.jsonb_agg(to_jsonb(selected) order by selected.created_at, selected.id),
    '[]'::jsonb
  ), count(*)::integer
  into page_rows, returned_count
  from selected;

  has_more := returned_count > p_page_size;
  select coalesce(
    pg_catalog.jsonb_agg(element.value order by element.ordinality), '[]'::jsonb
  ) into returned_items
  from pg_catalog.jsonb_array_elements(page_rows) with ordinality element(value, ordinality)
  where element.ordinality <= p_page_size;

  if has_more then
    last_item := returned_items->(p_page_size - 1);
    next_cursor := calendar_private.issue_cursor(
      clerk_subject,
      'subscriptions',
      request_identity,
      null,
      pg_catalog.jsonb_build_object(
        'snapshot_at', snapshot_at,
        'after_created_at', last_item->>'created_at',
        'after_id', last_item->>'id'
      )
    );
  else
    next_cursor := null;
  end if;

  response := pg_catalog.jsonb_build_object(
    'items', returned_items,
    'next_cursor', next_cursor,
    'complete', not has_more
  );
  if input_token is not null then
    update calendar_private.cursor_states
    set cached_response = response
    where token = input_token;
  end if;
  return response;
exception when invalid_text_representation or data_exception then
  raise exception 'invalid subscription page cursor' using errcode = '22023';
end;
$$;

create or replace function calendar_private.renewal_history_page(
  p_subscription_id text,
  p_page_size integer,
  p_cursor text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set work_mem = '4MB'
as $$
declare
  clerk_subject text := private.current_clerk_subject();
  request_identity text;
  input_token uuid;
  saved calendar_private.cursor_states%rowtype;
  snapshot_at timestamptz;
  after_created_at timestamptz;
  after_key text;
  page_rows jsonb;
  returned_events jsonb;
  returned_count integer;
  has_more boolean;
  last_event jsonb;
  next_cursor text;
  response jsonb;
begin
  if clerk_subject is null
    or p_subscription_id is null
    or p_subscription_id !~ '^[A-Za-z0-9_-]{1,128}$'
    or p_page_size is null or p_page_size < 1 or p_page_size > 100
    or (p_cursor is not null and p_cursor !~ '^[a-f0-9]{32}$')
  then
    raise exception 'invalid history page request' using errcode = '22023';
  end if;
  request_identity := pg_catalog.md5(
    'renewal_history|' || clerk_subject || '|' || p_subscription_id || '|' || p_page_size::text
  );

  if p_cursor is null then
    snapshot_at := statement_timestamp();
    after_created_at := null;
    after_key := null;
  else
    input_token := calendar_private.cursor_uuid(p_cursor);
    select * into saved
    from calendar_private.cursor_states state
    where state.token = input_token
    for update;
    if not found
      or saved.owner_user_id <> clerk_subject
      or saved.cursor_kind <> 'renewal_history'
      or saved.request_hash <> request_identity
      or saved.expires_at <= statement_timestamp()
    then
      raise exception 'invalid history page cursor' using errcode = '22023';
    end if;
    if saved.cached_response is not null then
      return saved.cached_response;
    end if;
    snapshot_at := (saved.cursor_state->>'snapshot_at')::timestamptz;
    after_created_at := (saved.cursor_state->>'after_created_at')::timestamptz;
    after_key := saved.cursor_state->>'after_key';
  end if;

  with selected as (
    select renewal.*
    from public.renewal_events renewal
    where renewal.owner_user_id = clerk_subject
      and renewal.subscription_id = p_subscription_id
      and renewal.created_at <= snapshot_at
      and (
        after_created_at is null
        or row(renewal.created_at, renewal.idempotency_key)
          > row(after_created_at, after_key)
      )
    order by renewal.created_at, renewal.idempotency_key
    limit p_page_size + 1
  )
  select coalesce(
    pg_catalog.jsonb_agg(to_jsonb(selected) order by selected.created_at, selected.idempotency_key),
    '[]'::jsonb
  ), count(*)::integer
  into page_rows, returned_count
  from selected;

  has_more := returned_count > p_page_size;
  select coalesce(
    pg_catalog.jsonb_agg(element.value order by element.ordinality), '[]'::jsonb
  ) into returned_events
  from pg_catalog.jsonb_array_elements(page_rows) with ordinality element(value, ordinality)
  where element.ordinality <= p_page_size;

  if has_more then
    last_event := returned_events->(p_page_size - 1);
    next_cursor := calendar_private.issue_cursor(
      clerk_subject,
      'renewal_history',
      request_identity,
      null,
      pg_catalog.jsonb_build_object(
        'snapshot_at', snapshot_at,
        'after_created_at', last_event->>'created_at',
        'after_key', last_event->>'idempotency_key'
      )
    );
  else
    next_cursor := null;
  end if;

  response := pg_catalog.jsonb_build_object(
    'events', returned_events,
    'next_cursor', next_cursor,
    'complete', not has_more
  );
  if input_token is not null then
    update calendar_private.cursor_states
    set cached_response = response
    where token = input_token;
  end if;
  return response;
exception when invalid_text_representation or data_exception then
  raise exception 'invalid history page cursor' using errcode = '22023';
end;
$$;

create or replace function calendar_private.authoritative_calendar_events_page(
  p_range_start date,
  p_range_end date,
  p_filter text,
  p_query text,
  p_page_size integer,
  p_cursor text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set work_mem = '64MB'
as $$
declare
  clerk_subject text := private.current_clerk_subject();
  normalized_query text := pg_catalog.lower(pg_catalog.btrim(p_query));
  request_identity text;
  account_revision bigint;
  input_token uuid;
  saved calendar_private.cursor_states%rowtype;
  state jsonb;
  phase text;
  source_after_id text;
  correction_after_key text;
  after_event jsonb;
  accumulated_events jsonb;
  phase_events jsonb;
  source_count integer := 0;
  source_rows_scanned integer := 0;
  recurrence_candidates integer := 0;
  correction_count integer := 0;
  correction_rows_scanned integer := 0;
  phases_completed integer;
  has_more boolean;
  returned_events jsonb;
  last_event jsonb;
  next_cursor text;
  response jsonb;
begin
  if clerk_subject is null
    or p_range_start is null or p_range_end is null
    or p_range_end < p_range_start or p_range_end - p_range_start > 185
    or p_filter not in ('all', 'trials', 'charges', 'access', 'changes')
    or p_query is null or pg_catalog.char_length(p_query) > 160
    or p_page_size is null or p_page_size < 1 or p_page_size > 256
    or (p_cursor is not null and p_cursor !~ '^[a-f0-9]{32}$')
  then
    raise exception 'invalid calendar page request' using errcode = '22023';
  end if;

  insert into calendar_private.account_revisions(owner_user_id)
  values (clerk_subject)
  on conflict (owner_user_id) do nothing;
  select revision into account_revision
  from calendar_private.account_revisions
  where owner_user_id = clerk_subject;

  request_identity := pg_catalog.md5(
    'calendar|' || clerk_subject || '|' || p_range_start::text || '|' ||
    p_range_end::text || '|' || p_filter || '|' || normalized_query || '|' ||
    p_page_size::text
  );

  if p_cursor is null then
    state := pg_catalog.jsonb_build_object(
      'phase', 'subscriptions',
      'source_after_id', null,
      'correction_after_key', null,
      'after_event', null,
      'accumulated_events', '[]'::jsonb,
      'phases_completed', 0
    );
  else
    input_token := calendar_private.cursor_uuid(p_cursor);
    select * into saved
    from calendar_private.cursor_states cursor_state
    where cursor_state.token = input_token
    for update;
    if not found
      or saved.owner_user_id <> clerk_subject
      or saved.cursor_kind <> 'calendar'
      or saved.request_hash <> request_identity
      or saved.expires_at <= statement_timestamp()
    then
      raise exception 'invalid calendar page cursor' using errcode = '22023';
    end if;
    if saved.account_revision <> account_revision then
      raise exception 'calendar cursor snapshot changed' using errcode = '40001';
    end if;
    if saved.cached_response is not null then
      return saved.cached_response;
    end if;
    state := saved.cursor_state;
  end if;

  phase := state->>'phase';
  source_after_id := state->>'source_after_id';
  correction_after_key := state->>'correction_after_key';
  after_event := state->'after_event';
  if after_event = 'null'::jsonb then after_event := null; end if;
  accumulated_events := coalesce(state->'accumulated_events', '[]'::jsonb);
  phases_completed := coalesce((state->>'phases_completed')::integer, 0) + 1;

  if phase = 'subscriptions' then
    with source as materialized (
      select subscription.*
      from public.subscriptions subscription
      where subscription.owner_user_id = clerk_subject
        and (source_after_id is null or subscription.id > source_after_id)
      order by subscription.id
      limit 256
    ), matched as materialized (
      select subscription.*
      from source subscription
      where normalized_query = ''
        or pg_catalog.strpos(pg_catalog.lower(subscription.service_name), normalized_query) > 0
        or pg_catalog.strpos(pg_catalog.lower(coalesce(subscription.plan_name, '')), normalized_query) > 0
        or pg_catalog.strpos(pg_catalog.lower(coalesce(subscription.category, '')), normalized_query) > 0
    ), recurrence_source as materialized (
      select subscription.*, occurrence.occurrence
      from matched subscription
      cross join lateral calendar_private.subscription_occurrences(
        subscription.start_date, subscription.next_renewal_date,
        subscription.recurrence_unit, subscription.recurrence_interval,
        p_range_start, p_range_end
      ) occurrence
      where subscription.kind = 'recurring'
        and subscription.lifecycle_status = 'active'
    ), raw_candidates as (
      select
        subscription.id || ':one_time_purchase:' || subscription.purchased_on::text as id,
        subscription.id as subscription_id, subscription.service_name,
        subscription.plan_name, subscription.category,
        subscription.purchased_on as event_date, 'one_time_purchase'::text as event_kind,
        null::date as original_date
      from matched subscription
      where subscription.kind = 'one_time'
        and subscription.purchased_on between p_range_start and p_range_end
      union all
      select subscription.id || ':access_expiry:' || subscription.access_ends_on::text,
        subscription.id, subscription.service_name, subscription.plan_name,
        subscription.category, subscription.access_ends_on, 'access_expiry', null::date
      from matched subscription
      where subscription.kind = 'one_time'
        and subscription.access_ends_on between p_range_start and p_range_end
      union all
      select subscription.id || ':trial_deadline:' || subscription.trial_ends_on::text,
        subscription.id, subscription.service_name, subscription.plan_name,
        subscription.category, subscription.trial_ends_on, 'trial_deadline', null::date
      from matched subscription
      where subscription.lifecycle_status = 'trial'
        and subscription.trial_ends_on between p_range_start and p_range_end
      union all
      select subscription.id || ':paused:' || subscription.lifecycle_since::text,
        subscription.id, subscription.service_name, subscription.plan_name,
        subscription.category, subscription.lifecycle_since, 'paused', null::date
      from matched subscription
      where subscription.lifecycle_status = 'paused'
        and subscription.lifecycle_since between p_range_start and p_range_end
      union all
      select subscription.id || ':canceled:' || subscription.lifecycle_since::text,
        subscription.id, subscription.service_name, subscription.plan_name,
        subscription.category, subscription.lifecycle_since, 'canceled', null::date
      from matched subscription
      where subscription.lifecycle_status = 'canceled'
        and subscription.lifecycle_since between p_range_start and p_range_end
      union all
      select subscription.id || ':access_expiry:' || subscription.lifecycle_access_ends_on::text,
        subscription.id, subscription.service_name, subscription.plan_name,
        subscription.category, subscription.lifecycle_access_ends_on, 'access_expiry', null::date
      from matched subscription
      where subscription.lifecycle_status = 'canceled'
        and subscription.lifecycle_access_ends_on between p_range_start and p_range_end
        and not (subscription.kind = 'one_time' and subscription.access_ends_on = subscription.lifecycle_access_ends_on)
      union all
      select subscription.id || ':access_expiry:' || subscription.lifecycle_since::text,
        subscription.id, subscription.service_name, subscription.plan_name,
        subscription.category, subscription.lifecycle_since, 'access_expiry', null::date
      from matched subscription
      where subscription.lifecycle_status = 'expired'
        and subscription.lifecycle_since between p_range_start and p_range_end
        and not (subscription.kind = 'one_time' and subscription.access_ends_on = subscription.lifecycle_since)
      union all
      select subscription.id || ':expected_charge:' || subscription.occurrence::text,
        subscription.id, subscription.service_name, subscription.plan_name,
        subscription.category, subscription.occurrence, 'expected_charge', null::date
      from recurrence_source subscription
      where not exists (
        select 1 from public.renewal_events renewal
        where renewal.owner_user_id = clerk_subject
          and renewal.subscription_id = subscription.id
          and (case when renewal.state = 'corrected'
            then renewal.original_occurrence_date else renewal.occurrence_date end
          ) = subscription.occurrence
      )
    ), eligible as (
      select candidate.*
      from raw_candidates candidate
      where (case p_filter
        when 'all' then true
        when 'trials' then candidate.event_kind = 'trial_deadline'
        when 'charges' then candidate.event_kind in ('expected_charge', 'one_time_purchase')
        when 'access' then candidate.event_kind = 'access_expiry'
        when 'changes' then candidate.event_kind in ('paused', 'canceled')
        else false end)
        and (after_event is null or row(
          candidate.event_date,
          candidate.service_name collate "C",
          candidate.event_kind,
          candidate.subscription_id,
          candidate.id
        ) > row(
          (after_event->>'event_date')::date,
          (after_event->>'service_name') collate "C",
          after_event->>'event_kind',
          after_event->>'subscription_id',
          after_event->>'id'
        ))
    ), phase_page as (
      select candidate.* from eligible candidate
      order by candidate.event_date, candidate.service_name collate "C",
        candidate.event_kind, candidate.subscription_id, candidate.id
      limit p_page_size + 1
    )
    select
      (select count(*)::integer from source),
      (select max(id) from source),
      (select count(*)::integer from recurrence_source),
      coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', page.id, 'subscription_id', page.subscription_id,
        'service_name', page.service_name, 'plan_name', page.plan_name,
        'category', page.category, 'event_date', page.event_date,
        'event_kind', page.event_kind, 'original_date', page.original_date
      ) order by page.event_date, page.service_name collate "C", page.event_kind,
        page.subscription_id, page.id) from phase_page page), '[]'::jsonb)
    into source_count, source_after_id, recurrence_candidates, phase_events;

    source_rows_scanned := source_count;
    accumulated_events := calendar_private.merge_calendar_events(
      accumulated_events, phase_events, p_page_size
    );
    if source_count = 256 then
      state := pg_catalog.jsonb_build_object(
        'phase', 'subscriptions', 'source_after_id', source_after_id,
        'correction_after_key', null, 'after_event', after_event,
        'accumulated_events', accumulated_events,
        'phases_completed', phases_completed
      );
    else
      phase := 'corrections';
    end if;
  end if;

  if phase = 'corrections' then
    with correction_source as materialized (
      select renewal.*, subscription.service_name, subscription.plan_name,
        subscription.category
      from public.renewal_events renewal
      join public.subscriptions subscription
        on subscription.owner_user_id = renewal.owner_user_id
        and subscription.id = renewal.subscription_id
      where renewal.owner_user_id = clerk_subject
        and renewal.state = 'corrected'
        and renewal.occurrence_date between p_range_start and p_range_end
        and (correction_after_key is null or renewal.idempotency_key > correction_after_key)
      order by renewal.idempotency_key
      limit 1024
    ), eligible as (
      select
        correction.subscription_id || ':corrected_charge:' || correction.occurrence_date::text || ':' || correction.idempotency_key as id,
        correction.subscription_id, correction.service_name,
        correction.plan_name, correction.category,
        correction.occurrence_date as event_date,
        'corrected_charge'::text as event_kind,
        correction.original_occurrence_date as original_date
      from correction_source correction
      where p_filter in ('all', 'charges', 'changes')
        and (
          normalized_query = ''
          or pg_catalog.strpos(pg_catalog.lower(correction.service_name), normalized_query) > 0
          or pg_catalog.strpos(pg_catalog.lower(coalesce(correction.plan_name, '')), normalized_query) > 0
          or pg_catalog.strpos(pg_catalog.lower(coalesce(correction.category, '')), normalized_query) > 0
        )
        and (after_event is null or row(
          correction.occurrence_date,
          correction.service_name collate "C",
          'corrected_charge'::text,
          correction.subscription_id,
          correction.subscription_id || ':corrected_charge:' || correction.occurrence_date::text || ':' || correction.idempotency_key
        ) > row(
          (after_event->>'event_date')::date,
          (after_event->>'service_name') collate "C",
          after_event->>'event_kind', after_event->>'subscription_id', after_event->>'id'
        ))
    ), phase_page as (
      select candidate.* from eligible candidate
      order by candidate.event_date, candidate.service_name collate "C",
        candidate.event_kind, candidate.subscription_id, candidate.id
      limit p_page_size + 1
    )
    select
      (select count(*)::integer from correction_source),
      (select max(idempotency_key) from correction_source),
      coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', page.id, 'subscription_id', page.subscription_id,
        'service_name', page.service_name, 'plan_name', page.plan_name,
        'category', page.category, 'event_date', page.event_date,
        'event_kind', page.event_kind, 'original_date', page.original_date
      ) order by page.event_date, page.service_name collate "C", page.event_kind,
        page.subscription_id, page.id) from phase_page page), '[]'::jsonb)
    into correction_count, correction_after_key, phase_events;

    correction_rows_scanned := correction_count;
    accumulated_events := calendar_private.merge_calendar_events(
      accumulated_events, phase_events, p_page_size
    );
    if correction_count = 1024 then
      state := pg_catalog.jsonb_build_object(
        'phase', 'corrections', 'source_after_id', source_after_id,
        'correction_after_key', correction_after_key, 'after_event', after_event,
        'accumulated_events', accumulated_events,
        'phases_completed', phases_completed
      );
    end if;
  end if;

  if source_count = 256 or correction_count = 1024 then
    next_cursor := calendar_private.issue_cursor(
      clerk_subject, 'calendar', request_identity, account_revision, state
    );
    response := pg_catalog.jsonb_build_object(
      'events', '[]'::jsonb, 'next_cursor', next_cursor,
      'complete', false, 'truncated', true, 'authoritative', false,
      'work', pg_catalog.jsonb_build_object(
        'source_rows_scanned', source_rows_scanned,
        'recurrence_candidates', recurrence_candidates,
        'correction_rows_scanned', correction_rows_scanned,
        'phases_completed', phases_completed
      )
    );
  else
    has_more := pg_catalog.jsonb_array_length(accumulated_events) > p_page_size;
    select coalesce(pg_catalog.jsonb_agg(element.value order by element.ordinality), '[]'::jsonb)
    into returned_events
    from pg_catalog.jsonb_array_elements(accumulated_events) with ordinality element(value, ordinality)
    where element.ordinality <= p_page_size;
    if has_more then
      last_event := returned_events->(p_page_size - 1);
      next_cursor := calendar_private.issue_cursor(
        clerk_subject,
        'calendar',
        request_identity,
        account_revision,
        pg_catalog.jsonb_build_object(
          'phase', 'subscriptions', 'source_after_id', null,
          'correction_after_key', null, 'after_event', last_event,
          'accumulated_events', '[]'::jsonb, 'phases_completed', 0
        )
      );
    else
      next_cursor := null;
    end if;
    response := pg_catalog.jsonb_build_object(
      'events', returned_events, 'next_cursor', next_cursor,
      'complete', not has_more, 'truncated', has_more, 'authoritative', true,
      'work', pg_catalog.jsonb_build_object(
        'source_rows_scanned', source_rows_scanned,
        'recurrence_candidates', recurrence_candidates,
        'correction_rows_scanned', correction_rows_scanned,
        'phases_completed', phases_completed
      )
    );
  end if;

  if input_token is not null then
    update calendar_private.cursor_states
    set cached_response = response
    where token = input_token;
  end if;
  return response;
exception when invalid_text_representation or data_exception then
  raise exception 'invalid calendar page cursor' using errcode = '22023';
end;
$$;

alter function calendar_private.subscriptions_page(integer, text) owner to postgres;
alter function calendar_private.renewal_history_page(text, integer, text) owner to postgres;
alter function calendar_private.authoritative_calendar_events_page(date, date, text, text, integer, text)
  owner to postgres;
revoke all on function calendar_private.subscriptions_page(integer, text)
  from public, anon, service_role;
revoke all on function calendar_private.renewal_history_page(text, integer, text)
  from public, anon, service_role;
revoke all on function calendar_private.authoritative_calendar_events_page(date, date, text, text, integer, text)
  from public, anon, service_role;
grant execute on function calendar_private.subscriptions_page(integer, text)
  to authenticated;
grant execute on function calendar_private.renewal_history_page(text, integer, text)
  to authenticated;
grant execute on function calendar_private.authoritative_calendar_events_page(date, date, text, text, integer, text)
  to authenticated;

create or replace function public.subscriptions_page(
  p_page_size integer,
  p_cursor text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select calendar_private.subscriptions_page(p_page_size, p_cursor)
$$;

create or replace function public.renewal_history_page(
  p_subscription_id text,
  p_page_size integer,
  p_cursor text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select calendar_private.renewal_history_page(
    p_subscription_id, p_page_size, p_cursor
  )
$$;

create or replace function public.calendar_events_page(
  p_range_start date,
  p_range_end date,
  p_filter text,
  p_query text,
  p_page_size integer,
  p_cursor text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select calendar_private.authoritative_calendar_events_page(
    p_range_start, p_range_end, p_filter, p_query, p_page_size, p_cursor
  )
$$;

alter function public.subscriptions_page(integer, text) owner to postgres;
alter function public.renewal_history_page(text, integer, text) owner to postgres;
alter function public.calendar_events_page(date, date, text, text, integer, text)
  owner to postgres;
revoke all on function public.subscriptions_page(integer, text)
  from public, anon, service_role;
revoke all on function public.renewal_history_page(text, integer, text)
  from public, anon, service_role;
revoke all on function public.calendar_events_page(date, date, text, text, integer, text)
  from public, anon, service_role;
grant execute on function public.subscriptions_page(integer, text) to authenticated;
grant execute on function public.renewal_history_page(text, integer, text) to authenticated;
grant execute on function public.calendar_events_page(date, date, text, text, integer, text)
  to authenticated;

comment on function public.subscriptions_page(integer, text) is
  'Returns a deletion-stable ledger snapshot page; opaque continuations are private, subject-bound, replay-idempotent, and expire after ten minutes.';
comment on function public.renewal_history_page(text, integer, text) is
  'Returns a deletion-stable subscription history snapshot page through a POST RPC and private opaque continuation.';
comment on function public.calendar_events_page(date, date, text, text, integer, text) is
  'Reconciles at most 256 subscription sources and 1024 corrections per call; events are returned only after exact global top-k reconciliation is authoritative.';

commit;
