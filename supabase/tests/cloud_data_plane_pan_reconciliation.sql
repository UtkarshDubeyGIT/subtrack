begin;
set local role postgres;
set local search_path = extensions, public, pg_catalog;

select plan(10);

select ok(
  exists (
    select 1
    from supabase_migrations.schema_migrations
    where name = 'pan_constraint_upgrade_reconciliation'
      and version > '20260805175233'
  ),
  'PAN constraint upgrade reconciliation is recorded after the helper upgrade'
);

select is(
  (
    select count(*)
    from pg_catalog.pg_constraint constraint_definition
    where constraint_definition.conrelid = 'public.subscriptions'::regclass
      and constraint_definition.conname in (
        'subscriptions_notes_pan_free',
        'subscriptions_payment_label_pan_free'
      )
      and constraint_definition.convalidated
  ),
  2::bigint,
  'both rebuilt PAN constraints are validated'
);

select ok(
  pg_catalog.strpos(
    (
      select pg_catalog.pg_get_constraintdef(constraint_definition.oid)
      from pg_catalog.pg_constraint constraint_definition
      where constraint_definition.conrelid = 'public.subscriptions'::regclass
        and constraint_definition.conname = 'subscriptions_payment_label_pan_free'
    ),
    'private.contains_payment_card_number(payment_label)'
  ) > 0,
  'payment-label constraint uses the current PAN helper'
);

select ok(
  pg_catalog.strpos(
    (
      select pg_catalog.pg_get_constraintdef(constraint_definition.oid)
      from pg_catalog.pg_constraint constraint_definition
      where constraint_definition.conrelid = 'public.subscriptions'::regclass
        and constraint_definition.conname = 'subscriptions_notes_pan_free'
    ),
    'private.contains_payment_card_number(notes)'
  ) > 0,
  'notes constraint uses the current PAN helper'
);

select is(
  (
    select count(*)
    from public.subscriptions
    where (payment_label is not null and private.contains_payment_card_number(payment_label))
      or (notes is not null and private.contains_payment_card_number(notes))
  ),
  0::bigint,
  'no persisted subscription field violates the current PAN helper'
);

select lives_ok(
  $$
    insert into public.subscriptions(
      owner_user_id, id, kind, service_name, amount_minor, currency_code,
      timezone, lifecycle_status, lifecycle_since, purchased_on,
      payment_label, notes
    ) values (
      'user_pan_reconciliation_test', 'sub_pan_reconciliation_safe',
      'one_time', 'Safe metadata', 100, 'USD', 'UTC', 'active',
      '2026-01-01', '2026-01-01', 'Visa •••• 4242', 'Invoice 12345'
    )
  $$,
  'safe payment metadata remains accepted'
);

select throws_ok(
  $$
    insert into public.subscriptions(
      owner_user_id, id, kind, service_name, amount_minor, currency_code,
      timezone, lifecycle_status, lifecycle_since, purchased_on, payment_label
    ) values (
      'user_pan_reconciliation_test', 'sub_pan_reconciliation_dot',
      'one_time', 'Dotted PAN', 100, 'USD', 'UTC', 'active',
      '2026-01-01', '2026-01-01', '4111.1111.1111.1111'
    )
  $$,
  '23514', null,
  'rebuilt payment-label constraint rejects dotted PAN writes'
);

select throws_ok(
  $$
    insert into public.subscriptions(
      owner_user_id, id, kind, service_name, amount_minor, currency_code,
      timezone, lifecycle_status, lifecycle_since, purchased_on, notes
    ) values (
      'user_pan_reconciliation_test', 'sub_pan_reconciliation_nbsp',
      'one_time', 'Unicode-space PAN', 100, 'USD', 'UTC', 'active',
      '2026-01-01', '2026-01-01', U&'4111\00A01111\00A01111\00A01111'
    )
  $$,
  '23514', null,
  'rebuilt notes constraint rejects Unicode-space PAN writes'
);

select throws_ok(
  $$
    update public.subscriptions
    set payment_label = '4111.1111.1111.1111'
    where owner_user_id = 'user_pan_reconciliation_test'
      and id = 'sub_pan_reconciliation_safe'
  $$,
  '23514', null,
  'rebuilt payment-label constraint rejects dotted PAN updates'
);

select throws_ok(
  $$
    update public.subscriptions
    set notes = U&'4111\00A01111\00A01111\00A01111'
    where owner_user_id = 'user_pan_reconciliation_test'
      and id = 'sub_pan_reconciliation_safe'
  $$,
  '23514', null,
  'rebuilt notes constraint rejects Unicode-space PAN updates'
);

select * from finish();
rollback;
