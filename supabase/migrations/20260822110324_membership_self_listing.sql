create function app_private.has_self_membership(target_tenant_id text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select
    app_private.current_user_id() is not null
    and exists (
      select 1
      from identity.shop_memberships membership
      join identity.users application_user
        on application_user.id = membership.user_id
       and application_user.status = 'active'
      join identity.tenants tenant
        on tenant.id = membership.tenant_id
       and tenant.status = 'active'
      where membership.tenant_id = target_tenant_id
        and membership.user_id = app_private.current_user_id()
        and membership.status = 'active'
    )
$$;

revoke all on function app_private.has_self_membership(text) from public;
grant execute on function app_private.has_self_membership(text) to public;

drop policy memberships_members_read on identity.shop_memberships;
create policy memberships_self_list on identity.shop_memberships
  for select using (
    user_id = app_private.current_user_id()
    and status = 'active'
    and app_private.current_user_id() is not null
  );
create policy memberships_tenant_members_read on identity.shop_memberships
  for select using (
    app_private.has_active_membership(tenant_id, null)
    or app_private.has_platform_role(array['admin', 'operator', 'auditor'])
  );

drop policy tenants_members_select on identity.tenants;
create policy tenants_members_select on identity.tenants
  for select using (
    app_private.has_active_membership(id, null)
    or app_private.has_self_membership(id)
    or app_private.has_platform_role(array['admin', 'operator', 'auditor'])
  );

drop policy shops_public_read on catalog.shops;
create policy shops_public_read on catalog.shops
  for select using (
    (
      app_private.has_public_catalog_access()
      and app_private.is_public_shop(tenant_id, status)
    )
    or app_private.has_active_membership(tenant_id, null)
    or app_private.has_self_membership(tenant_id)
  );
