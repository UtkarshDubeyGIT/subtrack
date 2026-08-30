#!/bin/sh
set -eu

DOCKER_CONTEXT=colima
export DOCKER_CONTEXT

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
container_name="subtrack-calendar-plan-$$"
postgres_password="calendar-plan-fixture"
postgres_image="public.ecr.aws/supabase/postgres:17.6.1.155"
plan_log=$(mktemp -t subtrack-calendar-plan.XXXXXX)

cleanup() {
  docker rm --force "$container_name" >/dev/null 2>&1 || true
  rm -f "$plan_log"
}
trap cleanup EXIT INT TERM

docker run --detach --rm \
  --name "$container_name" \
  --env POSTGRES_PASSWORD="$postgres_password" \
  "$postgres_image" >/dev/null

attempt=0
until docker exec "$container_name" pg_isready --host localhost --username postgres >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "disposable PostgreSQL did not become ready" >&2
    exit 1
  fi
  sleep 1
done

docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
  psql --host localhost --username supabase_admin --dbname postgres --set ON_ERROR_STOP=1 <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;
create schema if not exists private;
create schema if not exists auth;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
SQL

for migration in "$repo_dir"/supabase/migrations/*.sql; do
  docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
    psql --host localhost --username supabase_admin --dbname postgres \
      --set ON_ERROR_STOP=1 < "$migration" >/dev/null
done

docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
  psql --host localhost --username supabase_admin --dbname postgres --set ON_ERROR_STOP=1 <<'SQL'
insert into private.clerk_identity_authority(singleton, issuer)
values (true, 'https://fixture.clerk.accounts.dev')
on conflict (singleton) do update set issuer = excluded.issuer;

insert into public.subscriptions(
  owner_user_id, id, kind, service_name, plan_name, category,
  amount_minor, currency_code, timezone, lifecycle_status, lifecycle_since,
  start_date, next_renewal_date, recurrence_unit, recurrence_interval
)
select
  fixture.owner_user_id,
  fixture.id_prefix || pg_catalog.lpad(series::text, 5, '0'),
  'recurring',
  fixture.service_prefix || series::text,
  case when series % 2 = 0 then 'Standard' else 'Family' end,
  case when series % 3 = 0 then 'Streaming' else 'Software' end,
  1299,
  'USD',
  'UTC',
  'active',
  fixture.anchor_date,
  fixture.anchor_date,
  fixture.next_renewal_date,
  fixture.recurrence_unit,
  fixture.recurrence_interval
from (
  values
    ('user_calendar_dense', 'dense_', 'Dense daily ', date '1900-01-01', date '1900-01-01', 'day', 1),
    ('user_calendar_sparse', 'sparse_', 'Sparse future ', date '1900-01-01', date '9100-01-01', 'year', 1200)
) fixture(
  owner_user_id, id_prefix, service_prefix, anchor_date,
  next_renewal_date, recurrence_unit, recurrence_interval
)
cross join pg_catalog.generate_series(1, 20000) series;

insert into public.subscriptions(
  owner_user_id, id, kind, service_name, plan_name, category,
  amount_minor, currency_code, timezone, lifecycle_status, lifecycle_since,
  start_date, next_renewal_date, recurrence_unit, recurrence_interval
) values (
  'user_calendar_corrections', 'correction_source', 'recurring',
  'Correction source', 'Standard', 'Software', 1299, 'USD', 'UTC',
  'active', date '1900-01-01', date '1900-01-01', date '9100-01-01',
  'year', 1200
);

insert into public.renewal_events(
  owner_user_id, idempotency_key, subscription_id, occurrence_date,
  amount_minor, currency_code, state, corrected_on,
  original_occurrence_date, original_amount_minor, original_currency_code
)
select
  'user_calendar_corrections',
  fixture.key_prefix || pg_catalog.lpad(series::text, 6, '0'),
  'correction_source',
  fixture.occurrence_date,
  1199,
  'USD',
  'corrected',
  fixture.occurrence_date,
  fixture.original_date,
  1299,
  'USD'
from (
  values
    ('a_out_', date '2025-01-01', date '2024-12-01', 100000),
    ('z_in_', date '2026-08-15', date '2026-08-01', 20000)
) fixture(key_prefix, occurrence_date, original_date, fixture_count)
cross join lateral pg_catalog.generate_series(1, fixture.fixture_count) series;

analyze public.subscriptions;
analyze public.renewal_events;

select pg_catalog.pg_stat_reset();

select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"user_calendar_dense","iss":"https://fixture.clerk.accounts.dev","exp":4102444800}',
  false
);

load 'auto_explain';
set auto_explain.log_min_duration = 0;
set auto_explain.log_analyze = on;
set auto_explain.log_buffers = on;
set auto_explain.log_nested_statements = on;
set auto_explain.log_timing = off;
set auto_explain.log_parameter_max_length = 0;
set client_min_messages = warning;

set role authenticated;

create temporary table dense_first_phase as
select public.calendar_events_page(
  date '2026-08-01', date '2026-08-31', 'charges', '', 256, null
) page;

select 1 / ((
  page->>'authoritative' = 'false'
  and jsonb_array_length(page->'events') = 0
  and (page#>>'{work,source_rows_scanned}')::integer = 256
  and (page#>>'{work,recurrence_candidates}')::integer = 7936
  and (page#>>'{work,correction_rows_scanned}')::integer = 0
  and page->>'next_cursor' ~ '^[a-f0-9]{32}$'
)::integer) as dense_first_phase_structural_assertion
from dense_first_phase;

explain (analyze, buffers, settings, format text)
select public.calendar_events_page(
  date '2026-08-01', date '2026-08-31', 'charges', '', 256,
  (select page->>'next_cursor' from dense_first_phase)
);

reset role;
set client_min_messages = notice;
set auto_explain.log_min_duration = -1;
set role authenticated;

do $$
declare
  page jsonb;
  cursor_value text := null;
  call_count integer := 0;
  max_source integer := 0;
  max_recurrence integer := 0;
  max_corrections integer := 0;
  started_at timestamptz := clock_timestamp();
begin
  loop
    page := public.calendar_events_page(
      date '2026-08-01', date '2026-08-31', 'charges', '', 256, cursor_value
    );
    call_count := call_count + 1;
    max_source := greatest(max_source, (page#>>'{work,source_rows_scanned}')::integer);
    max_recurrence := greatest(max_recurrence, (page#>>'{work,recurrence_candidates}')::integer);
    max_corrections := greatest(max_corrections, (page#>>'{work,correction_rows_scanned}')::integer);
    if page->>'authoritative' = 'true' then exit; end if;
    if jsonb_array_length(page->'events') <> 0
      or page->>'next_cursor' !~ '^[a-f0-9]{32}$'
      or call_count > 100
    then
      raise exception 'invalid dense reconciliation phase';
    end if;
    cursor_value := page->>'next_cursor';
  end loop;
  if max_source > 256 or max_recurrence > 47616 or max_corrections > 1024
    or jsonb_array_length(page->'events') <> 256
  then
    raise exception 'dense work contract exceeded';
  end if;
  raise notice 'DENSE_METRIC calls=% max_source=% max_recurrence=% max_corrections=% elapsed_ms=% returned=%',
    call_count, max_source, max_recurrence, max_corrections,
    round(extract(epoch from clock_timestamp() - started_at) * 1000, 3),
    jsonb_array_length(page->'events');
end;
$$;

reset role;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"user_calendar_sparse","iss":"https://fixture.clerk.accounts.dev","exp":4102444800}',
  false
);
set role authenticated;

do $$
declare
  page jsonb;
  cursor_value text := null;
  call_count integer := 0;
  max_source integer := 0;
  max_recurrence integer := 0;
  started_at timestamptz := clock_timestamp();
begin
  loop
    page := public.calendar_events_page(
      date '2026-08-01', date '2026-08-31', 'all', 'definitely absent', 256,
      cursor_value
    );
    call_count := call_count + 1;
    max_source := greatest(max_source, (page#>>'{work,source_rows_scanned}')::integer);
    max_recurrence := greatest(max_recurrence, (page#>>'{work,recurrence_candidates}')::integer);
    if page->>'authoritative' = 'true' then exit; end if;
    if jsonb_array_length(page->'events') <> 0
      or page->>'next_cursor' !~ '^[a-f0-9]{32}$'
      or call_count > 100
    then
      raise exception 'invalid sparse reconciliation phase';
    end if;
    cursor_value := page->>'next_cursor';
  end loop;
  if max_source > 256 or max_recurrence <> 0
    or jsonb_array_length(page->'events') <> 0
    or page->>'complete' <> 'true'
  then
    raise exception 'sparse work contract exceeded';
  end if;
  raise notice 'SPARSE_METRIC calls=% max_source=% max_recurrence=% elapsed_ms=% returned=%',
    call_count, max_source, max_recurrence,
    round(extract(epoch from clock_timestamp() - started_at) * 1000, 3),
    jsonb_array_length(page->'events');
end;
$$;

reset role;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"user_calendar_corrections","iss":"https://fixture.clerk.accounts.dev","exp":4102444800}',
  false
);
set client_min_messages = warning;
set auto_explain.log_min_duration = 0;
set role authenticated;

create temporary table correction_first_phase as
select public.calendar_events_page(
  date '2026-08-01', date '2026-08-31', 'changes', '', 256, null
) page;

select 1 / (coalesce((
  page->>'authoritative' = 'false'
  and jsonb_array_length(page->'events') = 0
  and (page#>>'{work,source_rows_scanned}')::integer = 1
  and (page#>>'{work,correction_rows_scanned}')::integer = 1024
  and page->>'next_cursor' ~ '^[a-f0-9]{32}$'
), false)::integer) as correction_first_phase_structural_assertion
from correction_first_phase;

explain (analyze, buffers, settings, format text)
select public.calendar_events_page(
  date '2026-08-01', date '2026-08-31', 'changes', '', 256,
  (select page->>'next_cursor' from correction_first_phase)
);

reset role;
set client_min_messages = notice;
set auto_explain.log_min_duration = -1;
set role authenticated;

do $$
declare
  page jsonb;
  cursor_value text := null;
  call_count integer := 0;
  max_correction_source integer := 0;
  started_at timestamptz := clock_timestamp();
begin
  loop
    page := public.calendar_events_page(
      date '2026-08-01', date '2026-08-31', 'changes', '', 256,
      cursor_value
    );
    call_count := call_count + 1;
    max_correction_source := greatest(
      max_correction_source,
      (page#>>'{work,correction_rows_scanned}')::integer
    );
    if page->>'authoritative' = 'true' then exit; end if;
    if jsonb_array_length(page->'events') <> 0
      or page->>'next_cursor' !~ '^[a-f0-9]{32}$'
      or call_count > 25
    then
      raise exception 'invalid correction reconciliation phase';
    end if;
    cursor_value := page->>'next_cursor';
  end loop;
  if max_correction_source > 1024
    or jsonb_array_length(page->'events') <> 256
  then
    raise exception 'correction work contract exceeded';
  end if;
  raise notice 'CORRECTION_METRIC calls=% max_correction_source=% elapsed_ms=% returned=%',
    call_count, max_correction_source,
    round(extract(epoch from clock_timestamp() - started_at) * 1000, 3),
    jsonb_array_length(page->'events');
end;
$$;

reset role;
select pg_catalog.pg_stat_force_next_flush();
select 1 / ((temp_files = 0 and temp_bytes = 0)::integer)
  as no_temp_io_structural_assertion,
  temp_files,
  temp_bytes
from pg_catalog.pg_stat_database
where datname = current_database();

explain (analyze, buffers, format text)
select subscription.id
from public.subscriptions subscription
where subscription.owner_user_id = 'user_calendar_sparse'
  and subscription.id > 'sparse_10000'
order by subscription.id
limit 256;
SQL

docker logs "$container_name" >"$plan_log" 2>&1
if grep -Eq 'Rows Removed by Filter: 100000|Rows Removed by Filter: [1-9][0-9]{5,}' "$plan_log"; then
  grep -En -B 12 -A 4 \
    'Rows Removed by Filter: 100000|Rows Removed by Filter: [1-9][0-9]{5,}' \
    "$plan_log" | head -80 >&2
  echo "correction source plan examined an unbounded out-of-range prefix" >&2
  exit 1
fi
