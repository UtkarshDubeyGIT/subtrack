begin;
set local role postgres;
set local search_path = extensions, public, pg_catalog;

select plan(13);

delete from private.clerk_identity_authority;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"user_runtime_a","iss":"https://fixture.clerk.accounts.dev","exp":4102444800}',
  true
);
select is(
  private.current_clerk_subject(),
  null,
  'empty issuer authority fails closed'
);
insert into private.clerk_identity_authority(singleton, issuer)
values (true, 'https://fixture.clerk.accounts.dev');

select throws_ok(
  $$
    insert into public.subscriptions(
      owner_user_id, id, kind, service_name, amount_minor, currency_code, timezone,
      lifecycle_status, lifecycle_since, start_date, next_renewal_date,
      recurrence_unit, recurrence_interval
    ) values (
      'user_runtime_a', 'sub_null_unit', 'recurring', 'Null Unit', 100, 'USD', 'UTC',
      'active', '2026-01-01', '2026-01-01', '2026-02-01', null, 1
    )
  $$,
  '23514',
  null,
  'recurring unit is explicitly non-null'
);
select throws_ok(
  $$
    insert into public.subscriptions(
      owner_user_id, id, kind, service_name, amount_minor, currency_code, timezone,
      lifecycle_status, lifecycle_since, start_date, next_renewal_date,
      recurrence_unit, recurrence_interval
    ) values (
      'user_runtime_a', 'sub_null_interval', 'recurring', 'Null Interval', 100, 'USD', 'UTC',
      'active', '2026-01-01', '2026-01-01', '2026-02-01', 'month', null
    )
  $$,
  '23514',
  null,
  'recurring interval is explicitly non-null'
);

insert into public.subscriptions(
  owner_user_id, id, kind, service_name, amount_minor, currency_code, timezone,
  lifecycle_status, lifecycle_since, start_date, next_renewal_date,
  recurrence_unit, recurrence_interval
) values
  ('user_runtime_a', 'sub_runtime_a', 'recurring', 'Runtime A', 100, 'EUR', 'UTC', 'active', '2026-01-01', '2026-01-01', '2026-02-01', 'month', 1),
  ('user_runtime_b', 'sub_runtime_b', 'recurring', 'Runtime B', 100, 'USD', 'UTC', 'active', '2026-01-01', '2026-01-01', '2026-02-01', 'month', 1);

insert into public.renewal_events(
  owner_user_id, idempotency_key, subscription_id, occurrence_date, amount_minor,
  currency_code, state, corrected_on, original_occurrence_date,
  original_amount_minor, original_currency_code
) values (
  'user_runtime_a', 'renewal_runtime_a', 'sub_runtime_a', '2026-02-01', 90,
  'EUR', 'corrected', '2026-02-02', '2026-02-01', 100, 'USD'
);
insert into public.renewal_events(
  owner_user_id, idempotency_key, subscription_id, occurrence_date, amount_minor,
  currency_code, state
) values (
  'user_runtime_a', 'renewal_runtime_expected', 'sub_runtime_a', '2026-03-01',
  100, 'EUR', 'expected'
);
select results_eq(
  $$select currency_code || ':' || amount_minor || '|' || original_currency_code || ':' || original_amount_minor from public.renewal_events where idempotency_key = 'renewal_runtime_a'$$,
  array['EUR:90|USD:100'::text],
  'corrected renewal preserves current EUR and original USD exactly'
);
select throws_ok(
  $$update public.renewal_events set original_amount_minor = 9007199254740992 where idempotency_key = 'renewal_runtime_a'$$,
  '23514',
  null,
  'unsafe original amount is denied'
);

select has_function(
  'private',
  'assert_corrected_renewal_currency_ready',
  array[]::text[],
  'legacy corrected-row preflight exists'
);
alter table public.renewal_events drop constraint renewal_events_state_dates_valid;
insert into public.renewal_events(
  owner_user_id, idempotency_key, subscription_id, occurrence_date, amount_minor,
  currency_code, state, corrected_on, original_occurrence_date, original_amount_minor
) values (
  'user_runtime_a', 'renewal_legacy', 'sub_runtime_a', '2026-03-01', 80,
  'EUR', 'corrected', '2026-03-02', '2026-03-01', 100
);
select throws_ok(
  $$select private.assert_corrected_renewal_currency_ready()$$,
  '23514',
  'legacy corrected renewals require original_currency_code backfill before migration',
  'legacy corrected rows fail with an actionable migration error'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"user_runtime_a","iss":"https://fixture.clerk.accounts.dev","exp":4102444800}',
  true
);
select lives_ok(
  $$update public.subscriptions set service_name = 'Patched' where id = 'sub_runtime_a'$$,
  'authenticated subscription PATCH columns pass real grants'
);
select lives_ok(
  $$update public.renewal_events set state = 'confirmed', confirmed_on = '2026-03-02' where idempotency_key = 'renewal_runtime_expected'$$,
  'authenticated fixed renewal transition columns pass real grants'
);
select throws_ok(
  $$update public.subscriptions set id = 'forbidden' where id = 'sub_runtime_a'$$,
  '42501',
  null,
  'authenticated subscription PATCH cannot include immutable id'
);
select throws_ok(
  $$update public.renewal_events set subscription_id = 'sub_runtime_b' where idempotency_key = 'renewal_runtime_a'$$,
  '42501',
  null,
  'authenticated renewal PATCH cannot include immutable identifiers'
);
select throws_ok(
  $$insert into public.reminder_overrides(subscription_id, lead_days, channels) values ('sub_runtime_b', array[7]::smallint[], array['email'])$$,
  '23503',
  null,
  'cross-user reminder override insertion is denied'
);
set local role postgres;
select is(
  to_regclass('private.data_plane_behavioral_test_registry'),
  null::regclass,
  'production database carries no self-asserted behavioral coverage registry'
);

select * from finish();
rollback;
