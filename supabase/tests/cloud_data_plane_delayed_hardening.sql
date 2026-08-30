begin;
set local role postgres;
set local search_path = extensions, public, pg_catalog;

select plan(25);

select has_function(
  'private',
  'contains_payment_card_number',
  array['text'],
  'payment-card screening is a database invariant'
);

insert into public.subscriptions(
  owner_user_id, id, kind, service_name, amount_minor, currency_code, timezone,
  lifecycle_status, lifecycle_since, purchased_on
) values (
  'user_hardening', 'sub_hardening', 'one_time', 'Hardening', 100, 'USD', 'UTC',
  'active', '2026-01-01', '2026-01-01'
);

select throws_ok(
  $$insert into public.reminder_deliveries(owner_user_id, idempotency_key, subscription_id, occurrence_date, channel, state, scheduled_for) values ('user_hardening', '', 'sub_hardening', '2026-02-01', 'email', 'pending', statement_timestamp())$$,
  '23514', null,
  'delivery idempotency keys cannot be empty'
);
select throws_ok(
  $$insert into public.reminder_deliveries(owner_user_id, idempotency_key, subscription_id, occurrence_date, channel, state, scheduled_for) values ('user_hardening', repeat('x', 257), 'sub_hardening', '2026-02-01', 'email', 'pending', statement_timestamp())$$,
  '23514', null,
  'delivery idempotency keys cannot exceed 256 characters'
);
select throws_ok(
  $$insert into public.security_audit_events(owner_user_id, event_type) values ('', 'export_requested')$$,
  '23514', null,
  'audit owners cannot be empty'
);
select throws_ok(
  $$insert into public.security_audit_events(owner_user_id, event_type) values (' padded-owner ', 'export_requested')$$,
  '23514', null,
  'audit owners must be trimmed'
);
select throws_ok(
  $$insert into public.security_audit_events(owner_user_id, event_type) values (repeat('o', 513), 'export_requested')$$,
  '23514', null,
  'audit owners cannot exceed 512 characters'
);

select throws_ok(
  $$insert into public.subscriptions(owner_user_id, id, kind, service_name, amount_minor, currency_code, timezone, lifecycle_status, lifecycle_since, purchased_on, management_url) values ('user_hardening', 'sub_url_credentials', 'one_time', 'URL credentials', 100, 'USD', 'UTC', 'active', '2026-01-01', '2026-01-01', 'https://username:password@example.test/manage')$$,
  '23514', null,
  'management URLs cannot contain username or password credentials'
);
select throws_ok(
  $$insert into public.subscriptions(owner_user_id, id, kind, service_name, amount_minor, currency_code, timezone, lifecycle_status, lifecycle_since, purchased_on, payment_label) values ('user_hardening', 'sub_pan_label', 'one_time', 'PAN label', 100, 'USD', 'UTC', 'active', '2026-01-01', '2026-01-01', 'Card 4111111111111111')$$,
  '23514', null,
  'payment labels reject a Luhn-valid full PAN'
);
select throws_ok(
  $$insert into public.subscriptions(owner_user_id, id, kind, service_name, amount_minor, currency_code, timezone, lifecycle_status, lifecycle_since, purchased_on, notes) values ('user_hardening', 'sub_pan_notes', 'one_time', 'PAN notes', 100, 'USD', 'UTC', 'active', '2026-01-01', '2026-01-01', 'Do not persist 4111111111111111 here')$$,
  '23514', null,
  'free-form notes reject a Luhn-valid full PAN'
);
select lives_ok(
  $$insert into public.subscriptions(owner_user_id, id, kind, service_name, amount_minor, currency_code, timezone, lifecycle_status, lifecycle_since, purchased_on, payment_label) values ('user_hardening', 'sub_masked_label', 'one_time', 'Masked label', 100, 'USD', 'UTC', 'active', '2026-01-01', '2026-01-01', 'Visa •••• 4242')$$,
  'masked last-four payment labels remain supported'
);
select lives_ok(
  $$insert into public.subscriptions(owner_user_id, id, kind, service_name, amount_minor, currency_code, timezone, lifecycle_status, lifecycle_since, purchased_on, notes) values ('user_hardening', 'sub_numeric_notes', 'one_time', 'Numeric notes', 100, 'USD', 'UTC', 'active', '2026-01-01', '2026-01-01', 'Invoice 12345')$$,
  'ordinary numeric text remains supported'
);

insert into public.subscriptions(
  owner_user_id, id, kind, service_name, amount_minor, currency_code, timezone,
  lifecycle_status, lifecycle_since, start_date, next_renewal_date,
  recurrence_unit, recurrence_interval, trial_ends_on, lifecycle_access_ends_on
) values
  ('user_hardening', 'sub_active_pause', 'recurring', 'Active pause', 100, 'USD', 'UTC', 'active', '2026-01-01', '2026-01-01', '2026-02-01', 'month', 1, null, null),
  ('user_hardening', 'sub_trial_activate', 'recurring', 'Trial activate', 100, 'USD', 'UTC', 'trial', '2026-01-01', '2026-01-01', '2026-02-01', 'month', 1, '2026-01-15', null),
  ('user_hardening', 'sub_canceled_expire', 'recurring', 'Canceled expire', 100, 'USD', 'UTC', 'canceled', '2026-01-01', '2026-01-01', '2026-02-01', 'month', 1, null, '2026-01-15'),
  ('user_hardening', 'sub_expired_restart', 'recurring', 'Expired restart', 100, 'USD', 'UTC', 'expired', '2026-01-01', '2026-01-01', '2026-02-01', 'month', 1, null, null),
  ('user_hardening', 'sub_active_invalid', 'recurring', 'Active invalid', 100, 'USD', 'UTC', 'active', '2026-01-01', '2026-01-01', '2026-02-01', 'month', 1, null, null),
  ('user_hardening', 'sub_active_rewrite', 'recurring', 'Active rewrite', 100, 'USD', 'UTC', 'active', '2026-01-01', '2026-01-01', '2026-02-01', 'month', 1, null, null);

select lives_ok(
  $$update public.subscriptions set lifecycle_status = 'paused', lifecycle_since = '2026-01-10' where id = 'sub_active_pause'$$,
  'active subscriptions may transition to paused'
);
select lives_ok(
  $$update public.subscriptions set lifecycle_status = 'active', lifecycle_since = '2026-01-11' where id = 'sub_active_pause'$$,
  'paused subscriptions may transition back to active'
);
select lives_ok(
  $$update public.subscriptions set lifecycle_status = 'active', lifecycle_since = '2026-01-15', trial_ends_on = null where id = 'sub_trial_activate'$$,
  'trial subscriptions may activate at the trial boundary'
);
select lives_ok(
  $$update public.subscriptions set lifecycle_status = 'expired', lifecycle_since = '2026-01-15', lifecycle_access_ends_on = null where id = 'sub_canceled_expire'$$,
  'canceled subscriptions may expire when access ends'
);
select lives_ok(
  $$update public.subscriptions set lifecycle_status = 'active', lifecycle_since = '2026-01-20' where id = 'sub_expired_restart'$$,
  'expired subscriptions may explicitly restart'
);
select throws_ok(
  $$update public.subscriptions set lifecycle_status = 'trial', lifecycle_since = '2026-01-10', trial_ends_on = '2026-01-20' where id = 'sub_active_invalid'$$,
  '23514', null,
  'active subscriptions cannot transition backward to trial'
);
select throws_ok(
  $$update public.subscriptions set lifecycle_since = '2026-01-02' where id = 'sub_active_rewrite'$$,
  '23514', null,
  'same-state updates cannot rewrite lifecycle history'
);

insert into public.renewal_events(
  owner_user_id, idempotency_key, subscription_id, occurrence_date, amount_minor,
  currency_code, state, confirmed_on, skipped_on
) values
  ('user_hardening', 'renewal_confirm', 'sub_active_pause', '2026-02-01', 100, 'USD', 'expected', null, null),
  ('user_hardening', 'renewal_skip', 'sub_active_pause', '2026-02-01', 100, 'USD', 'expected', null, null),
  ('user_hardening', 'renewal_correct', 'sub_active_pause', '2026-02-01', 100, 'USD', 'expected', null, null),
  ('user_hardening', 'renewal_confirmed_correct', 'sub_active_pause', '2026-02-01', 100, 'USD', 'confirmed', '2026-02-02', null),
  ('user_hardening', 'renewal_skipped_invalid', 'sub_active_pause', '2026-02-01', 100, 'USD', 'skipped', null, '2026-02-02'),
  ('user_hardening', 'renewal_bad_original', 'sub_active_pause', '2026-02-01', 100, 'USD', 'expected', null, null),
  ('user_hardening', 'renewal_rewrite', 'sub_active_pause', '2026-02-01', 100, 'USD', 'expected', null, null);

select lives_ok(
  $$update public.renewal_events set state = 'confirmed', confirmed_on = '2026-02-02' where idempotency_key = 'renewal_confirm'$$,
  'expected renewals may transition to confirmed'
);
select lives_ok(
  $$update public.renewal_events set state = 'skipped', skipped_on = '2026-02-02' where idempotency_key = 'renewal_skip'$$,
  'expected renewals may transition to skipped'
);
select lives_ok(
  $$update public.renewal_events set state = 'corrected', occurrence_date = '2026-02-02', amount_minor = 90, currency_code = 'EUR', corrected_on = '2026-02-02', original_occurrence_date = '2026-02-01', original_amount_minor = 100, original_currency_code = 'USD' where idempotency_key = 'renewal_correct'$$,
  'expected renewals may transition to a faithful correction'
);
select lives_ok(
  $$update public.renewal_events set state = 'corrected', occurrence_date = '2026-02-02', amount_minor = 90, currency_code = 'EUR', confirmed_on = null, corrected_on = '2026-02-02', original_occurrence_date = '2026-02-01', original_amount_minor = 100, original_currency_code = 'USD' where idempotency_key = 'renewal_confirmed_correct'$$,
  'confirmed renewals may transition to a faithful correction'
);
select throws_ok(
  $$update public.renewal_events set state = 'confirmed', skipped_on = null, confirmed_on = '2026-02-02' where idempotency_key = 'renewal_skipped_invalid'$$,
  '23514', null,
  'skipped renewals are terminal'
);
select throws_ok(
  $$update public.renewal_events set state = 'corrected', occurrence_date = '2026-02-02', amount_minor = 90, currency_code = 'EUR', corrected_on = '2026-02-02', original_occurrence_date = '2026-02-01', original_amount_minor = 999, original_currency_code = 'USD' where idempotency_key = 'renewal_bad_original'$$,
  '23514', null,
  'corrections must snapshot the actual prior money and date'
);
select throws_ok(
  $$update public.renewal_events set amount_minor = 101 where idempotency_key = 'renewal_rewrite'$$,
  '23514', null,
  'same-state updates cannot rewrite renewal history'
);

select * from finish();
rollback;
