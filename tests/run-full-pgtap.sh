#!/bin/sh
set -eu

DOCKER_CONTEXT=colima
export DOCKER_CONTEXT

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
container_name="subtrack-full-pgtap-$$"
postgres_password="full-pgtap-fixture"
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
create schema if not exists supabase_migrations authorization postgres;
alter schema private owner to postgres;
create table if not exists supabase_migrations.schema_migrations (
  version text primary key,
  name text not null
);
alter table supabase_migrations.schema_migrations owner to postgres;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
SQL

for migration in "$repo_dir"/supabase/migrations/*.sql; do
  migration_file=$(basename "$migration")
  migration_version=${migration_file%%_*}
  migration_name=${migration_file#*_}
  migration_name=${migration_name%.sql}
  case "$migration_version" in *[!0-9]*) echo "invalid migration version" >&2; exit 1 ;; esac
  case "$migration_name" in *[!A-Za-z0-9_]*) echo "invalid migration name" >&2; exit 1 ;; esac
  docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
    psql --host localhost --username postgres --dbname postgres \
      --set ON_ERROR_STOP=1 < "$migration" >/dev/null
  docker exec --env PGPASSWORD="$postgres_password" "$container_name" \
    psql --host localhost --username postgres --dbname postgres \
      --set ON_ERROR_STOP=1 \
      --command "insert into supabase_migrations.schema_migrations(version, name) values ('$migration_version', '$migration_name')" \
      >/dev/null
done

for test_file in "$repo_dir"/supabase/tests/*.sql; do
  echo "pgTAP: $(basename "$test_file")"
  docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
    psql --host localhost --username postgres --dbname postgres \
      --set ON_ERROR_STOP=1 < "$test_file"
done
