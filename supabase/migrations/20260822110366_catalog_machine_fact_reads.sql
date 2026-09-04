create policy shops_machine_read on catalog.shops
  for select using (app_private.has_machine_tenant_access(tenant_id));

create policy products_machine_read on catalog.products
  for select using (app_private.has_machine_tenant_access(tenant_id));

create policy inventory_machine_read on catalog.inventory
  for select using (app_private.has_machine_tenant_access(tenant_id));
