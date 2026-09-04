create policy shop_policies_machine_update on policy.shop_policies
  for update using (app_private.has_machine_tenant_access(tenant_id))
  with check (app_private.has_machine_tenant_access(tenant_id));
