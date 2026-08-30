begin;
set local role postgres;
set local search_path = extensions, public, pg_catalog;

select plan(41);

select has_table(
  'private',
  'clerk_identity_authority',
  'Clerk issuer authority is stored outside exposed schemas'
);

do $$
begin
  if to_regclass('private.clerk_identity_authority') is not null then
    execute $insert$
      insert into private.clerk_identity_authority(singleton, issuer)
      values (true, 'https://fixture.clerk.accounts.dev')
      on conflict (singleton) do update set issuer = excluded.issuer
    $insert$;
  end if;
end;
$$;

select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"user_fixture_a","iss":"https://not-clerk.example","exp":4102444800}',
  true
);
select is(
  private.current_clerk_subject(),
  null,
  'a verified authenticated token from a non-Clerk issuer is denied'
);

select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"user_fixture_a","iss":"https://fixture.clerk.accounts.dev","exp":4102444800}',
  true
);
select is(
  private.current_clerk_subject(),
  'user_fixture_a',
  'the exact configured Clerk issuer is accepted'
);

select has_column(
  'public',
  'renewal_events',
  'original_currency_code',
  'corrected renewal snapshots persist their original currency'
);

select throws_ok(
  $$
    insert into public.subscriptions(
      owner_user_id, id, kind, service_name, amount_minor, currency_code,
      timezone, lifecycle_status, lifecycle_since, purchased_on
    ) values (
      'user_fixture_a', 'sub_unsafe_money', 'one_time', 'Unsafe', 9007199254740992,
      'USD', 'UTC', 'active', '2026-01-01', '2026-01-01'
    )
  $$,
  '23514',
  null,
  'subscription minor units stay within the JavaScript safe-integer range'
);

select throws_ok(
  $$
    insert into public.subscriptions(
      owner_user_id, id, kind, service_name, amount_minor, currency_code,
      timezone, lifecycle_status, lifecycle_since, purchased_on
    ) values (
      'user_fixture_a', 'sub_trial_null', 'one_time', 'Trial Null', 1,
      'USD', 'UTC', 'trial', '2026-01-01', '2026-01-01'
    )
  $$,
  '23514',
  null,
  'trial lifecycle requires a trial end date'
);

select throws_ok(
  $$
    insert into public.subscriptions(
      owner_user_id, id, kind, service_name, amount_minor, currency_code,
      timezone, lifecycle_status, lifecycle_since, purchased_on
    ) values (
      'user_fixture_a', 'sub_cancel_null', 'one_time', 'Cancel Null', 1,
      'USD', 'UTC', 'canceled', '2026-01-01', '2026-01-01'
    )
  $$,
  '23514',
  null,
  'canceled lifecycle requires an access end date'
);

select throws_ok(
  $$
    insert into public.subscriptions(
      owner_user_id, id, kind, service_name, amount_minor, currency_code,
      timezone, lifecycle_status, lifecycle_since, trial_ends_on, purchased_on
    ) values (
      'user_fixture_a', 'sub_active_trial', 'one_time', 'Active Trial', 1,
      'USD', 'UTC', 'active', '2026-01-01', '2026-02-01', '2026-01-01'
    )
  $$,
  '23514',
  null,
  'non-trial lifecycle rejects trial-only fields'
);

select throws_ok(
  $$
    insert into public.subscriptions(
      owner_user_id, id, kind, service_name, amount_minor, currency_code,
      timezone, lifecycle_status, lifecycle_since, next_renewal_date,
      recurrence_unit, recurrence_interval
    ) values (
      'user_fixture_a', 'sub_recurring_null', 'recurring', 'Recurring Null', 1,
      'USD', 'UTC', 'active', '2026-01-01', '2026-02-01', 'month', 1
    )
  $$,
  '23514',
  null,
  'recurring subscriptions require every recurring discriminant'
);

select throws_ok(
  $$
    insert into public.subscriptions(
      owner_user_id, id, kind, service_name, amount_minor, currency_code,
      timezone, lifecycle_status, lifecycle_since, start_date, purchased_on,
      next_renewal_date, recurrence_unit, recurrence_interval
    ) values (
      'user_fixture_a', 'sub_recurring_mixed', 'recurring', 'Recurring Mixed', 1,
      'USD', 'UTC', 'active', '2026-01-01', '2026-01-01', '2026-01-01',
      '2026-02-01', 'month', 1
    )
  $$,
  '23514',
  null,
  'recurring subscriptions reject one-time discriminants'
);

select throws_ok(
  $$
    insert into public.subscriptions(
      owner_user_id, id, kind, service_name, amount_minor, currency_code,
      timezone, lifecycle_status, lifecycle_since, purchased_on, recurrence_unit
    ) values (
      'user_fixture_a', 'sub_one_time_mixed', 'one_time', 'Mixed', 1,
      'USD', 'UTC', 'active', '2026-01-01', '2026-01-01', 'month'
    )
  $$,
  '23514',
  null,
  'one-time subscriptions reject recurring discriminants'
);

insert into public.subscriptions(
  owner_user_id, id, kind, service_name, amount_minor, currency_code, timezone,
  lifecycle_status, lifecycle_since, start_date, next_renewal_date,
  recurrence_unit, recurrence_interval
) values
  (
    'user_fixture_a', 'sub_integrity_a', 'recurring', 'Integrity A', 100, 'USD', 'UTC',
    'active', '2026-01-01', '2026-01-01', '2026-02-01', 'month', 1
  ),
  (
    'user_fixture_b', 'sub_integrity_b', 'recurring', 'Integrity B', 100, 'USD', 'UTC',
    'active', '2026-01-01', '2026-01-01', '2026-02-01', 'month', 1
  ),
  (
    'user_fixture_a', 'sub_integrity_leads', 'recurring', 'Integrity Leads', 100, 'USD', 'UTC',
    'active', '2026-01-01', '2026-01-01', '2026-02-01', 'month', 1
  ),
  (
    'user_fixture_a', 'sub_integrity_channels', 'recurring', 'Integrity Channels', 100, 'USD', 'UTC',
    'active', '2026-01-01', '2026-01-01', '2026-02-01', 'month', 1
  );

select throws_ok(
  $$
    insert into public.renewal_events(
      owner_user_id, idempotency_key, subscription_id, occurrence_date,
      amount_minor, currency_code, state
    ) values (
      'user_fixture_a', 'confirmed_null', 'sub_integrity_a', '2026-02-01',
      100, 'USD', 'confirmed'
    )
  $$,
  '23514',
  null,
  'confirmed renewal requires confirmed_on'
);

select throws_ok(
  $$
    insert into public.renewal_events(
      owner_user_id, idempotency_key, subscription_id, occurrence_date,
      amount_minor, currency_code, state, confirmed_on
    ) values (
      'user_fixture_a', 'expected_with_confirmation', 'sub_integrity_a', '2026-02-01',
      100, 'USD', 'expected', '2026-02-02'
    )
  $$,
  '23514',
  null,
  'expected renewal rejects terminal-state fields'
);

select throws_ok(
  $$
    insert into public.renewal_events(
      owner_user_id, idempotency_key, subscription_id, occurrence_date,
      amount_minor, currency_code, state, confirmed_on, corrected_on
    ) values (
      'user_fixture_a', 'confirmed_with_correction', 'sub_integrity_a', '2026-02-01',
      100, 'USD', 'confirmed', '2026-02-02', '2026-02-02'
    )
  $$,
  '23514',
  null,
  'confirmed renewal rejects corrected-state fields'
);

select throws_ok(
  $$
    insert into public.renewal_events(
      owner_user_id, idempotency_key, subscription_id, occurrence_date,
      amount_minor, currency_code, state, corrected_on,
      original_occurrence_date, original_amount_minor, original_currency_code
    ) values (
      'user_fixture_a', 'corrected_currency_null', 'sub_integrity_a', '2026-02-01',
      90, 'EUR', 'corrected', '2026-02-02', '2026-02-01', 100, null
    )
  $$,
  '23514',
  null,
  'corrected renewal requires a complete original money snapshot'
);

select throws_ok(
  $$
    insert into public.renewal_events(
      owner_user_id, idempotency_key, subscription_id, occurrence_date,
      amount_minor, currency_code, state, corrected_on,
      original_occurrence_date, original_currency_code
    ) values (
      'user_fixture_a', 'corrected_amount_null', 'sub_integrity_a', '2026-02-01',
      90, 'EUR', 'corrected', '2026-02-02', '2026-02-01', 'USD'
    )
  $$,
  '23514',
  null,
  'corrected renewal requires the original minor-unit amount'
);

select throws_ok(
  $$
    insert into public.renewal_events(
      owner_user_id, idempotency_key, subscription_id, occurrence_date,
      amount_minor, currency_code, state
    ) values (
      'user_fixture_a', 'skipped_null', 'sub_integrity_a', '2026-02-01',
      100, 'USD', 'skipped'
    )
  $$,
  '23514',
  null,
  'skipped renewal requires skipped_on'
);

select throws_ok(
  $$
    insert into public.renewal_events(
      owner_user_id, idempotency_key, subscription_id, occurrence_date,
      amount_minor, currency_code, state, skipped_on, confirmed_on
    ) values (
      'user_fixture_a', 'skipped_with_confirmation', 'sub_integrity_a', '2026-02-01',
      100, 'USD', 'skipped', '2026-02-02', '2026-02-02'
    )
  $$,
  '23514',
  null,
  'skipped renewal rejects other terminal-state fields'
);

select throws_ok(
  $$
    insert into public.renewal_events(
      owner_user_id, idempotency_key, subscription_id, occurrence_date,
      amount_minor, currency_code, state
    ) values (
      'user_fixture_a', 'unsafe_renewal', 'sub_integrity_a', '2026-02-01',
      9007199254740992, 'USD', 'expected'
    )
  $$,
  '23514',
  null,
  'renewal minor units stay within the JavaScript safe-integer range'
);

select throws_ok(
  $$
    insert into public.user_preferences(owner_user_id, reminder_lead_days)
    values ('user_null_pref_array', array[7, null]::smallint[])
  $$,
  '23514',
  null,
  'preference reminder arrays reject null elements'
);

select throws_ok(
  $$
    insert into public.reminder_overrides(owner_user_id, subscription_id, lead_days, channels)
    values (
      'user_fixture_a', 'sub_integrity_leads', array[7, null]::smallint[], array['in_app']
    )
  $$,
  '23514',
  null,
  'override lead-day arrays reject null elements'
);

select throws_ok(
  $$
    insert into public.reminder_overrides(owner_user_id, subscription_id, lead_days, channels)
    values (
      'user_fixture_a', 'sub_integrity_channels', array[7]::smallint[], array['in_app', null]::text[]
    )
  $$,
  '23514',
  null,
  'override channel arrays reject null elements'
);

select throws_ok(
  $$
    insert into public.reminder_deliveries(
      owner_user_id, idempotency_key, subscription_id, occurrence_date,
      channel, state, scheduled_for
    ) values (
      'user_fixture_a', 'delivered_null', 'sub_integrity_a', '2026-02-01',
      'email', 'delivered', statement_timestamp()
    )
  $$,
  '23514',
  null,
  'delivered reminders require delivered_at'
);

select throws_ok(
  $$
    insert into public.reminder_deliveries(
      owner_user_id, idempotency_key, subscription_id, occurrence_date,
      channel, state, scheduled_for, error_code
    ) values (
      'user_fixture_a', 'pending_error', 'sub_integrity_a', '2026-02-01',
      'email', 'pending', statement_timestamp(), 'UNEXPECTED'
    )
  $$,
  '23514',
  null,
  'pending reminders reject terminal-state fields'
);

select throws_ok(
  $$
    insert into public.reminder_deliveries(
      owner_user_id, idempotency_key, subscription_id, occurrence_date,
      channel, state, scheduled_for, delivered_at, error_code
    ) values (
      'user_fixture_a', 'delivered_error', 'sub_integrity_a', '2026-02-01',
      'email', 'delivered', statement_timestamp(), statement_timestamp(), 'UNEXPECTED'
    )
  $$,
  '23514',
  null,
  'delivered reminders reject failure fields'
);

select throws_ok(
  $$
    insert into public.reminder_deliveries(
      owner_user_id, idempotency_key, subscription_id, occurrence_date,
      channel, state, scheduled_for
    ) values (
      'user_fixture_a', 'failed_null', 'sub_integrity_a', '2026-02-01',
      'email', 'failed', statement_timestamp()
    )
  $$,
  '23514',
  null,
  'failed reminders require an error code'
);

select throws_ok(
  $$
    insert into public.reminder_deliveries(
      owner_user_id, idempotency_key, subscription_id, occurrence_date,
      channel, state, scheduled_for, delivered_at, error_code
    ) values (
      'user_fixture_a', 'failed_delivered', 'sub_integrity_a', '2026-02-01',
      'email', 'failed', statement_timestamp(), statement_timestamp(), 'FAILED'
    )
  $$,
  '23514',
  null,
  'failed reminders reject delivery fields'
);

select is_empty(
  $$
    select p.tablename, p.cmd
    from pg_catalog.pg_policies p
    where p.schemaname = 'public'
      and p.tablename in ('reminder_deliveries', 'security_audit_events')
      and p.cmd in ('INSERT', 'UPDATE', 'DELETE')
      and (
        (p.cmd = 'INSERT' and regexp_replace(coalesce(p.with_check, ''), '[()]', '', 'g') <> 'false')
        or (
          p.cmd = 'UPDATE'
          and (
            regexp_replace(coalesce(p.qual, ''), '[()]', '', 'g') <> 'false'
            or regexp_replace(coalesce(p.with_check, ''), '[()]', '', 'g') <> 'false'
          )
        )
        or (p.cmd = 'DELETE' and regexp_replace(coalesce(p.qual, ''), '[()]', '', 'g') <> 'false')
      )
  $$,
  'server-written table mutation policies are explicit denial'
);

select is_empty(
  $$
    with exposed as (
      select c.relname as table_name
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
    ), operations(command) as (
      values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')
    )
    select exposed.table_name, operations.command
    from exposed cross join operations
    left join pg_catalog.pg_class c on c.relname = exposed.table_name
    left join pg_catalog.pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    left join pg_catalog.pg_policies p
      on p.schemaname = 'public'
      and p.tablename = exposed.table_name
      and p.cmd = operations.command
    where not c.relrowsecurity or not c.relforcerowsecurity or p.policyname is null
  $$,
  'catalog-derived coverage requires forced RLS and CRUD policies on every exposed table'
);

insert into public.user_preferences(owner_user_id, timezone, home_currency)
values ('user_fixture_a', 'UTC', 'USD'), ('user_fixture_b', 'UTC', 'USD');
insert into public.renewal_events(
  owner_user_id, idempotency_key, subscription_id, occurrence_date,
  amount_minor, currency_code, state
) values
  ('user_fixture_a', 'renewal_integrity_a', 'sub_integrity_a', '2026-02-01', 100, 'USD', 'expected'),
  ('user_fixture_b', 'renewal_integrity_b', 'sub_integrity_b', '2026-02-01', 100, 'USD', 'expected');
insert into public.reminder_overrides(owner_user_id, subscription_id, lead_days, channels)
values
  ('user_fixture_a', 'sub_integrity_a', array[7]::smallint[], array['in_app']),
  ('user_fixture_b', 'sub_integrity_b', array[7]::smallint[], array['in_app']);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"user_fixture_a","iss":"https://fixture.clerk.accounts.dev","exp":4102444800}',
  true
);

select results_eq(
  $$select owner_user_id from public.user_preferences$$,
  array['user_fixture_a'::text],
  'preference SELECT is owner-isolated'
);
select results_eq(
  $$with changed as (update public.user_preferences set locale = 'fr' where owner_user_id = 'user_fixture_b' returning 1) select count(*)::bigint from changed$$,
  array[0::bigint],
  'preference UPDATE is owner-isolated'
);
select results_eq(
  $$with removed as (delete from public.user_preferences where owner_user_id = 'user_fixture_b' returning 1) select count(*)::bigint from removed$$,
  array[0::bigint],
  'preference DELETE is owner-isolated'
);
delete from public.user_preferences where owner_user_id = 'user_fixture_a';
select lives_ok(
  $$insert into public.user_preferences(timezone, home_currency) values ('Asia/Kolkata', 'INR')$$,
  'preference INSERT derives the current owner'
);

select results_eq(
  $$select idempotency_key from public.renewal_events$$,
  array['renewal_integrity_a'::text],
  'renewal SELECT is owner-isolated'
);
select results_eq(
  $$with changed as (update public.renewal_events set amount_minor = 200 where idempotency_key = 'renewal_integrity_b' returning 1) select count(*)::bigint from changed$$,
  array[0::bigint],
  'renewal UPDATE is owner-isolated'
);
select throws_ok(
  $$delete from public.renewal_events where idempotency_key = 'renewal_integrity_a'$$,
  '42501', null,
  'renewal DELETE is denied for the owner'
);
select lives_ok(
  $$
    insert into public.renewal_events(
      idempotency_key, subscription_id, occurrence_date, amount_minor, currency_code
    ) values ('renewal_integrity_insert', 'sub_integrity_a', '2026-03-01', 100, 'USD')
  $$,
  'renewal INSERT derives the current owner'
);

select results_eq(
  $$select subscription_id from public.reminder_overrides$$,
  array['sub_integrity_a'::text],
  'override SELECT is owner-isolated'
);
select results_eq(
  $$with changed as (update public.reminder_overrides set lead_days = array[1]::smallint[] where subscription_id = 'sub_integrity_b' returning 1) select count(*)::bigint from changed$$,
  array[0::bigint],
  'override UPDATE is owner-isolated'
);
select results_eq(
  $$with removed as (delete from public.reminder_overrides where subscription_id = 'sub_integrity_b' returning 1) select count(*)::bigint from removed$$,
  array[0::bigint],
  'override DELETE is owner-isolated'
);
delete from public.reminder_overrides where subscription_id = 'sub_integrity_a';
select lives_ok(
  $$insert into public.reminder_overrides(subscription_id, lead_days, channels) values ('sub_integrity_a', array[3]::smallint[], array['email'])$$,
  'override INSERT derives the current owner'
);

select * from finish();
rollback;
