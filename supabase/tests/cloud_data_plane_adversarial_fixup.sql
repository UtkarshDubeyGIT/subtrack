begin;
set local role postgres;
set local search_path = extensions, public, pg_catalog;

select plan(24);

select has_function(
  'private',
  'contains_payment_card_number',
  array['text'],
  'payment-card screening remains a database invariant'
);

select is(private.contains_payment_card_number('4111111111111111'), true, 'contiguous PAN is detected');
select is(private.contains_payment_card_number('4111 1111 1111 1111'), true, 'ASCII-spaced PAN is detected');
select is(private.contains_payment_card_number('4111-1111-1111-1111'), true, 'hyphenated PAN is detected');
select is(private.contains_payment_card_number('4111.1111.1111.1111'), true, 'dotted PAN is detected');
select is(private.contains_payment_card_number(U&'4111\00A01111\00A01111\00A01111'), true, 'Unicode-spaced PAN is detected');
select is(private.contains_payment_card_number('Visa •••• 4242'), false, 'masked last four is not a PAN');
select is(private.contains_payment_card_number('490154203237518'), false, 'Luhn-valid IMEI is not a PAN');
select is(private.contains_payment_card_number('1234567890123452'), false, 'unrelated Luhn-valid numeric identifier is not a PAN');

insert into public.subscriptions(
  owner_user_id, id, kind, service_name, amount_minor, currency_code, timezone,
  lifecycle_status, lifecycle_since, purchased_on
) values (
  'user_acceptance', 'sub_acceptance', 'one_time', 'Acceptance', 100, 'USD', 'UTC',
  'active', '2026-01-01', '2026-01-01'
);

select throws_ok(
  $$insert into public.subscriptions(owner_user_id, id, kind, service_name, amount_minor, currency_code, timezone, lifecycle_status, lifecycle_since, purchased_on, payment_label) values ('user_acceptance', 'sub_pan_dot', 'one_time', 'Dotted PAN', 100, 'USD', 'UTC', 'active', '2026-01-01', '2026-01-01', '4111.1111.1111.1111')$$,
  '23514', null,
  'subscription constraint rejects dotted PANs'
);
select throws_ok(
  $$insert into public.subscriptions(owner_user_id, id, kind, service_name, amount_minor, currency_code, timezone, lifecycle_status, lifecycle_since, purchased_on, notes) values ('user_acceptance', 'sub_pan_unicode', 'one_time', 'Unicode PAN', 100, 'USD', 'UTC', 'active', '2026-01-01', '2026-01-01', U&'4111\00A01111\00A01111\00A01111')$$,
  '23514', null,
  'subscription constraint rejects Unicode-spaced PANs'
);
select lives_ok(
  $$insert into public.subscriptions(owner_user_id, id, kind, service_name, amount_minor, currency_code, timezone, lifecycle_status, lifecycle_since, purchased_on, notes) values ('user_acceptance', 'sub_imei', 'one_time', 'IMEI', 100, 'USD', 'UTC', 'active', '2026-01-01', '2026-01-01', '490154203237518')$$,
  'subscription constraint allows a Luhn-valid IMEI'
);
select lives_ok(
  $$insert into public.subscriptions(owner_user_id, id, kind, service_name, amount_minor, currency_code, timezone, lifecycle_status, lifecycle_since, purchased_on, notes) values ('user_acceptance', 'sub_numeric_identifier', 'one_time', 'Numeric identifier', 100, 'USD', 'UTC', 'active', '2026-01-01', '2026-01-01', '1234567890123452')$$,
  'subscription constraint allows an unrelated Luhn-valid numeric identifier'
);

insert into private.clerk_identity_authority(singleton, issuer)
values (true, 'https://fixture.clerk.accounts.dev')
on conflict (singleton) do update set issuer = excluded.issuer;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"user_acceptance","iss":"https://fixture.clerk.accounts.dev","exp":4102444800}',
  true
);
set local role authenticated;

select results_eq(
  $$
    select array_agg(attribute.attname order by attribute.attname)
    from pg_catalog.pg_attribute attribute
    where attribute.attrelid = 'public.renewal_events'::regclass
      and attribute.attnum > 0
      and not attribute.attisdropped
      and pg_catalog.has_column_privilege(
        'authenticated', attribute.attrelid, attribute.attnum, 'INSERT'
      )
  $$,
  $$values (array[
    'amount_minor', 'currency_code', 'idempotency_key', 'occurrence_date',
    'subscription_id'
  ]::name[])$$,
  'authenticated renewal INSERT is limited to the expected-event representation'
);
select is(
  pg_catalog.has_table_privilege(
    'authenticated', 'public.renewal_events', 'DELETE'
  ),
  false,
  'authenticated renewal DELETE privilege is revoked'
);

select lives_ok(
  $$insert into public.renewal_events(idempotency_key, subscription_id, occurrence_date, amount_minor, currency_code) values
    ('renewal_acceptance_expected', 'sub_acceptance', '2026-02-01', 100, 'USD'),
    ('renewal_acceptance_confirm', 'sub_acceptance', '2026-03-01', 100, 'USD'),
    ('renewal_acceptance_skip', 'sub_acceptance', '2026-04-01', 100, 'USD'),
    ('renewal_acceptance_correct', 'sub_acceptance', '2026-05-01', 100, 'USD'),
    ('renewal_acceptance_delete', 'sub_acceptance', '2026-06-01', 100, 'USD')$$,
  'authenticated clients create canonical expected renewals without state fields'
);
select results_eq(
  $$select state from public.renewal_events where idempotency_key = 'renewal_acceptance_expected'$$,
  array['expected'::text],
  'authenticated renewal creation defaults to expected state'
);
select results_eq(
  $$with changed as (update public.renewal_events set state = 'confirmed', confirmed_on = '2026-03-02' where idempotency_key = 'renewal_acceptance_confirm' returning state) select state from changed$$,
  array['confirmed'::text],
  'fixed expected-to-confirmed transition remains available'
);
select results_eq(
  $$with changed as (update public.renewal_events set state = 'skipped', skipped_on = '2026-04-02' where idempotency_key = 'renewal_acceptance_skip' returning state) select state from changed$$,
  array['skipped'::text],
  'fixed expected-to-skipped transition remains available'
);
select results_eq(
  $$with changed as (update public.renewal_events set state = 'corrected', occurrence_date = '2026-05-02', amount_minor = 90, currency_code = 'EUR', corrected_on = '2026-05-02', original_occurrence_date = '2026-05-01', original_amount_minor = 100, original_currency_code = 'USD' where idempotency_key = 'renewal_acceptance_correct' returning state) select state from changed$$,
  array['corrected'::text],
  'fixed expected-to-corrected transition remains available'
);
select throws_ok(
  $$insert into public.renewal_events(idempotency_key, subscription_id, occurrence_date, amount_minor, currency_code, state, confirmed_on) values ('renewal_acceptance_terminal_confirmed', 'sub_acceptance', '2026-07-01', 100, 'USD', 'confirmed', '2026-07-02')$$,
  '42501', null,
  'authenticated clients cannot insert confirmed history'
);
select throws_ok(
  $$insert into public.renewal_events(idempotency_key, subscription_id, occurrence_date, amount_minor, currency_code, state, corrected_on, original_occurrence_date, original_amount_minor, original_currency_code) values ('renewal_acceptance_terminal_corrected', 'sub_acceptance', '2026-08-02', 90, 'EUR', 'corrected', '2026-08-02', '2026-08-01', 100, 'USD')$$,
  '42501', null,
  'authenticated clients cannot insert corrected history'
);
select throws_ok(
  $$insert into public.renewal_events(idempotency_key, subscription_id, occurrence_date, amount_minor, currency_code, state, skipped_on) values ('renewal_acceptance_terminal_skipped', 'sub_acceptance', '2026-09-01', 100, 'USD', 'skipped', '2026-09-02')$$,
  '42501', null,
  'authenticated clients cannot insert skipped history'
);
select throws_ok(
  $$delete from public.renewal_events where idempotency_key = 'renewal_acceptance_delete'$$,
  '42501', null,
  'authenticated clients cannot delete their own renewal history'
);

select * from finish();
rollback;
