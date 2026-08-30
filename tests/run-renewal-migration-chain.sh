#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
container_name="subtrack-renewal-chain-$$"
postgres_password="migration-chain-fixture"
postgres_image="public.ecr.aws/supabase/postgres:17.6.1.155"
configured_major=$(
  awk -F= '/^[[:space:]]*major_version[[:space:]]*=/ {
    gsub(/[[:space:]]/, "", $2); print $2; exit
  }' "$repo_dir/supabase/config.toml"
)
image_tag=${postgres_image##*:}
image_major=${image_tag%%.*}

if [ -z "$configured_major" ] || [ "$configured_major" != "$image_major" ]; then
  echo "Postgres major drift: config=$configured_major image=$image_major" >&2
  exit 1
fi

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

runtime_major=$(
  docker exec --env PGPASSWORD="$postgres_password" "$container_name" \
    psql --host localhost --username supabase_admin --dbname postgres \
      --tuples-only --no-align \
      --command "select current_setting('server_version_num')::integer / 10000"
)
if [ "$runtime_major" != "$configured_major" ]; then
  echo "Postgres major drift: config=$configured_major runtime=$runtime_major" >&2
  exit 1
fi

docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
  psql --host localhost --username supabase_admin --dbname postgres --set ON_ERROR_STOP=1 <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;
create schema if not exists private;
create schema if not exists auth;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
SQL

docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
  psql --host localhost --username supabase_admin --dbname postgres --set ON_ERROR_STOP=1 \
  < "$repo_dir/supabase/migrations/20260804220000_cloud_data_plane.sql"

docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
  psql --host localhost --username supabase_admin --dbname postgres --set ON_ERROR_STOP=1 <<'SQL'
insert into public.subscriptions(
  owner_user_id, id, kind, service_name, amount_minor, currency_code, timezone,
  lifecycle_status, lifecycle_since, start_date, next_renewal_date,
  recurrence_unit, recurrence_interval
) values (
  'legacy_user', 'legacy_subscription', 'recurring', 'Legacy fixture', 100,
  'USD', 'UTC', 'active', '2026-01-01', '2026-01-01', '2026-02-01', 'month', 1
);
insert into public.renewal_events(
  owner_user_id, idempotency_key, subscription_id, occurrence_date,
  amount_minor, currency_code, state, corrected_on,
  original_occurrence_date, original_amount_minor
) values (
  'legacy_user', 'legacy_renewal', 'legacy_subscription', '2026-02-02',
  90, 'EUR', 'corrected', '2026-02-02', '2026-02-01', 100
);
SQL

preflight_output=$(mktemp)
if docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
  psql --host localhost --username supabase_admin --dbname postgres --set ON_ERROR_STOP=1 \
  < "$repo_dir/supabase/migrations/20260805040000_legacy_corrected_renewal_preflight.sql" \
  >"$preflight_output" 2>&1; then
  echo "legacy corrected-row preflight unexpectedly succeeded" >&2
  exit 1
fi
if ! grep -q "legacy corrected renewals require explicit original_currency_code reconciliation" "$preflight_output"; then
  echo "legacy corrected-row preflight did not return the actionable error" >&2
  sed -n '1,40p' "$preflight_output" >&2
  exit 1
fi

# Simulate the documented reviewed repair. The fixture currency is explicit test
# data; production repair must provide the known original currency per row.
docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
  psql --host localhost --username supabase_admin --dbname postgres --set ON_ERROR_STOP=1 <<'SQL'
alter table public.renewal_events add column original_currency_code text;
update public.renewal_events
set original_currency_code = 'USD'
where owner_user_id = 'legacy_user' and idempotency_key = 'legacy_renewal';
SQL

docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
  psql --host localhost --username supabase_admin --dbname postgres --set ON_ERROR_STOP=1 \
  < "$repo_dir/supabase/migrations/20260805040000_legacy_corrected_renewal_preflight.sql"
docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
  psql --host localhost --username supabase_admin --dbname postgres --set ON_ERROR_STOP=1 \
  < "$repo_dir/supabase/migrations/20260805044822_security_integrity_fixup.sql"
docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
  psql --host localhost --username supabase_admin --dbname postgres --set ON_ERROR_STOP=1 \
  < "$repo_dir/supabase/migrations/20260805052035_adversarial_runtime_fixup.sql"
docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
  psql --host localhost --username supabase_admin --dbname postgres --set ON_ERROR_STOP=1 \
  < "$repo_dir/supabase/migrations/20260805080018_delayed_database_hardening.sql"
docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
  psql --host localhost --username supabase_admin --dbname postgres --set ON_ERROR_STOP=1 <<'SQL'
insert into public.subscriptions(
  owner_user_id, id, kind, service_name, plan_name, amount_minor, currency_code, timezone,
  lifecycle_status, lifecycle_since, purchased_on, payment_label, notes
) values
  (
    'user_pan_reconciliation', 'sub_pan_reconcile_label', 'one_time', 'PAN reconciliation label',
    'Preserved label plan', 100, 'USD', 'UTC', 'active', '2026-01-01',
    '2026-01-01', '4111.1111.1111.1111', 'Preserved label notes'
  ),
  (
    'user_pan_reconciliation', 'sub_pan_reconcile_notes', 'one_time', 'PAN reconciliation notes',
    'Preserved notes plan', 100, 'USD', 'UTC', 'active', '2026-01-01',
    '2026-01-01', 'Visa •••• 4242', U&'4111\00A01111\00A01111\00A01111'
  );
SQL
docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
  psql --host localhost --username supabase_admin --dbname postgres --set ON_ERROR_STOP=1 \
  < "$repo_dir/supabase/migrations/20260805175233_adversarial_acceptance_fixup.sql"

docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
  psql --host localhost --username supabase_admin --dbname postgres --set ON_ERROR_STOP=1 <<'SQL'
do $$
begin
  if (
    select count(*)
    from public.subscriptions
    where owner_user_id = 'user_pan_reconciliation'
      and id in ('sub_pan_reconcile_label', 'sub_pan_reconcile_notes')
  ) <> 2 then
    raise exception 'pre-upgrade PAN fixtures did not survive helper replacement';
  end if;
  if not (
    select private.contains_payment_card_number(payment_label)
    from public.subscriptions
    where owner_user_id = 'user_pan_reconciliation'
      and id = 'sub_pan_reconcile_label'
  ) or not (
    select private.contains_payment_card_number(notes)
    from public.subscriptions
    where owner_user_id = 'user_pan_reconciliation'
      and id = 'sub_pan_reconcile_notes'
  ) then
    raise exception 'upgraded PAN helper did not detect the persisted fixtures';
  end if;
  if not exists (
    select 1
    from public.subscriptions
    where owner_user_id = 'user_pan_reconciliation'
      and id = 'sub_pan_reconcile_label'
      and plan_name = 'Preserved label plan'
      and notes = 'Preserved label notes'
  ) or not exists (
    select 1
    from public.subscriptions
    where owner_user_id = 'user_pan_reconciliation'
      and id = 'sub_pan_reconcile_notes'
      and plan_name = 'Preserved notes plan'
      and payment_label = 'Visa •••• 4242'
  ) then
    raise exception 'non-sensitive PAN fixture metadata changed before reconciliation';
  end if;
end;
$$;
SQL

docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
  psql --host localhost --username supabase_admin --dbname postgres --set ON_ERROR_STOP=1 \
  < "$repo_dir/supabase/migrations/20260805182905_pan_constraint_upgrade_reconciliation.sql"

chain_anchor="$repo_dir/supabase/migrations/20260805182905_pan_constraint_upgrade_reconciliation.sql"
after_chain_anchor=false
for migration in "$repo_dir"/supabase/migrations/*.sql; do
  if [ "$after_chain_anchor" = true ]; then
    docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
      psql --host localhost --username supabase_admin --dbname postgres --set ON_ERROR_STOP=1 \
      < "$migration"
  fi
  if [ "$migration" = "$chain_anchor" ]; then
    after_chain_anchor=true
  fi
done

docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
  psql --host localhost --username supabase_admin --dbname postgres --set ON_ERROR_STOP=1 <<'SQL'
do $$
begin
  if to_regclass('private.data_plane_behavioral_test_registry') is not null
    or to_regclass('private.data_plane_exposed_schemas') is not null
  then
    raise exception 'production behavioral coverage registries remain';
  end if;
  if to_regprocedure('private.contains_payment_card_number(text)') is null then
    raise exception 'payment-card screening invariant is absent';
  end if;
  if to_regprocedure('private.decode_uri_component(text)') is null
    or to_regprocedure('private.contains_prohibited_subscription_secret(text)') is null
  then
    raise exception 'subscription normalization parity invariant is absent';
  end if;
  if to_regprocedure('private.contains_uri_userinfo(text)') is null
    or to_regprocedure(
      'private.is_subscription_occurrence(date,date,text,integer)'
    ) is null
  then
    raise exception 'subscription database invariant parity helpers are absent';
  end if;
  if not private.contains_uri_userinfo(
      'https://%75%73%65%72%3A%70%61%73%73%40billing.example.test/manage'
    )
    or not private.contains_uri_userinfo(
      'https://user：pass＠billing.example.test/manage'
    )
    or private.contains_uri_userinfo(
      'https://example.test/invoice/1234567890123452'
    )
    or not private.is_subscription_occurrence(
      date '2024-01-31', date '2024-02-29', 'month', 1
    )
    or private.is_subscription_occurrence(
      date '2024-01-31', date '2024-02-15', 'month', 1
    )
  then
    raise exception 'subscription database invariant parity corpus is absent';
  end if;
  if (
    select count(*)
    from pg_catalog.pg_constraint constraint_definition
    where constraint_definition.conrelid = 'public.subscriptions'::regclass
      and constraint_definition.conname in (
        'subscriptions_management_url_credentials_free',
        'subscriptions_recurrence_aligned'
      )
      and constraint_definition.convalidated
  ) <> 2 then
    raise exception 'subscription database invariant constraints are absent';
  end if;
  if not private.contains_prohibited_subscription_secret(
      'https://example.test/manage?secret=%43%56%56%20%23%31%32%33'
    )
    or not private.contains_prohibited_subscription_secret(
      U&'\FF14' || pg_catalog.repeat(U&'\FF11', 15)
    )
    or private.contains_prohibited_subscription_secret('IMEI 490154203237518')
    or private.contains_prohibited_subscription_secret(
      'Invoice 1234567890123452; Visa •••• 4242'
    )
  then
    raise exception 'subscription normalization parity corpus is absent';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.reminder_deliveries'::regclass
      and conname = 'reminder_deliveries_idempotency_valid'
      and convalidated
  ) then
    raise exception 'delivery idempotency constraint is absent or unvalidated';
  end if;
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.renewal_events'::regclass
      and tgname = 'renewal_events_transition_guard'
      and not tgisinternal
  ) then
    raise exception 'renewal transition guard is absent';
  end if;
  if (
    select pg_catalog.pg_get_expr(attribute.adbin, attribute.adrelid)
    from pg_catalog.pg_attrdef attribute
    join pg_catalog.pg_attribute column_definition
      on column_definition.attrelid = attribute.adrelid
      and column_definition.attnum = attribute.adnum
    where attribute.adrelid = 'public.renewal_events'::regclass
      and column_definition.attname = 'state'
  ) <> '''expected''::text' then
    raise exception 'renewal expected-state default is absent';
  end if;
  if pg_catalog.has_table_privilege('authenticated', 'public.renewal_events', 'DELETE') then
    raise exception 'authenticated renewal deletion remains granted';
  end if;
  if (
    select array_agg(column_definition.attname order by column_definition.attname)
    from pg_catalog.pg_attribute column_definition
    where column_definition.attrelid = 'public.renewal_events'::regclass
      and column_definition.attnum > 0
      and not column_definition.attisdropped
      and pg_catalog.has_column_privilege(
        'authenticated', column_definition.attrelid, column_definition.attnum, 'INSERT'
      )
  ) is distinct from array[
    'amount_minor', 'currency_code', 'idempotency_key', 'occurrence_date', 'subscription_id'
  ]::name[] then
    raise exception 'authenticated renewal INSERT grants are not expected-only';
  end if;
  if not private.contains_payment_card_number('4111.1111.1111.1111')
    or private.contains_payment_card_number('490154203237518')
  then
    raise exception 'payment-card screening parity is absent';
  end if;
  if not exists (
    select 1
    from public.subscriptions
    where owner_user_id = 'user_pan_reconciliation'
      and id = 'sub_pan_reconcile_label'
      and payment_label is null
      and plan_name = 'Preserved label plan'
      and notes = 'Preserved label notes'
  ) or not exists (
    select 1
    from public.subscriptions
    where owner_user_id = 'user_pan_reconciliation'
      and id = 'sub_pan_reconcile_notes'
      and notes is null
      and plan_name = 'Preserved notes plan'
      and payment_label = 'Visa •••• 4242'
  ) then
    raise exception 'PAN reconciliation did not clear only violating metadata';
  end if;
  if exists (
    select 1
    from public.subscriptions
    where (payment_label is not null and private.contains_payment_card_number(payment_label))
      or (notes is not null and private.contains_payment_card_number(notes))
  ) then
    raise exception 'PAN reconciliation left a violating subscription field';
  end if;
  if (
    select count(*)
    from pg_catalog.pg_constraint constraint_definition
    where constraint_definition.conrelid = 'public.subscriptions'::regclass
      and constraint_definition.conname in (
        'subscriptions_payment_label_pan_free',
        'subscriptions_notes_pan_free'
      )
      and constraint_definition.convalidated
      and pg_catalog.strpos(
        pg_catalog.pg_get_constraintdef(constraint_definition.oid),
        'private.contains_payment_card_number'
      ) > 0
  ) <> 2 then
    raise exception 'PAN constraints are absent, stale, or unvalidated';
  end if;
end;
$$;
SQL

docker exec --env PGPASSWORD="$postgres_password" -i "$container_name" \
  psql --host localhost --username supabase_admin --dbname postgres --tuples-only --no-align \
  --set ON_ERROR_STOP=1 \
  --command "select original_currency_code || ':' || convalidated from public.renewal_events cross join pg_constraint where conname = 'renewal_events_state_dates_valid' and idempotency_key = 'legacy_renewal'" \
  | grep -qx 'USD:true'

rm -f "$preflight_output"
echo "renewal migration chain: PASS"
