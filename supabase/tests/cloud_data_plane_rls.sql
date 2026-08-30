begin;
set local role postgres;
set local search_path = extensions, public, pg_catalog;

select plan(44);

insert into private.clerk_identity_authority(singleton, issuer)
values (true, 'https://fixture.clerk.accounts.dev')
on conflict (singleton) do update set issuer = excluded.issuer;

select has_table('public', 'user_preferences', 'preferences table exists');
select has_table('public', 'subscriptions', 'subscriptions table exists');
select has_table('public', 'renewal_events', 'renewal events table exists');
select has_table('public', 'reminder_overrides', 'reminder overrides table exists');
select has_table('public', 'reminder_deliveries', 'reminder deliveries table exists');
select has_table('public', 'fx_rates', 'FX rates table exists');
select has_table('public', 'security_audit_events', 'security audit table exists');

select is_empty(
  $$
    select expected.table_name
    from (values
      ('user_preferences'), ('subscriptions'), ('renewal_events'),
      ('reminder_overrides'), ('reminder_deliveries'), ('fx_rates'),
      ('security_audit_events')
    ) expected(table_name)
    left join pg_catalog.pg_class c on c.relname = expected.table_name
    left join pg_catalog.pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    where n.oid is null or not c.relrowsecurity or not c.relforcerowsecurity
  $$,
  'every exposed data-plane table enables and forces RLS'
);

select is_empty(
  $$
    select expected.table_name, expected.command
    from (values
      ('user_preferences'), ('subscriptions'), ('renewal_events'),
      ('reminder_overrides'), ('reminder_deliveries'), ('fx_rates'),
      ('security_audit_events')
    ) tables(table_name)
    cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) commands(command)
    cross join lateral (select tables.table_name, commands.command) expected
    left join pg_catalog.pg_policies p
      on p.schemaname = 'public'
      and p.tablename = expected.table_name
      and p.cmd = expected.command
    where p.policyname is null
  $$,
  'every exposed table has an explicit policy for every operation'
);

select is_empty(
  $$
    select tablename
    from pg_catalog.pg_policies
    where schemaname = 'public' and cmd = 'UPDATE'
      and tablename in (
        'user_preferences', 'subscriptions', 'renewal_events',
        'reminder_overrides', 'reminder_deliveries', 'fx_rates',
        'security_audit_events'
      )
      and (qual is null or with_check is null)
  $$,
  'every UPDATE policy has explicit USING and WITH CHECK expressions'
);

select is_empty(
  $$
    select expected.table_name
    from (values
      ('user_preferences'), ('subscriptions'), ('renewal_events'), ('reminder_overrides')
    ) expected(table_name)
    join information_schema.columns c
      on c.table_schema = 'public'
      and c.table_name = expected.table_name
      and c.column_name = 'owner_user_id'
    where c.column_default not like '%current_clerk_subject%'
  $$,
  'client-writable rows derive ownership from verified Clerk claims'
);

select is_empty(
  $$
    select expected.table_name
    from (values
      ('user_preferences'), ('subscriptions'), ('renewal_events'),
      ('reminder_overrides'), ('reminder_deliveries'), ('fx_rates'),
      ('security_audit_events')
    ) expected(table_name)
    where has_table_privilege('anon', 'public.' || expected.table_name, 'SELECT')
       or has_table_privilege('anon', 'public.' || expected.table_name, 'INSERT')
       or has_table_privilege('anon', 'public.' || expected.table_name, 'UPDATE')
       or has_table_privilege('anon', 'public.' || expected.table_name, 'DELETE')
  $$,
  'anonymous role has no data-plane table privileges'
);

select is_empty(
  $$
    select expected.table_name
    from (values
      ('user_preferences'), ('subscriptions'), ('renewal_events'),
      ('reminder_overrides'), ('reminder_deliveries'), ('security_audit_events')
    ) expected(table_name)
    where has_column_privilege(
      'authenticated', 'public.' || expected.table_name, 'owner_user_id', 'INSERT'
    ) or has_column_privilege(
      'authenticated', 'public.' || expected.table_name, 'owner_user_id', 'UPDATE'
    )
  $$,
  'authenticated clients cannot write ownership columns'
);

select is_empty(
  $$
    select expected.table_name
    from (values
      ('reminder_deliveries'), ('fx_rates'), ('security_audit_events')
    ) expected(table_name)
    where has_table_privilege('authenticated', 'public.' || expected.table_name, 'INSERT')
       or has_table_privilege('authenticated', 'public.' || expected.table_name, 'UPDATE')
       or has_table_privilege('authenticated', 'public.' || expected.table_name, 'DELETE')
  $$,
  'server-written tables expose SELECT only to authenticated clients'
);

select is_empty(
  $$
    select p.proname
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and p.proname in ('current_clerk_subject', 'enforce_owned_row')
      and (
        (p.proname = 'enforce_owned_row' and p.prosecdef)
        or (p.proname = 'current_clerk_subject' and not p.prosecdef)
        or coalesce(array_to_string(p.proconfig, ','), '') <> 'search_path=""'
      )
  $$,
  'data-plane helpers use the intended invoker/definer mode and an empty fixed search path'
);

select results_eq(
  $$
    select p.oid::regprocedure::text
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.prosecdef
      and has_function_privilege('authenticated', p.oid, 'EXECUTE')
    order by p.oid::regprocedure::text
  $$,
  $$values
    -- Reviewed addition (reminder engine): the acknowledgement RPC is the
    -- single client write path for reminder deliveries. Ownership comes from
    -- the verified token inside the function, direct table writes remain
    -- denied to authenticated, and its own suite pins the legal transitions
    -- and cross-account rejection (supabase/tests/reminder_engine.sql).
    ('acknowledge_reminder_delivery(text,text,text)'::text),
    ('private.contains_prohibited_subscription_secret(text)'::text),
    ('private.contains_uri_userinfo(text)'::text),
    ('private.current_clerk_subject()'::text)
  $$,
  'authenticated security-definer access exactly matches the reviewed constraint and Clerk helper allowlist'
);

select is_empty(
  $$
    select publication_tables.tablename
    from pg_catalog.pg_publication_tables publication_tables
    where publication_tables.pubname = 'supabase_realtime'
      and publication_tables.schemaname = 'public'
      and publication_tables.tablename in (
        'user_preferences', 'subscriptions', 'renewal_events',
        'reminder_overrides', 'reminder_deliveries', 'security_audit_events'
      )
  $$,
  'owner data is not exposed to unfilterable Postgres Changes DELETE events'
);

insert into public.user_preferences(owner_user_id, timezone, home_currency)
values
  ('user_fixture_a', 'UTC', 'USD'),
  ('user_fixture_b', 'Asia/Kolkata', 'INR');

insert into public.subscriptions(
  owner_user_id, id, kind, service_name, amount_minor, currency_code, timezone,
  lifecycle_status, lifecycle_since, start_date, next_renewal_date,
  recurrence_unit, recurrence_interval
) values
  (
    'user_fixture_a', 'sub_fixture_a', 'recurring', 'Fixture A', 1299, 'USD', 'UTC',
    'active', '2026-01-01', '2026-01-01', '2026-02-01', 'month', 1
  ),
  (
    'user_fixture_b', 'sub_fixture_b', 'recurring', 'Fixture B', 999, 'INR', 'Asia/Kolkata',
    'active', '2026-01-01', '2026-01-01', '2026-02-01', 'month', 1
  );

insert into public.renewal_events(
  owner_user_id, idempotency_key, subscription_id, occurrence_date,
  amount_minor, currency_code, state
) values
  ('user_fixture_a', 'renewal_fixture_a', 'sub_fixture_a', '2026-02-01', 1299, 'USD', 'expected'),
  ('user_fixture_b', 'renewal_fixture_b', 'sub_fixture_b', '2026-02-01', 999, 'INR', 'expected');

insert into public.reminder_overrides(owner_user_id, subscription_id, lead_days, channels)
values
  ('user_fixture_a', 'sub_fixture_a', array[7, 1]::smallint[], array['in_app']),
  ('user_fixture_b', 'sub_fixture_b', array[3]::smallint[], array['in_app']);

insert into public.reminder_deliveries(
  owner_user_id, idempotency_key, subscription_id, occurrence_date,
  channel, state, scheduled_for
) values
  (
    'user_fixture_a', 'delivery_fixture_a', 'sub_fixture_a', '2026-02-01',
    'in_app', 'pending', '2026-01-25T00:00:00Z'
  ),
  (
    'user_fixture_b', 'delivery_fixture_b', 'sub_fixture_b', '2026-02-01',
    'in_app', 'pending', '2026-01-29T00:00:00Z'
  );

insert into public.security_audit_events(owner_user_id, event_type, request_id)
values
  ('user_fixture_a', 'export_requested', 'request_fixture_a'),
  ('user_fixture_b', 'deletion_requested', 'request_fixture_b');

insert into public.fx_rates(base_currency, quote_currency, rate, effective_at, provider_code)
values ('USD', 'INR', 83.250000000000, '2026-08-04T00:00:00Z', 'FIXTURE');

select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"user_fixture_a","iss":"https://fixture.clerk.accounts.dev","exp":4102444800}',
  true
);
set local role authenticated;

select results_eq(
  $$select owner_user_id from public.user_preferences order by owner_user_id$$,
  array['user_fixture_a'::text],
  'user A sees only their preferences'
);
select results_eq(
  $$select id from public.subscriptions order by id$$,
  array['sub_fixture_a'::text],
  'user A sees only their subscriptions'
);
select results_eq(
  $$select idempotency_key from public.renewal_events order by idempotency_key$$,
  array['renewal_fixture_a'::text],
  'user A sees only their renewal events'
);
select results_eq(
  $$select subscription_id from public.reminder_overrides order by subscription_id$$,
  array['sub_fixture_a'::text],
  'user A sees only their reminder overrides'
);
select results_eq(
  $$select idempotency_key from public.reminder_deliveries order by idempotency_key$$,
  array['delivery_fixture_a'::text],
  'user A sees only their reminder deliveries'
);
select is(
  (select count(*)::integer from public.security_audit_events),
  1,
  'user A sees only their audit events'
);
select is(
  (select count(*)::integer from public.fx_rates),
  1,
  'authenticated users can read server-provided FX rates'
);

select lives_ok(
  $$
    insert into public.subscriptions(
      id, kind, service_name, amount_minor, currency_code, timezone,
      lifecycle_status, lifecycle_since, purchased_on, access_ends_on
    ) values (
      'sub_insert_a', 'one_time', 'Fixture Insert', 4999, 'USD', 'UTC',
      'active', '2026-08-04', '2026-08-04', null
    )
  $$,
  'user A can insert a valid row without supplying ownership'
);
select results_eq(
  $$select owner_user_id from public.subscriptions where id = 'sub_insert_a'$$,
  array['user_fixture_a'::text],
  'insert ownership is derived from the verified sub claim'
);
select throws_ok(
  $$
    insert into public.subscriptions(
      owner_user_id, id, kind, service_name, amount_minor, currency_code,
      timezone, lifecycle_status, lifecycle_since, purchased_on
    ) values (
      'user_fixture_b', 'sub_forged', 'one_time', 'Forged', 1, 'USD',
      'UTC', 'active', '2026-08-04', '2026-08-04'
    )
  $$,
  '42501',
  'permission denied for table subscriptions',
  'user A cannot forge insert ownership'
);
select lives_ok(
  $$update public.subscriptions set service_name = 'Fixture A Updated' where id = 'sub_fixture_a'$$,
  'user A can update their subscription'
);
select is(
  (select version::integer from public.subscriptions where id = 'sub_fixture_a'),
  2,
  'server trigger advances optimistic version'
);
select results_eq(
  $$
    with changed as (
      update public.subscriptions set service_name = 'Cross User' where id = 'sub_fixture_b'
      returning id
    ) select count(*)::bigint from changed
  $$,
  array[0::bigint],
  'user A cannot update user B rows'
);
select throws_ok(
  $$update public.subscriptions set owner_user_id = 'user_fixture_b' where id = 'sub_fixture_a'$$,
  '42501',
  'permission denied for table subscriptions',
  'user A cannot transfer ownership'
);
select results_eq(
  $$
    with removed as (
      delete from public.subscriptions where id = 'sub_fixture_b' returning id
    ) select count(*)::bigint from removed
  $$,
  array[0::bigint],
  'user A cannot delete user B rows'
);
select results_eq(
  $$
    with removed as (
      delete from public.subscriptions where id = 'sub_insert_a' returning id
    ) select count(*)::bigint from removed
  $$,
  array[1::bigint],
  'user A can delete their own row'
);
select throws_ok(
  $$
    insert into public.renewal_events(
      idempotency_key, subscription_id, occurrence_date,
      amount_minor, currency_code
    ) values ('renewal_cross_user', 'sub_fixture_b', '2026-03-01', 1, 'USD')
  $$,
  '23503',
  'insert or update on table "renewal_events" violates foreign key constraint "renewal_events_owner_user_id_subscription_id_fkey"',
  'user A cannot attach child rows to user B subscriptions'
);

select set_config('request.jwt.claims', '{}', true);
select is((select count(*)::integer from public.subscriptions), 0, 'missing claims fail closed');
select set_config(
  'request.jwt.claims',
  '{"role":"anon","sub":"user_fixture_a","iss":"https://fixture.clerk.accounts.dev","exp":4102444800}',
  true
);
select is((select count(*)::integer from public.subscriptions), 0, 'wrong role claim fails closed');
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"user_fixture_a","iss":"https://fixture.clerk.accounts.dev","exp":1}',
  true
);
select is((select count(*)::integer from public.subscriptions), 0, 'expired claims fail closed');
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"user_fixture_a","iss":"https://fixture.clerk.accounts.dev","exp":4102444800}',
  true
);
select is((select count(*)::integer from public.subscriptions), 1, 'valid claims restore access');

set local role anon;
select throws_ok(
  $$select count(*) from public.subscriptions$$,
  '42501',
  'permission denied for table subscriptions',
  'anonymous role cannot query subscriptions'
);

set local role postgres;
select throws_ok(
  $$update public.subscriptions set owner_user_id = 'user_fixture_a' where id = 'sub_fixture_b'$$,
  '42501',
  'owner_user_id is immutable',
  'ownership remains immutable even on privileged updates'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"user_fixture_a","iss":"https://fixture.clerk.accounts.dev","exp":4102444800}',
  true
);
select throws_ok(
  $$
    insert into public.reminder_deliveries(
      owner_user_id, idempotency_key, subscription_id, occurrence_date,
      channel, state, scheduled_for
    ) values (
      'user_fixture_a', 'delivery_client', 'sub_fixture_a', '2026-03-01',
      'in_app', 'pending', statement_timestamp()
    )
  $$,
  '42501',
  'permission denied for table reminder_deliveries',
  'authenticated clients cannot write reminder deliveries'
);
select throws_ok(
  $$
    insert into public.fx_rates(base_currency, quote_currency, rate, effective_at, provider_code)
    values ('EUR', 'USD', 1.1, statement_timestamp(), 'CLIENT')
  $$,
  '42501',
  'permission denied for table fx_rates',
  'authenticated clients cannot write FX rates'
);
select throws_ok(
  $$
    insert into public.security_audit_events(owner_user_id, event_type)
    values ('user_fixture_a', 'export_requested')
  $$,
  '42501',
  'permission denied for table security_audit_events',
  'authenticated clients cannot write audit events'
);
select throws_ok(
  $$select public.broker_get_authorization('cross_user_probe')$$,
  '42501',
  'permission denied for function broker_get_authorization',
  'authenticated users cannot invoke privileged broker RPCs'
);

select * from finish();
rollback;
