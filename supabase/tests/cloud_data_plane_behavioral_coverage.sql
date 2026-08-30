begin;
set local role postgres;
set local search_path = extensions, public, pg_catalog;

select plan(23);

create temporary table exposed_schemas (
  schema_name name primary key
) on commit drop;
insert into pg_temp.exposed_schemas(schema_name)
values ('public'), ('graphql_public');

create temporary table behaviorally_exercised (
  role_name name not null,
  table_schema name not null,
  table_name name not null,
  operation_name name not null check (operation_name in ('INSERT', 'UPDATE', 'DELETE')),
  primary key (role_name, table_schema, table_name, operation_name)
) on commit drop;
grant insert on table pg_temp.behaviorally_exercised to anon, authenticated;

create function pg_temp.effective_client_writable_operations()
returns table(role_name name, table_schema name, table_name name, operation_name name)
language sql
security invoker
set search_path = ''
as $$
  select client.role_name, namespace.nspname, relation.relname, operation.operation_name
  from (values ('anon'::name), ('authenticated'::name)) client(role_name)
  cross join pg_catalog.pg_class relation
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  cross join (values ('INSERT'::name), ('UPDATE'::name), ('DELETE'::name)) operation(operation_name)
  where namespace.nspname in (select schema_name from pg_temp.exposed_schemas)
    and relation.relkind in ('r', 'p', 'v', 'm', 'f')
    and (
      pg_catalog.has_table_privilege(
        client.role_name::text,
        relation.oid,
        operation.operation_name::text
      )
      or (
        operation.operation_name in ('INSERT'::name, 'UPDATE'::name)
        and exists (
          select 1
          from pg_catalog.pg_attribute attribute
          where attribute.attrelid = relation.oid
            and attribute.attnum > 0
            and not attribute.attisdropped
            and pg_catalog.has_column_privilege(
              client.role_name::text,
              relation.oid,
              attribute.attnum,
              operation.operation_name::text
            )
        )
      )
    )
$$;

insert into private.clerk_identity_authority(singleton, issuer)
values (true, 'https://fixture.clerk.accounts.dev')
on conflict (singleton) do update set issuer = excluded.issuer;

insert into public.user_preferences(owner_user_id, timezone, home_currency)
values ('user_coverage_b', 'UTC', 'USD');
insert into public.subscriptions(
  owner_user_id, id, kind, service_name, amount_minor, currency_code, timezone,
  lifecycle_status, lifecycle_since, start_date, next_renewal_date,
  recurrence_unit, recurrence_interval
) values
  ('user_coverage_a', 'sub_coverage_a', 'recurring', 'Coverage A', 100, 'USD', 'UTC', 'active', '2026-01-01', '2026-01-01', '2026-02-01', 'month', 1),
  ('user_coverage_b', 'sub_coverage_b', 'recurring', 'Coverage B', 100, 'USD', 'UTC', 'active', '2026-01-01', '2026-01-01', '2026-02-01', 'month', 1);
insert into public.renewal_events(
  owner_user_id, idempotency_key, subscription_id, occurrence_date,
  amount_minor, currency_code, state
) values
  ('user_coverage_a', 'renewal:v1:sub_coverage_a:2026-02-01', 'sub_coverage_a', '2026-02-01', 100, 'USD', 'expected'),
  ('user_coverage_b', 'renewal:v1:sub_coverage_b:2026-02-01', 'sub_coverage_b', '2026-02-01', 100, 'USD', 'expected');
insert into public.reminder_overrides(owner_user_id, subscription_id, lead_days, channels)
values ('user_coverage_b', 'sub_coverage_b', array[7]::smallint[], array['email']);

select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"user_coverage_a","iss":"https://fixture.clerk.accounts.dev","exp":4102444800}',
  true
);
set local role authenticated;

select results_eq(
  $$select owner_user_id from public.user_preferences$$,
  array[]::text[],
  'preference SELECT is behaviorally owner-isolated'
);
select results_eq(
  $$select id from public.subscriptions order by id$$,
  array['sub_coverage_a'::text],
  'subscription SELECT is behaviorally owner-isolated'
);
select results_eq(
  $$select idempotency_key from public.renewal_events$$,
  array['renewal:v1:sub_coverage_a:2026-02-01'::text],
  'renewal SELECT is behaviorally owner-isolated'
);
select results_eq(
  $$select subscription_id from public.reminder_overrides$$,
  array[]::text[],
  'override SELECT is behaviorally owner-isolated'
);

select results_eq(
  $$
    with changed as (
      update public.user_preferences set locale = 'fr'
      where owner_user_id = 'user_coverage_b' returning 1
    ), evidenced as (
      insert into pg_temp.behaviorally_exercised(role_name, table_schema, table_name, operation_name)
      select 'authenticated', 'public', 'user_preferences', 'UPDATE'
      where not exists (select 1 from changed)
      returning 1
    )
    select count(*)::bigint from changed
  $$,
  array[0::bigint],
  'preference UPDATE is behaviorally owner-isolated and records UPDATE evidence'
);
select results_eq(
  $$
    with removed as (
      delete from public.user_preferences where owner_user_id = 'user_coverage_b' returning 1
    ), evidenced as (
      insert into pg_temp.behaviorally_exercised(role_name, table_schema, table_name, operation_name)
      select 'authenticated', 'public', 'user_preferences', 'DELETE'
      where not exists (select 1 from removed)
      returning 1
    )
    select count(*)::bigint from removed
  $$,
  array[0::bigint],
  'preference DELETE is behaviorally owner-isolated and records DELETE evidence'
);
select results_eq(
  $$
    with inserted as (
      insert into public.user_preferences(timezone, home_currency)
      values ('UTC', 'USD') returning 1
    ), evidenced as (
      insert into pg_temp.behaviorally_exercised(role_name, table_schema, table_name, operation_name)
      select 'authenticated', 'public', 'user_preferences', 'INSERT' from inserted
      returning 1
    )
    select count(*)::bigint from inserted
  $$,
  array[1::bigint],
  'preference INSERT derives the owner and records INSERT evidence'
);

select results_eq(
  $$
    with changed as (
      update public.subscriptions set service_name = 'Blocked' where id = 'sub_coverage_b' returning 1
    ), evidenced as (
      insert into pg_temp.behaviorally_exercised(role_name, table_schema, table_name, operation_name)
      select 'authenticated', 'public', 'subscriptions', 'UPDATE'
      where not exists (select 1 from changed)
      returning 1
    )
    select count(*)::bigint from changed
  $$,
  array[0::bigint],
  'subscription UPDATE is behaviorally owner-isolated and records UPDATE evidence'
);
select results_eq(
  $$
    with removed as (
      delete from public.subscriptions where id = 'sub_coverage_b' returning 1
    ), evidenced as (
      insert into pg_temp.behaviorally_exercised(role_name, table_schema, table_name, operation_name)
      select 'authenticated', 'public', 'subscriptions', 'DELETE'
      where not exists (select 1 from removed)
      returning 1
    )
    select count(*)::bigint from removed
  $$,
  array[0::bigint],
  'subscription DELETE is behaviorally owner-isolated and records DELETE evidence'
);
select results_eq(
  $$
    with inserted as (
      insert into public.subscriptions(
        id, kind, service_name, amount_minor, currency_code, timezone,
        lifecycle_status, lifecycle_since, purchased_on
      ) values (
        'sub_coverage_insert', 'one_time', 'Inserted', 100, 'USD', 'UTC',
        'active', '2026-01-01', '2026-01-01'
      ) returning 1
    ), evidenced as (
      insert into pg_temp.behaviorally_exercised(role_name, table_schema, table_name, operation_name)
      select 'authenticated', 'public', 'subscriptions', 'INSERT' from inserted
      returning 1
    )
    select count(*)::bigint from inserted
  $$,
  array[1::bigint],
  'subscription INSERT derives the owner and records INSERT evidence'
);

select results_eq(
  $$
    with changed as (
      update public.renewal_events set amount_minor = 101
      where idempotency_key = 'renewal:v1:sub_coverage_b:2026-02-01' returning 1
    ), evidenced as (
      insert into pg_temp.behaviorally_exercised(role_name, table_schema, table_name, operation_name)
      select 'authenticated', 'public', 'renewal_events', 'UPDATE'
      where not exists (select 1 from changed)
      returning 1
    )
    select count(*)::bigint from changed
  $$,
  array[0::bigint],
  'renewal UPDATE is behaviorally owner-isolated and records UPDATE evidence'
);
select results_eq(
  $$
    with inserted as (
      insert into public.renewal_events(
        idempotency_key, subscription_id, occurrence_date, amount_minor, currency_code
      ) values (
        'renewal:v1:sub_coverage_a:2026-03-01', 'sub_coverage_a', '2026-03-01', 100, 'USD'
      ) returning 1
    ), evidenced as (
      insert into pg_temp.behaviorally_exercised(role_name, table_schema, table_name, operation_name)
      select 'authenticated', 'public', 'renewal_events', 'INSERT' from inserted
      returning 1
    )
    select count(*)::bigint from inserted
  $$,
  array[1::bigint],
  'renewal expected INSERT derives the owner and records INSERT evidence'
);
select throws_ok(
  $$delete from public.renewal_events where idempotency_key = 'renewal:v1:sub_coverage_a:2026-02-01'$$,
  '42501', null,
  'renewal DELETE is denied even for the authenticated owner'
);

select results_eq(
  $$
    with changed as (
      update public.reminder_overrides set lead_days = array[1]::smallint[]
      where subscription_id = 'sub_coverage_b' returning 1
    ), evidenced as (
      insert into pg_temp.behaviorally_exercised(role_name, table_schema, table_name, operation_name)
      select 'authenticated', 'public', 'reminder_overrides', 'UPDATE'
      where not exists (select 1 from changed)
      returning 1
    )
    select count(*)::bigint from changed
  $$,
  array[0::bigint],
  'override UPDATE is behaviorally owner-isolated and records UPDATE evidence'
);
select results_eq(
  $$
    with removed as (
      delete from public.reminder_overrides where subscription_id = 'sub_coverage_b' returning 1
    ), evidenced as (
      insert into pg_temp.behaviorally_exercised(role_name, table_schema, table_name, operation_name)
      select 'authenticated', 'public', 'reminder_overrides', 'DELETE'
      where not exists (select 1 from removed)
      returning 1
    )
    select count(*)::bigint from removed
  $$,
  array[0::bigint],
  'override DELETE is behaviorally owner-isolated and records DELETE evidence'
);
select results_eq(
  $$
    with inserted as (
      insert into public.reminder_overrides(subscription_id, lead_days, channels)
      values ('sub_coverage_a', array[3]::smallint[], array['email']) returning 1
    ), evidenced as (
      insert into pg_temp.behaviorally_exercised(role_name, table_schema, table_name, operation_name)
      select 'authenticated', 'public', 'reminder_overrides', 'INSERT' from inserted
      returning 1
    )
    select count(*)::bigint from inserted
  $$,
  array[1::bigint],
  'override INSERT derives the owner and records INSERT evidence'
);

set local role postgres;
select is_empty(
  $$
    (select * from pg_temp.effective_client_writable_operations()
      except select * from pg_temp.behaviorally_exercised)
    union all
    (select * from pg_temp.behaviorally_exercised
      except select * from pg_temp.effective_client_writable_operations())
  $$,
  'executed operation evidence exactly matches production effective writes'
);

create table public.behavioral_operation_fixture(id integer primary key, value integer not null);
alter table public.behavioral_operation_fixture enable row level security;
alter table public.behavioral_operation_fixture force row level security;
insert into public.behavioral_operation_fixture values (1, 0);
revoke all on table public.behavioral_operation_fixture from public, anon, authenticated;
create policy behavioral_operation_fixture_select on public.behavioral_operation_fixture
  for select to anon, authenticated using (true);
create policy behavioral_operation_fixture_update on public.behavioral_operation_fixture
  for update to anon, authenticated using (true) with check (true);
grant select on table public.behavioral_operation_fixture to public;
grant update (value) on public.behavioral_operation_fixture to public;

set local role anon;
select results_eq(
  $$
    with changed as (
      update public.behavioral_operation_fixture set value = value + 1 where id = 1 returning 1
    ), evidenced as (
      insert into pg_temp.behaviorally_exercised(role_name, table_schema, table_name, operation_name)
      select 'anon', 'public', 'behavioral_operation_fixture', 'UPDATE' from changed
      returning 1
    )
    select count(*)::bigint from changed
  $$,
  array[1::bigint],
  'PUBLIC UPDATE is executed and evidenced for anon'
);
set local role authenticated;
select results_eq(
  $$
    with changed as (
      update public.behavioral_operation_fixture set value = value + 1 where id = 1 returning 1
    ), evidenced as (
      insert into pg_temp.behaviorally_exercised(role_name, table_schema, table_name, operation_name)
      select 'authenticated', 'public', 'behavioral_operation_fixture', 'UPDATE' from changed
      returning 1
    )
    select count(*)::bigint from changed
  $$,
  array[1::bigint],
  'PUBLIC UPDATE is executed and evidenced for authenticated'
);
set local role postgres;
select is_empty(
  $$
    (select * from pg_temp.effective_client_writable_operations()
      except select * from pg_temp.behaviorally_exercised)
    union all
    (select * from pg_temp.behaviorally_exercised
      except select * from pg_temp.effective_client_writable_operations())
  $$,
  'operation evidence exactly includes PUBLIC privilege paths'
);

revoke select on table public.behavioral_operation_fixture from public;
revoke update (value) on public.behavioral_operation_fixture from public;
delete from pg_temp.behaviorally_exercised
where table_name = 'behavioral_operation_fixture';
create role data_plane_inherited_coverage nologin;
grant select on table public.behavioral_operation_fixture to data_plane_inherited_coverage;
grant update (value) on public.behavioral_operation_fixture to data_plane_inherited_coverage;
grant data_plane_inherited_coverage to authenticated;

set local role authenticated;
select results_eq(
  $$
    with changed as (
      update public.behavioral_operation_fixture set value = value + 1 where id = 1 returning 1
    ), evidenced as (
      insert into pg_temp.behaviorally_exercised(role_name, table_schema, table_name, operation_name)
      select 'authenticated', 'public', 'behavioral_operation_fixture', 'UPDATE' from changed
      returning 1
    )
    select count(*)::bigint from changed
  $$,
  array[1::bigint],
  'inherited UPDATE is executed and evidenced for authenticated'
);
set local role postgres;
select is_empty(
  $$
    (select * from pg_temp.effective_client_writable_operations()
      except select * from pg_temp.behaviorally_exercised)
    union all
    (select * from pg_temp.behaviorally_exercised
      except select * from pg_temp.effective_client_writable_operations())
  $$,
  'operation evidence exactly includes inherited privilege paths'
);

revoke data_plane_inherited_coverage from authenticated;
revoke all on table public.behavioral_operation_fixture from data_plane_inherited_coverage;
drop role data_plane_inherited_coverage;
drop table public.behavioral_operation_fixture;
delete from pg_temp.behaviorally_exercised
where table_name = 'behavioral_operation_fixture';

select is_empty(
  $$
    (select * from pg_temp.effective_client_writable_operations()
      except select * from pg_temp.behaviorally_exercised)
    union all
    (select * from pg_temp.behaviorally_exercised
      except select * from pg_temp.effective_client_writable_operations())
  $$,
  'final operation evidence exactly matches anon/authenticated writes across exposed schemas'
);

select * from finish();
rollback;
