begin;
set local role postgres;
set local search_path = extensions, public, pg_catalog;

select plan(30);

-- Parts of this suite impersonate a client with `set local role authenticated`
-- and then call pgTAP assertions. pgTAP is installed in `extensions`, which
-- `authenticated` has no USAGE on, so the assertion itself would fail to
-- resolve. Granting usage for the duration of this transaction keeps the
-- impersonation honest without changing anything under test; the rollback at
-- the end of the file reverts it.
grant usage on schema extensions to authenticated;

-- ---------------------------------------------------------------------------
-- Structure
-- ---------------------------------------------------------------------------

select has_schema(
  'reminder_private',
  'reminder computation lives in an internal schema'
);

select has_view(
  'reminder_private',
  'effective_reminder_plan',
  'override, preference, and default resolution is a single shared view'
);

select has_function(
  'reminder_private',
  'materialize_due_reminders',
  array['integer', 'integer'],
  'due reminder materialization is a database operation'
);

select has_function(
  'reminder_private',
  'cancel_orphaned_reminders',
  array[]::text[],
  'reminder reconciliation is a database operation'
);

select has_function(
  'reminder_private',
  'run_reminder_cycle',
  array[]::text[],
  'the scheduled cycle has a single entry point'
);

select has_function(
  'public',
  'acknowledge_reminder_delivery',
  array['text', 'text', 'text'],
  'clients advance deliveries only through the acknowledgement function'
);

-- ---------------------------------------------------------------------------
-- Fixture
-- ---------------------------------------------------------------------------

insert into private.clerk_identity_authority (singleton, issuer)
values (true, 'https://pgtap.clerk.accounts.dev')
on conflict (singleton) do update set issuer = excluded.issuer;

create or replace function pg_temp.act_as(subject text)
  returns void language plpgsql as $$
begin
  perform set_config(
    'request.jwt.claims',
    json_build_object(
      'role', 'authenticated',
      'iss', 'https://pgtap.clerk.accounts.dev',
      'sub', subject,
      'exp', (extract(epoch from statement_timestamp())::bigint + 3600)::text
    )::text,
    true
  );
end;
$$;

select pg_temp.act_as('pgtap_owner');
set local role authenticated;

insert into public.user_preferences (
  timezone, home_currency, reminder_lead_days, email_reminders_enabled, locale
) values ('America/New_York', 'USD', array[7, 1]::smallint[], false, 'en');

-- Spring-forward in America/New_York for 2027 falls on March 14, so these two
-- renewals put their 7-day reminders on opposite sides of the transition.
insert into public.subscriptions (
  id, kind, service_name, amount_minor, currency_code, timezone,
  lifecycle_status, lifecycle_since, start_date, next_renewal_date,
  recurrence_unit, recurrence_interval
) values
  ('sub_pre', 'recurring', 'Pre DST', 1000, 'USD', 'America/New_York',
   'active', '2026-01-01', '2027-03-20', '2027-03-20', 'month', 1),
  ('sub_post', 'recurring', 'Post DST', 1000, 'USD', 'America/New_York',
   'active', '2026-01-01', '2027-03-28', '2027-03-28', 'month', 1);

-- ---------------------------------------------------------------------------
-- The client write path stays closed
-- ---------------------------------------------------------------------------

select throws_ok(
  $$insert into public.reminder_deliveries (
      owner_user_id, idempotency_key, subscription_id, occurrence_date,
      channel, state, scheduled_for
    ) values (
      'pgtap_owner', 'forged', 'sub_pre', '2027-03-20',
      'native', 'pending', statement_timestamp()
    )$$,
  '42501',
  null,
  'an authenticated client cannot insert a reminder delivery'
);

set local role postgres;

-- ---------------------------------------------------------------------------
-- Materialization and idempotency
-- ---------------------------------------------------------------------------

select ok(
  reminder_private.materialize_due_reminders(400) > 0,
  'materialization creates pending deliveries for active recurring subscriptions'
);

select is(
  reminder_private.materialize_due_reminders(400),
  0,
  'a second materialization run creates nothing, because the key is derived'
);

select is(
  (select count(*)::integer from public.reminder_deliveries where state <> 'pending'),
  0,
  'materialization only ever produces pending deliveries'
);

-- ---------------------------------------------------------------------------
-- Daylight-saving correctness
-- ---------------------------------------------------------------------------

-- 09:00 local is 14:00Z under EST and 13:00Z under EDT. Resolving the local
-- send moment in the account zone before converting to an instant is what
-- produces the correct offset on each side of the transition.
select is(
  (
    select extract(hour from d.scheduled_for at time zone 'UTC')::integer
    from public.reminder_deliveries d
    where d.subscription_id = 'sub_pre'
      and d.occurrence_date = '2027-03-20'
      and d.idempotency_key like '%|7|native'
  ),
  14,
  'a pre-transition reminder resolves 09:00 EST to 14:00Z'
);

select is(
  (
    select extract(hour from d.scheduled_for at time zone 'UTC')::integer
    from public.reminder_deliveries d
    where d.subscription_id = 'sub_post'
      and d.occurrence_date = '2027-03-28'
      and d.idempotency_key like '%|7|native'
  ),
  13,
  'a post-transition reminder resolves 09:00 EDT to 13:00Z'
);

-- ---------------------------------------------------------------------------
-- Channel and lead resolution
-- ---------------------------------------------------------------------------

select is(
  (select array_agg(distinct d.channel order by d.channel)
   from public.reminder_deliveries d),
  array['native'],
  'with email reminders disabled only the native channel is scheduled'
);

select pg_temp.act_as('pgtap_owner');
set local role authenticated;
update public.user_preferences set email_reminders_enabled = true;
insert into public.reminder_overrides (subscription_id, lead_days, channels)
values ('sub_pre', array[30]::smallint[], array['native']::text[]);
set local role postgres;

select ok(
  reminder_private.materialize_due_reminders(400) > 0,
  'changing reminder configuration materializes the newly applicable rows'
);

select ok(
  exists (
    select 1 from public.reminder_deliveries d
    where d.subscription_id = 'sub_post' and d.channel = 'email'
  ),
  'enabling email reminders schedules the email channel'
);

select ok(
  exists (
    select 1 from public.reminder_deliveries d
    where d.subscription_id = 'sub_pre'
      and d.idempotency_key like '%|30|native'
  ),
  'a per-subscription override replaces the account lead days'
);

select ok(
  not exists (
    select 1 from public.reminder_deliveries d
    where d.subscription_id = 'sub_pre' and d.channel = 'email'
  ),
  'a per-subscription channel override is not widened by the account preference'
);

-- ---------------------------------------------------------------------------
-- Acknowledgement
-- ---------------------------------------------------------------------------

-- The target key is pinned in a transaction-local setting rather than a temp
-- table: the assertions below run as `authenticated`, which would not own a
-- temp table created here, and a re-selected "first pending row" would drift
-- as these very assertions advance its state.
select set_config(
  'subtrack.test_ack_key',
  (
    select d.idempotency_key
    from public.reminder_deliveries d
    where d.owner_user_id = 'pgtap_owner' and d.state = 'pending'
    order by d.scheduled_for, d.idempotency_key
    limit 1
  ),
  true
);

select pg_temp.act_as('pgtap_owner');
set local role authenticated;

select is(
  (
    public.acknowledge_reminder_delivery(
      current_setting('subtrack.test_ack_key'), 'claimed'
    )
  ).attempt_count,
  1,
  'claiming a pending delivery counts the attempt'
);

select ok(
  (
    public.acknowledge_reminder_delivery(
      current_setting('subtrack.test_ack_key'), 'delivered'
    )
  ).delivered_at is not null,
  'delivering a claimed delivery records the delivery instant'
);

select throws_ok(
  $$select public.acknowledge_reminder_delivery(
      current_setting('subtrack.test_ack_key'), 'claimed'
    )$$,
  'P0001',
  'reminder_acknowledge_terminal_state',
  'a terminal delivery cannot be acknowledged again'
);

select throws_ok(
  $$select public.acknowledge_reminder_delivery(
      current_setting('subtrack.test_ack_key'), 'pending'
    )$$,
  'P0001',
  'reminder_acknowledge_invalid_state',
  'pending is not a state a client may assign'
);

select throws_ok(
  $$select public.acknowledge_reminder_delivery(
      current_setting('subtrack.test_ack_key'), 'failed', 'not a code'
    )$$,
  'P0001',
  'reminder_acknowledge_invalid_error_code',
  'a malformed error code is rejected'
);

select pg_temp.act_as('pgtap_intruder');

select throws_ok(
  $$select public.acknowledge_reminder_delivery(
      current_setting('subtrack.test_ack_key'), 'claimed'
    )$$,
  'P0001',
  'reminder_acknowledge_not_found',
  'one account cannot acknowledge another account''s delivery'
);

-- ---------------------------------------------------------------------------
-- Reconciliation
-- ---------------------------------------------------------------------------

select pg_temp.act_as('pgtap_owner');
update public.subscriptions set lifecycle_status = 'paused' where id = 'sub_post';
set local role postgres;

select ok(
  reminder_private.cancel_orphaned_reminders() > 0,
  'pausing a subscription cancels its outstanding reminders'
);

select is(
  (
    select count(*)::integer from public.reminder_deliveries d
    where d.subscription_id = 'sub_post' and d.state in ('pending', 'claimed')
  ),
  0,
  'no outstanding reminder survives for a paused subscription'
);

select is(
  reminder_private.materialize_due_reminders(400),
  0,
  'a paused subscription is not materialized again'
);

-- Rescheduling moves the recurrence, so previously scheduled occurrences are
-- no longer dates the subscription will ever renew on.
select pg_temp.act_as('pgtap_owner');
set local role authenticated;
update public.subscriptions
set start_date = '2027-01-05', next_renewal_date = '2027-04-05'
where id = 'sub_pre';
set local role postgres;

select ok(
  reminder_private.cancel_orphaned_reminders() > 0,
  'rescheduling cancels reminders for occurrences no longer on the recurrence'
);

select is(
  (
    select count(*)::integer from public.reminder_deliveries d
    where d.subscription_id = 'sub_pre'
      and d.state = 'pending'
      and not private.is_subscription_occurrence(
        '2027-01-05'::date, d.occurrence_date, 'month', 1
      )
  ),
  0,
  'every surviving pending reminder sits on the current recurrence'
);

-- ---------------------------------------------------------------------------
-- No backfill into the past
-- ---------------------------------------------------------------------------

delete from public.reminder_deliveries;

select pg_temp.act_as('pgtap_owner');
set local role authenticated;
insert into public.subscriptions (
  id, kind, service_name, amount_minor, currency_code, timezone,
  lifecycle_status, lifecycle_since, start_date, next_renewal_date,
  recurrence_unit, recurrence_interval
) values (
  'sub_imminent', 'recurring', 'Imminent', 1000, 'USD', 'America/New_York',
  'active', '2026-01-01', current_date, current_date, 'month', 1
);
set local role postgres;

select ok(
  reminder_private.materialize_due_reminders(400) >= 0,
  'materialization tolerates a subscription renewing today'
);

select is(
  (
    select count(*)::integer from public.reminder_deliveries d
    where d.scheduled_for < statement_timestamp() - interval '1 day'
  ),
  0,
  'no reminder is created for a send moment that has already passed'
);

select * from finish();
rollback;
