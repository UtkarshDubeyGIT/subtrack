create or replace function private.contains_payment_card_number(value text)
returns boolean
language plpgsql
immutable
strict
security invoker
set search_path = ''
as $$
declare
  normalized text;
  candidate text;
  digits text;
  digit integer;
  digit_sum integer;
  digit_position integer;
  digit_length integer;
  double_digit boolean;
  plausible_network boolean;
begin
  normalized := pg_catalog.regexp_replace(
    value,
    U&'[\0009-\000D\0020\0085\00A0\1680\2000-\200A\2028\2029\202F\205F\3000]',
    ' ',
    'g'
  );
  for candidate in
    select part
    from pg_catalog.regexp_split_to_table(normalized, '[^0-9. -]+') as parts(part)
  loop
    digits := pg_catalog.regexp_replace(candidate, '[^0-9]', '', 'g');
    digit_length := pg_catalog.char_length(digits);
    plausible_network :=
      (
        pg_catalog.substr(digits, 1, 1) = '4'
        and digit_length in (13, 16, 19)
      )
      or (
        digit_length = 16
        and (
          pg_catalog.substr(digits, 1, 2)::integer between 51 and 55
          or pg_catalog.substr(digits, 1, 4)::integer between 2221 and 2720
        )
      )
      or (
        digit_length = 15
        and pg_catalog.substr(digits, 1, 2)::integer in (34, 37)
      )
      or (
        digit_length in (16, 19)
        and (
          pg_catalog.substr(digits, 1, 4) = '6011'
          or pg_catalog.substr(digits, 1, 2)::integer = 65
          or pg_catalog.substr(digits, 1, 3)::integer between 644 and 649
          or pg_catalog.substr(digits, 1, 6)::integer between 622126 and 622925
        )
      )
      or (
        digit_length between 16 and 19
        and pg_catalog.substr(digits, 1, 4)::integer between 3528 and 3589
      )
      or (
        digit_length = 14
        and (
          pg_catalog.substr(digits, 1, 3)::integer between 300 and 305
          or pg_catalog.substr(digits, 1, 2)::integer in (36, 38, 39)
        )
      )
      or (
        digit_length between 16 and 19
        and pg_catalog.substr(digits, 1, 2)::integer = 62
      );
    if plausible_network then
      digit_sum := 0;
      double_digit := false;
      for digit_position in reverse digit_length..1 loop
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

alter table public.renewal_events
  alter column state set default 'expected';

drop policy if exists renewal_events_insert on public.renewal_events;
drop policy if exists renewal_events_insert_expected on public.renewal_events;
create policy renewal_events_insert_expected on public.renewal_events
for insert to authenticated
with check (
  owner_user_id = (select private.current_clerk_subject())
  and state = 'expected'
  and confirmed_on is null
  and corrected_on is null
  and skipped_on is null
  and original_occurrence_date is null
  and original_amount_minor is null
  and original_currency_code is null
);

drop policy if exists renewal_events_delete on public.renewal_events;
drop policy if exists renewal_events_delete_denied on public.renewal_events;
create policy renewal_events_delete_denied on public.renewal_events
for delete to authenticated using (false);

revoke insert (
  owner_user_id, idempotency_key, subscription_id, occurrence_date,
  amount_minor, currency_code, state, confirmed_on, corrected_on, skipped_on,
  original_occurrence_date, original_amount_minor, original_currency_code,
  version, created_at, updated_at
) on public.renewal_events from authenticated;
grant insert (
  idempotency_key, subscription_id, occurrence_date, amount_minor, currency_code
) on public.renewal_events to authenticated;
revoke delete on table public.renewal_events from authenticated;
