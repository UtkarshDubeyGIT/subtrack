begin;
set local role postgres;
set local search_path = extensions, public, pg_catalog;

select plan(71);

select has_column(
  'public',
  'subscriptions',
  'category',
  'subscriptions persist an optional category'
);

select col_type_is(
  'public',
  'subscriptions',
  'category',
  'text',
  'subscription category remains exact text'
);

select has_function(
  'private',
  'contains_prohibited_subscription_secret',
  array['text'],
  'sensitive subscription text screening is a database invariant'
);

select has_function(
  'private',
  'contains_uri_userinfo',
  array['text'],
  'management URL userinfo screening is a database invariant'
);

select has_function(
  'private',
  'is_subscription_occurrence',
  array['date', 'date', 'text', 'integer'],
  'anchored recurrence alignment is a database invariant'
);

select is(
  (
    select count(*)::integer
    from pg_catalog.pg_constraint constraint_definition
    where constraint_definition.conrelid = 'public.subscriptions'::regclass
      and constraint_definition.conname in (
        'subscriptions_management_url_credentials_free',
        'subscriptions_recurrence_aligned'
      )
      and constraint_definition.convalidated
      and (
        constraint_definition.conname = 'subscriptions_recurrence_aligned'
        or pg_catalog.strpos(
          pg_catalog.pg_get_constraintdef(constraint_definition.oid),
          'private.contains_uri_userinfo'
        ) > 0
      )
  ),
  2,
  'validated subscription constraints use the URI-userinfo and recurrence helpers'
);

select ok(
  private.contains_prohibited_subscription_secret(
    'https://example.test/manage?secret=%43%56%56%20%23%31%32%33'
  ),
  'fully percent-encoded CVV URL is normalized before screening'
);

select ok(
  private.contains_prohibited_subscription_secret(
    U&'\FF14' || pg_catalog.repeat(U&'\FF11', 15)
  ),
  'fullwidth Visa PAN is compatibility-normalized before screening'
);

select ok(
  not private.contains_prohibited_subscription_secret('IMEI 490154203237518'),
  'IMEI control remains accepted by the helper'
);

select ok(
  not private.contains_prohibited_subscription_secret(
    'Invoice 1234567890123452'
  ),
  'non-network invoice control remains accepted by the helper'
);

select ok(
  not private.contains_prohibited_subscription_secret('Visa •••• 4242'),
  'masked last-four control remains accepted by the helper'
);

select is(
  (
    select count(*)::integer
    from pg_catalog.pg_constraint constraint_definition
    where constraint_definition.conrelid = 'public.subscriptions'::regclass
      and constraint_definition.conname in (
        'subscriptions_service_secret_free',
        'subscriptions_plan_secret_free',
        'subscriptions_account_email_secret_free',
        'subscriptions_payment_label_secret_free',
        'subscriptions_management_url_secret_free',
        'subscriptions_category_secret_free',
        'subscriptions_notes_secret_free'
      )
      and constraint_definition.convalidated
  ),
  7,
  'all user-entered free-text subscription fields have validated secret guards'
);

select ok(
  pg_catalog.has_column_privilege(
    'authenticated', 'public.subscriptions', 'category', 'INSERT'
  ),
  'authenticated owners may insert a category'
);

select ok(
  pg_catalog.has_column_privilege(
    'authenticated', 'public.subscriptions', 'category', 'UPDATE'
  ),
  'authenticated owners may update a category'
);

select ok(
  not pg_catalog.has_column_privilege(
    'anon', 'public.subscriptions', 'category', 'INSERT'
  ) and not pg_catalog.has_column_privilege(
    'anon', 'public.subscriptions', 'category', 'UPDATE'
  ),
  'anonymous clients cannot write a category'
);

select ok(
  (
    select relation.relrowsecurity and relation.relforcerowsecurity
    from pg_catalog.pg_class relation
    where relation.oid = 'public.subscriptions'::regclass
  ),
  'category remains protected by forced subscription RLS'
);

select lives_ok(
  $$
    insert into public.subscriptions(
      owner_user_id, id, kind, service_name, amount_minor, currency_code,
      timezone, lifecycle_status, lifecycle_since, purchased_on, category,
      payment_label, notes
    ) values (
      'user_management', 'sub_management_safe', 'one_time', '1Password', 100,
      'USD', 'UTC', 'active', '2026-01-01', '2026-01-01', 'Security tools',
      'Visa •••• 4242', 'Invoice 12345 for the password manager family plan'
    )
  $$,
  'ordinary category, last-four, numeric text, and product names remain valid'
);

select throws_ok(
  $$
    insert into public.subscriptions(
      owner_user_id, id, kind, service_name, amount_minor, currency_code,
      timezone, lifecycle_status, lifecycle_since, purchased_on, notes
    ) values (
      'user_management', 'sub_management_cvv', 'one_time', 'Unsafe CVV', 100,
      'USD', 'UTC', 'active', '2026-01-01', '2026-01-01', 'CVV: 123'
    )
  $$,
  '23514', null,
  'notes reject an obvious CVV'
);

select throws_ok(
  $$
    insert into public.subscriptions(
      owner_user_id, id, kind, service_name, amount_minor, currency_code,
      timezone, lifecycle_status, lifecycle_since, purchased_on, payment_label
    ) values (
      'user_management', 'sub_management_security_code', 'one_time',
      'Unsafe security code', 100, 'USD', 'UTC', 'active', '2026-01-01',
      '2026-01-01', 'Security code = 1234'
    )
  $$,
  '23514', null,
  'payment labels reject an obvious security code'
);

select throws_ok(
  $$
    insert into public.subscriptions(
      owner_user_id, id, kind, service_name, plan_name, amount_minor,
      currency_code, timezone, lifecycle_status, lifecycle_since, purchased_on
    ) values (
      'user_management', 'sub_management_password', 'one_time', 'Unsafe plan',
      'password: fixture-value', 100, 'USD', 'UTC', 'active', '2026-01-01',
      '2026-01-01'
    )
  $$,
  '23514', null,
  'plan names reject an obvious password'
);

select throws_ok(
  $$
    insert into public.subscriptions(
      owner_user_id, id, kind, service_name, amount_minor, currency_code,
      timezone, lifecycle_status, lifecycle_since, purchased_on, category
    ) values (
      'user_management', 'sub_management_recovery', 'one_time',
      'Unsafe recovery', 100, 'USD', 'UTC', 'active', '2026-01-01',
      '2026-01-01', 'Recovery code: ABCD-EFGH-IJKL'
    )
  $$,
  '23514', null,
  'categories reject an obvious recovery code'
);

select throws_ok(
  $$
    insert into public.subscriptions(
      owner_user_id, id, kind, service_name, amount_minor, currency_code,
      timezone, lifecycle_status, lifecycle_since, purchased_on, notes
    ) values (
      'user_management', 'sub_management_bank', 'one_time', 'Unsafe bank', 100,
      'USD', 'UTC', 'active', '2026-01-01', '2026-01-01',
      'Routing number: 123456789'
    )
  $$,
  '23514', null,
  'notes reject an obvious bank credential'
);

select throws_ok(
  $$
    insert into public.subscriptions(
      owner_user_id, id, kind, service_name, amount_minor, currency_code,
      timezone, lifecycle_status, lifecycle_since, purchased_on, notes
    ) values (
      'user_management', 'sub_management_pan', 'one_time', 'Unsafe card', 100,
      'USD', 'UTC', 'active', '2026-01-01', '2026-01-01',
      'Card 4111 1111 1111 1111'
    )
  $$,
  '23514', null,
  'notes continue to reject full payment-card numbers'
);

select lives_ok(
  $$
    update public.subscriptions
    set category = 'Password managers'
    where owner_user_id = 'user_management' and id = 'sub_management_safe'
  $$,
  'safe category edits remain available'
);

select results_eq(
  $$
    select category
    from public.subscriptions
    where owner_user_id = 'user_management' and id = 'sub_management_safe'
  $$,
  array['Password managers'::text],
  'safe category edits persist exactly'
);

select is(
  (
    select version
    from public.subscriptions
    where owner_user_id = 'user_management' and id = 'sub_management_safe'
  ),
  2::bigint,
  'category edits participate in optimistic version increments'
);

select throws_ok(
  $$
    update public.subscriptions
    set notes = 'passcode = fixture-value'
    where owner_user_id = 'user_management' and id = 'sub_management_safe'
  $$,
  '23514', null,
  'sensitive text is rejected on updates as well as inserts'
);

select throws_ok(
  $$
    insert into public.subscriptions(
      owner_user_id, id, kind, service_name, amount_minor, currency_code,
      timezone, lifecycle_status, lifecycle_since, purchased_on, account_email
    ) values (
      'user_management', 'sub_management_email_pan', 'one_time',
      'Unsafe email', 100, 'USD', 'UTC', 'active', '2026-01-01',
      '2026-01-01', '4111111111111111@example.test'
    )
  $$,
  '23514', null,
  'account email rejects a PAN-like local part'
);

select throws_ok(
  $$
    insert into public.subscriptions(
      owner_user_id, id, kind, service_name, amount_minor, currency_code,
      timezone, lifecycle_status, lifecycle_since, purchased_on, management_url
    ) values (
      'user_management', 'sub_management_url_pan', 'one_time', 'Unsafe URL',
      100, 'USD', 'UTC', 'active', '2026-01-01', '2026-01-01',
      'https://example.test/manage/4111-1111-1111-1111'
    )
  $$,
  '23514', null,
  'management URL path rejects a PAN'
);

select throws_ok(
  $$
    insert into public.subscriptions(
      owner_user_id, id, kind, service_name, amount_minor, currency_code,
      timezone, lifecycle_status, lifecycle_since, purchased_on, management_url
    ) values (
      'user_management', 'sub_management_url_cvv', 'one_time', 'Unsafe URL',
      100, 'USD', 'UTC', 'active', '2026-01-01', '2026-01-01',
      'https://example.test/manage?CVV=%23123'
    )
  $$,
  '23514', null,
  'management URL query rejects a percent-encoded CVV separator'
);

select throws_ok(
  $$
    insert into public.subscriptions(
      owner_user_id, id, kind, service_name, amount_minor, currency_code,
      timezone, lifecycle_status, lifecycle_since, purchased_on, notes
    ) values (
      'user_management', 'sub_management_cvv_hash', 'one_time', 'Unsafe CVV',
      100, 'USD', 'UTC', 'active', '2026-01-01', '2026-01-01', 'CVV #123'
    )
  $$,
  '23514', null,
  'hash-separated CVV is rejected'
);

select throws_ok(
  $$
    insert into public.subscriptions(
      owner_user_id, id, kind, service_name, amount_minor, currency_code,
      timezone, lifecycle_status, lifecycle_since, purchased_on, notes
    ) values (
      'user_management', 'sub_management_unicode_pan', 'one_time',
      'Unsafe Unicode PAN', 100, 'USD', 'UTC', 'active', '2026-01-01',
      '2026-01-01', U&'4111\20111111\20111111\20111111'
    )
  $$,
  '23514', null,
  'Unicode dash-separated PAN is rejected'
);

select throws_ok(
  $$
    insert into public.subscriptions(
      owner_user_id, id, kind, service_name, amount_minor, currency_code,
      timezone, lifecycle_status, lifecycle_since, purchased_on, payment_label
    ) values (
      'user_management', 'sub_management_maestro', 'one_time', 'Unsafe Maestro',
      100, 'USD', 'UTC', 'active', '2026-01-01', '2026-01-01',
      '6759000000000000'
    )
  $$,
  '23514', null,
  'Maestro network PAN is rejected'
);

select throws_ok(
  $$
    insert into public.subscriptions(
      owner_user_id, id, kind, service_name, amount_minor, currency_code,
      timezone, lifecycle_status, lifecycle_since, purchased_on, category
    ) values (
      'user_management', 'sub_management_mir', 'one_time', 'Unsafe MIR',
      100, 'USD', 'UTC', 'active', '2026-01-01', '2026-01-01',
      '2200000000000004'
    )
  $$,
  '23514', null,
  'MIR network PAN is rejected'
);

select throws_ok(
  $$
    insert into public.subscriptions(
      owner_user_id, id, kind, service_name, amount_minor, currency_code,
      timezone, lifecycle_status, lifecycle_since, purchased_on, management_url
    ) values (
      'user_management', 'sub_management_encoded_cvv', 'one_time',
      'Unsafe encoded CVV', 100, 'USD', 'UTC', 'active', '2026-01-01',
      '2026-01-01',
      'https://example.test/manage?secret=%43%56%56%20%23%31%32%33'
    )
  $$,
  '23514', null,
  'fully percent-encoded CVV URL is rejected by the table constraint'
);

select throws_ok(
  $$
    insert into public.subscriptions(
      owner_user_id, id, kind, service_name, amount_minor, currency_code,
      timezone, lifecycle_status, lifecycle_since, purchased_on, notes
    ) values (
      'user_management', 'sub_management_fullwidth_pan', 'one_time',
      'Unsafe fullwidth PAN', 100, 'USD', 'UTC', 'active', '2026-01-01',
      '2026-01-01', U&'\FF14' || pg_catalog.repeat(U&'\FF11', 15)
    )
  $$,
  '23514', null,
  'fullwidth Visa PAN is rejected by the table constraint'
);

select lives_ok(
  $$
    insert into public.subscriptions(
      owner_user_id, id, kind, service_name, amount_minor, currency_code,
      timezone, lifecycle_status, lifecycle_since, purchased_on, account_email,
      management_url, notes
    ) values (
      'user_management', 'sub_management_safe_identifiers', 'one_time',
      'Safe identifiers', 100, 'USD', 'UTC', 'active', '2026-01-01',
      '2026-01-01', '490154203237518@example.test',
      'https://example.test/invoice/1234567890123452',
      'IMEI 490154203237518; invoice 1234567890123452'
    )
  $$,
  'IMEI and non-network invoice identifiers remain accepted'
);

select throws_ok(
  $$
    insert into public.subscriptions(
      owner_user_id, id, kind, service_name, amount_minor, currency_code,
      timezone, lifecycle_status, lifecycle_since, purchased_on, management_url
    ) values (
      'user_management', 'sub_management_encoded_userinfo', 'one_time',
      'Encoded userinfo', 100, 'USD', 'UTC', 'active', '2026-01-01',
      '2026-01-01',
      'https://%75%73%65%72%3A%70%61%73%73%40billing.example.test/manage'
    )
  $$,
  '23514', null,
  'fully percent-encoded URI userinfo is rejected by the table constraint'
);

select throws_ok(
  $$
    insert into public.subscriptions(
      owner_user_id, id, kind, service_name, amount_minor, currency_code,
      timezone, lifecycle_status, lifecycle_since, purchased_on, management_url
    ) values (
      'user_management', 'sub_management_fullwidth_userinfo', 'one_time',
      'Fullwidth userinfo', 100, 'USD', 'UTC', 'active', '2026-01-01',
      '2026-01-01', 'https://user：pass＠billing.example.test/manage'
    )
  $$,
  '23514', null,
  'fullwidth URI userinfo is rejected by the table constraint'
);

select throws_ok(
  $$
    insert into public.subscriptions(
      owner_user_id, id, kind, service_name, amount_minor, currency_code,
      timezone, lifecycle_status, lifecycle_since, start_date,
      next_renewal_date, recurrence_unit, recurrence_interval
    ) values (
      'user_management', 'sub_management_off_schedule', 'recurring',
      'Off schedule', 100, 'USD', 'UTC', 'active', '2024-01-31',
      '2024-01-31', '2024-02-15', 'month', 1
    )
  $$,
  '23514', null,
  'an off-anchor recurring renewal is rejected by the table constraint'
);

select lives_ok(
  $$
    insert into public.subscriptions(
      owner_user_id, id, kind, service_name, amount_minor, currency_code,
      timezone, lifecycle_status, lifecycle_since, start_date,
      next_renewal_date, recurrence_unit, recurrence_interval
    ) values
      ('user_management', 'sub_aligned_weekly', 'recurring', 'Weekly', 100, 'USD', 'UTC', 'active', '2026-01-05', '2026-01-05', '2026-01-19', 'week', 1),
      ('user_management', 'sub_aligned_monthly', 'recurring', 'Monthly', 100, 'USD', 'UTC', 'active', '2026-01-15', '2026-01-15', '2026-03-15', 'month', 1),
      ('user_management', 'sub_aligned_quarterly', 'recurring', 'Quarterly', 100, 'USD', 'UTC', 'active', '2026-01-15', '2026-01-15', '2026-10-15', 'month', 3),
      ('user_management', 'sub_aligned_semiannual', 'recurring', 'Semiannual', 100, 'USD', 'UTC', 'active', '2026-01-15', '2026-01-15', '2027-01-15', 'month', 6),
      ('user_management', 'sub_aligned_annual', 'recurring', 'Annual', 100, 'USD', 'UTC', 'active', '2024-02-28', '2024-02-28', '2026-02-28', 'year', 1),
      ('user_management', 'sub_aligned_custom', 'recurring', 'Custom', 100, 'USD', 'UTC', 'active', '2024-02-29', '2024-02-29', '2025-08-29', 'month', 18),
      ('user_management', 'sub_aligned_month_end', 'recurring', 'Month end', 100, 'USD', 'UTC', 'active', '2024-01-31', '2024-01-31', '2024-03-31', 'month', 1),
      ('user_management', 'sub_aligned_leap', 'recurring', 'Leap anchor', 100, 'USD', 'UTC', 'active', '2024-02-29', '2024-02-29', '2028-02-29', 'year', 1)
  $$,
  'aligned preset, custom, month-end, and leap recurrence rows remain valid'
);

delete from public.subscriptions
where id in (
  'sub_management_encoded_userinfo',
  'sub_management_fullwidth_userinfo',
  'sub_management_off_schedule'
);

insert into public.subscriptions(
  owner_user_id, id, kind, service_name, amount_minor, currency_code, timezone,
  lifecycle_status, lifecycle_since, purchased_on
) values (
  'user_management_other', 'sub_management_other', 'one_time', 'Other owner',
  100, 'USD', 'UTC', 'active', '2026-01-01', '2026-01-01'
);

reset role;
insert into private.clerk_identity_authority(singleton, issuer)
values (true, 'https://fixture.clerk.accounts.dev')
on conflict (singleton) do update set issuer = excluded.issuer;
set local role postgres;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"user_management_auth","iss":"https://fixture.clerk.accounts.dev","exp":4102444800}',
  true
);
set local role authenticated;

select ok(
  not pg_catalog.has_schema_privilege('authenticated', 'private', 'USAGE'),
  'authenticated CRUD does not require broad private schema usage'
);

select lives_ok(
  $$
    insert into public.subscriptions(
      id, kind, service_name, amount_minor, currency_code, timezone,
      lifecycle_status, lifecycle_since, purchased_on, category, notes
    ) values (
      'sub_management_authenticated', 'one_time', 'Authenticated safe row',
      2500, 'USD', 'UTC', 'active', '2026-08-06', '2026-08-06',
      'Utilities', 'Invoice 20260806'
    )
  $$,
  'authenticated owner can insert safe subscription text'
);

select results_eq(
  $$select owner_user_id from public.subscriptions where id = 'sub_management_authenticated'$$,
  array['user_management_auth'::text],
  'authenticated insert derives ownership from the verified subject'
);

select is(
  (select count(*)::integer from public.subscriptions),
  1,
  'authenticated SELECT sees only the derived owner row'
);

select lives_ok(
  $$
    update public.subscriptions
    set category = 'Household utilities'
    where id = 'sub_management_authenticated' and version = 1
  $$,
  'authenticated owner can update safe subscription text'
);

select is(
  (select version from public.subscriptions where id = 'sub_management_authenticated'),
  2::bigint,
  'authenticated update retains optimistic version increments'
);

select results_eq(
  $$select id from public.subscriptions where id = 'sub_management_other'$$,
  array[]::text[],
  'authenticated SELECT cannot infer another owner row'
);

select results_eq(
  $$
    with changed as (
      update public.subscriptions set category = 'Leaked'
      where id = 'sub_management_other' returning 1
    )
    select count(*)::integer from changed
  $$,
  array[0::integer],
  'authenticated UPDATE cannot affect another owner row'
);

select results_eq(
  $$
    with removed as (
      delete from public.subscriptions
      where id = 'sub_management_other' returning 1
    )
    select count(*)::integer from removed
  $$,
  array[0::integer],
  'authenticated DELETE cannot affect another owner row'
);

select throws_ok(
  $$
    insert into public.subscriptions(
      id, kind, service_name, amount_minor, currency_code, timezone,
      lifecycle_status, lifecycle_since, purchased_on, management_url
    ) values (
      'sub_authenticated_encoded_cvv', 'one_time', 'Encoded CVV direct write',
      100, 'USD', 'UTC', 'active', '2026-08-06', '2026-08-06',
      'https://example.test/manage?secret=%43%56%56%20%23%31%32%33'
    )
  $$,
  '23514', null,
  'authenticated INSERT rejects a fully percent-encoded CVV URL'
);

select throws_ok(
  $$
    insert into public.subscriptions(
      id, kind, service_name, amount_minor, currency_code, timezone,
      lifecycle_status, lifecycle_since, purchased_on, notes
    ) values (
      'sub_authenticated_fullwidth_pan', 'one_time', 'Fullwidth PAN direct write',
      100, 'USD', 'UTC', 'active', '2026-08-06', '2026-08-06',
      U&'\FF14' || pg_catalog.repeat(U&'\FF11', 15)
    )
  $$,
  '23514', null,
  'authenticated INSERT rejects a fullwidth Visa PAN'
);

select throws_ok(
  $$
    update public.subscriptions
    set management_url =
      'https://example.test/manage?secret=%43%56%56%20%23%31%32%33'
    where id = 'sub_management_authenticated'
  $$,
  '23514', null,
  'authenticated UPDATE rejects a fully percent-encoded CVV URL'
);

select throws_ok(
  $$
    update public.subscriptions
    set notes = U&'\FF14' || pg_catalog.repeat(U&'\FF11', 15)
    where id = 'sub_management_authenticated'
  $$,
  '23514', null,
  'authenticated UPDATE rejects a fullwidth Visa PAN'
);

select throws_ok(
  $$
    insert into public.subscriptions(
      id, kind, service_name, amount_minor, currency_code, timezone,
      lifecycle_status, lifecycle_since, purchased_on, management_url
    ) values (
      'sub_authenticated_encoded_userinfo', 'one_time', 'Encoded userinfo',
      100, 'USD', 'UTC', 'active', '2026-08-06', '2026-08-06',
      'https://%75%73%65%72%3A%70%61%73%73%40billing.example.test/manage'
    )
  $$,
  '23514', null,
  'authenticated INSERT rejects fully percent-encoded URI userinfo'
);

select throws_ok(
  $$
    insert into public.subscriptions(
      id, kind, service_name, amount_minor, currency_code, timezone,
      lifecycle_status, lifecycle_since, purchased_on, management_url
    ) values (
      'sub_authenticated_fullwidth_userinfo', 'one_time', 'Fullwidth userinfo',
      100, 'USD', 'UTC', 'active', '2026-08-06', '2026-08-06',
      'https://user：pass＠billing.example.test/manage'
    )
  $$,
  '23514', null,
  'authenticated INSERT rejects fullwidth URI userinfo'
);

select throws_ok(
  $$
    update public.subscriptions
    set management_url =
      'https://%75%73%65%72%3A%70%61%73%73%40billing.example.test/manage'
    where id = 'sub_management_authenticated'
  $$,
  '23514', null,
  'authenticated UPDATE rejects fully percent-encoded URI userinfo'
);

select throws_ok(
  $$
    update public.subscriptions
    set management_url = 'https://user：pass＠billing.example.test/manage'
    where id = 'sub_management_authenticated'
  $$,
  '23514', null,
  'authenticated UPDATE rejects fullwidth URI userinfo'
);

select throws_ok(
  $$
    insert into public.subscriptions(
      id, kind, service_name, amount_minor, currency_code, timezone,
      lifecycle_status, lifecycle_since, start_date, next_renewal_date,
      recurrence_unit, recurrence_interval
    ) values (
      'sub_authenticated_off_schedule', 'recurring', 'Off schedule',
      100, 'USD', 'UTC', 'active', '2024-01-31', '2024-01-31',
      '2024-02-15', 'month', 1
    )
  $$,
  '23514', null,
  'authenticated INSERT rejects an off-anchor recurring renewal'
);

select lives_ok(
  $$
    insert into public.subscriptions(
      id, kind, service_name, amount_minor, currency_code, timezone,
      lifecycle_status, lifecycle_since, start_date, next_renewal_date,
      recurrence_unit, recurrence_interval
    ) values (
      'sub_authenticated_aligned', 'recurring', 'Aligned month end',
      100, 'USD', 'UTC', 'active', '2024-01-31', '2024-01-31',
      '2024-02-29', 'month', 1
    )
  $$,
  'authenticated INSERT accepts an aligned month-end recurring renewal'
);

select throws_ok(
  $$
    update public.subscriptions
    set next_renewal_date = '2024-03-15'
    where id = 'sub_authenticated_aligned'
  $$,
  '23514', null,
  'authenticated UPDATE rejects an off-anchor recurring renewal'
);

select lives_ok(
  $$
    update public.subscriptions
    set next_renewal_date = '2024-03-31'
    where id = 'sub_authenticated_aligned'
  $$,
  'authenticated UPDATE accepts a later aligned month-end renewal'
);

select is(
  (select version from public.subscriptions where id = 'sub_authenticated_aligned'),
  2::bigint,
  'rejected recurrence writes do not consume an optimistic version'
);

delete from public.subscriptions
where id in (
  'sub_authenticated_encoded_cvv',
  'sub_authenticated_fullwidth_pan',
  'sub_authenticated_encoded_userinfo',
  'sub_authenticated_fullwidth_userinfo',
  'sub_authenticated_off_schedule'
);

select lives_ok(
  $$
    update public.subscriptions
    set management_url = 'https://example.test/invoice/1234567890123452',
        notes = 'IMEI 490154203237518; invoice 1234567890123452',
        payment_label = 'Visa •••• 4242'
    where id = 'sub_management_authenticated'
  $$,
  'authenticated UPDATE retains IMEI, invoice, and masked last-four controls'
);

select lives_ok(
  $$
    delete from public.subscriptions
    where id in ('sub_management_authenticated', 'sub_authenticated_aligned')
  $$,
  'authenticated owner can delete their subscription'
);

select is(
  (select count(*)::integer from public.subscriptions),
  0,
  'authenticated delete removes only the owner row'
);

reset role;

select results_eq(
  $$
    select private.contains_uri_userinfo(
      'https://%75%73%65%72%3A%70%61%73%73%40billing.example.test/manage'
    )
  $$,
  array[true],
  'fully percent-encoded URI userinfo is normalized before screening'
);

select results_eq(
  $$
    select private.contains_uri_userinfo(
      'https://user：pass＠billing.example.test/manage'
    )
  $$,
  array[true],
  'fullwidth URI userinfo delimiters are compatibility-normalized'
);

select results_eq(
  $$
    select private.contains_uri_userinfo(
      'https://example.test/invoice/1234567890123452'
    )
  $$,
  array[false],
  'credential-free HTTPS management links remain valid'
);

select results_eq(
  $$
    select label
    from (
      values
        ('weekly', date '2026-01-05', date '2026-01-19', 'week', 1),
        ('monthly', date '2026-01-15', date '2026-03-15', 'month', 1),
        ('quarterly', date '2026-01-15', date '2026-10-15', 'month', 3),
        ('semiannual', date '2026-01-15', date '2027-01-15', 'month', 6),
        ('annual', date '2024-02-28', date '2026-02-28', 'year', 1),
        ('custom 18-month', date '2024-02-29', date '2025-08-29', 'month', 18),
        ('month-end', date '2024-01-31', date '2024-03-31', 'month', 1),
        ('leap anchor', date '2024-02-29', date '2028-02-29', 'year', 1)
    ) as cases(label, anchor_date, candidate_date, recurrence_unit, recurrence_interval)
    where not private.is_subscription_occurrence(
      anchor_date, candidate_date, recurrence_unit, recurrence_interval
    )
    order by label
  $$,
  array[]::text[],
  'weekly, monthly, quarterly, semiannual, annual, custom, month-end, and leap renewals align'
);

select results_eq(
  $$
    select private.is_subscription_occurrence(
      date '2024-01-31', date '2024-02-15', 'month', 1
    )
  $$,
  array[false],
  'an off-anchor recurring renewal is rejected by the helper'
);

select * from finish();
rollback;
