-- Reminder engine: computation, cancellation, and client acknowledgement.
--
-- The delivery table, its state machine, and its idempotency key already
-- existed; nothing computed or advanced them. This migration adds the
-- server-side materializer, the reconciliation that cancels reminders which no
-- longer apply, and the single narrow path a client uses to report delivery.
--
-- Write-path design, forced by two existing constraints:
--
--   1. `public.reminder_deliveries` denies insert, update, and delete to
--      `authenticated` (see 20260805044822_security_integrity_fixup.sql), and
--      grants writes only to `service_role`. Clients therefore cannot create
--      or advance a delivery directly, by design.
--   2. Every one of these tables sets FORCE ROW LEVEL SECURITY, so the table
--      owner is subject to policies too. A `security definer` function owned
--      by `postgres` is consequently *also* denied unless a policy admits it.
--
-- So the engine's own access is granted explicitly and narrowly: a policy
-- scoped to `postgres` that additionally requires a session flag which only
-- the functions below set, via a function-local `SET`. The flag is not
-- settable by `authenticated` through any client path, and the client-facing
-- denial policies are left exactly as they are. Where the invoking role
-- already holds BYPASSRLS the policy is simply redundant, so this works on
-- both a vanilla server and a hosted project without assuming either.

begin;

create schema if not exists reminder_private;
revoke all on schema reminder_private from public, anon, authenticated;
grant usage on schema reminder_private to service_role;

comment on schema reminder_private is
  'Internal reminder computation. Never exposed to the Data API; clients reach reminders only through public.acknowledge_reminder_delivery.';

-- ---------------------------------------------------------------------------
-- Engine access policies
-- ---------------------------------------------------------------------------

create policy reminder_deliveries_engine on public.reminder_deliveries
  for all to postgres
  using (
    pg_catalog.current_setting('subtrack.reminder_engine', true) = 'on'
  )
  with check (
    pg_catalog.current_setting('subtrack.reminder_engine', true) = 'on'
  );

create policy subscriptions_engine_read on public.subscriptions
  for select to postgres
  using (
    pg_catalog.current_setting('subtrack.reminder_engine', true) = 'on'
  );

create policy user_preferences_engine_read on public.user_preferences
  for select to postgres
  using (
    pg_catalog.current_setting('subtrack.reminder_engine', true) = 'on'
  );

create policy reminder_overrides_engine_read on public.reminder_overrides
  for select to postgres
  using (
    pg_catalog.current_setting('subtrack.reminder_engine', true) = 'on'
  );

-- ---------------------------------------------------------------------------
-- Effective reminder configuration
-- ---------------------------------------------------------------------------

-- Resolves, per subscription, the lead days and channels that actually apply:
-- a per-subscription override when present, otherwise the account preference,
-- otherwise a conservative default. Kept as a view so the materializer and its
-- tests observe exactly the same resolution.
create view reminder_private.effective_reminder_plan as
  select
    s.owner_user_id,
    s.id as subscription_id,
    s.start_date,
    s.next_renewal_date,
    s.recurrence_unit,
    s.recurrence_interval,
    coalesce(p.timezone, s.timezone, 'UTC') as timezone,
    coalesce(
      o.lead_days,
      p.reminder_lead_days,
      array[7, 1]::smallint[]
    ) as lead_days,
    coalesce(
      o.channels,
      case
        when coalesce(p.email_reminders_enabled, false)
          then array['native', 'email']::text[]
        else array['native']::text[]
      end
    ) as channels
  from public.subscriptions s
  left join public.user_preferences p
    on p.owner_user_id = s.owner_user_id
  left join public.reminder_overrides o
    on o.owner_user_id = s.owner_user_id
   and o.subscription_id = s.id
  where s.kind = 'recurring'
    and s.lifecycle_status in ('active', 'trial')
    and s.recurrence_unit is not null
    and s.recurrence_interval is not null
    and s.start_date is not null
    and s.next_renewal_date is not null;

revoke all on reminder_private.effective_reminder_plan
  from public, anon, authenticated;

comment on view reminder_private.effective_reminder_plan is
  'Per-subscription reminder configuration after override, account preference, and default resolution. Only active and trial recurring subscriptions appear.';

-- ---------------------------------------------------------------------------
-- Materializer
-- ---------------------------------------------------------------------------

create function reminder_private.materialize_due_reminders(
  horizon_days integer default 45,
  send_hour integer default 9
) returns integer
  language plpgsql
  security definer
  set search_path to ''
  set "subtrack.reminder_engine" to 'on'
as $function$
declare
  inserted_count integer;
begin
  if horizon_days < 1 or horizon_days > 400 then
    raise exception 'horizon_days out of range: %', horizon_days;
  end if;
  if send_hour < 0 or send_hour > 23 then
    raise exception 'send_hour out of range: %', send_hour;
  end if;

  with planned as (
    select
      plan.owner_user_id,
      plan.subscription_id,
      occurrence.occurrence as occurrence_date,
      lead.lead_day,
      channel.channel,
      -- The local send moment is resolved in the account's own zone and then
      -- converted to an absolute instant. Doing it in this order is what makes
      -- the result correct across a daylight-saving transition: the same wall
      -- clock hour maps to a different UTC offset either side of the change.
      (
        (
          (occurrence.occurrence - lead.lead_day)::date
          + pg_catalog.make_interval(hours => send_hour)
        ) at time zone plan.timezone
      ) as scheduled_for
    from reminder_private.effective_reminder_plan plan
    cross join pg_catalog.unnest(plan.lead_days) as lead(lead_day)
    cross join pg_catalog.unnest(plan.channels) as channel(channel)
    cross join calendar_private.subscription_occurrences(
      plan.start_date,
      plan.next_renewal_date,
      plan.recurrence_unit,
      plan.recurrence_interval,
      current_date,
      (current_date + horizon_days)
    ) as occurrence
  ),
  fresh as (
    select * from planned
    -- A reminder whose send moment has already passed is not created. On a
    -- first run, or after a long outage, backfilling them would deliver a
    -- burst of notifications for renewals the user can no longer act on
    -- earlier. One day of grace absorbs ordinary scheduling lag.
    where planned.scheduled_for >= pg_catalog.now() - pg_catalog.make_interval(days => 1)
  ),
  written as (
    insert into public.reminder_deliveries (
      owner_user_id,
      idempotency_key,
      subscription_id,
      occurrence_date,
      channel,
      state,
      scheduled_for
    )
    select
      fresh.owner_user_id,
      pg_catalog.format(
        '%s|%s|%s|%s',
        fresh.subscription_id,
        fresh.occurrence_date,
        fresh.lead_day,
        fresh.channel
      ),
      fresh.subscription_id,
      fresh.occurrence_date,
      fresh.channel,
      'pending',
      fresh.scheduled_for
    from fresh
    -- The key is derived from the subscription, occurrence, lead, and channel,
    -- so recomputation converges instead of duplicating. This is the whole
    -- reason the table is keyed the way it is.
    on conflict (owner_user_id, idempotency_key) do nothing
    returning 1
  )
  select pg_catalog.count(*)::integer into inserted_count from written;

  return coalesce(inserted_count, 0);
end;
$function$;

revoke all on function reminder_private.materialize_due_reminders(integer, integer)
  from public, anon, authenticated;
grant execute on function reminder_private.materialize_due_reminders(integer, integer)
  to service_role;

comment on function reminder_private.materialize_due_reminders(integer, integer) is
  'Expands active and trial recurring subscriptions into pending reminder deliveries over the horizon. Idempotent: the derived key means repeated runs converge rather than duplicate. Send moments resolve in the account timezone before conversion to an instant, so daylight-saving transitions are handled correctly.';

-- ---------------------------------------------------------------------------
-- Reconciliation
-- ---------------------------------------------------------------------------

create function reminder_private.cancel_orphaned_reminders()
  returns integer
  language plpgsql
  security definer
  set search_path to ''
  set "subtrack.reminder_engine" to 'on'
as $function$
declare
  canceled_count integer;
begin
  with canceled as (
    update public.reminder_deliveries d
    set state = 'canceled',
        version = d.version + 1,
        updated_at = pg_catalog.statement_timestamp()
    from public.subscriptions s
    where s.owner_user_id = d.owner_user_id
      and s.id = d.subscription_id
      and d.state in ('pending', 'claimed')
      and (
        -- No longer a commitment the user is being reminded about.
        s.lifecycle_status not in ('active', 'trial')
        or s.kind <> 'recurring'
        -- Rescheduled: the stored occurrence is no longer on the subscription's
        -- own recurrence, so the pending reminder points at a date that will
        -- never arrive. Reuses the existing predicate rather than restating
        -- recurrence rules here.
        or not private.is_subscription_occurrence(
             s.start_date,
             d.occurrence_date,
             s.recurrence_unit,
             s.recurrence_interval
           )
      )
    returning 1
  )
  select pg_catalog.count(*)::integer into canceled_count from canceled;

  return coalesce(canceled_count, 0);
end;
$function$;

revoke all on function reminder_private.cancel_orphaned_reminders()
  from public, anon, authenticated;
grant execute on function reminder_private.cancel_orphaned_reminders()
  to service_role;

comment on function reminder_private.cancel_orphaned_reminders() is
  'Cancels pending or claimed deliveries whose subscription is no longer an active recurring commitment, or whose occurrence no longer falls on the subscription recurrence after a reschedule.';

create function reminder_private.run_reminder_cycle()
  returns void
  language plpgsql
  security definer
  set search_path to ''
as $function$
begin
  -- Cancellation runs first so a rescheduled or paused subscription cannot be
  -- re-materialized and then cancelled within the same cycle.
  perform reminder_private.cancel_orphaned_reminders();
  perform reminder_private.materialize_due_reminders();
end;
$function$;

revoke all on function reminder_private.run_reminder_cycle()
  from public, anon, authenticated;

comment on function reminder_private.run_reminder_cycle() is
  'Scheduled entry point: reconciles cancellations, then materializes newly due reminders.';

-- ---------------------------------------------------------------------------
-- Client acknowledgement
-- ---------------------------------------------------------------------------

-- The only reminder write a client can perform. Clients cannot insert or
-- delete deliveries, and cannot move one to an arbitrary state: ownership is
-- taken from the verified token rather than an argument, and only the
-- transitions below are permitted.
create function public.acknowledge_reminder_delivery(
  p_idempotency_key text,
  p_state text,
  p_error_code text default null
) returns public.reminder_deliveries
  language plpgsql
  security definer
  set search_path to ''
  set "subtrack.reminder_engine" to 'on'
as $function$
declare
  v_owner text;
  v_current text;
  v_row public.reminder_deliveries;
begin
  v_owner := private.current_clerk_subject();
  if v_owner is null then
    raise exception 'reminder_acknowledge_unauthorized';
  end if;

  if p_state not in ('claimed', 'delivered', 'failed', 'canceled') then
    raise exception 'reminder_acknowledge_invalid_state';
  end if;

  if p_error_code is not null
     and p_error_code !~ '^[A-Z0-9_]{1,64}$'
  then
    raise exception 'reminder_acknowledge_invalid_error_code';
  end if;

  -- Ownership is filtered here, not supplied by the caller, so one account can
  -- never acknowledge another's delivery even though this runs as definer.
  select d.state into v_current
  from public.reminder_deliveries d
  where d.owner_user_id = v_owner
    and d.idempotency_key = p_idempotency_key
  for update;

  if v_current is null then
    raise exception 'reminder_acknowledge_not_found';
  end if;

  if v_current not in ('pending', 'claimed') then
    raise exception 'reminder_acknowledge_terminal_state';
  end if;

  if p_state = 'claimed' and v_current <> 'pending' then
    raise exception 'reminder_acknowledge_illegal_transition';
  end if;

  update public.reminder_deliveries d
  set state = p_state,
      -- Counted on each claim and each failure, so a delivery that keeps
      -- failing is visible and bounded by the existing 0..20 constraint.
      attempt_count = case
        when p_state in ('claimed', 'failed') then d.attempt_count + 1
        else d.attempt_count
      end,
      delivered_at = case
        when p_state = 'delivered' then pg_catalog.statement_timestamp()
        else d.delivered_at
      end,
      error_code = case
        when p_state = 'failed' then p_error_code
        else null
      end,
      version = d.version + 1,
      updated_at = pg_catalog.statement_timestamp()
  where d.owner_user_id = v_owner
    and d.idempotency_key = p_idempotency_key
  returning d.* into v_row;

  return v_row;
end;
$function$;

revoke all on function public.acknowledge_reminder_delivery(text, text, text)
  from public, anon, service_role;
grant execute on function public.acknowledge_reminder_delivery(text, text, text)
  to authenticated;

comment on function public.acknowledge_reminder_delivery(text, text, text) is
  'Advances one of the caller''s own reminder deliveries. Ownership comes from the verified token, not an argument; only pending or claimed rows move, and only to claimed, delivered, failed, or canceled.';

-- ---------------------------------------------------------------------------
-- Schedule
-- ---------------------------------------------------------------------------

create extension if not exists pg_cron;

do $$
begin
  if exists (
    select 1 from cron.job where jobname = 'subtrack-reminder-cycle'
  ) then
    perform cron.alter_job(
      (select jobid from cron.job where jobname = 'subtrack-reminder-cycle'),
      schedule := '*/15 * * * *',
      command := 'select reminder_private.run_reminder_cycle()',
      active := true
    );
  else
    perform cron.schedule(
      'subtrack-reminder-cycle',
      '*/15 * * * *',
      'select reminder_private.run_reminder_cycle()'
    );
  end if;
end;
$$;

commit;
