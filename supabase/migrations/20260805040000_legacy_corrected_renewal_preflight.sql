-- This retroactively ordered pre-release guard intentionally runs before
-- 20260805044822 strengthens corrected-renewal history. Databases already past
-- this version apply it with the reviewed `db push --include-all` procedure.
do $$
declare
  original_currency_column_exists boolean;
begin
  select exists (
    select 1
    from pg_catalog.pg_attribute attribute
    join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'renewal_events'
      and attribute.attname = 'original_currency_code'
      and attribute.attnum > 0
      and not attribute.attisdropped
  ) into original_currency_column_exists;

  if not original_currency_column_exists then
    if exists (select 1 from public.renewal_events where state = 'corrected') then
      raise exception 'legacy corrected renewals require explicit original_currency_code reconciliation before migration 20260805044822'
        using errcode = '23514',
          hint = 'Add original_currency_code, backfill each corrected row from authoritative history, then rerun the migration chain; never infer it from currency_code.';
    end if;
  elsif exists (
    select 1
    from public.renewal_events
    where state = 'corrected' and original_currency_code is null
  ) then
    raise exception 'legacy corrected renewals require explicit original_currency_code reconciliation before migration 20260805044822'
      using errcode = '23514',
        hint = 'Backfill each corrected row from authoritative history, then rerun the migration chain; never infer it from currency_code.';
  end if;
end;
$$;
