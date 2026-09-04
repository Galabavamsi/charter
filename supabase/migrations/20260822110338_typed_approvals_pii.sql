drop policy memberships_tenant_members_read on identity.shop_memberships;
create policy memberships_tenant_members_read on identity.shop_memberships
  for select using (
    app_private.has_active_membership(tenant_id, array['owner', 'admin'])
    or app_private.has_platform_role(array['admin', 'operator', 'auditor'])
  );

drop policy consents_user_or_members_select on recovery.consents;
create policy consents_self_or_recovery_select on recovery.consents
  for select using (
    (
      user_id = app_private.current_user_id()
      and tenant_id = app_private.current_tenant_id()
      and app_private.can_access_user(user_id)
      and app_private.is_active_tenant(tenant_id)
    )
    or app_private.has_active_membership(tenant_id, array['owner', 'admin', 'support'])
    or app_private.has_platform_role(array['admin', 'operator', 'auditor'])
  );

alter table policy.approvals
  add column if not exists kind text not null default 'cart_spend'
    check (kind in ('cart_spend', 'catalog_publish', 'refund', 'campaign', 'platform')),
  add column if not exists action_hash text,
  add column if not exists currency text not null default 'INR' check (currency = 'INR');
