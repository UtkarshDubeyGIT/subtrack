-- Synthetic local-development fixtures only. Never replace these identifiers with production data.
insert into public.user_preferences(owner_user_id, timezone, home_currency)
values
  ('user_fixture_local_a', 'UTC', 'USD'),
  ('user_fixture_local_b', 'Asia/Kolkata', 'INR')
on conflict (owner_user_id) do nothing;

insert into public.subscriptions(
  owner_user_id, id, kind, service_name, amount_minor, currency_code, timezone,
  lifecycle_status, lifecycle_since, start_date, next_renewal_date,
  recurrence_unit, recurrence_interval
)
values
  (
    'user_fixture_local_a', 'sub_fixture_local_a', 'recurring', 'Fixture Streaming',
    1299, 'USD', 'UTC', 'active', '2026-01-01', '2026-01-01', '2026-02-01',
    'month', 1
  ),
  (
    'user_fixture_local_b', 'sub_fixture_local_b', 'recurring', 'Fixture Cloud',
    999, 'INR', 'Asia/Kolkata', 'active', '2026-01-01', '2026-01-01',
    '2026-02-01', 'month', 1
  )
on conflict (owner_user_id, id) do nothing;
