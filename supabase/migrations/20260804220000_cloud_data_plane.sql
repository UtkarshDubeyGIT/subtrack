create or replace function private.current_clerk_subject()
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select case
    when claims->>'role' = 'authenticated'
      and coalesce(claims->>'sub', '') = btrim(coalesce(claims->>'sub', ''))
      and char_length(coalesce(claims->>'sub', '')) between 1 and 512
      and coalesce(claims->>'exp', '') ~ '^[0-9]{1,12}$'
      and (claims->>'exp')::numeric > extract(epoch from statement_timestamp())
    then claims->>'sub'
    else null
  end
  from (select auth.jwt() as claims) token;
$$;

revoke all on function private.current_clerk_subject() from public, anon;
grant execute on function private.current_clerk_subject() to authenticated, service_role;

create or replace function private.enforce_owned_row()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.owner_user_id is distinct from old.owner_user_id then
    raise exception 'owner_user_id is immutable' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' then
    new.version := old.version + 1;
  end if;
  new.updated_at := statement_timestamp();
  return new;
end;
$$;

revoke all on function private.enforce_owned_row() from public, anon, authenticated;

create table public.user_preferences (
  owner_user_id text primary key default private.current_clerk_subject(),
  timezone text not null default 'UTC',
  home_currency text not null default 'USD',
  reminder_lead_days smallint[] not null default array[7, 1]::smallint[],
  email_reminders_enabled boolean not null default false,
  locale text not null default 'en',
  version bigint not null default 1,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint user_preferences_owner_valid check (
    char_length(owner_user_id) between 1 and 512 and owner_user_id = btrim(owner_user_id)
  ),
  constraint user_preferences_timezone_valid check (char_length(timezone) between 1 and 128),
  constraint user_preferences_currency_valid check (home_currency ~ '^[A-Z]{3}$'),
  constraint user_preferences_leads_valid check (
    cardinality(reminder_lead_days) between 1 and 10
    and 0 <= all(reminder_lead_days)
    and 365 >= all(reminder_lead_days)
  ),
  constraint user_preferences_locale_valid check (locale ~ '^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})?$'),
  constraint user_preferences_version_valid check (version >= 1)
);

create table public.subscriptions (
  owner_user_id text not null default private.current_clerk_subject(),
  id text not null,
  kind text not null,
  service_name text not null,
  plan_name text,
  amount_minor bigint not null,
  currency_code text not null,
  timezone text not null,
  lifecycle_status text not null,
  lifecycle_since date not null,
  trial_ends_on date,
  lifecycle_access_ends_on date,
  start_date date,
  purchased_on date,
  access_ends_on date,
  next_renewal_date date,
  recurrence_unit text,
  recurrence_interval integer,
  account_email text,
  payment_label text,
  management_url text,
  notes text,
  version bigint not null default 1,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  primary key (owner_user_id, id),
  constraint subscriptions_owner_valid check (
    char_length(owner_user_id) between 1 and 512 and owner_user_id = btrim(owner_user_id)
  ),
  constraint subscriptions_id_valid check (id ~ '^[A-Za-z0-9_-]{1,128}$'),
  constraint subscriptions_kind_valid check (kind in ('recurring', 'one_time')),
  constraint subscriptions_service_valid check (char_length(btrim(service_name)) between 1 and 160),
  constraint subscriptions_plan_valid check (plan_name is null or char_length(plan_name) between 1 and 160),
  constraint subscriptions_amount_valid check (amount_minor >= 0),
  constraint subscriptions_currency_valid check (currency_code ~ '^[A-Z]{3}$'),
  constraint subscriptions_timezone_valid check (char_length(timezone) between 1 and 128),
  constraint subscriptions_lifecycle_valid check (
    lifecycle_status in ('trial', 'active', 'paused', 'canceled', 'expired')
    and (lifecycle_status <> 'trial' or trial_ends_on >= lifecycle_since)
    and (lifecycle_status = 'trial' or trial_ends_on is null)
    and (lifecycle_status <> 'canceled' or lifecycle_access_ends_on >= lifecycle_since)
    and (lifecycle_status = 'canceled' or lifecycle_access_ends_on is null)
  ),
  constraint subscriptions_schedule_valid check (
    (
      kind = 'recurring'
      and start_date is not null
      and purchased_on is null
      and access_ends_on is null
      and next_renewal_date >= start_date
      and recurrence_unit in ('day', 'week', 'month', 'year')
      and recurrence_interval between 1 and 1200
    )
    or
    (
      kind = 'one_time'
      and start_date is null
      and purchased_on is not null
      and (access_ends_on is null or access_ends_on >= purchased_on)
      and next_renewal_date is null
      and recurrence_unit is null
      and recurrence_interval is null
    )
  ),
  constraint subscriptions_email_valid check (
    account_email is null or (char_length(account_email) between 3 and 320 and account_email like '%_@_%._%')
  ),
  constraint subscriptions_payment_label_valid check (
    payment_label is null or char_length(payment_label) between 1 and 80
  ),
  constraint subscriptions_management_url_valid check (
    management_url is null or (char_length(management_url) <= 2048 and management_url ~ '^https://')
  ),
  constraint subscriptions_notes_valid check (notes is null or char_length(notes) <= 4000),
  constraint subscriptions_version_valid check (version >= 1)
);

create table public.renewal_events (
  owner_user_id text not null default private.current_clerk_subject(),
  idempotency_key text not null,
  subscription_id text not null,
  occurrence_date date not null,
  amount_minor bigint not null,
  currency_code text not null,
  state text not null,
  confirmed_on date,
  corrected_on date,
  skipped_on date,
  original_occurrence_date date,
  original_amount_minor bigint,
  version bigint not null default 1,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  primary key (owner_user_id, idempotency_key),
  foreign key (owner_user_id, subscription_id)
    references public.subscriptions(owner_user_id, id) on delete cascade,
  constraint renewal_events_idempotency_valid check (char_length(idempotency_key) between 1 and 256),
  constraint renewal_events_amount_valid check (amount_minor >= 0),
  constraint renewal_events_currency_valid check (currency_code ~ '^[A-Z]{3}$'),
  constraint renewal_events_state_valid check (state in ('expected', 'confirmed', 'corrected', 'skipped')),
  constraint renewal_events_state_dates_valid check (
    (state = 'expected' and confirmed_on is null and corrected_on is null and skipped_on is null)
    or (state = 'confirmed' and confirmed_on >= occurrence_date and corrected_on is null and skipped_on is null)
    or (
      state = 'corrected' and corrected_on >= occurrence_date
      and original_occurrence_date is not null and original_amount_minor >= 0
      and confirmed_on is null and skipped_on is null
    )
    or (state = 'skipped' and skipped_on >= occurrence_date and confirmed_on is null and corrected_on is null)
  ),
  constraint renewal_events_version_valid check (version >= 1)
);

create table public.reminder_overrides (
  owner_user_id text not null default private.current_clerk_subject(),
  subscription_id text not null,
  lead_days smallint[] not null,
  channels text[] not null,
  version bigint not null default 1,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  primary key (owner_user_id, subscription_id),
  foreign key (owner_user_id, subscription_id)
    references public.subscriptions(owner_user_id, id) on delete cascade,
  constraint reminder_overrides_leads_valid check (
    cardinality(lead_days) between 1 and 10 and 0 <= all(lead_days) and 365 >= all(lead_days)
  ),
  constraint reminder_overrides_channels_valid check (
    cardinality(channels) between 1 and 3 and channels <@ array['in_app', 'native', 'email']::text[]
  ),
  constraint reminder_overrides_version_valid check (version >= 1)
);

create table public.reminder_deliveries (
  owner_user_id text not null,
  idempotency_key text not null,
  subscription_id text not null,
  occurrence_date date not null,
  channel text not null,
  state text not null,
  attempt_count integer not null default 0,
  scheduled_for timestamptz not null,
  delivered_at timestamptz,
  error_code text,
  version bigint not null default 1,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  primary key (owner_user_id, idempotency_key),
  foreign key (owner_user_id, subscription_id)
    references public.subscriptions(owner_user_id, id) on delete cascade,
  constraint reminder_deliveries_channel_valid check (channel in ('in_app', 'native', 'email')),
  constraint reminder_deliveries_state_valid check (state in ('pending', 'claimed', 'delivered', 'failed', 'canceled')),
  constraint reminder_deliveries_attempt_valid check (attempt_count between 0 and 20),
  constraint reminder_deliveries_error_valid check (
    error_code is null or error_code ~ '^[A-Z0-9_]{1,64}$'
  ),
  constraint reminder_deliveries_version_valid check (version >= 1)
);

create table public.fx_rates (
  base_currency text not null,
  quote_currency text not null,
  rate numeric(30, 12) not null,
  effective_at timestamptz not null,
  provider_code text not null,
  created_at timestamptz not null default statement_timestamp(),
  primary key (base_currency, quote_currency, effective_at),
  constraint fx_rates_base_valid check (base_currency ~ '^[A-Z]{3}$'),
  constraint fx_rates_quote_valid check (quote_currency ~ '^[A-Z]{3}$' and quote_currency <> base_currency),
  constraint fx_rates_rate_valid check (rate > 0),
  constraint fx_rates_provider_valid check (provider_code ~ '^[A-Z0-9_]{1,32}$')
);

create table public.security_audit_events (
  owner_user_id text not null,
  id bigint generated always as identity,
  event_type text not null,
  occurred_at timestamptz not null default statement_timestamp(),
  request_id text,
  version bigint not null default 1,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  primary key (owner_user_id, id),
  constraint security_audit_type_valid check (
    event_type in ('export_requested', 'deletion_requested', 'credential_reuse_detected', 'session_revoked')
  ),
  constraint security_audit_request_valid check (
    request_id is null or request_id ~ '^[A-Za-z0-9_-]{1,128}$'
  ),
  constraint security_audit_version_valid check (version >= 1)
);

create trigger user_preferences_owned_row
before update on public.user_preferences
for each row execute function private.enforce_owned_row();
create trigger subscriptions_owned_row
before update on public.subscriptions
for each row execute function private.enforce_owned_row();
create trigger renewal_events_owned_row
before update on public.renewal_events
for each row execute function private.enforce_owned_row();
create trigger reminder_overrides_owned_row
before update on public.reminder_overrides
for each row execute function private.enforce_owned_row();
create trigger reminder_deliveries_owned_row
before update on public.reminder_deliveries
for each row execute function private.enforce_owned_row();
create trigger security_audit_events_owned_row
before update on public.security_audit_events
for each row execute function private.enforce_owned_row();

alter table public.user_preferences enable row level security;
alter table public.user_preferences force row level security;
alter table public.subscriptions enable row level security;
alter table public.subscriptions force row level security;
alter table public.renewal_events enable row level security;
alter table public.renewal_events force row level security;
alter table public.reminder_overrides enable row level security;
alter table public.reminder_overrides force row level security;
alter table public.reminder_deliveries enable row level security;
alter table public.reminder_deliveries force row level security;
alter table public.fx_rates enable row level security;
alter table public.fx_rates force row level security;
alter table public.security_audit_events enable row level security;
alter table public.security_audit_events force row level security;

create policy user_preferences_select on public.user_preferences for select to authenticated
  using (owner_user_id = (select private.current_clerk_subject()));
create policy user_preferences_insert on public.user_preferences for insert to authenticated
  with check (owner_user_id = (select private.current_clerk_subject()));
create policy user_preferences_update on public.user_preferences for update to authenticated
  using (owner_user_id = (select private.current_clerk_subject()))
  with check (owner_user_id = (select private.current_clerk_subject()));
create policy user_preferences_delete on public.user_preferences for delete to authenticated
  using (owner_user_id = (select private.current_clerk_subject()));

create policy subscriptions_select on public.subscriptions for select to authenticated
  using (owner_user_id = (select private.current_clerk_subject()));
create policy subscriptions_insert on public.subscriptions for insert to authenticated
  with check (owner_user_id = (select private.current_clerk_subject()));
create policy subscriptions_update on public.subscriptions for update to authenticated
  using (owner_user_id = (select private.current_clerk_subject()))
  with check (owner_user_id = (select private.current_clerk_subject()));
create policy subscriptions_delete on public.subscriptions for delete to authenticated
  using (owner_user_id = (select private.current_clerk_subject()));

create policy renewal_events_select on public.renewal_events for select to authenticated
  using (owner_user_id = (select private.current_clerk_subject()));
create policy renewal_events_insert on public.renewal_events for insert to authenticated
  with check (owner_user_id = (select private.current_clerk_subject()));
create policy renewal_events_update on public.renewal_events for update to authenticated
  using (owner_user_id = (select private.current_clerk_subject()))
  with check (owner_user_id = (select private.current_clerk_subject()));
create policy renewal_events_delete on public.renewal_events for delete to authenticated
  using (owner_user_id = (select private.current_clerk_subject()));

create policy reminder_overrides_select on public.reminder_overrides for select to authenticated
  using (owner_user_id = (select private.current_clerk_subject()));
create policy reminder_overrides_insert on public.reminder_overrides for insert to authenticated
  with check (owner_user_id = (select private.current_clerk_subject()));
create policy reminder_overrides_update on public.reminder_overrides for update to authenticated
  using (owner_user_id = (select private.current_clerk_subject()))
  with check (owner_user_id = (select private.current_clerk_subject()));
create policy reminder_overrides_delete on public.reminder_overrides for delete to authenticated
  using (owner_user_id = (select private.current_clerk_subject()));

create policy reminder_deliveries_select on public.reminder_deliveries for select to authenticated
  using (owner_user_id = (select private.current_clerk_subject()));
create policy reminder_deliveries_insert on public.reminder_deliveries for insert to authenticated
  with check (owner_user_id = (select private.current_clerk_subject()));
create policy reminder_deliveries_update on public.reminder_deliveries for update to authenticated
  using (owner_user_id = (select private.current_clerk_subject()))
  with check (owner_user_id = (select private.current_clerk_subject()));
create policy reminder_deliveries_delete on public.reminder_deliveries for delete to authenticated
  using (owner_user_id = (select private.current_clerk_subject()));

create policy fx_rates_select on public.fx_rates for select to authenticated
  using ((select private.current_clerk_subject()) is not null);
create policy fx_rates_insert_denied on public.fx_rates for insert to authenticated with check (false);
create policy fx_rates_update_denied on public.fx_rates for update to authenticated using (false) with check (false);
create policy fx_rates_delete_denied on public.fx_rates for delete to authenticated using (false);

create policy security_audit_events_select on public.security_audit_events for select to authenticated
  using (owner_user_id = (select private.current_clerk_subject()));
create policy security_audit_events_insert on public.security_audit_events for insert to authenticated
  with check (owner_user_id = (select private.current_clerk_subject()));
create policy security_audit_events_update on public.security_audit_events for update to authenticated
  using (owner_user_id = (select private.current_clerk_subject()))
  with check (owner_user_id = (select private.current_clerk_subject()));
create policy security_audit_events_delete on public.security_audit_events for delete to authenticated
  using (owner_user_id = (select private.current_clerk_subject()));

revoke all on table public.user_preferences from public, anon, authenticated;
revoke all on table public.subscriptions from public, anon, authenticated;
revoke all on table public.renewal_events from public, anon, authenticated;
revoke all on table public.reminder_overrides from public, anon, authenticated;
revoke all on table public.reminder_deliveries from public, anon, authenticated;
revoke all on table public.fx_rates from public, anon, authenticated;
revoke all on table public.security_audit_events from public, anon, authenticated;

grant select, delete on table public.user_preferences to authenticated;
grant insert (timezone, home_currency, reminder_lead_days, email_reminders_enabled, locale)
  on public.user_preferences to authenticated;
grant update (timezone, home_currency, reminder_lead_days, email_reminders_enabled, locale)
  on public.user_preferences to authenticated;

grant select, delete on table public.subscriptions to authenticated;
grant insert (
  id, kind, service_name, plan_name, amount_minor, currency_code, timezone,
  lifecycle_status, lifecycle_since, trial_ends_on, lifecycle_access_ends_on,
  start_date, purchased_on, access_ends_on, next_renewal_date, recurrence_unit,
  recurrence_interval, account_email, payment_label, management_url, notes
) on public.subscriptions to authenticated;
grant update (
  kind, service_name, plan_name, amount_minor, currency_code, timezone,
  lifecycle_status, lifecycle_since, trial_ends_on, lifecycle_access_ends_on,
  start_date, purchased_on, access_ends_on, next_renewal_date, recurrence_unit,
  recurrence_interval, account_email, payment_label, management_url, notes
) on public.subscriptions to authenticated;

grant select, delete on table public.renewal_events to authenticated;
grant insert (
  idempotency_key, subscription_id, occurrence_date, amount_minor, currency_code,
  state, confirmed_on, corrected_on, skipped_on, original_occurrence_date,
  original_amount_minor
) on public.renewal_events to authenticated;
grant update (
  occurrence_date, amount_minor, currency_code, state, confirmed_on, corrected_on,
  skipped_on, original_occurrence_date, original_amount_minor
) on public.renewal_events to authenticated;

grant select, delete on table public.reminder_overrides to authenticated;
grant insert (subscription_id, lead_days, channels)
  on public.reminder_overrides to authenticated;
grant update (lead_days, channels)
  on public.reminder_overrides to authenticated;

grant select on table public.reminder_deliveries to authenticated;
grant select on table public.fx_rates to authenticated;
grant select on table public.security_audit_events to authenticated;

grant all on table public.user_preferences to service_role;
grant all on table public.subscriptions to service_role;
grant all on table public.renewal_events to service_role;
grant all on table public.reminder_overrides to service_role;
grant all on table public.reminder_deliveries to service_role;
grant all on table public.fx_rates to service_role;
grant all on table public.security_audit_events to service_role;
grant usage, select on all sequences in schema public to service_role;
revoke all on all sequences in schema public from public, anon, authenticated;

create index subscriptions_owner_renewal_idx
  on public.subscriptions(owner_user_id, next_renewal_date)
  where next_renewal_date is not null;
create index renewal_events_owner_occurrence_idx
  on public.renewal_events(owner_user_id, occurrence_date);
create index reminder_deliveries_owner_schedule_idx
  on public.reminder_deliveries(owner_user_id, scheduled_for)
  where state in ('pending', 'claimed');
create index security_audit_events_owner_time_idx
  on public.security_audit_events(owner_user_id, occurred_at desc);
