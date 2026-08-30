begin;

create or replace function private.contains_uri_userinfo(value text)
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
    if normalized ~ '^https://[^/?#]*@' then
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

alter function private.contains_uri_userinfo(text) owner to postgres;
revoke all on function private.contains_uri_userinfo(text)
  from public, anon;
grant execute on function private.contains_uri_userinfo(text)
  to authenticated, service_role;

create or replace function private.is_subscription_occurrence(
  anchor_date date,
  candidate_date date,
  recurrence_unit text,
  recurrence_interval integer
)
returns boolean
language plpgsql
immutable
strict
security invoker
set search_path = ''
as $$
declare
  month_distance integer;
  step_months integer;
  candidate_last_day integer;
begin
  if candidate_date < anchor_date
    or recurrence_interval < 1
    or recurrence_interval > 1200
  then
    return false;
  end if;

  if recurrence_unit = 'day' then
    return (candidate_date - anchor_date) % recurrence_interval = 0;
  end if;

  if recurrence_unit = 'week' then
    return (candidate_date - anchor_date) % (recurrence_interval * 7) = 0;
  end if;

  if recurrence_unit not in ('month', 'year') then
    return false;
  end if;

  month_distance := (
    extract(year from candidate_date)::integer
    - extract(year from anchor_date)::integer
  ) * 12 + (
    extract(month from candidate_date)::integer
    - extract(month from anchor_date)::integer
  );
  step_months := recurrence_interval * (
    case when recurrence_unit = 'year' then 12 else 1 end
  );

  if month_distance % step_months <> 0 then
    return false;
  end if;

  candidate_last_day := extract(
    day from (
      pg_catalog.date_trunc('month', candidate_date::timestamp)
      + interval '1 month - 1 day'
    )
  )::integer;

  return extract(day from candidate_date)::integer = least(
    extract(day from anchor_date)::integer,
    candidate_last_day
  );
end;
$$;

alter function private.is_subscription_occurrence(date, date, text, integer)
  owner to postgres;
revoke all on function private.is_subscription_occurrence(date, date, text, integer)
  from public, anon;
grant execute on function private.is_subscription_occurrence(date, date, text, integer)
  to authenticated, service_role;

lock table public.subscriptions in access exclusive mode;

do $$
begin
  if exists (
    select 1
    from public.subscriptions
    where (
      management_url is not null
      and private.contains_uri_userinfo(management_url)
    ) or (
      kind = 'recurring'
      and not private.is_subscription_occurrence(
        start_date,
        next_renewal_date,
        recurrence_unit,
        recurrence_interval
      )
    )
  ) then
    raise exception 'existing subscriptions require reviewed URL or recurrence reconciliation'
      using errcode = '23514';
  end if;
end;
$$;

alter table public.subscriptions
  drop constraint subscriptions_management_url_credentials_free,
  add constraint subscriptions_management_url_credentials_free check (
    management_url is null
    or not private.contains_uri_userinfo(management_url)
  ) not valid,
  add constraint subscriptions_recurrence_aligned check (
    kind <> 'recurring'
    or private.is_subscription_occurrence(
      start_date,
      next_renewal_date,
      recurrence_unit,
      recurrence_interval
    )
  ) not valid;

alter table public.subscriptions
  validate constraint subscriptions_management_url_credentials_free,
  validate constraint subscriptions_recurrence_aligned;

comment on function private.contains_uri_userinfo(text) is
  'Screens NFKC and up to two URI-decoded variants for authority userinfo.';
comment on function private.is_subscription_occurrence(date, date, text, integer) is
  'Checks an anchored day, week, month, or year recurrence without iterative projection.';

commit;
