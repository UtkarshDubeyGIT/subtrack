begin;
set local role postgres;
set local search_path = extensions, public, pg_catalog;

select plan(5);

select ok(
  exists (
    select 1
    from supabase_migrations.schema_migrations
    where version = '20260805040000'
  ),
  'retroactive corrected-renewal preflight is recorded before the integrity migration'
);

select is(
  to_regclass('private.data_plane_behavioral_test_registry'),
  null::regclass,
  'behavioral coverage evidence is not production database state'
);

select is(
  to_regclass('private.data_plane_exposed_schemas'),
  null::regclass,
  'configured exposed-schema evidence remains test-owned'
);

select results_eq(
  $$
    select array_agg(attribute.attname order by attribute.attname)
    from pg_catalog.pg_attribute attribute
    where attribute.attrelid = 'public.subscriptions'::regclass
      and attribute.attnum > 0
      and not attribute.attisdropped
      and has_column_privilege('authenticated', attribute.attrelid, attribute.attnum, 'UPDATE')
  $$,
  $$values (array[
    'access_ends_on', 'account_email', 'amount_minor', 'category',
    'currency_code', 'kind', 'lifecycle_access_ends_on', 'lifecycle_since',
    'lifecycle_status', 'management_url', 'next_renewal_date', 'notes',
    'payment_label', 'plan_name', 'purchased_on', 'recurrence_interval',
    'recurrence_unit', 'service_name', 'start_date', 'timezone', 'trial_ends_on'
  ]::name[])$$,
  'subscription PATCH serializer columns exactly match effective UPDATE grants'
);

select results_eq(
  $$
    select array_agg(attribute.attname order by attribute.attname)
    from pg_catalog.pg_attribute attribute
    where attribute.attrelid = 'public.renewal_events'::regclass
      and attribute.attnum > 0
      and not attribute.attisdropped
      and has_column_privilege('authenticated', attribute.attrelid, attribute.attnum, 'UPDATE')
  $$,
  $$values (array[
    'amount_minor', 'confirmed_on', 'corrected_on', 'currency_code',
    'occurrence_date', 'original_amount_minor', 'original_currency_code',
    'original_occurrence_date', 'skipped_on', 'state'
  ]::name[])$$,
  'renewal PATCH serializer columns exactly match effective UPDATE grants'
);

select * from finish();
rollback;
