create policy categories_public_read on catalog.categories
  for select using (
    status = 'active'
    and app_private.has_public_catalog_access()
    and app_private.is_public_shop(tenant_id, 'published')
  );

create index public_directory_shop_sort_idx
  on catalog.shops (published_at desc, lower(name), tenant_id)
  where status = 'published';

create index public_directory_category_lookup_idx
  on catalog.categories (tenant_id, slug, title)
  where status = 'active';

create index public_directory_product_category_idx
  on catalog.products (tenant_id, category_id, published_at desc, id)
  where status = 'published';

create index public_directory_variant_price_idx
  on catalog.variants (tenant_id, price_minor, published_at desc, id)
  where status = 'published';

create index public_directory_variant_aliases_idx
  on catalog.variants using gin (aliases)
  where status = 'published';
