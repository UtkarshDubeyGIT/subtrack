\set ON_ERROR_STOP on

create extension if not exists dblink with schema extensions;

insert into private.clerk_identity_authority(singleton, issuer)
values (true, 'https://fixture.clerk.accounts.dev')
on conflict (singleton) do update set issuer = excluded.issuer;

create schema test_serialization;

create or replace function test_serialization.set_subject(subject text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object(
      'role', 'authenticated',
      'sub', subject,
      'iss', 'https://fixture.clerk.accounts.dev',
      'exp', 4102444800
    )::text,
    true
  );
end;
$$;

create or replace function test_serialization.calendar_call(
  subject text,
  continuation text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  page jsonb;
begin
  perform test_serialization.set_subject(subject);
  page := public.calendar_events_page(
    date '2026-08-01', date '2026-08-31', 'charges', '', 2, continuation
  );
  return pg_catalog.jsonb_build_object(
    'completed_at', pg_catalog.clock_timestamp(),
    'page', page
  );
end;
$$;

create or replace function test_serialization.mutate(
  subject text,
  mutation_kind text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform test_serialization.set_subject(subject);
  case mutation_kind
    when 'delete' then
      delete from public.subscriptions
      where owner_user_id = subject and id = 'race_00001';
    when 'reschedule' then
      update public.subscriptions
      set next_renewal_date = date '2026-09-01'
      where owner_user_id = subject and id = 'race_00001';
    when 'lifecycle' then
      update public.subscriptions
      set lifecycle_status = 'paused', lifecycle_since = date '2026-08-15'
      where owner_user_id = subject and id = 'race_00001';
    when 'correction' then
      insert into public.renewal_events(
        owner_user_id, idempotency_key, subscription_id, occurrence_date,
        amount_minor, currency_code, state, corrected_on,
        original_occurrence_date, original_amount_minor,
        original_currency_code
      ) values (
        subject, 'serialization_correction', 'race_00001', date '2026-08-20',
        90, 'USD', 'corrected', date '2026-08-20', date '2026-08-01',
        100, 'USD'
      );
    else
      raise exception 'unknown mutation';
  end case;
  return pg_catalog.jsonb_build_object(
    'completed_at', pg_catalog.clock_timestamp()
  );
end;
$$;

create or replace function test_serialization.block_root_cursor_issue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.owner_user_id = 'serialization_root' then
    perform pg_catalog.pg_advisory_xact_lock(74291, 1);
  end if;
  return new;
end;
$$;

create trigger block_serialization_root_cursor_issue
before insert on calendar_private.cursor_states
for each row execute function test_serialization.block_root_cursor_issue();

insert into public.subscriptions(
  owner_user_id, id, kind, service_name, amount_minor, currency_code,
  timezone, lifecycle_status, lifecycle_since, start_date,
  next_renewal_date, recurrence_unit, recurrence_interval
)
select
  fixture.subject,
  'race_' || pg_catalog.lpad(series::text, 5, '0'),
  'recurring',
  fixture.label || series,
  100,
  'USD',
  'UTC',
  'active',
  date '2026-01-01',
  date '2026-01-01',
  date '2026-08-01',
  'day',
  1
from (
  values
    ('serialization_delete', 'Delete '),
    ('serialization_root', 'Root '),
    ('serialization_replay', 'Replay '),
    ('serialization_correction', 'Correction ')
) fixture(subject, label)
cross join pg_catalog.generate_series(1, 257) series;

-- A continuation must acquire the account serialization lock before it waits
-- for its cursor row, so a delete cannot slip past and invalidate its result.
create temporary table delete_first_phase as
select test_serialization.calendar_call(
  'serialization_delete', null
)->'page' as page;

select extensions.dblink_connect(
  'delete_calendar',
  'host=localhost dbname=postgres user=supabase_admin password=serialization-fixture'
);
select extensions.dblink_connect(
  'delete_mutation',
  'host=localhost dbname=postgres user=supabase_admin password=serialization-fixture'
);

begin;
select token
from calendar_private.cursor_states
where pg_catalog.replace(token::text, '-', '') = (
  select page->>'next_cursor' from delete_first_phase
)
for update;
select extensions.dblink_send_query(
  'delete_calendar',
  pg_catalog.format(
    'select test_serialization.calendar_call(%L, %L) as result',
    'serialization_delete',
    (select page->>'next_cursor' from delete_first_phase)
  )
);
select pg_catalog.pg_sleep(0.2);
select extensions.dblink_send_query(
  'delete_mutation',
  'select test_serialization.mutate(''serialization_delete'', ''delete'') as result'
);
select pg_catalog.pg_sleep(0.3);
do $$
begin
  if extensions.dblink_is_busy('delete_calendar') <> 1 then
    raise exception 'continuation did not block on the held cursor row';
  end if;
  if extensions.dblink_is_busy('delete_mutation') <> 1 then
    raise exception 'delete committed while the continuation was blocked';
  end if;
end;
$$;
commit;

create temporary table delete_calendar_result as
select result
from extensions.dblink_get_result('delete_calendar') as response(result jsonb);
create temporary table delete_mutation_result as
select result
from extensions.dblink_get_result('delete_mutation') as response(result jsonb);
do $$
begin
  if (select (result->>'completed_at')::timestamptz from delete_calendar_result)
    > (select (result->>'completed_at')::timestamptz from delete_mutation_result)
  then
    raise exception 'delete serialized before the authoritative continuation';
  end if;
  if exists (
    select 1 from public.subscriptions
    where owner_user_id = 'serialization_delete' and id = 'race_00001'
  ) then
    raise exception 'delete mutation did not commit';
  end if;
end;
$$;
select extensions.dblink_disconnect('delete_calendar');
select extensions.dblink_disconnect('delete_mutation');

-- A root call has no cursor row to serialize on. Pause it at cursor issuance,
-- after source materialization, and prove a reschedule remains blocked.
select extensions.dblink_connect(
  'root_calendar',
  'host=localhost dbname=postgres user=supabase_admin password=serialization-fixture'
);
select extensions.dblink_connect(
  'root_mutation',
  'host=localhost dbname=postgres user=supabase_admin password=serialization-fixture'
);
begin;
select pg_catalog.pg_advisory_xact_lock(74291, 1);
select extensions.dblink_send_query(
  'root_calendar',
  'select test_serialization.calendar_call(''serialization_root'', null) as result'
);
select pg_catalog.pg_sleep(0.2);
select extensions.dblink_send_query(
  'root_mutation',
  'select test_serialization.mutate(''serialization_root'', ''reschedule'') as result'
);
select pg_catalog.pg_sleep(0.3);
do $$
begin
  if extensions.dblink_is_busy('root_calendar') <> 1 then
    raise exception 'calendar root did not block at cursor issuance';
  end if;
  if extensions.dblink_is_busy('root_mutation') <> 1 then
    raise exception 'reschedule committed while root truth was being constructed';
  end if;
end;
$$;
commit;
create temporary table root_calendar_result as
select result
from extensions.dblink_get_result('root_calendar') as response(result jsonb);
create temporary table root_mutation_result as
select result
from extensions.dblink_get_result('root_mutation') as response(result jsonb);
do $$
begin
  if (select (result->>'completed_at')::timestamptz from root_calendar_result)
    > (select (result->>'completed_at')::timestamptz from root_mutation_result)
  then
    raise exception 'reschedule serialized before the calendar root';
  end if;
end;
$$;
select extensions.dblink_disconnect('root_calendar');
select extensions.dblink_disconnect('root_mutation');

-- A replay takes the same revision lock before reading its cached response.
create temporary table replay_first_phase as
select test_serialization.calendar_call(
  'serialization_replay', null
)->'page' as page;
create temporary table replay_consumed as
select test_serialization.calendar_call(
  'serialization_replay', (select page->>'next_cursor' from replay_first_phase)
)->'page' as page;
select extensions.dblink_connect(
  'replay_calendar',
  'host=localhost dbname=postgres user=supabase_admin password=serialization-fixture'
);
select extensions.dblink_connect(
  'replay_mutation',
  'host=localhost dbname=postgres user=supabase_admin password=serialization-fixture'
);
begin;
select token
from calendar_private.cursor_states
where pg_catalog.replace(token::text, '-', '') = (
  select page->>'next_cursor' from replay_first_phase
)
for update;
select extensions.dblink_send_query(
  'replay_calendar',
  pg_catalog.format(
    'select test_serialization.calendar_call(%L, %L) as result',
    'serialization_replay',
    (select page->>'next_cursor' from replay_first_phase)
  )
);
select pg_catalog.pg_sleep(0.2);
select extensions.dblink_send_query(
  'replay_mutation',
  'select test_serialization.mutate(''serialization_replay'', ''lifecycle'') as result'
);
select pg_catalog.pg_sleep(0.3);
do $$
begin
  if extensions.dblink_is_busy('replay_calendar') <> 1 then
    raise exception 'cached replay did not block on the held cursor row';
  end if;
  if extensions.dblink_is_busy('replay_mutation') <> 1 then
    raise exception 'lifecycle mutation committed while replay was blocked';
  end if;
end;
$$;
commit;
create temporary table replay_calendar_result as
select result
from extensions.dblink_get_result('replay_calendar') as response(result jsonb);
create temporary table replay_mutation_result as
select result
from extensions.dblink_get_result('replay_mutation') as response(result jsonb);
do $$
begin
  if (select (result->>'completed_at')::timestamptz from replay_calendar_result)
    > (select (result->>'completed_at')::timestamptz from replay_mutation_result)
  then
    raise exception 'lifecycle mutation serialized before cached replay';
  end if;
end;
$$;
select extensions.dblink_disconnect('replay_calendar');
select extensions.dblink_disconnect('replay_mutation');

-- Renewal corrections use the same protocol as subscription mutations.
create temporary table correction_first_phase as
select test_serialization.calendar_call(
  'serialization_correction', null
)->'page' as page;
select extensions.dblink_connect(
  'correction_calendar',
  'host=localhost dbname=postgres user=supabase_admin password=serialization-fixture'
);
select extensions.dblink_connect(
  'correction_mutation',
  'host=localhost dbname=postgres user=supabase_admin password=serialization-fixture'
);
begin;
select token
from calendar_private.cursor_states
where pg_catalog.replace(token::text, '-', '') = (
  select page->>'next_cursor' from correction_first_phase
)
for update;
select extensions.dblink_send_query(
  'correction_calendar',
  pg_catalog.format(
    'select test_serialization.calendar_call(%L, %L) as result',
    'serialization_correction',
    (select page->>'next_cursor' from correction_first_phase)
  )
);
select pg_catalog.pg_sleep(0.2);
select extensions.dblink_send_query(
  'correction_mutation',
  'select test_serialization.mutate(''serialization_correction'', ''correction'') as result'
);
select pg_catalog.pg_sleep(0.3);
do $$
begin
  if extensions.dblink_is_busy('correction_calendar') <> 1 then
    raise exception 'correction continuation did not block on its cursor row';
  end if;
  if extensions.dblink_is_busy('correction_mutation') <> 1 then
    raise exception 'correction committed while continuation was blocked';
  end if;
end;
$$;
commit;
create temporary table correction_calendar_result as
select result
from extensions.dblink_get_result('correction_calendar') as response(result jsonb);
create temporary table correction_mutation_result as
select result
from extensions.dblink_get_result('correction_mutation') as response(result jsonb);
do $$
begin
  if (select (result->>'completed_at')::timestamptz from correction_calendar_result)
    > (select (result->>'completed_at')::timestamptz from correction_mutation_result)
  then
    raise exception 'correction serialized before authoritative continuation';
  end if;
  if not exists (
    select 1 from public.renewal_events
    where owner_user_id = 'serialization_correction'
      and idempotency_key = 'serialization_correction'
  ) then
    raise exception 'correction mutation did not commit';
  end if;
end;
$$;
select extensions.dblink_disconnect('correction_calendar');
select extensions.dblink_disconnect('correction_mutation');

drop schema test_serialization cascade;

select 'calendar transaction serialization: PASS' as result;
