\set ON_ERROR_STOP on

create extension if not exists dblink with schema extensions;

insert into private.clerk_identity_authority(singleton, issuer)
values (true, 'https://fixture.clerk.accounts.dev')
on conflict (singleton) do update set issuer = excluded.issuer;

insert into public.subscriptions(
  owner_user_id, id, kind, service_name, amount_minor, currency_code,
  timezone, lifecycle_status, lifecycle_since, start_date,
  next_renewal_date, recurrence_unit, recurrence_interval
)
select
  'retention_user',
  'retention_' || pg_catalog.lpad(series::text, 5, '0'),
  'recurring',
  'Retention ' || series,
  100,
  'USD',
  'UTC',
  'active',
  date '2026-01-01',
  date '2026-01-01',
  date '2026-08-01',
  'month',
  1
from pg_catalog.generate_series(1, 256) series;

select pg_catalog.set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"retention_user","iss":"https://fixture.clerk.accounts.dev","exp":4102444800}',
  false
);
set role authenticated;

do $$
declare
  traversal integer;
  page jsonb;
  cursor_value text;
  call_count integer;
begin
  for traversal in 1..3 loop
    cursor_value := null;
    call_count := 0;
    loop
      page := public.calendar_events_page(
        date '2026-08-01', date '2026-08-31', 'charges', '', 1,
        cursor_value
      );
      call_count := call_count + 1;
      exit when page->>'next_cursor' is null;
      if call_count > 800 then
        raise exception 'calendar traversal did not terminate';
      end if;
      cursor_value := page->>'next_cursor';
    end loop;
    if page->>'authoritative' <> 'true'
      or page->>'complete' <> 'true'
      or pg_catalog.jsonb_array_length(page->'events') <> 1
    then
      raise exception 'calendar traversal did not finish authoritatively';
    end if;
  end loop;
end;
$$;

reset role;

create temporary table retention_metrics(
  retained_rows bigint not null,
  expired_rows bigint
);
insert into retention_metrics(retained_rows)
select pg_catalog.count(*)
from calendar_private.cursor_states state
where state.owner_user_id = 'retention_user';

update calendar_private.cursor_states
set created_at = created_at - interval '20 minutes',
    expires_at = statement_timestamp() - interval '1 second'
where owner_user_id = 'retention_user';

do $$
begin
  if pg_catalog.to_regprocedure(
    'calendar_private.cleanup_cursor_retention()'
  ) is not null then
    execute 'select calendar_private.cleanup_cursor_retention()';
  else
    perform calendar_private.issue_cursor(
      'retention_cleanup_probe', 'subscriptions', pg_catalog.md5('probe'),
      null, '{}'::jsonb
    );
  end if;
end;
$$;

update retention_metrics
set expired_rows = (
  select pg_catalog.count(*) from calendar_private.cursor_states
  where expires_at <= statement_timestamp()
);

do $$
declare
  metrics retention_metrics%rowtype;
  retained_bytes bigint;
begin
  select * into metrics from retention_metrics;
  if metrics.retained_rows > 6 or metrics.expired_rows > 0 then
    raise exception
      'three traversals retained % cursor rows; cleanup left % expired rows',
      metrics.retained_rows, metrics.expired_rows;
  end if;
  execute 'select coalesce(sum(retained_bytes), 0) from calendar_private.cursor_states where owner_user_id = $1'
    into retained_bytes using 'retention_user';
  if retained_bytes > 1048576 then
    raise exception 'three traversals retained % cursor bytes', retained_bytes;
  end if;
  if not exists (
    select 1
    from pg_catalog.pg_indexes
    where schemaname = 'calendar_private'
      and tablename = 'cursor_states'
      and indexdef ~ '\(expires_at, token\)'
  ) then
    raise exception 'cursor cleanup lacks a leading expiry index';
  end if;
  if not exists (
    select 1 from cron.job
    where jobname = 'subtrack-calendar-cursor-cleanup'
      and active
  ) then
    raise exception 'cursor cleanup is not scheduled';
  end if;
end;
$$;

create schema test_retention;
create or replace function test_retention.issue_at_subject_cap()
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform calendar_private.issue_cursor(
    'concurrent_quota_user', 'subscriptions', pg_catalog.md5('quota'),
    null, '{}'::jsonb, null
  );
  return 'issued';
exception when sqlstate '54000' then
  return 'capacity';
end;
$$;
create or replace function test_retention.pause_quota_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.owner_user_id = 'concurrent_quota_user' then
    perform pg_catalog.pg_sleep(0.3);
  end if;
  return new;
end;
$$;

insert into calendar_private.cursor_states(
  owner_user_id, cursor_kind, request_hash, cursor_state, retained_bytes
)
select
  'concurrent_quota_user', 'subscriptions', pg_catalog.md5('quota'),
  pg_catalog.jsonb_build_object('fixture', series), 256
from pg_catalog.generate_series(1, 255) series;

create trigger pause_concurrent_quota_insert
before insert on calendar_private.cursor_states
for each row execute function test_retention.pause_quota_insert();

select extensions.dblink_connect(
  'quota_a',
  'host=localhost dbname=postgres user=supabase_admin password=calendar-retention-fixture'
);
select extensions.dblink_connect(
  'quota_b',
  'host=localhost dbname=postgres user=supabase_admin password=calendar-retention-fixture'
);
select extensions.dblink_send_query(
  'quota_a', 'select test_retention.issue_at_subject_cap()'
);
select extensions.dblink_send_query(
  'quota_b', 'select test_retention.issue_at_subject_cap()'
);

create temporary table quota_results(status text);
insert into quota_results
select status from extensions.dblink_get_result('quota_a') result(status text);
insert into quota_results
select status from extensions.dblink_get_result('quota_b') result(status text);

do $$
begin
  if (select count(*) from quota_results where status = 'issued') <> 1
    or (select count(*) from quota_results where status = 'capacity') <> 1
    or (
      select count(*) from calendar_private.cursor_states
      where owner_user_id = 'concurrent_quota_user'
    ) <> 256
  then
    raise exception 'concurrent cursor issuance exceeded the atomic subject cap';
  end if;
end;
$$;

select extensions.dblink_disconnect('quota_a');
select extensions.dblink_disconnect('quota_b');
drop schema test_retention cascade;

select 'calendar cursor retention: PASS' as result;
