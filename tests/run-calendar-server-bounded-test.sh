#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
container_name="subtrack-calendar-bounded-$$"
postgres_password="calendar-bounded-fixture"
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
    --set ON_ERROR_STOP=1 < "$repo_dir/supabase/tests/calendar_server_bounded.sql"
