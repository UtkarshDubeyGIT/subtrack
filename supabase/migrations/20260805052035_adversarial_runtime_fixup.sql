create or replace function private.assert_corrected_renewal_currency_ready()
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.renewal_events
    where state = 'corrected' and original_currency_code is null
  ) then
    raise exception 'legacy corrected renewals require original_currency_code backfill before migration'
      using errcode = '23514';
  end if;
end;
$$;

revoke all on function private.assert_corrected_renewal_currency_ready() from public, anon, authenticated, service_role;
select private.assert_corrected_renewal_currency_ready();

alter table public.subscriptions
  drop constraint subscriptions_schedule_valid,
  add constraint subscriptions_schedule_valid check (
    (
      kind = 'recurring'
      and start_date is not null
      and purchased_on is null
      and access_ends_on is null
      and next_renewal_date is not null
      and next_renewal_date >= start_date
      and recurrence_unit is not null
      and recurrence_unit in ('day', 'week', 'month', 'year')
      and recurrence_interval is not null
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

create table private.data_plane_exposed_schemas (
  schema_name name primary key
);
insert into private.data_plane_exposed_schemas(schema_name)
values ('public'), ('graphql_public');

create table private.data_plane_behavioral_test_registry (
  table_schema name not null,
  table_name name not null,
  primary key (table_schema, table_name),
  foreign key (table_schema)
    references private.data_plane_exposed_schemas(schema_name)
);
insert into private.data_plane_behavioral_test_registry(table_schema, table_name)
values
  ('public', 'user_preferences'),
  ('public', 'subscriptions'),
  ('public', 'renewal_events'),
  ('public', 'reminder_overrides');

revoke all on table private.data_plane_exposed_schemas from public, anon, authenticated, service_role;
revoke all on table private.data_plane_behavioral_test_registry from public, anon, authenticated, service_role;
