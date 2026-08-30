begin;

-- Existing cursors contain the pre-serialization state shape and cannot be
-- continued safely across this migration.
delete from calendar_private.cursor_states;

alter table calendar_private.cursor_states
  add column parent_token uuid,
  add column retained_bytes bigint not null default 256,
  add constraint cursor_states_parent_fk
    foreign key (parent_token)
    references calendar_private.cursor_states(token)
    on delete set null,
  add constraint cursor_states_retained_bytes_valid check (
    retained_bytes between 1 and 2097152
  );

create index cursor_states_expiry_token_idx
  on calendar_private.cursor_states(expires_at, token);
create index cursor_states_parent_idx
  on calendar_private.cursor_states(parent_token)
  where parent_token is not null;

create table calendar_private.calendar_rpc_budgets (
  owner_user_id text primary key,
  window_started_at timestamptz not null,
  call_count integer not null,
  constraint calendar_rpc_budgets_owner_valid check (
    char_length(owner_user_id) between 1 and 512
    and owner_user_id = btrim(owner_user_id)
  ),
  constraint calendar_rpc_budgets_count_valid check (
    call_count between 1 and 4096
  )
);

create index calendar_rpc_budgets_window_idx
  on calendar_private.calendar_rpc_budgets(window_started_at, owner_user_id);

alter table calendar_private.calendar_rpc_budgets owner to postgres;
revoke all on table calendar_private.calendar_rpc_budgets
  from public, anon, authenticated, service_role;

create or replace function calendar_private.lock_account_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  clerk_subject text := private.current_clerk_subject();
begin
  if clerk_subject is null then
    if pg_catalog.current_setting('role', true)
      in ('anon', 'authenticated', 'service_role')
    then
      -- Invalid client claims must fail through RLS without acquiring the
      -- privileged global maintenance gate.
      return null;
    end if;
    -- Privileged/migration statements may touch multiple accounts. The global
    -- exclusive gate is taken before any row lock and blocks calendar readers.
    perform pg_catalog.pg_advisory_xact_lock(74280, 1);
  else
    -- Authenticated writes are single-owner under RLS and remain concurrent
    -- across owners. Lock order: global gate, revision row, application rows.
    perform pg_catalog.pg_advisory_xact_lock_shared(74280, 1);
    insert into calendar_private.account_revisions(owner_user_id)
    values (clerk_subject)
    on conflict (owner_user_id) do nothing;
    perform revision
    from calendar_private.account_revisions
    where owner_user_id = clerk_subject
    for update;
  end if;
  return null;
end;
$$;

alter function calendar_private.lock_account_mutation() owner to postgres;
revoke all on function calendar_private.lock_account_mutation()
  from public, anon, authenticated, service_role;

create trigger a_subscriptions_revision_lock
before insert or update or delete on public.subscriptions
for each statement execute function calendar_private.lock_account_mutation();
create trigger a_renewal_events_revision_lock
before insert or update or delete on public.renewal_events
for each statement execute function calendar_private.lock_account_mutation();

create or replace function calendar_private.lock_calendar_revision(
  p_owner_user_id text
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  locked_revision bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock_shared(74280, 1);
  insert into calendar_private.account_revisions(owner_user_id)
  values (p_owner_user_id)
  on conflict (owner_user_id) do nothing;
  select revision into locked_revision
  from calendar_private.account_revisions
  where owner_user_id = p_owner_user_id
  for share;
  return locked_revision;
end;
$$;

create or replace function calendar_private.consume_calendar_rpc_budget(
  p_owner_user_id text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  accepted_count integer;
begin
  insert into calendar_private.calendar_rpc_budgets(
    owner_user_id, window_started_at, call_count
  ) values (
    p_owner_user_id, statement_timestamp(), 1
  )
  on conflict (owner_user_id) do update
  set window_started_at = case
        when calendar_private.calendar_rpc_budgets.window_started_at
          <= statement_timestamp() - interval '1 minute'
        then statement_timestamp()
        else calendar_private.calendar_rpc_budgets.window_started_at
      end,
      call_count = case
        when calendar_private.calendar_rpc_budgets.window_started_at
          <= statement_timestamp() - interval '1 minute'
        then 1
        else calendar_private.calendar_rpc_budgets.call_count + 1
      end
  where calendar_private.calendar_rpc_budgets.window_started_at
      <= statement_timestamp() - interval '1 minute'
    or calendar_private.calendar_rpc_budgets.call_count < 4096
  returning call_count into accepted_count;

  if accepted_count is null then
    raise exception 'calendar request unavailable' using errcode = '54000';
  end if;
end;
$$;

create or replace function calendar_private.cleanup_cursor_retention()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  removed_count integer;
begin
  with expired as materialized (
    select state.token
    from calendar_private.cursor_states state
    where state.expires_at <= statement_timestamp()
    order by state.expires_at, state.token
    limit 8192
    for update skip locked
  ), removed as (
    delete from calendar_private.cursor_states state
    using expired
    where state.token = expired.token
    returning 1
  )
  select count(*)::integer into removed_count from removed;

  delete from calendar_private.calendar_rpc_budgets budget
  where budget.owner_user_id in (
    select candidate.owner_user_id
    from calendar_private.calendar_rpc_budgets candidate
    where candidate.window_started_at
      <= statement_timestamp() - interval '2 minutes'
    order by candidate.window_started_at, candidate.owner_user_id
    limit 4096
    for update skip locked
  );

  return removed_count;
end;
$$;

create or replace function calendar_private.issue_cursor(
  p_owner_user_id text,
  p_cursor_kind text,
  p_request_hash text,
  p_account_revision bigint,
  p_cursor_state jsonb,
  p_parent_token uuid
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  issued_token uuid;
  parent_parent_token uuid;
  state_bytes bigint := pg_catalog.pg_column_size(p_cursor_state)::bigint + 256;
  owner_rows bigint;
  owner_bytes bigint;
  global_rows bigint;
  global_bytes bigint;
begin
  if state_bytes > 1048576 then
    raise exception 'cursor capacity reached' using errcode = '54000';
  end if;

  if p_parent_token is not null then
    select state.parent_token into parent_parent_token
    from calendar_private.cursor_states state
    where state.token = p_parent_token
      and state.owner_user_id = p_owner_user_id
      and state.cursor_kind = p_cursor_kind
      and state.request_hash = p_request_hash
      and state.account_revision is not distinct from p_account_revision
      and state.expires_at > statement_timestamp()
    for update;
    if not found then
      raise exception 'invalid page cursor' using errcode = '22023';
    end if;
    if parent_parent_token is not null then
      delete from calendar_private.cursor_states ancestor
      where ancestor.token = parent_parent_token;
    end if;
  end if;

  perform calendar_private.cleanup_cursor_retention();
  perform pg_catalog.pg_advisory_xact_lock(74280, 2);

  select count(*), coalesce(sum(retained_bytes), 0)
  into global_rows, global_bytes
  from calendar_private.cursor_states;
  select count(*), coalesce(sum(retained_bytes), 0)
  into owner_rows, owner_bytes
  from calendar_private.cursor_states
  where owner_user_id = p_owner_user_id;

  if global_rows >= 8192
    or global_bytes + state_bytes > 268435456
    or owner_rows >= 256
    or owner_bytes + state_bytes > 16777216
  then
    raise exception 'cursor capacity reached' using errcode = '54000';
  end if;

  insert into calendar_private.cursor_states(
    owner_user_id, cursor_kind, request_hash, account_revision,
    cursor_state, parent_token, retained_bytes
  ) values (
    p_owner_user_id, p_cursor_kind, p_request_hash, p_account_revision,
    p_cursor_state, p_parent_token, state_bytes
  ) returning token into issued_token;

  return pg_catalog.replace(issued_token::text, '-', '');
end;
$$;

create or replace function calendar_private.store_cursor_response(
  p_token uuid,
  p_response jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  saved calendar_private.cursor_states%rowtype;
  replacement_bytes bigint;
  byte_delta bigint;
  owner_bytes bigint;
  global_bytes bigint;
begin
  select * into saved
  from calendar_private.cursor_states state
  where state.token = p_token
  for update;
  if not found then
    raise exception 'invalid page cursor' using errcode = '22023';
  end if;

  if saved.parent_token is not null then
    delete from calendar_private.cursor_states ancestor
    where ancestor.token = saved.parent_token;
  end if;

  replacement_bytes :=
    pg_catalog.pg_column_size(saved.cursor_state)::bigint
    + pg_catalog.pg_column_size(p_response)::bigint + 256;
  if replacement_bytes > 2097152 then
    raise exception 'cursor capacity reached' using errcode = '54000';
  end if;
  byte_delta := replacement_bytes - saved.retained_bytes;

  perform pg_catalog.pg_advisory_xact_lock(74280, 2);
  select coalesce(sum(retained_bytes), 0)
  into global_bytes
  from calendar_private.cursor_states;
  select coalesce(sum(retained_bytes), 0)
  into owner_bytes
  from calendar_private.cursor_states
  where owner_user_id = saved.owner_user_id;

  if global_bytes + byte_delta > 268435456
    or owner_bytes + byte_delta > 16777216
  then
    raise exception 'cursor capacity reached' using errcode = '54000';
  end if;

  update calendar_private.cursor_states
  set cached_response = p_response,
      retained_bytes = replacement_bytes
  where token = p_token;
end;
$$;

alter function calendar_private.lock_calendar_revision(text) owner to postgres;
alter function calendar_private.consume_calendar_rpc_budget(text) owner to postgres;
alter function calendar_private.cleanup_cursor_retention() owner to postgres;
alter function calendar_private.issue_cursor(text, text, text, bigint, jsonb, uuid)
  owner to postgres;
alter function calendar_private.store_cursor_response(uuid, jsonb)
  owner to postgres;
revoke all on function calendar_private.lock_calendar_revision(text)
  from public, anon, authenticated, service_role;
revoke all on function calendar_private.consume_calendar_rpc_budget(text)
  from public, anon, authenticated, service_role;
revoke all on function calendar_private.cleanup_cursor_retention()
  from public, anon, authenticated, service_role;
revoke all on function calendar_private.issue_cursor(text, text, text, bigint, jsonb, uuid)
  from public, anon, authenticated, service_role;
revoke all on function calendar_private.store_cursor_response(uuid, jsonb)
  from public, anon, authenticated, service_role;

drop function calendar_private.issue_cursor(text, text, text, bigint, jsonb);

drop index if exists public.renewal_events_calendar_corrected_idx;
create index renewal_events_calendar_corrected_idx
  on public.renewal_events(owner_user_id, occurrence_date, idempotency_key)
  include (subscription_id, original_occurrence_date)
  where state = 'corrected';

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
      ),
      input_token
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
    perform calendar_private.store_cursor_response(input_token, response);
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
      ),
      input_token
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
    perform calendar_private.store_cursor_response(input_token, response);
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
set statement_timeout = '5s'
set plan_cache_mode = 'force_custom_plan'
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
  correction_after_date date;
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

  -- This shared row lock is acquired before cursor/source reads and remains
  -- held through response construction. Mutation triggers take FOR UPDATE.
  account_revision := calendar_private.lock_calendar_revision(clerk_subject);
  perform calendar_private.consume_calendar_rpc_budget(clerk_subject);

  request_identity := pg_catalog.md5(
    'calendar|' || clerk_subject || '|' || p_range_start::text || '|' ||
    p_range_end::text || '|' || p_filter || '|' || normalized_query || '|' ||
    p_page_size::text
  );

  if p_cursor is null then
    state := pg_catalog.jsonb_build_object(
      'phase', 'subscriptions',
      'source_after_id', null,
      'correction_after_date', null,
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
  correction_after_date := (state->>'correction_after_date')::date;
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
        offset 0
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
        'correction_after_date', null, 'correction_after_key', null,
        'after_event', after_event,
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
        and (
          correction_after_date is null
          or row(renewal.occurrence_date, renewal.idempotency_key)
            > row(correction_after_date, correction_after_key)
        )
      order by renewal.occurrence_date, renewal.idempotency_key
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
      (select occurrence_date from correction_source
        order by occurrence_date desc, idempotency_key desc limit 1),
      (select idempotency_key from correction_source
        order by occurrence_date desc, idempotency_key desc limit 1),
      coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', page.id, 'subscription_id', page.subscription_id,
        'service_name', page.service_name, 'plan_name', page.plan_name,
        'category', page.category, 'event_date', page.event_date,
        'event_kind', page.event_kind, 'original_date', page.original_date
      ) order by page.event_date, page.service_name collate "C", page.event_kind,
        page.subscription_id, page.id) from phase_page page), '[]'::jsonb)
    into correction_count, correction_after_date, correction_after_key,
      phase_events;

    correction_rows_scanned := correction_count;
    accumulated_events := calendar_private.merge_calendar_events(
      accumulated_events, phase_events, p_page_size
    );
    if correction_count = 1024 then
      state := pg_catalog.jsonb_build_object(
        'phase', 'corrections', 'source_after_id', source_after_id,
        'correction_after_date', correction_after_date,
        'correction_after_key', correction_after_key,
        'after_event', after_event,
        'accumulated_events', accumulated_events,
        'phases_completed', phases_completed
      );
    end if;
  end if;

  if source_count = 256 or correction_count = 1024 then
    next_cursor := calendar_private.issue_cursor(
      clerk_subject, 'calendar', request_identity, account_revision, state,
      input_token
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
          'correction_after_date', null, 'correction_after_key', null,
          'after_event', last_event,
          'accumulated_events', '[]'::jsonb, 'phases_completed', 0
        ),
        input_token
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
    perform calendar_private.store_cursor_response(input_token, response);
  end if;
  return response;
exception when invalid_text_representation or data_exception then
  raise exception 'invalid calendar page cursor' using errcode = '22023';
end;
$$;

alter function calendar_private.subscriptions_page(integer, text)
  owner to postgres;
alter function calendar_private.renewal_history_page(text, integer, text)
  owner to postgres;
alter function calendar_private.authoritative_calendar_events_page(
  date, date, text, text, integer, text
) owner to postgres;
revoke all on function calendar_private.subscriptions_page(integer, text)
  from public, anon, service_role;
revoke all on function calendar_private.renewal_history_page(text, integer, text)
  from public, anon, service_role;
revoke all on function calendar_private.authoritative_calendar_events_page(
  date, date, text, text, integer, text
) from public, anon, service_role;
grant execute on function calendar_private.subscriptions_page(integer, text)
  to authenticated;
grant execute on function calendar_private.renewal_history_page(text, integer, text)
  to authenticated;
grant execute on function calendar_private.authoritative_calendar_events_page(
  date, date, text, text, integer, text
) to authenticated;

create extension if not exists pg_cron;

do $$
begin
  if exists (
    select 1 from cron.job
    where jobname = 'subtrack-calendar-cursor-cleanup'
  ) then
    perform cron.alter_job(
      (select jobid from cron.job
        where jobname = 'subtrack-calendar-cursor-cleanup'),
      schedule := '* * * * *',
      command := 'select calendar_private.cleanup_cursor_retention()',
      active := true
    );
  else
    perform cron.schedule(
      'subtrack-calendar-cursor-cleanup',
      '* * * * *',
      'select calendar_private.cleanup_cursor_retention()'
    );
  end if;
end;
$$;

comment on function calendar_private.lock_account_mutation() is
  'Lock order for subscription/renewal writes: global admin gate, authenticated account revision FOR UPDATE, then application rows; locks last through transaction end.';
comment on function calendar_private.authoritative_calendar_events_page(
  date, date, text, text, integer, text
) is
  'Holds the account revision FOR SHARE through authoritative response construction; each statement scans at most 256 subscription sources or 1024 date-keyed corrections and has explicit statement, working-memory, and caller budgets.';
comment on function calendar_private.cleanup_cursor_retention() is
  'Deletes up to the complete 8192-row global cursor cap per scheduled minute using the expiry-leading index and SKIP LOCKED for guaranteed eventual cleanup.';
comment on function public.calendar_events_page(
  date, date, text, text, integer, text
) is
  'Reconciles at most 256 subscription sources or 1024 indexed date-keyed corrections per call; events are returned only after a revision-serialized exact global top-k is authoritative.';

commit;
