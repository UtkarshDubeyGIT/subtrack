#!/bin/sh
set -eu

DOCKER_CONTEXT=colima
export DOCKER_CONTEXT

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
container_name="subtrack-calendar-retention-$$"
postgres_password="calendar-retention-fixture"
postgres_image="public.ecr.aws/supabase/postgres:17.6.1.155"

cleanup() {
  docker rm --force "$container_name" >/dev/null 2>&1 || true
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
  psql --host localhost --username supabase_admin --dbname postgres \
    --set ON_ERROR_STOP=1 < "$repo_dir/tests/calendar-cursor-retention.sql"

docker exec --env PGPASSWORD="$postgres_password" "$container_name" \
  psql --host localhost --username supabase_admin --dbname postgres \
    --set ON_ERROR_STOP=1 --command "
      insert into calendar_private.cursor_states(
        owner_user_id, cursor_kind, request_hash, cursor_state,
        created_at, expires_at, retained_bytes
      ) values (
        'restart_cleanup_probe', 'subscriptions', md5('restart-probe'), '{}',
        statement_timestamp() - interval '20 minutes',
        statement_timestamp() - interval '1 second', 256
      );
    " >/dev/null

docker restart "$container_name" >/dev/null
attempt=0
until docker exec "$container_name" pg_isready --host localhost --username postgres >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "PostgreSQL did not recover after the retention restart" >&2
    exit 1
  fi
  sleep 1
done

attempt=0
while :; do
  remaining=$(docker exec --env PGPASSWORD="$postgres_password" "$container_name" \
    psql --host localhost --username supabase_admin --dbname postgres \
      --tuples-only --no-align --command "
        select count(*) from calendar_private.cursor_states
        where owner_user_id = 'restart_cleanup_probe';
      ")
  if [ "$remaining" = "0" ]; then
    echo "scheduled cursor cleanup after restart: PASS"
    break
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 18 ]; then
    docker exec --env PGPASSWORD="$postgres_password" "$container_name" \
      psql --host localhost --username supabase_admin --dbname postgres \
        --command "select status, return_message from cron.job_run_details order by start_time desc limit 3" >&2
    echo "scheduled cursor cleanup did not run after restart" >&2
    exit 1
  fi
  sleep 5
done
