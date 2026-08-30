begin;
set local role postgres;
set local search_path = extensions, public, pg_catalog;

select plan(53);

select has_function(
  'public', 'subscriptions_page', array['integer', 'text'],
  'ledger pagination uses a narrow POST RPC contract'
);
select has_function(
  'public', 'renewal_history_page', array['text', 'integer', 'text'],
  'history pagination uses a narrow POST RPC contract'
);
select ok(
  not pg_catalog.has_function_privilege(
    'anon', 'public.subscriptions_page(integer,text)', 'EXECUTE'
  ) and not pg_catalog.has_function_privilege(
    'service_role', 'public.subscriptions_page(integer,text)', 'EXECUTE'
  ) and pg_catalog.has_function_privilege(
    'authenticated', 'public.subscriptions_page(integer,text)', 'EXECUTE'
  ),
  'ledger RPC is authenticated-only'
);
select ok(
  not pg_catalog.has_function_privilege(
    'anon', 'public.renewal_history_page(text,integer,text)', 'EXECUTE'
  ) and not pg_catalog.has_function_privilege(
    'service_role', 'public.renewal_history_page(text,integer,text)', 'EXECUTE'
  ) and pg_catalog.has_function_privilege(
    'authenticated', 'public.renewal_history_page(text,integer,text)', 'EXECUTE'
  ),
  'history RPC is authenticated-only'
);
select ok(
  to_regclass('calendar_private.cursor_states') is not null,
  'opaque cursor state is private server data'
);
select ok(
  not pg_catalog.has_table_privilege(
    'authenticated', 'calendar_private.cursor_states', 'SELECT'
  ) and not pg_catalog.has_table_privilege(
    'service_role', 'calendar_private.cursor_states', 'SELECT'
  ),
  'clients and service credentials cannot read cursor state'
);
select ok(
  to_regclass('calendar_private.account_revisions') is not null,
  'account mutation revisions have indexed private state'
);
select has_column(
  'calendar_private', 'cursor_states', 'parent_token',
  'cursor chains retain an explicit acknowledgement parent'
);
select has_column(
  'calendar_private', 'cursor_states', 'retained_bytes',
  'cursor capacity accounts for state and cached response bytes'
);
select ok(
  exists (
    select 1 from pg_catalog.pg_indexes
    where schemaname = 'calendar_private'
      and tablename = 'cursor_states'
      and indexdef ~ '\(expires_at, token\)'
  ),
  'scheduled cleanup has a leading expiry index'
);
select has_function(
  'calendar_private', 'cleanup_cursor_retention', array[]::text[],
  'cursor retention has a bounded scheduled cleanup function'
);
select ok(
  not pg_catalog.has_function_privilege(
    'authenticated', 'calendar_private.cleanup_cursor_retention()', 'EXECUTE'
  ) and not pg_catalog.has_function_privilege(
    'service_role', 'calendar_private.cleanup_cursor_retention()', 'EXECUTE'
  ),
  'cursor cleanup is unavailable to clients and service credentials'
);
select ok(
  exists (
    select 1 from cron.job
    where jobname = 'subtrack-calendar-cursor-cleanup' and active
  ),
  'cursor cleanup is scheduled independently of request traffic'
);
select ok(
  to_regclass('calendar_private.calendar_rpc_budgets') is not null,
  'calendar caller budgets use private server state'
);
select ok(
  not pg_catalog.has_table_privilege(
    'authenticated', 'calendar_private.calendar_rpc_budgets', 'SELECT'
  ) and not pg_catalog.has_table_privilege(
    'service_role', 'calendar_private.calendar_rpc_budgets', 'SELECT'
  ),
  'calendar caller budget state is not client-readable'
);
select ok(
  (
    select procedure.proconfig @> array[
      'work_mem=64MB',
      'statement_timeout=5s',
      'plan_cache_mode=force_custom_plan'
    ]
    from pg_catalog.pg_proc procedure
    where procedure.oid =
      'calendar_private.authoritative_calendar_events_page(date,date,text,text,integer,text)'::regprocedure
  ),
  'calendar statements have working-memory, timeout, and plan-stability budgets'
);
select matches(
  pg_catalog.pg_get_functiondef(
    'calendar_private.authoritative_calendar_events_page(date,date,text,text,integer,text)'::regprocedure
  ),
  'row\(renewal\.occurrence_date, renewal\.idempotency_key\)',
  'correction continuation is keyed by membership date and stable identity'
);
select ok(
  exists (
    select 1 from pg_catalog.pg_trigger
    where tgrelid = 'public.subscriptions'::regclass
      and tgname = 'a_subscriptions_revision_lock'
      and not tgisinternal
  ) and exists (
    select 1 from pg_catalog.pg_trigger
    where tgrelid = 'public.renewal_events'::regclass
      and tgname = 'a_renewal_events_revision_lock'
      and not tgisinternal
  ) and pg_catalog.pg_get_functiondef(
    'calendar_private.lock_calendar_revision(text)'::regprocedure
  ) ~* 'for share',
  'calendar reads and both mutation tables share the revision lock protocol'
);
select matches(
  pg_catalog.pg_get_functiondef(
    'calendar_private.lock_account_mutation()'::regprocedure
  ),
  'current_setting\(''role''[\s\S]*authenticated[\s\S]*return null',
  'invalid client claims cannot acquire the privileged global mutation gate'
);

reset role;
insert into private.clerk_identity_authority(singleton, issuer)
values (true, 'https://fixture.clerk.accounts.dev')
on conflict (singleton) do update set issuer = excluded.issuer;

insert into public.subscriptions(
  owner_user_id, id, kind, service_name, amount_minor, currency_code,
  timezone, lifecycle_status, lifecycle_since, start_date,
  next_renewal_date, recurrence_unit, recurrence_interval
) values
  ('cursor_user_a', 'sub_cursor_a', 'recurring', E'Literal 50%_off\\plan', 100, 'USD', 'UTC', 'active', '2026-01-01', '2026-01-01', '2026-08-01', 'day', 1),
  ('cursor_user_a', 'sub_cursor_b', 'recurring', 'Literal 50xxoff plan', 100, 'USD', 'UTC', 'active', '2026-01-01', '2026-01-01', '2026-08-01', 'month', 1),
  ('cursor_user_a', 'sub_cursor_c', 'recurring', 'Third item', 100, 'USD', 'UTC', 'active', '2026-01-01', '2026-01-01', '2026-08-01', 'month', 1),
  ('cursor_user_b', 'sub_cursor_private', 'recurring', 'Private B', 100, 'USD', 'UTC', 'active', '2026-01-01', '2026-01-01', '2026-08-01', 'month', 1),
  ('cursor_unicode', 'unicode_precomposed', 'recurring', 'Café', 100, 'USD', 'UTC', 'active', '2026-01-01', '2026-01-01', '2026-08-04', 'day', 1),
  ('cursor_unicode', 'unicode_decomposed', 'recurring', 'Cafe' || chr(769), 100, 'USD', 'UTC', 'active', '2026-01-01', '2026-01-01', '2026-08-04', 'day', 1),
  ('cursor_unicode', 'unicode_case', 'recurring', 'ÅNGSTRÖM', 100, 'USD', 'UTC', 'active', '2026-01-01', '2026-01-01', '2026-08-04', 'day', 1);

insert into public.renewal_events(
  owner_user_id, idempotency_key, subscription_id, occurrence_date,
  amount_minor, currency_code
) values
  ('cursor_user_a', 'history_cursor_a', 'sub_cursor_a', '2026-08-01', 100, 'USD'),
  ('cursor_user_a', 'history_cursor_b', 'sub_cursor_a', '2026-08-02', 100, 'USD'),
  ('cursor_user_a', 'history_cursor_c', 'sub_cursor_a', '2026-08-03', 100, 'USD');

select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"cursor_user_a","iss":"https://fixture.clerk.accounts.dev","exp":4102444800}',
  true
);
set local role authenticated;

create temporary table ledger_first as
select public.subscriptions_page(1, null) as page;

select is((select page->>'complete' from ledger_first), 'false', 'ledger first page is incomplete');
select matches(
  (select page->>'next_cursor' from ledger_first), '^[a-f0-9]{32}$',
  'ledger cursor is an opaque 128-bit token'
);
select ok(
  (select page->>'next_cursor' from ledger_first) not like '%cursor_user_a%'
  and (select page->>'next_cursor' from ledger_first) not like '%sub_cursor_a%'
  and (select page->>'next_cursor' from ledger_first) not like '%Literal%',
  'ledger cursor contains no owner, record, or service identity'
);
select is(
  public.subscriptions_page(1, (select page->>'next_cursor' from ledger_first)),
  public.subscriptions_page(1, (select page->>'next_cursor' from ledger_first)),
  'ledger cursor replay is idempotent'
);
select throws_ok(
  $$select public.subscriptions_page(1, '00000000000000000000000000000000')$$,
  '22023', null, 'a forged ledger cursor fails closed'
);

reset role;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"cursor_user_b","iss":"https://fixture.clerk.accounts.dev","exp":4102444800}',
  true
);
set local role authenticated;
select throws_ok(
  $$select public.subscriptions_page(1, (select page->>'next_cursor' from ledger_first))$$,
  '22023', null, 'a ledger cursor cannot cross subjects'
);

reset role;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"cursor_user_a","iss":"https://fixture.clerk.accounts.dev","exp":4102444800}',
  true
);
set local role authenticated;
create temporary table history_first as
select public.renewal_history_page('sub_cursor_a', 1, null) as page;
select matches(
  (select page->>'next_cursor' from history_first), '^[a-f0-9]{32}$',
  'history cursor is opaque'
);
select is(
  public.renewal_history_page(
    'sub_cursor_a', 1, (select page->>'next_cursor' from history_first)
  ),
  public.renewal_history_page(
    'sub_cursor_a', 1, (select page->>'next_cursor' from history_first)
  ),
  'history cursor replay is idempotent'
);
select throws_ok(
  $$select public.renewal_history_page('sub_cursor_b', 1, (select page->>'next_cursor' from history_first))$$,
  '22023', null, 'history cursor is bound to subscription identity'
);

create temporary table ledger_second as
select public.subscriptions_page(
  1, (select page->>'next_cursor' from ledger_first)
) as page;
create temporary table history_second as
select public.renewal_history_page(
  'sub_cursor_a', 1, (select page->>'next_cursor' from history_first)
) as page;
reset role;
delete from public.renewal_events
where owner_user_id = 'cursor_user_a' and idempotency_key = 'history_cursor_c';
delete from public.subscriptions
where owner_user_id = 'cursor_user_a' and id = 'sub_cursor_c';
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"cursor_user_a","iss":"https://fixture.clerk.accounts.dev","exp":4102444800}',
  true
);
set local role authenticated;
select is(
  public.subscriptions_page(1, (select page->>'next_cursor' from ledger_second))->>'complete',
  'true',
  'deleting the ledger high-water row completes instead of dead-ending'
);
select is(
  public.renewal_history_page(
    'sub_cursor_a', 1, (select page->>'next_cursor' from history_second)
  )->>'complete',
  'true',
  'deleting the history high-water row completes instead of dead-ending'
);

create temporary table literal_calendar as
select public.calendar_events_page(
  date '2026-08-04', date '2026-08-05', 'all', E'%_off\\plan', 256, null
) as page;
select is(
  (select count(*)::integer from jsonb_array_elements((select page->'events' from literal_calendar))),
  2,
  'literal percent, underscore, and escape search matches only the literal service'
);
select is((select page->>'authoritative' from literal_calendar), 'true', 'small calendar page is authoritative');
select cmp_ok(
  ((select page#>>'{work,source_rows_scanned}' from literal_calendar))::integer,
  '<=', 256, 'calendar phase scans at most 256 subscription sources'
);
select cmp_ok(
  ((select page#>>'{work,recurrence_candidates}' from literal_calendar))::integer,
  '<=', 47616, 'calendar phase expands at most the structural recurrence budget'
);

reset role;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"cursor_unicode","iss":"https://fixture.clerk.accounts.dev","exp":4102444800}',
  true
);
set local role authenticated;
select is(
  jsonb_array_length(public.calendar_events_page(
    date '2026-08-04', date '2026-08-04', 'all', 'CAFÉ', 256, null
  )->'events'),
  1,
  'Unicode case lowering preserves literal precomposed search semantics'
);
select is(
  jsonb_array_length(public.calendar_events_page(
    date '2026-08-04', date '2026-08-04', 'all', 'CAFE' || chr(769), 256, null
  )->'events'),
  1,
  'Unicode combining marks remain literal instead of silently normalizing'
);
select is(
  jsonb_array_length(public.calendar_events_page(
    date '2026-08-04', date '2026-08-04', 'all', 'ångström', 256, null
  )->'events'),
  1,
  'Unicode case folding matches the client substring corpus'
);

reset role;
insert into public.subscriptions(
  owner_user_id, id, kind, service_name, amount_minor, currency_code,
  timezone, lifecycle_status, lifecycle_since, start_date,
  next_renewal_date, recurrence_unit, recurrence_interval
)
select
  'cursor_dense', 'dense_' || lpad(number::text, 5, '0'), 'recurring',
  'Dense ' || number, 100, 'USD', 'UTC', 'active', '1900-01-01',
  '1900-01-01', '1900-01-01', 'day', 1
from generate_series(1, 257) number;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"cursor_dense","iss":"https://fixture.clerk.accounts.dev","exp":4102444800}',
  true
);
set local role authenticated;
create temporary table dense_phase as
select public.calendar_events_page(
  date '2026-08-01', date '2026-08-31', 'charges', 'DENSE', 2, null
) as page;
select is((select page->>'authoritative' from dense_phase), 'false', 'large account returns a bounded reconciliation phase');
select is(jsonb_array_length((select page->'events' from dense_phase)), 0, 'intermediate phase exposes no partial truth');
select is(((select page#>>'{work,source_rows_scanned}' from dense_phase))::integer, 256, 'dense phase source work is capped exactly');
select is(((select page#>>'{work,recurrence_candidates}' from dense_phase))::integer, 7936, 'dense phase reports actual 31-day recurrence expansion');

create temporary table dense_continuation as
select public.calendar_events_page(
  date '2026-08-01', date '2026-08-31', 'charges', 'dense', 2,
  (select page->>'next_cursor' from dense_phase)
) as page;
select is(
  (select page->>'authoritative' from dense_continuation),
  'true',
  'case-equivalent search preserves continuation identity'
);
select is(
  public.calendar_events_page(
    date '2026-08-01', date '2026-08-31', 'charges', 'dense', 2,
    (select page->>'next_cursor' from dense_phase)
  ),
  public.calendar_events_page(
    date '2026-08-01', date '2026-08-31', 'charges', 'dense', 2,
    (select page->>'next_cursor' from dense_phase)
  ),
  'calendar cursor replay is idempotent'
);
select throws_ok(
  $$select public.calendar_events_page(
    date '2026-08-01', date '2026-08-31', 'charges', 'sparse', 2,
    (select page->>'next_cursor' from dense_phase)
  )$$,
  '22023', null, 'calendar cursor is bound to the normalized predicate'
);
select throws_ok(
  $$select public.calendar_events_page(
    date '2026-08-01', date '2026-08-31', 'charges', 'dense', 2,
    '00000000000000000000000000000000'
  )$$,
  '22023', null, 'a forged calendar cursor fails closed'
);

reset role;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"cursor_user_b","iss":"https://fixture.clerk.accounts.dev","exp":4102444800}',
  true
);
set local role authenticated;
select throws_ok(
  $$select public.calendar_events_page(
    date '2026-08-01', date '2026-08-31', 'charges', 'dense', 2,
    (select page->>'next_cursor' from dense_phase)
  )$$,
  '22023', null, 'a calendar cursor cannot cross subjects'
);

reset role;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"cursor_dense","iss":"https://fixture.clerk.accounts.dev","exp":4102444800}',
  true
);
update public.subscriptions set plan_name = 'mutated' where owner_user_id = 'cursor_dense' and id = 'dense_00001';
set local role authenticated;
select throws_ok(
  $$select public.calendar_events_page(
    date '2026-08-01', date '2026-08-31', 'charges', 'dense', 2,
    (select page->>'next_cursor' from dense_phase)
  )$$,
  '40001', null, 'a mutation invalidates an in-flight calendar reconciliation'
);

create temporary table dense_expiring as
select public.calendar_events_page(
  date '2026-08-01', date '2026-08-31', 'charges', 'dense', 2, null
) as page;

reset role;
update calendar_private.cursor_states
set created_at = created_at - interval '20 minutes',
    expires_at = statement_timestamp() - interval '1 second';
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"cursor_dense","iss":"https://fixture.clerk.accounts.dev","exp":4102444800}',
  true
);
set local role authenticated;
select throws_ok(
  $$select public.calendar_events_page(
    date '2026-08-01', date '2026-08-31', 'charges', 'dense', 2,
    (select page->>'next_cursor' from dense_expiring)
  )$$,
  '22023', null, 'an expired calendar cursor fails closed'
);
reset role;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"cursor_user_a","iss":"https://fixture.clerk.accounts.dev","exp":4102444800}',
  true
);
set local role authenticated;
select throws_ok(
  $$select public.subscriptions_page(1, (select page->>'next_cursor' from ledger_first))$$,
  '22023', null, 'expired cursors fail closed'
);

reset role;
set local role anon;
select throws_ok(
  $$select public.subscriptions_page(1, null)$$,
  '42501', null, 'anonymous ledger execution is denied'
);
select throws_ok(
  $$select public.renewal_history_page('sub_cursor_a', 1, null)$$,
  '42501', null, 'anonymous history execution is denied'
);
reset role;

insert into calendar_private.calendar_rpc_budgets(
  owner_user_id, window_started_at, call_count
) values (
  'cursor_user_a', statement_timestamp(), 4096
)
on conflict (owner_user_id) do update
set window_started_at = excluded.window_started_at,
    call_count = excluded.call_count;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"cursor_user_a","iss":"https://fixture.clerk.accounts.dev","exp":4102444800}',
  true
);
set local role authenticated;
select throws_ok(
  $$select public.calendar_events_page(
    date '2026-08-01', date '2026-08-31', 'all', '', 256, null
  )$$,
  '54000', null, 'calendar RPC fails closed at its authenticated caller budget'
);
reset role;

select matches(
  pg_catalog.pg_get_functiondef(
    'calendar_private.issue_cursor(text,text,text,bigint,jsonb,uuid)'::regprocedure
  ),
  'global_rows >= 8192[\s\S]*global_bytes \+ state_bytes > 268435456[\s\S]*owner_rows >= 256[\s\S]*owner_bytes \+ state_bytes > 16777216',
  'cursor issuance atomically enforces global and per-subject row and byte bounds'
);

select * from finish();
rollback;
