create schema if not exists private;

revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create table private.auth_transactions (
  id text primary key check (length(id) between 32 and 128),
  state text not null check (length(state) between 1 and 512),
  code_challenge text not null check (length(code_challenge) between 43 and 128),
  redirect_uri text not null check (length(redirect_uri) between 1 and 512),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  status text not null check (status in ('pending', 'callback_complete', 'exchanged')),
  authorization_code_hash text unique,
  authorization_code_expires_at timestamptz,
  provider_session_id text,
  subject text,
  check (expires_at > created_at)
);

create table private.credential_families (
  id text primary key,
  provider_session_id text not null,
  subject text not null,
  audience text not null,
  created_at timestamptz not null,
  revoked_at timestamptz
);

create table private.refresh_credentials (
  credential_hash text primary key,
  family_id text not null references private.credential_families(id) on delete cascade,
  generation integer not null check (generation >= 0),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  check (expires_at > created_at)
);

create table private.auth_rate_limits (
  key_hash text primary key,
  attempt_count integer not null check (attempt_count > 0),
  window_ends_at timestamptz not null
);

create index auth_transactions_expiry_idx on private.auth_transactions(expires_at);
create index auth_transactions_code_expiry_idx on private.auth_transactions(authorization_code_expires_at);
create index refresh_credentials_family_idx on private.refresh_credentials(family_id);
create index refresh_credentials_expiry_idx on private.refresh_credentials(expires_at);
create index auth_rate_limits_expiry_idx on private.auth_rate_limits(window_ends_at);

alter table private.auth_transactions enable row level security;
alter table private.credential_families enable row level security;
alter table private.refresh_credentials enable row level security;
alter table private.auth_rate_limits enable row level security;

revoke all on all tables in schema private from public, anon, authenticated;
grant select, insert, update, delete on all tables in schema private to service_role;

create or replace function public.broker_create_authorization(p_transaction jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into private.auth_transactions (
    id, state, code_challenge, redirect_uri, created_at, expires_at, status
  ) values (
    p_transaction->>'id',
    p_transaction->>'state',
    p_transaction->>'codeChallenge',
    p_transaction->>'redirectUri',
    to_timestamp((p_transaction->>'createdAt')::double precision / 1000),
    to_timestamp((p_transaction->>'expiresAt')::double precision / 1000),
    p_transaction->>'status'
  );
$$;

create or replace function public.broker_get_authorization(p_id text)
returns jsonb
language sql
security definer
set search_path = ''
stable
as $$
  select jsonb_build_object(
    'id', id,
    'state', state,
    'codeChallenge', code_challenge,
    'redirectUri', redirect_uri,
    'createdAt', extract(epoch from created_at) * 1000,
    'expiresAt', extract(epoch from expires_at) * 1000,
    'status', status,
    'authorizationCodeHash', authorization_code_hash,
    'authorizationCodeExpiresAt', extract(epoch from authorization_code_expires_at) * 1000,
    'providerSessionId', provider_session_id,
    'subject', subject
  ) from private.auth_transactions where id = p_id;
$$;

create or replace function public.broker_complete_authorization(
  p_id text,
  p_completion jsonb,
  p_now_ms bigint
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.auth_transactions
  set status = 'callback_complete',
      authorization_code_hash = p_completion->>'authorizationCodeHash',
      authorization_code_expires_at = to_timestamp((p_completion->>'authorizationCodeExpiresAt')::double precision / 1000),
      provider_session_id = p_completion->>'providerSessionId',
      subject = p_completion->>'subject'
  where id = p_id
    and status = 'pending'
    and expires_at > to_timestamp(p_now_ms::double precision / 1000);
  return found;
end;
$$;

create or replace function public.broker_consume_authorization_code(p_hash text, p_now_ms bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed private.auth_transactions;
begin
  update private.auth_transactions
  set status = 'exchanged'
  where authorization_code_hash = p_hash
    and status = 'callback_complete'
    and authorization_code_expires_at > to_timestamp(p_now_ms::double precision / 1000)
  returning * into claimed;
  if not found then return null; end if;
  return jsonb_build_object(
    'id', claimed.id,
    'state', claimed.state,
    'codeChallenge', claimed.code_challenge,
    'redirectUri', claimed.redirect_uri,
    'createdAt', extract(epoch from claimed.created_at) * 1000,
    'expiresAt', extract(epoch from claimed.expires_at) * 1000,
    'status', claimed.status,
    'authorizationCodeHash', claimed.authorization_code_hash,
    'authorizationCodeExpiresAt', extract(epoch from claimed.authorization_code_expires_at) * 1000,
    'providerSessionId', claimed.provider_session_id,
    'subject', claimed.subject
  );
end;
$$;

create or replace function public.broker_create_credential_family(p_family jsonb, p_credential jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.credential_families (
    id, provider_session_id, subject, audience, created_at
  ) values (
    p_family->>'id', p_family->>'providerSessionId', p_family->>'subject',
    p_family->>'audience', to_timestamp((p_family->>'createdAt')::double precision / 1000)
  );
  insert into private.refresh_credentials (
    credential_hash, family_id, generation, created_at, expires_at
  ) values (
    p_credential->>'hash', p_credential->>'familyId', (p_credential->>'generation')::integer,
    to_timestamp((p_credential->>'createdAt')::double precision / 1000),
    to_timestamp((p_credential->>'expiresAt')::double precision / 1000)
  );
end;
$$;

create or replace function public.broker_inspect_refresh(p_hash text, p_now_ms bigint)
returns jsonb
language sql
security definer
set search_path = ''
stable
as $$
  with found as (
    select r.*, f.provider_session_id, f.subject, f.audience,
           f.created_at as family_created_at, f.revoked_at
    from private.refresh_credentials r
    join private.credential_families f on f.id = r.family_id
    where r.credential_hash = p_hash
  )
  select coalesce((
    select jsonb_build_object(
      'status', case
        when expires_at <= to_timestamp(p_now_ms::double precision / 1000) then 'expired'
        when revoked_at is not null then 'family_revoked'
        when used_at is not null then 'used'
        else 'active'
      end,
      'credential', jsonb_build_object(
        'hash', credential_hash, 'familyId', family_id, 'generation', generation,
        'createdAt', extract(epoch from created_at) * 1000,
        'expiresAt', extract(epoch from expires_at) * 1000,
        'usedAt', extract(epoch from used_at) * 1000
      ),
      'family', jsonb_build_object(
        'id', family_id, 'providerSessionId', provider_session_id, 'subject', subject,
        'audience', audience, 'createdAt', extract(epoch from family_created_at) * 1000,
        'revokedAt', extract(epoch from revoked_at) * 1000
      )
    ) from found
  ), '{"status":"missing"}'::jsonb);
$$;

create or replace function public.broker_rotate_refresh(
  p_old_hash text,
  p_replacement jsonb,
  p_now_ms bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_row private.refresh_credentials;
  family_row private.credential_families;
begin
  select * into old_row from private.refresh_credentials
  where credential_hash = p_old_hash for update;
  if not found then return '{"status":"missing"}'::jsonb; end if;
  select * into family_row from private.credential_families
  where id = old_row.family_id for update;
  if family_row.revoked_at is not null then
    return jsonb_build_object('status', 'family_revoked', 'family', jsonb_build_object(
      'id', family_row.id, 'providerSessionId', family_row.provider_session_id,
      'subject', family_row.subject, 'audience', family_row.audience,
      'createdAt', extract(epoch from family_row.created_at) * 1000,
      'revokedAt', extract(epoch from family_row.revoked_at) * 1000));
  end if;
  if old_row.expires_at <= to_timestamp(p_now_ms::double precision / 1000) then
    return '{"status":"expired"}'::jsonb;
  end if;
  if old_row.used_at is not null then
    return jsonb_build_object('status', 'reused', 'family', jsonb_build_object(
      'id', family_row.id, 'providerSessionId', family_row.provider_session_id,
      'subject', family_row.subject, 'audience', family_row.audience,
      'createdAt', extract(epoch from family_row.created_at) * 1000));
  end if;
  update private.refresh_credentials set used_at = to_timestamp(p_now_ms::double precision / 1000)
  where credential_hash = p_old_hash;
  insert into private.refresh_credentials (
    credential_hash, family_id, generation, created_at, expires_at
  ) values (
    p_replacement->>'hash', p_replacement->>'familyId', (p_replacement->>'generation')::integer,
    to_timestamp((p_replacement->>'createdAt')::double precision / 1000),
    to_timestamp((p_replacement->>'expiresAt')::double precision / 1000)
  );
  return jsonb_build_object('status', 'rotated', 'family', jsonb_build_object(
    'id', family_row.id, 'providerSessionId', family_row.provider_session_id,
    'subject', family_row.subject, 'audience', family_row.audience,
    'createdAt', extract(epoch from family_row.created_at) * 1000));
end;
$$;

create or replace function public.broker_revoke_family(p_family_id text, p_now_ms bigint)
returns void
language sql
security definer
set search_path = ''
as $$
  update private.credential_families
  set revoked_at = coalesce(revoked_at, to_timestamp(p_now_ms::double precision / 1000))
  where id = p_family_id;
$$;

create or replace function public.broker_take_rate_limit(
  p_key_hash text,
  p_limit integer,
  p_window_ms bigint,
  p_now_ms bigint
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare current_count integer;
begin
  insert into private.auth_rate_limits(key_hash, attempt_count, window_ends_at)
  values (p_key_hash, 1, to_timestamp((p_now_ms + p_window_ms)::double precision / 1000))
  on conflict (key_hash) do update set
    attempt_count = case
      when private.auth_rate_limits.window_ends_at <= to_timestamp(p_now_ms::double precision / 1000)
        then 1 else private.auth_rate_limits.attempt_count + 1 end,
    window_ends_at = case
      when private.auth_rate_limits.window_ends_at <= to_timestamp(p_now_ms::double precision / 1000)
        then excluded.window_ends_at else private.auth_rate_limits.window_ends_at end
  returning attempt_count into current_count;
  return current_count <= p_limit;
end;
$$;

create or replace function public.broker_cleanup(p_now_ms bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare transaction_count integer; credential_count integer; rate_count integer;
begin
  delete from private.auth_transactions
  where expires_at <= to_timestamp(p_now_ms::double precision / 1000)
     or authorization_code_expires_at <= to_timestamp(p_now_ms::double precision / 1000);
  get diagnostics transaction_count = row_count;
  delete from private.refresh_credentials
  where expires_at <= to_timestamp(p_now_ms::double precision / 1000);
  get diagnostics credential_count = row_count;
  delete from private.auth_rate_limits
  where window_ends_at <= to_timestamp(p_now_ms::double precision / 1000);
  get diagnostics rate_count = row_count;
  return jsonb_build_object(
    'transactions', transaction_count,
    'credentials', credential_count,
    'rateLimits', rate_count
  );
end;
$$;

revoke all on function public.broker_create_authorization(jsonb) from public, anon, authenticated;
revoke all on function public.broker_get_authorization(text) from public, anon, authenticated;
revoke all on function public.broker_complete_authorization(text, jsonb, bigint) from public, anon, authenticated;
revoke all on function public.broker_consume_authorization_code(text, bigint) from public, anon, authenticated;
revoke all on function public.broker_create_credential_family(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.broker_inspect_refresh(text, bigint) from public, anon, authenticated;
revoke all on function public.broker_rotate_refresh(text, jsonb, bigint) from public, anon, authenticated;
revoke all on function public.broker_revoke_family(text, bigint) from public, anon, authenticated;
revoke all on function public.broker_take_rate_limit(text, integer, bigint, bigint) from public, anon, authenticated;
revoke all on function public.broker_cleanup(bigint) from public, anon, authenticated;

grant execute on function public.broker_create_authorization(jsonb) to service_role;
grant execute on function public.broker_get_authorization(text) to service_role;
grant execute on function public.broker_complete_authorization(text, jsonb, bigint) to service_role;
grant execute on function public.broker_consume_authorization_code(text, bigint) to service_role;
grant execute on function public.broker_create_credential_family(jsonb, jsonb) to service_role;
grant execute on function public.broker_inspect_refresh(text, bigint) to service_role;
grant execute on function public.broker_rotate_refresh(text, jsonb, bigint) to service_role;
grant execute on function public.broker_revoke_family(text, bigint) to service_role;
grant execute on function public.broker_take_rate_limit(text, integer, bigint, bigint) to service_role;
grant execute on function public.broker_cleanup(bigint) to service_role;
