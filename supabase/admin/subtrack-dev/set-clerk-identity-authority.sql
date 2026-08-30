-- Environment-specific admin operation for subtrack-dev (qjsyhvclllikkopjfqtc).
-- This file is intentionally outside supabase/migrations: other environments
-- must review and supply their own exact public Clerk issuer.
begin;

lock table private.clerk_identity_authority in exclusive mode;

insert into private.clerk_identity_authority(singleton, issuer)
values (true, 'https://steady-ladybug-22.clerk.accounts.dev')
on conflict (singleton) do update
set issuer = excluded.issuer;

do $$
begin
  if (
    select count(*) = 1
      and bool_and(singleton)
      and bool_and(issuer = 'https://steady-ladybug-22.clerk.accounts.dev')
    from private.clerk_identity_authority
  ) is not true then
    raise exception 'subtrack-dev Clerk identity authority assertion failed'
      using errcode = '23514';
  end if;
end;
$$;

commit;
