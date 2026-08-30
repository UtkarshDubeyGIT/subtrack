begin;
set local role postgres;
set local search_path = extensions, public, pg_catalog;

select plan(27);

select has_function(
  'public',
  'calendar_events_page',
  array['date', 'date', 'text', 'text', 'integer', 'text'],
  'calendar range RPC has the narrow predicate and cursor contract'
);

select function_returns(
  'public',
  'calendar_events_page',
  array['date', 'date', 'text', 'text', 'integer', 'text'],
  'jsonb',
  'calendar range RPC returns one bounded page envelope'
);

select ok(
  not pg_catalog.has_function_privilege(
    'anon',
    'public.calendar_events_page(date,date,text,text,integer,text)',
    'EXECUTE'
  ) and pg_catalog.has_function_privilege(
    'authenticated',
    'public.calendar_events_page(date,date,text,text,integer,text)',
    'EXECUTE'
  ),
  'only authenticated clients can execute the calendar RPC'
);

select ok(
  not (
    select procedure.prosecdef
    from pg_catalog.pg_proc procedure
    where procedure.oid = 'public.calendar_events_page(date,date,text,text,integer,text)'::regprocedure
  ),
  'calendar RPC remains security invoker'
);

select ok(
  to_regprocedure(
    'calendar_private.subscription_occurrences(date,date,text,integer,date,date)'
  ) is not null,
  'bounded recurrence helper exists'
);

select results_eq(
  $$
    select occurrence::text
    from calendar_private.subscription_occurrences(
      date '2024-01-31', date '2024-01-31', 'month', 1,
      date '2024-02-01', date '2024-04-30'
    ) occurrence
  $$,
  array['2024-02-29', '2024-03-31', '2024-04-30']::text[],
  'month-end recurrence seeks directly and re-anchors every month'
);

select results_eq(
  $$
    select occurrence::text
    from calendar_private.subscription_occurrences(
      date '2024-02-29', date '2024-02-29', 'year', 1,
      date '2025-01-01', date '2028-12-31'
    ) occurrence
  $$,
  array['2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29']::text[],
  'leap-year recurrence parity is anchored rather than iteratively drifted'
);

select results_eq(
  $$
    select occurrence::text
    from calendar_private.subscription_occurrences(
      date '1900-01-01', date '1900-01-01', 'day', 1200,
      date '9990-01-01', date '9999-12-31'
    ) occurrence
  $$,
  array['9992-02-28', '9995-06-12', '9998-09-24']::text[],
  'large historical daily schedules seek to the requested range'
);

select results_eq(
  $$
    select occurrence::text
    from calendar_private.subscription_occurrences(
      date '2024-02-29', date '2025-08-29', 'month', 18,
      date '2026-01-01', date '2030-12-31'
    ) occurrence
  $$,
  array['2027-02-28', '2028-08-29', '2030-02-28']::text[],
  'custom month interval honors the persisted next occurrence boundary'
);

select results_eq(
  $$
    select occurrence::text
    from calendar_private.subscription_occurrences(
      date '9999-12-31', date '9999-12-31', 'year', 1,
      date '9999-12-31', date '9999-12-31'
    ) occurrence
  $$,
  array['9999-12-31']::text[],
  'supported maximum recurrence boundary saturates without overflow'
);

reset role;

insert into private.clerk_identity_authority(singleton, issuer)
values (true, 'https://fixture.clerk.accounts.dev')
on conflict (singleton) do update set issuer = excluded.issuer;

insert into public.subscriptions(
  owner_user_id, id, kind, service_name, plan_name, category, amount_minor,
  currency_code, timezone, lifecycle_status, lifecycle_since, trial_ends_on,
  lifecycle_access_ends_on, start_date, purchased_on, access_ends_on,
  next_renewal_date, recurrence_unit, recurrence_interval
) values
  ('user_calendar_a', 'sub_active', 'recurring', 'Alpha active', 'Standard', 'Streaming', 1299, 'USD', 'UTC', 'active', '2026-01-31', null, null, '2026-01-31', null, null, '2026-08-31', 'month', 1),
  ('user_calendar_a', 'sub_trial', 'recurring', 'Beta trial', null, 'Work', 900, 'USD', 'UTC', 'trial', '2026-08-01', '2026-08-15', null, '2026-08-15', null, null, '2026-08-15', 'month', 1),
  ('user_calendar_a', 'sub_paused', 'recurring', 'Gamma paused', null, null, 500, 'USD', 'UTC', 'paused', '2026-08-12', null, null, '2026-01-12', null, null, '2026-08-12', 'month', 1),
  ('user_calendar_a', 'sub_canceled', 'recurring', 'Delta canceled', null, null, 700, 'USD', 'UTC', 'canceled', '2026-08-10', null, '2026-08-20', '2026-01-10', null, null, '2026-08-10', 'month', 1),
  ('user_calendar_a', 'sub_expired', 'recurring', 'Epsilon expired', null, null, 700, 'USD', 'UTC', 'expired', '2026-08-05', null, null, '2026-01-05', null, null, '2026-08-05', 'month', 1),
  ('user_calendar_a', 'sub_one_time', 'one_time', 'Zeta pass', null, 'Software', 4900, 'USD', 'UTC', 'active', '2026-08-08', null, null, null, '2026-08-08', '2026-08-30', null, null, null),
  ('user_calendar_a', 'sub_corrected', 'recurring', 'Eta corrected', 'Family', 'Streaming', 1500, 'USD', 'UTC', 'active', '2026-01-31', null, null, '2026-01-31', null, null, '2026-08-31', 'month', 1),
  ('user_calendar_b', 'sub_other', 'recurring', 'Other private', null, null, 2000, 'USD', 'UTC', 'active', '2026-01-31', null, null, '2026-01-31', null, null, '2026-08-31', 'month', 1);

insert into public.renewal_events(
  owner_user_id, idempotency_key, subscription_id, occurrence_date,
  amount_minor, currency_code, state, corrected_on,
  original_occurrence_date, original_amount_minor, original_currency_code
) values
  ('user_calendar_a', 'correction-a', 'sub_corrected', '2026-10-05', 1450, 'USD', 'corrected', '2026-10-05', '2026-08-31', 1500, 'USD'),
  ('user_calendar_a', 'correction-b', 'sub_corrected', '2026-10-05', 1400, 'USD', 'corrected', '2026-10-05', '2026-09-30', 1500, 'USD');

set local role postgres;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"user_calendar_a","iss":"https://fixture.clerk.accounts.dev","exp":4102444800}',
  true
);
set local role authenticated;

select is(
  jsonb_array_length(
    public.calendar_events_page(
      date '2026-08-01', date '2026-10-31', 'trials', '', 256, null
    )->'events'
  ),
  1,
  'trial predicate is computed inside the bounded RPC'
);

select is(
  public.calendar_events_page(
    date '2026-08-01', date '2026-10-31', 'trials', '', 256, null
  )#>>'{events,0,event_kind}',
  'trial_deadline',
  'trial event kind matches the domain calendar'
);

select results_eq(
  $$
    select value->>'event_kind'
    from jsonb_array_elements(
      public.calendar_events_page(
        date '2026-08-01', date '2026-08-31', 'changes', '', 256, null
      )->'events'
    ) value
    order by value->>'event_kind'
  $$,
  array['canceled', 'paused']::text[],
  'paused and canceled lifecycle changes remain distinct'
);

select results_eq(
  $$
    select value->>'event_kind'
    from jsonb_array_elements(
      public.calendar_events_page(
        date '2026-08-01', date '2026-08-31', 'access', '', 256, null
      )->'events'
    ) value
    order by value->>'event_kind', value->>'event_date'
  $$,
  array['access_expiry', 'access_expiry', 'access_expiry']::text[],
  'canceled access, expired lifecycle, and one-time access remain visible'
);

select is(
  (
    select count(*)::integer
    from jsonb_array_elements(
      public.calendar_events_page(
        date '2026-08-01', date '2026-10-31', 'charges', 'eta', 256, null
      )->'events'
    ) value
    where value->>'event_kind' = 'expected_charge'
      and value->>'event_date' in ('2026-08-31', '2026-09-30')
  ),
  0,
  'persisted corrections suppress only their original expected identities'
);

select is(
  (
    select count(*)::integer
    from jsonb_array_elements(
      public.calendar_events_page(
        date '2026-08-01', date '2026-10-31', 'changes', 'eta', 256, null
      )->'events'
    ) value
    where value->>'event_kind' = 'corrected_charge'
      and value->>'event_date' = '2026-10-05'
  ),
  2,
  'same-date corrections stay distinct by persisted idempotency identity'
);

select is(
  (
    select count(*)::integer
    from jsonb_array_elements(
      public.calendar_events_page(
        date '2026-08-01', date '2026-10-31', 'all', 'other private', 256, null
      )->'events'
    )
  ),
  0,
  'authenticated owner A cannot infer owner B calendar truth'
);

set local role postgres;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"user_calendar_b","iss":"https://fixture.clerk.accounts.dev","exp":4102444800}',
  true
);
set local role authenticated;

select is(
  (
    select count(*)::integer
    from jsonb_array_elements(
      public.calendar_events_page(
        date '2026-08-01', date '2026-10-31', 'all', '', 256, null
      )->'events'
    ) value
    where value->>'service_name' = 'Other private'
  ),
  3,
  'authenticated owner B receives only its own recurring occurrences'
);

set local role postgres;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"user_calendar_a","iss":"https://fixture.clerk.accounts.dev","exp":4102444800}',
  true
);
set local role authenticated;

select is(
  public.calendar_events_page(
    date '2026-08-01', date '2026-10-31', 'charges', '', 2, null
  )->>'complete',
  'false',
  'a capped first page reports incomplete truth honestly'
);

select ok(
  nullif(
    public.calendar_events_page(
      date '2026-08-01', date '2026-10-31', 'charges', '', 2, null
    )->>'next_cursor',
    ''
  ) is not null,
  'an incomplete page returns an opaque continuation cursor'
);

select is(
  (
    with first_page as (
      select public.calendar_events_page(
        date '2026-08-01', date '2026-10-31', 'charges', '', 2, null
      ) page
    ), second_page as (
      select public.calendar_events_page(
        date '2026-08-01', date '2026-10-31', 'charges', '', 2,
        first_page.page->>'next_cursor'
      ) page
      from first_page
    )
    select count(distinct value->>'id')::integer
    from (
      select jsonb_array_elements(first_page.page->'events') value from first_page
      union all
      select jsonb_array_elements(second_page.page->'events') value from second_page
    ) pages
  ),
  4,
  'stable cursor pages do not repeat event identity'
);

select throws_ok(
  $$
    select public.calendar_events_page(
      date '2026-08-01', date '2026-10-31', 'trials', '', 2,
      public.calendar_events_page(
        date '2026-08-01', date '2026-10-31', 'charges', '', 2, null
      )->>'next_cursor'
    )
  $$,
  '22023', null,
  'a cursor cannot cross predicate identity'
);

select throws_ok(
  $$
    select public.calendar_events_page(
      date '2026-10-31', date '2026-08-01', 'all', '', 256, null
    )
  $$,
  '22023', null,
  'reversed ranges fail closed'
);

select throws_ok(
  $$
    select public.calendar_events_page(
      date '2026-01-01', date '2026-12-31', 'all', '', 256, null
    )
  $$,
  '22023', null,
  'calendar work is bounded to the supported range span'
);

create temporary table calendar_cursor_fixture as
select public.calendar_events_page(
  date '2026-08-01', date '2026-10-31', 'charges', '', 2, null
)->>'next_cursor' as cursor;

set local role postgres;
update public.subscriptions
set plan_name = 'Changed after cursor'
where owner_user_id = 'user_calendar_a' and id = 'sub_active';
set local role authenticated;

select throws_ok(
  $$
    select public.calendar_events_page(
      date '2026-08-01', date '2026-10-31', 'charges', '', 2,
      (select cursor from calendar_cursor_fixture)
    )
  $$,
  '40001', null,
  'a mutation invalidates a stale continuation instead of mixing snapshots'
);

reset role;

set local role anon;
select throws_ok(
  $$
    select public.calendar_events_page(
      date '2026-08-01', date '2026-10-31', 'all', '', 256, null
    )
  $$,
  '42501', null,
  'anonymous execution is denied at the function boundary'
);
reset role;

select ok(
  exists (
    select 1
    from pg_catalog.pg_indexes
    where schemaname = 'public'
      and indexname = 'subscriptions_calendar_owner_idx'
  ) and exists (
    select 1
    from pg_catalog.pg_indexes
    where schemaname = 'public'
      and indexname = 'renewal_events_calendar_identity_idx'
  ),
  'calendar ownership and correction identity have dedicated indexes'
);

select * from finish();
rollback;
