begin;

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
    U&'[\2010-\2015\2212\FE58\FE63\FF0D]',
    '-',
    'g'
  );
  normalized := pg_catalog.regexp_replace(
    normalized,
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
      )
      or (
        digit_length between 12 and 19
        and (
          pg_catalog.substr(digits, 1, 4)::integer in (5018, 5020, 5038)
          or pg_catalog.substr(digits, 1, 2)::integer between 56 and 69
        )
      )
      or (
        digit_length between 16 and 19
        and pg_catalog.substr(digits, 1, 4)::integer between 2200 and 2204
      )
      or (
        digit_length = 16
        and (
          pg_catalog.substr(digits, 1, 3)::integer = 508
          or pg_catalog.substr(digits, 1, 2)::integer in (60, 81, 82)
          or pg_catalog.substr(digits, 1, 4)::integer in (6521, 6522)
        )
      )
      or (
        digit_length in (16, 18, 19)
        and (
          pg_catalog.substr(digits, 1, 6)::integer between 506099 and 506198
          or pg_catalog.substr(digits, 1, 6)::integer between 650002 and 650027
        )
      )
      or (
        digit_length = 15
        and pg_catalog.substr(digits, 1, 1) = '1'
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
revoke all on function private.contains_payment_card_number(text)
  from public, anon;
grant execute on function private.contains_payment_card_number(text)
  to authenticated, service_role;

alter table public.subscriptions
  add column category text;

create or replace function private.contains_prohibited_subscription_secret(value text)
returns boolean
language plpgsql
immutable
strict
security definer
set search_path = ''
as $$
declare
  normalized text := value;
  decode_pass integer;
begin
  for decode_pass in 1..2 loop
    normalized := pg_catalog.regexp_replace(normalized, '%23', '#', 'gi');
    normalized := pg_catalog.regexp_replace(normalized, '%2d', '-', 'gi');
    normalized := pg_catalog.regexp_replace(normalized, '%20', ' ', 'gi');
    normalized := pg_catalog.regexp_replace(normalized, '%3a', ':', 'gi');
    normalized := pg_catalog.regexp_replace(normalized, '%3d', '=', 'gi');
    normalized := pg_catalog.regexp_replace(normalized, '%30', '0', 'gi');
    normalized := pg_catalog.regexp_replace(normalized, '%31', '1', 'gi');
    normalized := pg_catalog.regexp_replace(normalized, '%32', '2', 'gi');
    normalized := pg_catalog.regexp_replace(normalized, '%33', '3', 'gi');
    normalized := pg_catalog.regexp_replace(normalized, '%34', '4', 'gi');
    normalized := pg_catalog.regexp_replace(normalized, '%35', '5', 'gi');
    normalized := pg_catalog.regexp_replace(normalized, '%36', '6', 'gi');
    normalized := pg_catalog.regexp_replace(normalized, '%37', '7', 'gi');
    normalized := pg_catalog.regexp_replace(normalized, '%38', '8', 'gi');
    normalized := pg_catalog.regexp_replace(normalized, '%39', '9', 'gi');
    normalized := pg_catalog.regexp_replace(
      normalized,
      '%e2%80%(90|91|92|93|94|95)',
      '-',
      'gi'
    );
    normalized := pg_catalog.regexp_replace(normalized, '%25', '%', 'gi');
  end loop;
  normalized := pg_catalog.replace(normalized, '+', ' ');
  return
    private.contains_payment_card_number(normalized)
    or normalized ~* '\m(cvv2?|cvc2?|cid|security[[:space:]]*code)\M[[:space:]:=#-]*[0-9]{3,4}\M'
    or normalized ~* '\m(password|passcode)\M[[:space:]]*(:|=)[[:space:]]*[^[:space:]]{4,}'
    or normalized ~* '\m(recovery|backup)[[:space:]]+code\M[[:space:]]*(:|=)[[:space:]]*[[:alnum:]][[:alnum:] -]{5,}'
    or normalized ~* '\m((bank[[:space:]]+)?account|routing|sort)[[:space:]]+(number|code)\M[[:space:]]*(:|=)[[:space:]]*[[:alnum:]][[:alnum:] -]{3,}';
end;
$$;

alter function private.contains_prohibited_subscription_secret(text) owner to postgres;
revoke all on function private.contains_prohibited_subscription_secret(text)
  from public, anon;
grant execute on function private.contains_prohibited_subscription_secret(text)
  to authenticated, service_role;

do $$
begin
  if exists (
    select 1
    from public.subscriptions
    where private.contains_prohibited_subscription_secret(service_name)
      or (
        plan_name is not null
        and private.contains_prohibited_subscription_secret(plan_name)
      )
      or (
        account_email is not null
        and private.contains_prohibited_subscription_secret(account_email)
      )
      or (
        payment_label is not null
        and private.contains_prohibited_subscription_secret(payment_label)
      )
      or (
        management_url is not null
        and private.contains_prohibited_subscription_secret(management_url)
      )
      or (
        category is not null
        and private.contains_prohibited_subscription_secret(category)
      )
      or (
        notes is not null
        and private.contains_prohibited_subscription_secret(notes)
      )
  ) then
    raise exception 'existing subscription text requires reviewed secret removal before migration'
      using errcode = '23514';
  end if;
end;
$$;

alter table public.subscriptions
  add constraint subscriptions_category_valid check (
    category is null
    or (
      pg_catalog.char_length(category) between 1 and 80
      and category = pg_catalog.btrim(category)
    )
  ) not valid,
  add constraint subscriptions_service_secret_free check (
    not private.contains_prohibited_subscription_secret(service_name)
  ) not valid,
  add constraint subscriptions_plan_secret_free check (
    plan_name is null
    or not private.contains_prohibited_subscription_secret(plan_name)
  ) not valid,
  add constraint subscriptions_account_email_secret_free check (
    account_email is null
    or not private.contains_prohibited_subscription_secret(account_email)
  ) not valid,
  add constraint subscriptions_payment_label_secret_free check (
    payment_label is null
    or not private.contains_prohibited_subscription_secret(payment_label)
  ) not valid,
  add constraint subscriptions_management_url_secret_free check (
    management_url is null
    or not private.contains_prohibited_subscription_secret(management_url)
  ) not valid,
  add constraint subscriptions_category_secret_free check (
    category is null
    or not private.contains_prohibited_subscription_secret(category)
  ) not valid,
  add constraint subscriptions_notes_secret_free check (
    notes is null
    or not private.contains_prohibited_subscription_secret(notes)
  ) not valid;

alter table public.subscriptions
  validate constraint subscriptions_category_valid,
  validate constraint subscriptions_service_secret_free,
  validate constraint subscriptions_plan_secret_free,
  validate constraint subscriptions_account_email_secret_free,
  validate constraint subscriptions_payment_label_secret_free,
  validate constraint subscriptions_management_url_secret_free,
  validate constraint subscriptions_category_secret_free,
  validate constraint subscriptions_notes_secret_free;

grant insert (category) on public.subscriptions to authenticated;
grant update (category) on public.subscriptions to authenticated;

comment on column public.subscriptions.category is
  'Optional user-owned organizational label; never a credential field.';

commit;
