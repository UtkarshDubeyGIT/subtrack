#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
container_name="subtrack-subscription-management-$$"
postgres_password="subscription-management-fixture"
postgres_image="public.ecr.aws/supabase/postgres:17.6.1.155"
test_output_file=$(mktemp)

cleanup() {
  docker rm --force "$container_name" >/dev/null 2>&1 || true
  rm -f "$test_output_file"
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
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), ''), '{}'
  )::jsonb
$$;
SQL

target_migration="$repo_dir/supabase/migrations/20260806200000_subscription_management.sql"
parity_migration="$repo_dir/supabase/migrations/20260806213000_subscription_secret_normalization_parity.sql"
invariant_migration="$repo_dir/supabase/migrations/20260806220000_database_invariant_parity.sql"
if [ ! -f "$parity_migration" ]; then
  echo "subscription normalization parity migration is missing" >&2
  exit 1
fi
if [ ! -f "$invariant_migration" ]; then
  echo "subscription database invariant parity migration is missing" >&2
  exit 1
fi
for migration in "$repo_dir"/supabase/migrations/*.sql; do
  if [ "$migration" = "$target_migration" ]; then
    break
  fi
  docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
    psql --host localhost --username supabase_admin --dbname postgres --set ON_ERROR_STOP=1 \
    < "$migration" >/dev/null
done

docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
  psql --host localhost --username supabase_admin --dbname postgres --set ON_ERROR_STOP=1 <<'SQL'
insert into public.subscriptions(
  owner_user_id, id, kind, service_name, amount_minor, currency_code, timezone,
  lifecycle_status, lifecycle_since, purchased_on, notes
) values (
  'legacy_management', 'legacy_management_secret', 'one_time',
  'Legacy fixture', 100, 'USD', 'UTC', 'active', '2026-01-01',
  '2026-01-01', 'CVV: 123'
);
SQL

if docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
  psql --host localhost --username supabase_admin --dbname postgres --set ON_ERROR_STOP=1 \
  < "$target_migration" > "$test_output_file" 2>&1; then
  echo "subscription migration unexpectedly accepted prohibited legacy text" >&2
  exit 1
fi
if ! grep -q 'existing subscription text requires reviewed secret removal' "$test_output_file"; then
  echo "subscription migration did not return its reviewed-reconciliation preflight" >&2
  sed -n '1,60p' "$test_output_file" >&2
  exit 1
fi

leaked_ddl=$(
  docker exec --env PGPASSWORD="$postgres_password" "$container_name" \
    psql --host localhost --username supabase_admin --dbname postgres \
      --tuples-only --no-align --set ON_ERROR_STOP=1 --command \
      "select ((to_regclass('public.subscriptions') is not null and exists (select 1 from pg_attribute where attrelid = 'public.subscriptions'::regclass and attname = 'category' and not attisdropped))::integer)::text || '|' || (to_regprocedure('private.contains_prohibited_subscription_secret(text)') is not null)::integer::text"
)
atomicity_failed=false
if [ "$leaked_ddl" != "0|0" ]; then
  echo "failed subscription migration leaked persistent DDL: $leaked_ddl" >&2
  atomicity_failed=true
  docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
    psql --host localhost --username supabase_admin --dbname postgres --set ON_ERROR_STOP=1 <<'SQL'
alter table public.subscriptions drop column if exists category;
drop function if exists private.contains_prohibited_subscription_secret(text);
SQL
fi

docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
  psql --host localhost --username supabase_admin --dbname postgres --set ON_ERROR_STOP=1 <<'SQL'
update public.subscriptions
set notes = 'Reviewed legacy invoice 12345'
where owner_user_id = 'legacy_management' and id = 'legacy_management_secret';
SQL

docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
  psql --host localhost --username supabase_admin --dbname postgres --set ON_ERROR_STOP=1 \
  < "$target_migration" >/dev/null

after_target=false
for migration in "$repo_dir"/supabase/migrations/*.sql; do
  if [ "$migration" = "$parity_migration" ]; then
    break
  fi
  if [ "$after_target" = true ]; then
    docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
      psql --host localhost --username supabase_admin --dbname postgres --set ON_ERROR_STOP=1 \
      < "$migration" >/dev/null
  fi
  if [ "$migration" = "$target_migration" ]; then
    after_target=true
  fi
done

docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
  psql --host localhost --username supabase_admin --dbname postgres --set ON_ERROR_STOP=1 <<'SQL'
insert into public.subscriptions(
  owner_user_id, id, kind, service_name, amount_minor, currency_code, timezone,
  lifecycle_status, lifecycle_since, purchased_on, management_url, notes
) values (
  'legacy_management', 'legacy_normalization_bypass', 'one_time',
  'Legacy normalization bypass', 100, 'USD', 'UTC', 'active', '2026-01-01',
  '2026-01-01',
  'https://example.test/manage?secret=%43%56%56%20%23%31%32%33',
  U&'\FF14' || pg_catalog.repeat(U&'\FF11', 15)
);
SQL

baseline_helper_hash=$(
  docker exec --env PGPASSWORD="$postgres_password" "$container_name" \
    psql --host localhost --username supabase_admin --dbname postgres \
      --tuples-only --no-align --set ON_ERROR_STOP=1 --command \
      "select md5(pg_get_functiondef('private.contains_prohibited_subscription_secret(text)'::regprocedure))"
)

if docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
  psql --host localhost --username supabase_admin --dbname postgres --set ON_ERROR_STOP=1 \
  < "$parity_migration" > "$test_output_file" 2>&1; then
  echo "normalization parity migration unexpectedly accepted prohibited legacy text" >&2
  exit 1
fi
if ! grep -q 'existing subscription text requires reviewed normalization before migration' "$test_output_file"; then
  echo "normalization parity migration did not return its reviewed-reconciliation preflight" >&2
  sed -n '1,60p' "$test_output_file" >&2
  exit 1
fi

parity_failure_state=$(
  docker exec --env PGPASSWORD="$postgres_password" "$container_name" \
    psql --host localhost --username supabase_admin --dbname postgres \
      --tuples-only --no-align --set ON_ERROR_STOP=1 --command \
      "select (to_regprocedure('private.decode_uri_component(text)') is not null)::integer::text || '|' || md5(pg_get_functiondef('private.contains_prohibited_subscription_secret(text)'::regprocedure))"
)
if [ "$parity_failure_state" != "0|$baseline_helper_hash" ]; then
  echo "failed normalization parity migration leaked helper DDL: $parity_failure_state" >&2
  exit 1
fi

docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
  psql --host localhost --username supabase_admin --dbname postgres --set ON_ERROR_STOP=1 <<'SQL'
update public.subscriptions
set management_url = 'https://example.test/invoice/1234567890123452',
    notes = 'Reviewed IMEI 490154203237518'
where owner_user_id = 'legacy_management'
  and id = 'legacy_normalization_bypass';
SQL

docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
  psql --host localhost --username supabase_admin --dbname postgres --set ON_ERROR_STOP=1 \
  < "$parity_migration" >/dev/null

parity_retry_state=$(
  docker exec --env PGPASSWORD="$postgres_password" "$container_name" \
    psql --host localhost --username supabase_admin --dbname postgres \
      --tuples-only --no-align --set ON_ERROR_STOP=1 --command \
      "select (to_regprocedure('private.decode_uri_component(text)') is not null)::integer::text || '|' || private.contains_prohibited_subscription_secret('https://example.test/manage?secret=%43%56%56%20%23%31%32%33')::integer::text || '|' || private.contains_prohibited_subscription_secret(U&'\FF14' || pg_catalog.repeat(U&'\FF11', 15))::integer::text"
)
if [ "$parity_retry_state" != "1|1|1" ]; then
  echo "normalization parity migration retry did not install the complete policy: $parity_retry_state" >&2
  exit 1
fi

after_parity=false
for migration in "$repo_dir"/supabase/migrations/*.sql; do
  if [ "$migration" = "$invariant_migration" ]; then
    break
  fi
  if [ "$after_parity" = true ]; then
    docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
      psql --host localhost --username supabase_admin --dbname postgres --set ON_ERROR_STOP=1 \
      < "$migration" >/dev/null
  fi
  if [ "$migration" = "$parity_migration" ]; then
    after_parity=true
  fi
done

docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
  psql --host localhost --username supabase_admin --dbname postgres --set ON_ERROR_STOP=1 <<'SQL'
insert into public.subscriptions(
  owner_user_id, id, kind, service_name, amount_minor, currency_code, timezone,
  lifecycle_status, lifecycle_since, purchased_on, management_url
) values (
  'legacy_management', 'legacy_uri_userinfo_bypass', 'one_time',
  'Legacy URI userinfo bypass', 100, 'USD', 'UTC', 'active', '2026-01-01',
  '2026-01-01',
  'https://%75%73%65%72%3A%70%61%73%73%40billing.example.test/manage'
);

insert into public.subscriptions(
  owner_user_id, id, kind, service_name, amount_minor, currency_code, timezone,
  lifecycle_status, lifecycle_since, start_date, next_renewal_date,
  recurrence_unit, recurrence_interval
) values (
  'legacy_management', 'legacy_off_schedule', 'recurring',
  'Legacy off schedule', 100, 'USD', 'UTC', 'active', '2024-01-31',
  '2024-01-31', '2024-02-15', 'month', 1
);
SQL

baseline_credentials_constraint_hash=$(
  docker exec --env PGPASSWORD="$postgres_password" "$container_name" \
    psql --host localhost --username supabase_admin --dbname postgres \
      --tuples-only --no-align --set ON_ERROR_STOP=1 --command \
      "select md5(pg_get_constraintdef(oid)) from pg_constraint where conrelid = 'public.subscriptions'::regclass and conname = 'subscriptions_management_url_credentials_free'"
)

if docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
  psql --host localhost --username supabase_admin --dbname postgres --set ON_ERROR_STOP=1 \
  < "$invariant_migration" > "$test_output_file" 2>&1; then
  echo "database invariant parity migration unexpectedly accepted invalid legacy rows" >&2
  exit 1
fi
if ! grep -q 'existing subscriptions require reviewed URL or recurrence reconciliation' "$test_output_file"; then
  echo "database invariant parity migration did not return its reviewed-reconciliation preflight" >&2
  sed -n '1,60p' "$test_output_file" >&2
  exit 1
fi

invariant_failure_state=$(
  docker exec --env PGPASSWORD="$postgres_password" "$container_name" \
    psql --host localhost --username supabase_admin --dbname postgres \
      --tuples-only --no-align --set ON_ERROR_STOP=1 --command \
      "select (to_regprocedure('private.contains_uri_userinfo(text)') is not null)::integer::text || '|' || (to_regprocedure('private.is_subscription_occurrence(date,date,text,integer)') is not null)::integer::text || '|' || exists(select 1 from pg_constraint where conrelid = 'public.subscriptions'::regclass and conname = 'subscriptions_recurrence_aligned')::integer::text || '|' || md5(pg_get_constraintdef(oid)) from pg_constraint where conrelid = 'public.subscriptions'::regclass and conname = 'subscriptions_management_url_credentials_free'"
)
if [ "$invariant_failure_state" != "0|0|0|$baseline_credentials_constraint_hash" ]; then
  echo "failed database invariant parity migration leaked persistent DDL: $invariant_failure_state" >&2
  exit 1
fi

docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
  psql --host localhost --username supabase_admin --dbname postgres --set ON_ERROR_STOP=1 <<'SQL'
update public.subscriptions
set management_url = 'https://example.test/invoice/1234567890123452'
where owner_user_id = 'legacy_management'
  and id = 'legacy_uri_userinfo_bypass';

update public.subscriptions
set next_renewal_date = '2024-02-29'
where owner_user_id = 'legacy_management'
  and id = 'legacy_off_schedule';
SQL

docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
  psql --host localhost --username supabase_admin --dbname postgres --set ON_ERROR_STOP=1 \
  < "$invariant_migration" >/dev/null

invariant_retry_state=$(
  docker exec --env PGPASSWORD="$postgres_password" "$container_name" \
    psql --host localhost --username supabase_admin --dbname postgres \
      --tuples-only --no-align --set ON_ERROR_STOP=1 --command \
      "select (to_regprocedure('private.contains_uri_userinfo(text)') is not null)::integer::text || '|' || (to_regprocedure('private.is_subscription_occurrence(date,date,text,integer)') is not null)::integer::text || '|' || private.contains_uri_userinfo('https://%75%73%65%72%3A%70%61%73%73%40billing.example.test/manage')::integer::text || '|' || private.contains_uri_userinfo('https://user：pass＠billing.example.test/manage')::integer::text || '|' || private.is_subscription_occurrence(date '2024-01-31', date '2024-02-29', 'month', 1)::integer::text || '|' || private.is_subscription_occurrence(date '2024-01-31', date '2024-02-15', 'month', 1)::integer::text || '|' || (select count(*) from pg_constraint where conrelid = 'public.subscriptions'::regclass and conname in ('subscriptions_management_url_credentials_free', 'subscriptions_recurrence_aligned') and convalidated)::text"
)
if [ "$invariant_retry_state" != "1|1|1|1|1|0|2" ]; then
  echo "database invariant parity migration retry did not install the complete policy: $invariant_retry_state" >&2
  exit 1
fi

after_invariant=false
for migration in "$repo_dir"/supabase/migrations/*.sql; do
  if [ "$after_invariant" = true ]; then
    docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
      psql --host localhost --username supabase_admin --dbname postgres --set ON_ERROR_STOP=1 \
      < "$migration" >/dev/null
  fi
  if [ "$migration" = "$invariant_migration" ]; then
    after_invariant=true
  fi
done

docker cp "$repo_dir/supabase/tests/subscription_management.sql" \
  "$container_name:/tmp/subscription_management.sql" >/dev/null
if ! docker exec --env PGPASSWORD="$postgres_password" "$container_name" \
  psql --host localhost --username supabase_admin --dbname postgres \
  --tuples-only --no-align --set ON_ERROR_STOP=1 \
  --file /tmp/subscription_management.sql > "$test_output_file"; then
  cat "$test_output_file"
  exit 1
fi
cat "$test_output_file"
if grep -q '^not ok' "$test_output_file"; then
  exit 1
fi
grep -q '^1..71$' "$test_output_file"
if [ "$atomicity_failed" = true ]; then
  echo "subscription migration atomicity proof failed" >&2
  exit 1
fi
