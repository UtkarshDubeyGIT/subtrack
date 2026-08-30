alter table private.credential_families
  drop column if exists audience;

create or replace function public.broker_create_credential_family(
  p_family jsonb,
  p_credential jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.credential_families (
    id, provider_session_id, subject, created_at
  ) values (
    p_family->>'id',
    p_family->>'providerSessionId',
    p_family->>'subject',
    to_timestamp((p_family->>'createdAt')::double precision / 1000)
  );
  insert into private.refresh_credentials (
    credential_hash, family_id, generation, created_at, expires_at
  ) values (
    p_credential->>'hash',
    p_credential->>'familyId',
    (p_credential->>'generation')::integer,
    to_timestamp((p_credential->>'createdAt')::double precision / 1000),
    to_timestamp((p_credential->>'expiresAt')::double precision / 1000)
  );
end;
$$;

create or replace function public.broker_inspect_refresh(
  p_hash text,
  p_now_ms bigint
)
returns jsonb
language sql
security definer
set search_path = ''
stable
as $$
  with found as (
    select r.*, f.provider_session_id, f.subject,
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
        'createdAt', extract(epoch from family_created_at) * 1000,
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
      'subject', family_row.subject,
      'createdAt', extract(epoch from family_row.created_at) * 1000,
      'revokedAt', extract(epoch from family_row.revoked_at) * 1000));
  end if;
  if old_row.expires_at <= to_timestamp(p_now_ms::double precision / 1000) then
    return '{"status":"expired"}'::jsonb;
  end if;
  if old_row.used_at is not null then
    return jsonb_build_object('status', 'reused', 'family', jsonb_build_object(
      'id', family_row.id, 'providerSessionId', family_row.provider_session_id,
      'subject', family_row.subject,
      'createdAt', extract(epoch from family_row.created_at) * 1000));
  end if;

  update private.refresh_credentials
  set used_at = to_timestamp(p_now_ms::double precision / 1000)
  where credential_hash = p_old_hash;
  insert into private.refresh_credentials (
    credential_hash, family_id, generation, created_at, expires_at
  ) values (
    p_replacement->>'hash',
    p_replacement->>'familyId',
    (p_replacement->>'generation')::integer,
    to_timestamp((p_replacement->>'createdAt')::double precision / 1000),
    to_timestamp((p_replacement->>'expiresAt')::double precision / 1000)
  );
  return jsonb_build_object('status', 'rotated', 'family', jsonb_build_object(
    'id', family_row.id, 'providerSessionId', family_row.provider_session_id,
    'subject', family_row.subject,
    'createdAt', extract(epoch from family_row.created_at) * 1000));
end;
$$;

revoke all on function public.broker_create_credential_family(jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function public.broker_inspect_refresh(text, bigint)
  from public, anon, authenticated;
revoke all on function public.broker_rotate_refresh(text, jsonb, bigint)
  from public, anon, authenticated;

grant execute on function public.broker_create_credential_family(jsonb, jsonb)
  to service_role;
grant execute on function public.broker_inspect_refresh(text, bigint)
  to service_role;
grant execute on function public.broker_rotate_refresh(text, jsonb, bigint)
  to service_role;
