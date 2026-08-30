create or replace function private.contains_payment_card_number(value text)
returns boolean
language plpgsql
immutable
strict
security invoker
set search_path = ''
as $$
declare
  candidate text;
  digits text;
  digit integer;
  digit_sum integer;
  digit_position integer;
  double_digit boolean;
begin
  for candidate in
    select part
    from pg_catalog.regexp_split_to_table(value, '[^0-9 -]+') as parts(part)
  loop
    digits := pg_catalog.regexp_replace(candidate, '[^0-9]', '', 'g');
    if pg_catalog.char_length(digits) between 13 and 19
      and pg_catalog.substr(digits, 1, 1) <> '0'
    then
      digit_sum := 0;
      double_digit := false;
      for digit_position in reverse pg_catalog.char_length(digits)..1 loop
        digit := pg_catalog.substr(digits, digit_position, 1)::integer;
        if double_digit then
          digit := digit * 2;
          if digit > 9 then
            digit := digit - 9;
          end if;
        end if;
        digit_sum := digit_sum + digit;
        double_digit := not double_digit;
      end loop;
      if digit_sum % 10 = 0 then
        return true;
      end if;
    end if;
  end loop;
  return false;
end;
$$;

alter function private.contains_payment_card_number(text) owner to postgres;
revoke all on function private.contains_payment_card_number(text) from public, anon;
grant execute on function private.contains_payment_card_number(text) to authenticated, service_role;

alter table public.reminder_deliveries
  add constraint reminder_deliveries_idempotency_valid check (
    pg_catalog.char_length(idempotency_key) between 1 and 256
  );

alter table public.security_audit_events
  add constraint security_audit_owner_valid check (
    pg_catalog.char_length(owner_user_id) between 1 and 512
    and owner_user_id = pg_catalog.btrim(owner_user_id)
  );

alter table public.subscriptions
  add constraint subscriptions_management_url_credentials_free check (
    management_url is null
    or management_url !~ '^https://[^/?#]*@'
  ),
  add constraint subscriptions_payment_label_pan_free check (
    payment_label is null
    or not private.contains_payment_card_number(payment_label)
  ),
  add constraint subscriptions_notes_pan_free check (
    notes is null
    or not private.contains_payment_card_number(notes)
  );

create or replace function private.enforce_subscription_lifecycle_transition()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.lifecycle_status = old.lifecycle_status then
    if new.lifecycle_since is distinct from old.lifecycle_since
      or new.trial_ends_on is distinct from old.trial_ends_on
      or new.lifecycle_access_ends_on is distinct from old.lifecycle_access_ends_on
    then
      raise exception 'same-state updates cannot rewrite lifecycle history'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if new.lifecycle_since < old.lifecycle_since then
    raise exception 'lifecycle transitions cannot move backward'
      using errcode = '23514';
  end if;

  if old.lifecycle_status = 'trial' and new.lifecycle_status = 'active' then
    if new.lifecycle_since < old.trial_ends_on then
      raise exception 'trial activation cannot precede the trial boundary'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if old.lifecycle_status = 'active' and new.lifecycle_status in ('paused', 'expired') then
    return new;
  end if;

  if old.lifecycle_status = 'paused' and new.lifecycle_status = 'active' then
    return new;
  end if;

  if old.lifecycle_status in ('trial', 'active', 'paused')
    and new.lifecycle_status = 'canceled'
  then
    return new;
  end if;

  if old.lifecycle_status = 'canceled' and new.lifecycle_status = 'expired' then
    if new.lifecycle_since < old.lifecycle_access_ends_on then
      raise exception 'canceled access cannot expire before its access boundary'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if old.lifecycle_status = 'expired' and new.lifecycle_status = 'active' then
    return new;
  end if;

  raise exception 'invalid subscription lifecycle transition'
    using errcode = '23514';
end;
$$;

alter function private.enforce_subscription_lifecycle_transition() owner to postgres;
revoke all on function private.enforce_subscription_lifecycle_transition() from public, anon, authenticated, service_role;

create trigger subscriptions_lifecycle_transition_guard
before update on public.subscriptions
for each row execute function private.enforce_subscription_lifecycle_transition();

create or replace function private.enforce_renewal_transition()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.idempotency_key is distinct from old.idempotency_key
    or new.subscription_id is distinct from old.subscription_id
  then
    raise exception 'renewal identity is immutable'
      using errcode = '23514';
  end if;

  if new.state = old.state then
    if new.occurrence_date is distinct from old.occurrence_date
      or new.amount_minor is distinct from old.amount_minor
      or new.currency_code is distinct from old.currency_code
      or new.confirmed_on is distinct from old.confirmed_on
      or new.corrected_on is distinct from old.corrected_on
      or new.skipped_on is distinct from old.skipped_on
      or new.original_occurrence_date is distinct from old.original_occurrence_date
      or new.original_amount_minor is distinct from old.original_amount_minor
      or new.original_currency_code is distinct from old.original_currency_code
    then
      raise exception 'same-state updates cannot rewrite renewal history'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if old.state = 'expected' and new.state in ('confirmed', 'skipped') then
    if new.occurrence_date is distinct from old.occurrence_date
      or new.amount_minor is distinct from old.amount_minor
      or new.currency_code is distinct from old.currency_code
    then
      raise exception 'renewal terminal transitions cannot rewrite expected values'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if old.state in ('expected', 'confirmed') and new.state = 'corrected' then
    if new.original_occurrence_date is distinct from old.occurrence_date
      or new.original_amount_minor is distinct from old.amount_minor
      or new.original_currency_code is distinct from old.currency_code
    then
      raise exception 'renewal corrections must preserve the prior snapshot'
        using errcode = '23514';
    end if;
    return new;
  end if;

  raise exception 'invalid renewal state transition'
    using errcode = '23514';
end;
$$;

alter function private.enforce_renewal_transition() owner to postgres;
revoke all on function private.enforce_renewal_transition() from public, anon, authenticated, service_role;

create trigger renewal_events_transition_guard
before update on public.renewal_events
for each row execute function private.enforce_renewal_transition();

drop table if exists private.data_plane_behavioral_test_registry;
drop table if exists private.data_plane_exposed_schemas;
