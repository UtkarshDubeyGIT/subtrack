begin;
-- Linked runs connect through an ephemeral CLI login. Elevate only inside this
-- rolled-back test transaction so the extension is visible without app-role grants.
set local role postgres;
set local search_path = extensions, public, pg_catalog;
select plan(18);

select has_schema('private', 'private schema exists');
select has_table('private', 'auth_transactions', 'authorization transactions exist');
select has_table('private', 'credential_families', 'credential families exist');
select has_table('private', 'refresh_credentials', 'refresh credentials exist');
select has_table('private', 'auth_rate_limits', 'rate limits exist');

select ok(not has_schema_privilege('anon', 'private', 'usage'), 'anon cannot use private schema');
select ok(not has_schema_privilege('authenticated', 'private', 'usage'), 'authenticated cannot use private schema');
select ok(not has_table_privilege('anon', 'private.auth_transactions', 'select'), 'anon cannot read transactions');
select ok(not has_table_privilege('authenticated', 'private.auth_transactions', 'select'), 'authenticated cannot read transactions');
select ok(not has_table_privilege('anon', 'private.refresh_credentials', 'select'), 'anon cannot read refresh hashes');
select ok(not has_table_privilege('authenticated', 'private.refresh_credentials', 'select'), 'authenticated cannot read refresh hashes');
select ok(not has_table_privilege('anon', 'private.credential_families', 'select'), 'anon cannot read families');
select ok(not has_table_privilege('authenticated', 'private.credential_families', 'select'), 'authenticated cannot read families');

select ok(not has_function_privilege('anon', 'public.broker_get_authorization(text)', 'execute'), 'anon cannot call broker RPC');
select ok(not has_function_privilege('authenticated', 'public.broker_get_authorization(text)', 'execute'), 'authenticated cannot call broker RPC');
select ok(not has_function_privilege('anon', 'public.broker_inspect_refresh(text,bigint)', 'execute'), 'anon cannot inspect refresh state');
select ok(not has_function_privilege('authenticated', 'public.broker_inspect_refresh(text,bigint)', 'execute'), 'authenticated cannot inspect refresh state');
select ok(has_function_privilege('service_role', 'public.broker_get_authorization(text)', 'execute'), 'service role can call broker RPC');

select * from finish();
rollback;
