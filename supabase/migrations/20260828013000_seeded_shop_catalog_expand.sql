-- Extra SKUs for published demo shops. Idempotent so live inventory is not reset.
-- Skip rows when tenant/category rows are not present yet (fresh migrate before seed).
insert into catalog.products (
  id,
  tenant_id,
  category_id,
  slug,
  title,
  description,
  status,
  currency,
  published_at,
  created_at,
  updated_at
)
select
  v.id,
  v.tenant_id,
  v.category_id,
  v.slug,
  v.title,
  v.description,
  v.status,
  v.currency,
  v.published_at,
  v.created_at,
  v.updated_at
from (
  values
    ('11000000-0000-4000-8000-000000000007'::uuid, 'northstar-demo-in', '10000000-0000-4000-8000-000000000001'::uuid, 'steel-travel-mug', 'Steel travel mug', 'Insulated mug for the road.', 'published', 'INR', '2026-01-01 00:00:00+00'::timestamptz, now(), now()),
    ('11000000-0000-4000-8000-000000000008'::uuid, 'northstar-demo-in', '10000000-0000-4000-8000-000000000001'::uuid, 'house-beans-250', 'House beans, 250 g', 'House roast for travel kits.', 'published', 'INR', '2026-01-01 00:00:00+00'::timestamptz, now(), now()),
    ('21000000-0000-4000-8000-000000000005'::uuid, 'indigo-desk-in', '20000000-0000-4000-8000-000000000001'::uuid, 'cork-desk-mat', 'Cork desk mat', 'Cork mat for a small desk.', 'published', 'INR', '2026-01-01 00:00:00+00'::timestamptz, now(), now()),
    ('21000000-0000-4000-8000-000000000006'::uuid, 'indigo-desk-in', '20000000-0000-4000-8000-000000000001'::uuid, 'washi-tape-set', 'Washi tape set', 'Washi tape for notes and wrapping.', 'published', 'INR', '2026-01-01 00:00:00+00'::timestamptz, now(), now()),
    ('21000000-0000-4000-8000-000000000007'::uuid, 'indigo-desk-in', '20000000-0000-4000-8000-000000000001'::uuid, 'letter-tray', 'Letter tray', 'Tray for incoming paper.', 'published', 'INR', '2026-01-01 00:00:00+00'::timestamptz, now(), now()),
    ('31000000-0000-4000-8000-000000000005'::uuid, 'harbor-spice-in', '30000000-0000-4000-8000-000000000001'::uuid, 'turmeric-100', 'Turmeric, 100 g', 'Everyday turmeric.', 'published', 'INR', '2026-01-01 00:00:00+00'::timestamptz, now(), now()),
    ('31000000-0000-4000-8000-000000000006'::uuid, 'harbor-spice-in', '30000000-0000-4000-8000-000000000001'::uuid, 'red-chili-100', 'Red chili, 100 g', 'Ground red chili.', 'published', 'INR', '2026-01-01 00:00:00+00'::timestamptz, now(), now()),
    ('31000000-0000-4000-8000-000000000007'::uuid, 'harbor-spice-in', '30000000-0000-4000-8000-000000000001'::uuid, 'assam-tea-200', 'Assam tea, 200 g', 'Everyday Assam leaf.', 'published', 'INR', '2026-01-01 00:00:00+00'::timestamptz, now(), now()),
    ('40100000-0000-4000-8000-000000000004'::uuid, 'sable-atelier-in', '40000000-0000-4000-8000-000000000001'::uuid, 'sand-linen-shirt', 'Sand linen shirt', 'Light linen shirt in sand.', 'published', 'INR', '2026-02-01 00:00:00+00'::timestamptz, now(), now()),
    ('40100000-0000-4000-8000-000000000005'::uuid, 'sable-atelier-in', '40000000-0000-4000-8000-000000000001'::uuid, 'oat-wool-beanie', 'Oat wool beanie', 'Soft wool beanie in oat.', 'published', 'INR', '2026-02-01 00:00:00+00'::timestamptz, now(), now()),
    ('40100000-0000-4000-8000-000000000006'::uuid, 'sable-atelier-in', '40000000-0000-4000-8000-000000000001'::uuid, 'cotton-crew-socks', 'Cotton crew socks', 'Everyday cotton crew socks.', 'published', 'INR', '2026-02-01 00:00:00+00'::timestamptz, now(), now()),
    ('50100000-0000-4000-8000-000000000004'::uuid, 'lotus-gifting-in', '50000000-0000-4000-8000-000000000001'::uuid, 'tea-hamper', 'Tea hamper', 'A small tea hamper for gifting.', 'published', 'INR', '2026-02-08 00:00:00+00'::timestamptz, now(), now()),
    ('50100000-0000-4000-8000-000000000005'::uuid, 'lotus-gifting-in', '50000000-0000-4000-8000-000000000001'::uuid, 'handmade-note-card', 'Handmade note card', 'A card to go with a gift.', 'published', 'INR', '2026-02-08 00:00:00+00'::timestamptz, now(), now()),
    ('50100000-0000-4000-8000-000000000006'::uuid, 'lotus-gifting-in', '50000000-0000-4000-8000-000000000001'::uuid, 'oak-photo-frame', 'Oak photo frame', 'A small oak frame.', 'published', 'INR', '2026-02-08 00:00:00+00'::timestamptz, now(), now()),
    ('60100000-0000-4000-8000-000000000004'::uuid, 'marigold-home-in', '60000000-0000-4000-8000-000000000001'::uuid, 'sandal-incense', 'Sandal incense', 'Sandalwood incense sticks.', 'published', 'INR', '2026-02-15 00:00:00+00'::timestamptz, now(), now()),
    ('60100000-0000-4000-8000-000000000005'::uuid, 'marigold-home-in', '60000000-0000-4000-8000-000000000001'::uuid, 'ceramic-bud-vase', 'Ceramic bud vase', 'A small ceramic vase.', 'published', 'INR', '2026-02-15 00:00:00+00'::timestamptz, now(), now()),
    ('60100000-0000-4000-8000-000000000006'::uuid, 'marigold-home-in', '60000000-0000-4000-8000-000000000001'::uuid, 'linen-napkin-set', 'Linen napkin set', 'Linen napkins for the table.', 'published', 'INR', '2026-02-15 00:00:00+00'::timestamptz, now(), now())
) as v(id, tenant_id, category_id, slug, title, description, status, currency, published_at, created_at, updated_at)
where exists (select 1 from identity.tenants as tenant where tenant.id = v.tenant_id)
  and exists (select 1 from catalog.categories as category where category.id = v.category_id)
on conflict (id) do nothing;

insert into catalog.variants (
  id,
  tenant_id,
  product_id,
  sku,
  title,
  price_minor,
  currency,
  material,
  aliases,
  status,
  published_at,
  created_at,
  updated_at
)
select
  v.id,
  v.tenant_id,
  v.product_id,
  v.sku,
  v.title,
  v.price_minor,
  v.currency,
  v.material,
  v.aliases,
  v.status,
  v.published_at,
  v.created_at,
  v.updated_at
from (
  values
    ('12000000-0000-4000-8000-000000000007'::uuid, 'northstar-demo-in', '11000000-0000-4000-8000-000000000007'::uuid, 'mug.steel-travel', 'Steel travel mug', 79900, 'INR', 'steel', array['mug', 'flask', 'cup', 'travel mug']::text[], 'published', '2026-01-01 00:00:00+00'::timestamptz, now(), now()),
    ('12000000-0000-4000-8000-000000000008'::uuid, 'northstar-demo-in', '11000000-0000-4000-8000-000000000008'::uuid, 'beans.house-250', 'House beans, 250 g', 44900, 'INR', 'other', array['coffee', 'beans', 'grounds']::text[], 'published', '2026-01-01 00:00:00+00'::timestamptz, now(), now()),
    ('22000000-0000-4000-8000-000000000005'::uuid, 'indigo-desk-in', '21000000-0000-4000-8000-000000000005'::uuid, 'mat.desk-cork', 'Cork desk mat', 89900, 'INR', 'other', array['mat', 'desk', 'stationery']::text[], 'published', '2026-01-01 00:00:00+00'::timestamptz, now(), now()),
    ('22000000-0000-4000-8000-000000000006'::uuid, 'indigo-desk-in', '21000000-0000-4000-8000-000000000006'::uuid, 'tape.washi-set', 'Washi tape set', 24900, 'INR', 'paper', array['tape', 'washi', 'stationery']::text[], 'published', '2026-01-01 00:00:00+00'::timestamptz, now(), now()),
    ('22000000-0000-4000-8000-000000000007'::uuid, 'indigo-desk-in', '21000000-0000-4000-8000-000000000007'::uuid, 'tray.letter', 'Letter tray', 59900, 'INR', 'other', array['tray', 'inbox', 'office']::text[], 'published', '2026-01-01 00:00:00+00'::timestamptz, now(), now()),
    ('32000000-0000-4000-8000-000000000005'::uuid, 'harbor-spice-in', '31000000-0000-4000-8000-000000000005'::uuid, 'spice.turmeric-100', 'Turmeric, 100 g', 12900, 'INR', 'other', array['haldi', 'turmeric']::text[], 'published', '2026-01-01 00:00:00+00'::timestamptz, now(), now()),
    ('32000000-0000-4000-8000-000000000006'::uuid, 'harbor-spice-in', '31000000-0000-4000-8000-000000000006'::uuid, 'spice.chili-100', 'Red chili, 100 g', 13900, 'INR', 'other', array['chili', 'chilli', 'mirch']::text[], 'published', '2026-01-01 00:00:00+00'::timestamptz, now(), now()),
    ('32000000-0000-4000-8000-000000000007'::uuid, 'harbor-spice-in', '31000000-0000-4000-8000-000000000007'::uuid, 'tea.assam-200', 'Assam tea, 200 g', 29900, 'INR', 'other', array['tea', 'chai']::text[], 'published', '2026-01-01 00:00:00+00'::timestamptz, now(), now()),
    ('40200000-0000-4000-8000-000000000004'::uuid, 'sable-atelier-in', '40100000-0000-4000-8000-000000000004'::uuid, 'shirt.linen-sand', 'Sand linen shirt', 219900, 'INR', 'other', array['linen', 'shirt', 'top', 'gift']::text[], 'published', '2026-02-01 00:00:00+00'::timestamptz, now(), now()),
    ('40200000-0000-4000-8000-000000000005'::uuid, 'sable-atelier-in', '40100000-0000-4000-8000-000000000005'::uuid, 'beanie.wool-oat', 'Oat wool beanie', 89900, 'INR', 'other', array['beanie', 'hat', 'wool', 'gift']::text[], 'published', '2026-02-01 00:00:00+00'::timestamptz, now(), now()),
    ('40200000-0000-4000-8000-000000000006'::uuid, 'sable-atelier-in', '40100000-0000-4000-8000-000000000006'::uuid, 'sock.cotton-crew', 'Cotton crew socks', 49900, 'INR', 'other', array['socks', 'gift']::text[], 'published', '2026-02-01 00:00:00+00'::timestamptz, now(), now()),
    ('50200000-0000-4000-8000-000000000004'::uuid, 'lotus-gifting-in', '50100000-0000-4000-8000-000000000004'::uuid, 'gift.tea-hamper', 'Tea hamper', 99900, 'INR', 'other', array['hamper', 'tea', 'gift']::text[], 'published', '2026-02-08 00:00:00+00'::timestamptz, now(), now()),
    ('50200000-0000-4000-8000-000000000005'::uuid, 'lotus-gifting-in', '50100000-0000-4000-8000-000000000005'::uuid, 'gift.note-card', 'Handmade note card', 19900, 'INR', 'paper', array['card', 'note', 'gift']::text[], 'published', '2026-02-08 00:00:00+00'::timestamptz, now(), now()),
    ('50200000-0000-4000-8000-000000000006'::uuid, 'lotus-gifting-in', '50100000-0000-4000-8000-000000000006'::uuid, 'gift.photo-frame', 'Oak photo frame', 79900, 'INR', 'other', array['frame', 'photo', 'gift']::text[], 'published', '2026-02-08 00:00:00+00'::timestamptz, now(), now()),
    ('60200000-0000-4000-8000-000000000004'::uuid, 'marigold-home-in', '60100000-0000-4000-8000-000000000004'::uuid, 'home.incense-sandal', 'Sandal incense', 34900, 'INR', 'other', array['incense', 'agarbatti', 'gift']::text[], 'published', '2026-02-15 00:00:00+00'::timestamptz, now(), now()),
    ('60200000-0000-4000-8000-000000000005'::uuid, 'marigold-home-in', '60100000-0000-4000-8000-000000000005'::uuid, 'home.ceramic-vase', 'Ceramic bud vase', 129900, 'INR', 'other', array['vase', 'home', 'gift']::text[], 'published', '2026-02-15 00:00:00+00'::timestamptz, now(), now()),
    ('60200000-0000-4000-8000-000000000006'::uuid, 'marigold-home-in', '60100000-0000-4000-8000-000000000006'::uuid, 'home.napkin-set', 'Linen napkin set', 69900, 'INR', 'other', array['napkin', 'linen', 'table']::text[], 'published', '2026-02-15 00:00:00+00'::timestamptz, now(), now())
) as v(id, tenant_id, product_id, sku, title, price_minor, currency, material, aliases, status, published_at, created_at, updated_at)
where exists (select 1 from identity.tenants as tenant where tenant.id = v.tenant_id)
  and exists (select 1 from catalog.products as product where product.id = v.product_id)
on conflict (id) do nothing;

insert into catalog.inventory (
  tenant_id,
  variant_id,
  on_hand,
  reserved,
  version,
  updated_at
)
select
  v.tenant_id,
  v.variant_id,
  v.on_hand,
  v.reserved,
  v.version,
  v.updated_at
from (
  values
    ('northstar-demo-in', '12000000-0000-4000-8000-000000000007'::uuid, 16, 0, 1, now()),
    ('northstar-demo-in', '12000000-0000-4000-8000-000000000008'::uuid, 22, 0, 1, now()),
    ('indigo-desk-in', '22000000-0000-4000-8000-000000000005'::uuid, 14, 0, 1, now()),
    ('indigo-desk-in', '22000000-0000-4000-8000-000000000006'::uuid, 20, 0, 1, now()),
    ('indigo-desk-in', '22000000-0000-4000-8000-000000000007'::uuid, 9, 0, 1, now()),
    ('harbor-spice-in', '32000000-0000-4000-8000-000000000005'::uuid, 40, 0, 1, now()),
    ('harbor-spice-in', '32000000-0000-4000-8000-000000000006'::uuid, 38, 0, 1, now()),
    ('harbor-spice-in', '32000000-0000-4000-8000-000000000007'::uuid, 24, 0, 1, now()),
    ('sable-atelier-in', '40200000-0000-4000-8000-000000000004'::uuid, 11, 0, 1, now()),
    ('sable-atelier-in', '40200000-0000-4000-8000-000000000005'::uuid, 16, 0, 1, now()),
    ('sable-atelier-in', '40200000-0000-4000-8000-000000000006'::uuid, 28, 0, 1, now()),
    ('lotus-gifting-in', '50200000-0000-4000-8000-000000000004'::uuid, 12, 0, 1, now()),
    ('lotus-gifting-in', '50200000-0000-4000-8000-000000000005'::uuid, 40, 0, 1, now()),
    ('lotus-gifting-in', '50200000-0000-4000-8000-000000000006'::uuid, 15, 0, 1, now()),
    ('marigold-home-in', '60200000-0000-4000-8000-000000000004'::uuid, 26, 0, 1, now()),
    ('marigold-home-in', '60200000-0000-4000-8000-000000000005'::uuid, 10, 0, 1, now()),
    ('marigold-home-in', '60200000-0000-4000-8000-000000000006'::uuid, 18, 0, 1, now())
) as v(tenant_id, variant_id, on_hand, reserved, version, updated_at)
where exists (select 1 from identity.tenants as tenant where tenant.id = v.tenant_id)
  and exists (select 1 from catalog.variants as variant where variant.id = v.variant_id)
on conflict (tenant_id, variant_id) do nothing;
