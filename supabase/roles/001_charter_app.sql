create or replace function pg_temp.provision_charter_app(role_password text)
returns void
language plpgsql
set search_path = pg_catalog
as $$
begin
  if role_password is null or length(role_password) < 16 then
    raise exception 'CHARTER_APP_PASSWORD_REQUIRED';
  end if;
  if to_regprocedure('app_private.resolve_webhook_checkout_by_order(text)') is null then
    raise exception 'CHARTER_APP_SCHEMA_NOT_MIGRATED';
  end if;

  if not exists (select 1 from pg_roles where rolname = 'charter_app') then
    execute 'create role charter_app';
  end if;

  execute
    'alter role charter_app with login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls';
  execute format('alter role charter_app password %L', role_password);

  execute format(
    'revoke all privileges on database %I from charter_app',
    current_database()
  );
  execute format(
    'grant connect on database %I to charter_app',
    current_database()
  );

  execute
    'revoke all on schema app_private, identity, commerce, payments, ledger, integration, catalog, policy, conversation, recovery, operations from charter_app';
  execute
    'grant usage on schema app_private, identity, commerce, payments, ledger, integration, catalog, policy, conversation, recovery, operations to charter_app';

  execute
    'revoke all on all tables in schema identity, commerce, payments, ledger, integration, catalog, policy, conversation, recovery, operations from charter_app';
  execute
    'grant select, insert, update, delete on all tables in schema identity, commerce, payments, ledger, integration, catalog, policy, conversation, recovery, operations to charter_app';

  execute
    'revoke all on all sequences in schema identity, commerce, payments, ledger, integration, catalog, policy, conversation, recovery, operations from charter_app';
  execute
    'grant usage, select on all sequences in schema identity, commerce, payments, ledger, integration, catalog, policy, conversation, recovery, operations to charter_app';

  execute
    'revoke all on function app_private.resolve_webhook_checkout_by_order(text) from charter_app';
  execute
    'grant execute on function app_private.resolve_webhook_checkout_by_order(text) to charter_app';
end
$$;
