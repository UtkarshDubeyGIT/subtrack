create table private.clerk_identity_authority (
  singleton boolean primary key default true,
  issuer text not null,
  constraint clerk_identity_authority_singleton check (singleton),
  constraint clerk_identity_authority_issuer check (
    issuer ~ '^https://[A-Za-z0-9][A-Za-z0-9.-]{1,251}[A-Za-z0-9]$'
    and char_length(issuer) <= 255
  )
);

revoke all on table private.clerk_identity_authority from public, anon, authenticated, service_role;

create or replace function private.current_clerk_subject()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when claims->>'role' = 'authenticated'
      and claims->>'iss' = authority.issuer
      and coalesce(claims->>'sub', '') = btrim(coalesce(claims->>'sub', ''))
      and char_length(coalesce(claims->>'sub', '')) between 1 and 512
      and coalesce(claims->>'exp', '') ~ '^[0-9]{1,12}$'
      and (claims->>'exp')::numeric > extract(epoch from statement_timestamp())
    then claims->>'sub'
    else null
  end
  from (select auth.jwt() as claims) token
  left join private.clerk_identity_authority authority on authority.singleton;
$$;

alter function private.current_clerk_subject() owner to postgres;
revoke all on function private.current_clerk_subject() from public, anon;
grant execute on function private.current_clerk_subject() to authenticated, service_role;

alter table public.renewal_events
  add column if not exists original_currency_code text;

alter table public.subscriptions
  drop constraint subscriptions_amount_valid,
  drop constraint subscriptions_lifecycle_valid,
  drop constraint subscriptions_schedule_valid,
  add constraint subscriptions_amount_valid check (
    amount_minor between 0 and 9007199254740991
  ),
  add constraint subscriptions_lifecycle_valid check (
    (
      lifecycle_status = 'trial'
      and trial_ends_on is not null
      and trial_ends_on >= lifecycle_since
      and lifecycle_access_ends_on is null
    )
    or (
      lifecycle_status = 'canceled'
      and lifecycle_access_ends_on is not null
      and lifecycle_access_ends_on >= lifecycle_since
      and trial_ends_on is null
    )
    or (
      lifecycle_status in ('active', 'paused', 'expired')
      and trial_ends_on is null
      and lifecycle_access_ends_on is null
    )
  ),
  add constraint subscriptions_schedule_valid check (
    (
      kind = 'recurring'
      and start_date is not null
      and purchased_on is null
      and access_ends_on is null
      and next_renewal_date is not null
      and next_renewal_date >= start_date
      and recurrence_unit in ('day', 'week', 'month', 'year')
      and recurrence_interval between 1 and 1200
    )
    or (
      kind = 'one_time'
      and start_date is null
      and purchased_on is not null
      and (access_ends_on is null or access_ends_on >= purchased_on)
      and next_renewal_date is null
      and recurrence_unit is null
      and recurrence_interval is null
    )
  );

alter table public.renewal_events
  drop constraint renewal_events_amount_valid,
  drop constraint renewal_events_state_dates_valid,
  add constraint renewal_events_amount_valid check (
    amount_minor between 0 and 9007199254740991
  ),
  add constraint renewal_events_original_amount_valid check (
    original_amount_minor is null
    or original_amount_minor between 0 and 9007199254740991
  ),
  add constraint renewal_events_original_currency_valid check (
    original_currency_code is null or original_currency_code ~ '^[A-Z]{3}$'
  ),
  add constraint renewal_events_state_dates_valid check (
    (
      state = 'expected'
      and confirmed_on is null
      and corrected_on is null
      and skipped_on is null
      and original_occurrence_date is null
      and original_amount_minor is null
      and original_currency_code is null
    )
    or (
      state = 'confirmed'
      and confirmed_on is not null
      and confirmed_on >= occurrence_date
      and corrected_on is null
      and skipped_on is null
      and original_occurrence_date is null
      and original_amount_minor is null
      and original_currency_code is null
    )
    or (
      state = 'corrected'
      and corrected_on is not null
      and original_occurrence_date is not null
      and corrected_on >= original_occurrence_date
      and original_amount_minor is not null
      and original_amount_minor between 0 and 9007199254740991
      and original_currency_code is not null
      and confirmed_on is null
      and skipped_on is null
    )
    or (
      state = 'skipped'
      and skipped_on is not null
      and skipped_on >= occurrence_date
      and confirmed_on is null
      and corrected_on is null
      and original_occurrence_date is null
      and original_amount_minor is null
      and original_currency_code is null
    )
  );

alter table public.user_preferences
  drop constraint user_preferences_leads_valid,
  add constraint user_preferences_leads_valid check (
    cardinality(reminder_lead_days) between 1 and 10
    and array_position(reminder_lead_days, null) is null
    and 0 <= all(reminder_lead_days)
    and 365 >= all(reminder_lead_days)
  );

alter table public.reminder_overrides
  drop constraint reminder_overrides_leads_valid,
  drop constraint reminder_overrides_channels_valid,
  add constraint reminder_overrides_leads_valid check (
    cardinality(lead_days) between 1 and 10
    and array_position(lead_days, null) is null
    and 0 <= all(lead_days)
    and 365 >= all(lead_days)
  ),
  add constraint reminder_overrides_channels_valid check (
    cardinality(channels) between 1 and 3
    and array_position(channels, null) is null
    and channels <@ array['in_app', 'native', 'email']::text[]
  );

alter table public.reminder_deliveries
  add constraint reminder_deliveries_state_fields_valid check (
    (
      state in ('pending', 'claimed', 'canceled')
      and delivered_at is null
      and error_code is null
    )
    or (
      state = 'delivered'
      and delivered_at is not null
      and error_code is null
    )
    or (
      state = 'failed'
      and delivered_at is null
      and error_code is not null
    )
  );

drop policy reminder_deliveries_insert on public.reminder_deliveries;
drop policy reminder_deliveries_update on public.reminder_deliveries;
drop policy reminder_deliveries_delete on public.reminder_deliveries;
create policy reminder_deliveries_insert_denied on public.reminder_deliveries
  for insert to authenticated with check (false);
create policy reminder_deliveries_update_denied on public.reminder_deliveries
  for update to authenticated using (false) with check (false);
create policy reminder_deliveries_delete_denied on public.reminder_deliveries
  for delete to authenticated using (false);

drop policy security_audit_events_insert on public.security_audit_events;
drop policy security_audit_events_update on public.security_audit_events;
drop policy security_audit_events_delete on public.security_audit_events;
create policy security_audit_events_insert_denied on public.security_audit_events
  for insert to authenticated with check (false);
create policy security_audit_events_update_denied on public.security_audit_events
  for update to authenticated using (false) with check (false);
create policy security_audit_events_delete_denied on public.security_audit_events
  for delete to authenticated using (false);

grant insert (
  idempotency_key, subscription_id, occurrence_date, amount_minor, currency_code,
  state, confirmed_on, corrected_on, skipped_on, original_occurrence_date,
  original_amount_minor, original_currency_code
) on public.renewal_events to authenticated;
grant update (
  occurrence_date, amount_minor, currency_code, state, confirmed_on, corrected_on,
  skipped_on, original_occurrence_date, original_amount_minor, original_currency_code
) on public.renewal_events to authenticated;
