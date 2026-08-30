begin;

create or replace function private.decode_uri_component(value text)
returns text
language plpgsql
immutable
strict
security invoker
set search_path = ''
as $$
declare
  result text := '';
  cursor_position integer := 1;
  value_length integer := pg_catalog.char_length(value);
  encoded_bytes text;
  hex_pair text;
  decoded_bytes text;
begin
  while cursor_position <= value_length loop
    if pg_catalog.substr(value, cursor_position, 1) <> '%' then
      result := result || pg_catalog.substr(value, cursor_position, 1);
      cursor_position := cursor_position + 1;
      continue;
    end if;

    encoded_bytes := '';
    while cursor_position <= value_length
      and pg_catalog.substr(value, cursor_position, 1) = '%'
    loop
      if cursor_position + 2 > value_length then
        return null;
      end if;
      hex_pair := pg_catalog.substr(value, cursor_position + 1, 2);
      if hex_pair !~ '^[0-9A-Fa-f]{2}$' then
        return null;
      end if;
      encoded_bytes := encoded_bytes || hex_pair;
      cursor_position := cursor_position + 3;
    end loop;

    begin
      decoded_bytes := pg_catalog.convert_from(
        pg_catalog.decode(encoded_bytes, 'hex'),
        'UTF8'
      );
    exception
      when others then
        return null;
    end;
    result := result || decoded_bytes;
  end loop;
  return result;
end;
$$;

alter function private.decode_uri_component(text) owner to postgres;
revoke all on function private.decode_uri_component(text)
  from public, anon, authenticated, service_role;

create or replace function private.contains_prohibited_subscription_secret(value text)
returns boolean
language plpgsql
immutable
strict
security definer
set search_path = ''
as $$
declare
  current_value text := value;
  normalized text;
  decoded text;
  normalization_pass integer;
begin
  for normalization_pass in 0..2 loop
    normalized := normalize(current_value, NFKC);
    normalized := pg_catalog.regexp_replace(
      normalized,
      U&'[\002D\058A\05BE\1400\1806\2010-\2015\2212\2E17\2E1A\2E3A\2E3B\2E40\2E5D\301C\3030\30A0\FE31\FE32\FE58\FE63\FF0D]',
      '-',
      'g'
    );
    normalized := pg_catalog.regexp_replace(
      normalized,
      U&'\+010EAD',
      '-',
      'g'
    );
    normalized := pg_catalog.replace(normalized, '+', ' ');

    if private.contains_payment_card_number(normalized)
      or normalized ~* '\m(cvv2?|cvc2?|cid|security[[:space:]]*code)\M[[:space:]:=#-]*[0-9]{3,4}\M'
      or normalized ~* '\m(password|passcode)\M[[:space:]]*(:|=)[[:space:]]*[^[:space:]]{4,}'
      or normalized ~* '\m(recovery|backup)[[:space:]]+code\M[[:space:]]*(:|=)[[:space:]]*[[:alnum:]][[:alnum:] -]{5,}'
      or normalized ~* '\m((bank[[:space:]]+)?account|routing|sort)[[:space:]]+(number|code)\M[[:space:]]*(:|=)[[:space:]]*[[:alnum:]][[:alnum:] -]{3,}'
    then
      return true;
    end if;

    if normalization_pass = 2 then
      return false;
    end if;
    decoded := private.decode_uri_component(current_value);
    if decoded is null or decoded = current_value then
      return false;
    end if;
    current_value := decoded;
  end loop;
  return false;
end;
$$;

alter function private.contains_prohibited_subscription_secret(text)
  owner to postgres;
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
    raise exception 'existing subscription text requires reviewed normalization before migration'
      using errcode = '23514';
  end if;
end;
$$;

comment on function private.decode_uri_component(text) is
  'Strict UTF-8 percent decoder used only by the subscription secret invariant.';
comment on function private.contains_prohibited_subscription_secret(text) is
  'Screens NFKC and up to two URI-decoded variants using the shared subscription secret policy.';

commit;
