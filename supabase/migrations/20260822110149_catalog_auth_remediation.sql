create function app_private.has_public_catalog_access()
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog
as $$
  select
    current_setting('app.service_context', true) = 'public_catalog'
    and (
      current_user::text = 'charter_app'
      or (
        current_user::text ~ '^charter_ci_[a-z0-9_]+$'
        and current_database() ~ '^charter_schema_auth_[a-f0-9]+$'
      )
    )
$$;

create function app_private.is_public_inventory(
  target_tenant_id text,
  target_variant_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select exists (
    select 1
    from catalog.shops shop
    join identity.tenants tenant
      on tenant.id = shop.tenant_id
     and tenant.status = 'active'
    join catalog.variants variant
      on variant.tenant_id = shop.tenant_id
     and variant.id = target_variant_id
     and variant.status = 'published'
    join catalog.products product
      on product.tenant_id = variant.tenant_id
     and product.id = variant.product_id
     and product.status = 'published'
    where shop.tenant_id = target_tenant_id
      and shop.status = 'published'
  )
$$;

revoke all on function app_private.has_public_catalog_access() from public;
revoke all on function app_private.is_public_inventory(text, uuid) from public;
grant execute on function app_private.has_public_catalog_access() to public;
grant execute on function app_private.is_public_inventory(text, uuid) to public;

drop policy shops_public_read on catalog.shops;
create policy shops_public_read on catalog.shops
  for select using (
    (
      app_private.has_public_catalog_access()
      and app_private.is_public_shop(tenant_id, status)
    )
    or app_private.has_active_membership(tenant_id, null)
  );

drop policy products_public_read on catalog.products;
create policy products_public_read on catalog.products
  for select using (
    (
      app_private.has_public_catalog_access()
      and app_private.is_public_product(tenant_id, status)
    )
    or app_private.has_active_membership(tenant_id, null)
  );

drop policy variants_public_read on catalog.variants;
create policy variants_public_read on catalog.variants
  for select using (
    (
      app_private.has_public_catalog_access()
      and app_private.is_public_variant(tenant_id, product_id, status)
    )
    or app_private.has_active_membership(tenant_id, null)
  );

create policy inventory_public_read on catalog.inventory
  for select using (
    app_private.has_public_catalog_access()
    and app_private.is_public_inventory(tenant_id, variant_id)
  );

drop policy products_managers_insert on catalog.products;
drop policy products_managers_update on catalog.products;
create policy products_catalog_writers_insert on catalog.products
  for insert with check (
    app_private.has_active_membership(tenant_id, array['owner', 'admin', 'catalog'])
  );
create policy products_catalog_writers_update on catalog.products
  for update using (
    app_private.has_active_membership(tenant_id, array['owner', 'admin', 'catalog'])
  )
  with check (
    app_private.has_active_membership(tenant_id, array['owner', 'admin', 'catalog'])
  );

drop policy variants_managers_insert on catalog.variants;
drop policy variants_managers_update on catalog.variants;
create policy variants_catalog_writers_insert on catalog.variants
  for insert with check (
    app_private.has_active_membership(tenant_id, array['owner', 'admin', 'catalog'])
  );
create policy variants_catalog_writers_update on catalog.variants
  for update using (
    app_private.has_active_membership(tenant_id, array['owner', 'admin', 'catalog'])
  )
  with check (
    app_private.has_active_membership(tenant_id, array['owner', 'admin', 'catalog'])
  );

drop policy inventory_managers_insert on catalog.inventory;
drop policy inventory_managers_update on catalog.inventory;
create policy inventory_catalog_writers_insert on catalog.inventory
  for insert with check (
    app_private.has_active_membership(tenant_id, array['owner', 'admin', 'catalog'])
  );
create policy inventory_catalog_writers_update on catalog.inventory
  for update using (
    app_private.has_active_membership(tenant_id, array['owner', 'admin', 'catalog'])
  )
  with check (
    app_private.has_active_membership(tenant_id, array['owner', 'admin', 'catalog'])
  );
