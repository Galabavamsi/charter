-- Deterministic published shop fixtures. Membership rows are authoritative;
-- email addresses are inert example.invalid contact data.
begin;

insert into identity.users (
  id,
  email,
  status,
  synthetic,
  auth_synced_at,
  created_at,
  updated_at
)
values
  (
    '01000000-0000-4000-8000-000000000001',
    'northstar.owner@example.invalid',
    'active',
    true,
    '2026-01-01 00:00:00+00',
    '2026-01-01 00:00:00+00',
    '2026-01-01 00:00:00+00'
  ),
  (
    '01000000-0000-4000-8000-000000000002',
    'indigo.owner@example.invalid',
    'active',
    true,
    '2026-01-01 00:00:00+00',
    '2026-01-01 00:00:00+00',
    '2026-01-01 00:00:00+00'
  ),
  (
    '01000000-0000-4000-8000-000000000003',
    'harbor.owner@example.invalid',
    'active',
    true,
    '2026-01-01 00:00:00+00',
    '2026-01-01 00:00:00+00',
    '2026-01-01 00:00:00+00'
  ),
  (
    '01000000-0000-4000-8000-000000000004',
    'sable.owner@example.invalid',
    'active',
    true,
    '2026-02-01 00:00:00+00',
    '2026-02-01 00:00:00+00',
    '2026-02-01 00:00:00+00'
  ),
  (
    '01000000-0000-4000-8000-000000000005',
    'lotus.owner@example.invalid',
    'active',
    true,
    '2026-02-08 00:00:00+00',
    '2026-02-08 00:00:00+00',
    '2026-02-08 00:00:00+00'
  ),
  (
    '01000000-0000-4000-8000-000000000006',
    'marigold.owner@example.invalid',
    'active',
    true,
    '2026-02-15 00:00:00+00',
    '2026-02-15 00:00:00+00',
    '2026-02-15 00:00:00+00'
  )
on conflict (id) do update
set
  email = excluded.email,
  status = excluded.status,
  synthetic = excluded.synthetic,
  auth_synced_at = excluded.auth_synced_at,
  updated_at = excluded.updated_at
where (users.email, users.status, users.synthetic, users.auth_synced_at)
  is distinct from
  (excluded.email, excluded.status, excluded.synthetic, excluded.auth_synced_at);

insert into identity.profiles (
  user_id,
  display_name,
  locale,
  time_zone,
  created_at,
  updated_at
)
values
  (
    '01000000-0000-4000-8000-000000000001',
    'Northstar Owner',
    'en-IN',
    'Asia/Kolkata',
    '2026-01-01 00:00:00+00',
    '2026-01-01 00:00:00+00'
  ),
  (
    '01000000-0000-4000-8000-000000000002',
    'Indigo Owner',
    'en-IN',
    'Asia/Kolkata',
    '2026-01-01 00:00:00+00',
    '2026-01-01 00:00:00+00'
  ),
  (
    '01000000-0000-4000-8000-000000000003',
    'Harbor Owner',
    'en-IN',
    'Asia/Kolkata',
    '2026-01-01 00:00:00+00',
    '2026-01-01 00:00:00+00'
  ),
  (
    '01000000-0000-4000-8000-000000000004',
    'Sable Owner',
    'en-IN',
    'Asia/Kolkata',
    '2026-02-01 00:00:00+00',
    '2026-02-01 00:00:00+00'
  ),
  (
    '01000000-0000-4000-8000-000000000005',
    'Lotus Owner',
    'en-IN',
    'Asia/Kolkata',
    '2026-02-08 00:00:00+00',
    '2026-02-08 00:00:00+00'
  ),
  (
    '01000000-0000-4000-8000-000000000006',
    'Marigold Owner',
    'en-IN',
    'Asia/Kolkata',
    '2026-02-15 00:00:00+00',
    '2026-02-15 00:00:00+00'
  )
on conflict (user_id) do update
set
  display_name = excluded.display_name,
  locale = excluded.locale,
  time_zone = excluded.time_zone,
  updated_at = excluded.updated_at
where (profiles.display_name, profiles.locale, profiles.time_zone)
  is distinct from
  (excluded.display_name, excluded.locale, excluded.time_zone);

insert into identity.tenants (
  id,
  label,
  synthetic,
  status,
  created_at,
  updated_at
)
values
  (
    'northstar-demo-in',
    'Northstar Travel Coffee',
    true,
    'active',
    '2026-01-01 00:00:00+00',
    '2026-01-01 00:00:00+00'
  ),
  (
    'indigo-desk-in',
    'Indigo Desk',
    true,
    'active',
    '2026-01-01 00:00:00+00',
    '2026-01-01 00:00:00+00'
  ),
  (
    'harbor-spice-in',
    'Harbor Spice',
    true,
    'active',
    '2026-01-01 00:00:00+00',
    '2026-01-01 00:00:00+00'
  ),
  (
    'sable-atelier-in',
    'Sable Atelier',
    true,
    'active',
    '2026-02-01 00:00:00+00',
    '2026-02-01 00:00:00+00'
  ),
  (
    'lotus-gifting-in',
    'Lotus Gifting',
    true,
    'active',
    '2026-02-08 00:00:00+00',
    '2026-02-08 00:00:00+00'
  ),
  (
    'marigold-home-in',
    'Marigold Home',
    true,
    'active',
    '2026-02-15 00:00:00+00',
    '2026-02-15 00:00:00+00'
  )
on conflict (id) do update
set
  label = excluded.label,
  synthetic = excluded.synthetic,
  status = excluded.status,
  updated_at = excluded.updated_at
where (tenants.label, tenants.synthetic, tenants.status)
  is distinct from
  (excluded.label, excluded.synthetic, excluded.status);

insert into identity.shop_memberships (
  tenant_id,
  user_id,
  role,
  status,
  joined_at,
  created_at,
  updated_at
)
values
  (
    'northstar-demo-in',
    '01000000-0000-4000-8000-000000000001',
    'owner',
    'active',
    '2026-01-01 00:00:00+00',
    '2026-01-01 00:00:00+00',
    '2026-01-01 00:00:00+00'
  ),
  (
    'indigo-desk-in',
    '01000000-0000-4000-8000-000000000002',
    'owner',
    'active',
    '2026-01-01 00:00:00+00',
    '2026-01-01 00:00:00+00',
    '2026-01-01 00:00:00+00'
  ),
  (
    'harbor-spice-in',
    '01000000-0000-4000-8000-000000000003',
    'owner',
    'active',
    '2026-01-01 00:00:00+00',
    '2026-01-01 00:00:00+00',
    '2026-01-01 00:00:00+00'
  ),
  (
    'sable-atelier-in',
    '01000000-0000-4000-8000-000000000004',
    'owner',
    'active',
    '2026-02-01 00:00:00+00',
    '2026-02-01 00:00:00+00',
    '2026-02-01 00:00:00+00'
  ),
  (
    'lotus-gifting-in',
    '01000000-0000-4000-8000-000000000005',
    'owner',
    'active',
    '2026-02-08 00:00:00+00',
    '2026-02-08 00:00:00+00',
    '2026-02-08 00:00:00+00'
  ),
  (
    'marigold-home-in',
    '01000000-0000-4000-8000-000000000006',
    'owner',
    'active',
    '2026-02-15 00:00:00+00',
    '2026-02-15 00:00:00+00',
    '2026-02-15 00:00:00+00'
  )
on conflict (tenant_id, user_id) do update
set
  role = excluded.role,
  status = excluded.status,
  joined_at = excluded.joined_at,
  updated_at = excluded.updated_at
where (shop_memberships.role, shop_memberships.status, shop_memberships.joined_at)
  is distinct from
  (excluded.role, excluded.status, excluded.joined_at);

insert into catalog.shops (
  tenant_id,
  slug,
  name,
  label,
  blurb,
  currency,
  status,
  synthetic,
  published_at,
  rating_milli,
  review_count,
  created_at,
  updated_at
)
values
  (
    'northstar-demo-in',
    'northstar',
    'Northstar Travel Coffee',
    'Northstar Travel Coffee',
    'Travel coffee kit. Steel press, grinders, filters. No glass.',
    'INR',
    'published',
    true,
    '2026-01-01 00:00:00+00',
    4800,
    128,
    '2026-01-01 00:00:00+00',
    '2026-01-01 00:00:00+00'
  ),
  (
    'indigo-desk-in',
    'indigo-desk',
    'Indigo Desk',
    'Indigo Desk',
    'Stationery, notebooks, pens, and a lamp for a small office.',
    'INR',
    'published',
    true,
    '2026-01-01 00:00:00+00',
    4600,
    54,
    '2026-01-01 00:00:00+00',
    '2026-01-01 00:00:00+00'
  ),
  (
    'harbor-spice-in',
    'harbor-spice',
    'Harbor Spice',
    'Harbor Spice',
    'Everyday masala and tea. Glass jars are not sold.',
    'INR',
    'published',
    true,
    '2026-01-01 00:00:00+00',
    4200,
    36,
    '2026-01-01 00:00:00+00',
    '2026-01-01 00:00:00+00'
  ),
  (
    'sable-atelier-in',
    'sable-atelier',
    'Sable Atelier',
    'Sable Atelier',
    'Quiet cotton tees, scarves, and a tote for everyday wear.',
    'INR',
    'published',
    true,
    '2026-02-01 00:00:00+00',
    4700,
    89,
    '2026-02-01 00:00:00+00',
    '2026-02-01 00:00:00+00'
  ),
  (
    'lotus-gifting-in',
    'lotus-gifting',
    'Lotus Gifting',
    'Lotus Gifting',
    'Wrapped sets for birthdays, anniversaries, and someone you like.',
    'INR',
    'published',
    true,
    '2026-02-08 00:00:00+00',
    4500,
    112,
    '2026-02-08 00:00:00+00',
    '2026-02-08 00:00:00+00'
  ),
  (
    'marigold-home-in',
    'marigold-home',
    'Marigold Home',
    'Marigold Home',
    'Candles, throws, and a mug for a quieter room.',
    'INR',
    'published',
    true,
    '2026-02-15 00:00:00+00',
    4400,
    67,
    '2026-02-15 00:00:00+00',
    '2026-02-15 00:00:00+00'
  )
on conflict (tenant_id) do update
set
  slug = excluded.slug,
  name = excluded.name,
  label = excluded.label,
  blurb = excluded.blurb,
  currency = excluded.currency,
  status = excluded.status,
  synthetic = excluded.synthetic,
  published_at = excluded.published_at,
  rating_milli = excluded.rating_milli,
  review_count = excluded.review_count,
  updated_at = excluded.updated_at
where (
  shops.slug,
  shops.name,
  shops.label,
  shops.blurb,
  shops.currency,
  shops.status,
  shops.synthetic,
  shops.published_at,
  shops.rating_milli,
  shops.review_count
) is distinct from (
  excluded.slug,
  excluded.name,
  excluded.label,
  excluded.blurb,
  excluded.currency,
  excluded.status,
  excluded.synthetic,
  excluded.published_at,
  excluded.rating_milli,
  excluded.review_count
);

-- Shop profile copy. Not verified KYC.
update catalog.shops
set
  gstin = '29AAAAA0000A1Z5',
  address_line = '12 Brigade Road, Bengaluru 560001',
  refund_policy = 'Unused kit in original packaging within 7 days of capture. Return shipping is on the shopper.',
  profile_verified = false
where tenant_id = 'northstar-demo-in';

update catalog.shops
set
  gstin = '27AAAAA0000A1Z5',
  address_line = '4 Bandra West, Mumbai 400050',
  refund_policy = 'Unopened stationery within 7 days of capture.',
  profile_verified = false
where tenant_id = 'indigo-desk-in';

update catalog.shops
set
  gstin = '33AAAAA0000A1Z5',
  address_line = '8 T. Nagar, Chennai 600017',
  refund_policy = 'Sealed packets within 7 days of capture.',
  profile_verified = false
where tenant_id = 'harbor-spice-in';

update catalog.shops
set
  gstin = '29BBBBB0000B1Z5',
  address_line = '22 Indiranagar 100 Feet Road, Bengaluru 560038',
  refund_policy = 'Unworn garments with tags within 7 days of capture.',
  profile_verified = false
where tenant_id = 'sable-atelier-in';

update catalog.shops
set
  gstin = '07CCCCC0000C1Z5',
  address_line = '15 Khan Market, New Delhi 110003',
  refund_policy = 'Unopened gift sets within 7 days of capture.',
  profile_verified = false
where tenant_id = 'lotus-gifting-in';

update catalog.shops
set
  gstin = '27DDDDD0000D1Z5',
  address_line = '9 Koregaon Park, Pune 411001',
  refund_policy = 'Unused home goods in original packaging within 7 days of capture.',
  profile_verified = false
where tenant_id = 'marigold-home-in';

insert into catalog.categories (
  id,
  tenant_id,
  slug,
  title,
  status,
  position,
  created_at,
  updated_at
)
values
  (
    '10000000-0000-4000-8000-000000000001',
    'northstar-demo-in',
    'travel-coffee',
    'Travel coffee',
    'active',
    0,
    '2026-01-01 00:00:00+00',
    '2026-01-01 00:00:00+00'
  ),
  (
    '20000000-0000-4000-8000-000000000001',
    'indigo-desk-in',
    'desk-essentials',
    'Desk essentials',
    'active',
    0,
    '2026-01-01 00:00:00+00',
    '2026-01-01 00:00:00+00'
  ),
  (
    '30000000-0000-4000-8000-000000000001',
    'harbor-spice-in',
    'spice-pantry',
    'Spice pantry',
    'active',
    0,
    '2026-01-01 00:00:00+00',
    '2026-01-01 00:00:00+00'
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    'harbor-spice-in',
    'travel-coffee',
    'Travel coffee',
    'active',
    1,
    '2026-01-01 00:00:00+00',
    '2026-01-01 00:00:00+00'
  ),
  (
    '40000000-0000-4000-8000-000000000001',
    'sable-atelier-in',
    'apparel',
    'Apparel',
    'active',
    0,
    '2026-02-01 00:00:00+00',
    '2026-02-01 00:00:00+00'
  ),
  (
    '50000000-0000-4000-8000-000000000001',
    'lotus-gifting-in',
    'gifts',
    'Gifts',
    'active',
    0,
    '2026-02-08 00:00:00+00',
    '2026-02-08 00:00:00+00'
  ),
  (
    '60000000-0000-4000-8000-000000000001',
    'marigold-home-in',
    'home',
    'Home',
    'active',
    0,
    '2026-02-15 00:00:00+00',
    '2026-02-15 00:00:00+00'
  )
on conflict (id) do update
set
  tenant_id = excluded.tenant_id,
  slug = excluded.slug,
  title = excluded.title,
  status = excluded.status,
  position = excluded.position,
  updated_at = excluded.updated_at
where (
  categories.tenant_id,
  categories.slug,
  categories.title,
  categories.status,
  categories.position
) is distinct from (
  excluded.tenant_id,
  excluded.slug,
  excluded.title,
  excluded.status,
  excluded.position
);

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
values
  ('11000000-0000-4000-8000-000000000001', 'northstar-demo-in', '10000000-0000-4000-8000-000000000001', 'trailpress-steel-750', 'Steel travel press, 750 ml', 'Steel press for the road.', 'published', 'INR', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('11000000-0000-4000-8000-000000000002', 'northstar-demo-in', '10000000-0000-4000-8000-000000000001', 'pocket-lite', 'Hand grinder', 'Manual grinder for travel kits.', 'published', 'INR', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('11000000-0000-4000-8000-000000000003', 'northstar-demo-in', '10000000-0000-4000-8000-000000000001', 'travel-filters-30', 'Paper filters, 30 pack', 'Filters that fit the steel press.', 'published', 'INR', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('11000000-0000-4000-8000-000000000004', 'northstar-demo-in', '10000000-0000-4000-8000-000000000001', 'pocket-pro', 'Pro hand grinder', 'Finer grind, still pocketable.', 'published', 'INR', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('11000000-0000-4000-8000-000000000005', 'northstar-demo-in', '10000000-0000-4000-8000-000000000001', 'clear-glass-500', 'Glass pour-over, 500 ml', 'Glass brewer. Not sold under shop policy.', 'published', 'INR', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('11000000-0000-4000-8000-000000000006', 'northstar-demo-in', '10000000-0000-4000-8000-000000000001', 'road-mini-kettle', 'Mini travel kettle', 'Compact kettle for hotel rooms.', 'published', 'INR', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('21000000-0000-4000-8000-000000000001', 'indigo-desk-in', '20000000-0000-4000-8000-000000000001', 'ruled-notebook-a5', 'Ruled notebook, A5', 'A5 ruled notebook for daily notes.', 'published', 'INR', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('21000000-0000-4000-8000-000000000002', 'indigo-desk-in', '20000000-0000-4000-8000-000000000001', 'fineliner-set', 'Fine liner set', 'Fine liners for lists and margins.', 'published', 'INR', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('21000000-0000-4000-8000-000000000003', 'indigo-desk-in', '20000000-0000-4000-8000-000000000001', 'desk-lamp', 'Desk lamp', 'Arm lamp for a small desk.', 'published', 'INR', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('21000000-0000-4000-8000-000000000004', 'indigo-desk-in', '20000000-0000-4000-8000-000000000001', 'binder-clips-24', 'Binder clips, 24 pack', 'Clips for a stack of paper.', 'published', 'INR', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('31000000-0000-4000-8000-000000000001', 'harbor-spice-in', '30000000-0000-4000-8000-000000000001', 'garam-masala-100', 'Garam masala, 100 g', 'Everyday garam masala.', 'published', 'INR', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('31000000-0000-4000-8000-000000000002', 'harbor-spice-in', '30000000-0000-4000-8000-000000000001', 'whole-cumin-200', 'Whole cumin, 200 g', 'Whole cumin for tadka.', 'published', 'INR', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('31000000-0000-4000-8000-000000000003', 'harbor-spice-in', '30000000-0000-4000-8000-000000000002', 'cast-iron-mill', 'Cast iron mill', 'Mill for whole spices.', 'published', 'INR', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('31000000-0000-4000-8000-000000000004', 'harbor-spice-in', '30000000-0000-4000-8000-000000000001', 'glass-spice-jar', 'Glass spice jar', 'Glass jar. Not sold under shop policy.', 'published', 'INR', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('40100000-0000-4000-8000-000000000001', 'sable-atelier-in', '40000000-0000-4000-8000-000000000001', 'crew-cotton-tee', 'Cotton crew tee', 'Quiet cotton tee for everyday wear.', 'published', 'INR', '2026-02-01 00:00:00+00', '2026-02-01 00:00:00+00', '2026-02-01 00:00:00+00'),
  ('40100000-0000-4000-8000-000000000002', 'sable-atelier-in', '40000000-0000-4000-8000-000000000001', 'sand-silk-scarf', 'Sand silk scarf', 'Light scarf in sand silk.', 'published', 'INR', '2026-02-01 00:00:00+00', '2026-02-01 00:00:00+00', '2026-02-01 00:00:00+00'),
  ('40100000-0000-4000-8000-000000000003', 'sable-atelier-in', '40000000-0000-4000-8000-000000000001', 'canvas-day-tote', 'Canvas day tote', 'Canvas tote for the day.', 'published', 'INR', '2026-02-01 00:00:00+00', '2026-02-01 00:00:00+00', '2026-02-01 00:00:00+00'),
  ('50100000-0000-4000-8000-000000000001', 'lotus-gifting-in', '50000000-0000-4000-8000-000000000001', 'assorted-chocolate-box', 'Assorted chocolate box', 'Wrapped chocolates for a gift.', 'published', 'INR', '2026-02-08 00:00:00+00', '2026-02-08 00:00:00+00', '2026-02-08 00:00:00+00'),
  ('50100000-0000-4000-8000-000000000002', 'lotus-gifting-in', '50000000-0000-4000-8000-000000000001', 'dried-flower-bunch', 'Dried flower bunch', 'Dried flowers that last on a desk.', 'published', 'INR', '2026-02-08 00:00:00+00', '2026-02-08 00:00:00+00', '2026-02-08 00:00:00+00'),
  ('50100000-0000-4000-8000-000000000003', 'lotus-gifting-in', '50000000-0000-4000-8000-000000000001', 'brass-diya-set', 'Brass diya set', 'Brass diyas for a small ritual.', 'published', 'INR', '2026-02-08 00:00:00+00', '2026-02-08 00:00:00+00', '2026-02-08 00:00:00+00'),
  ('60100000-0000-4000-8000-000000000001', 'marigold-home-in', '60000000-0000-4000-8000-000000000001', 'soy-candle-sandalwood', 'Soy candle, sandalwood', 'Sandalwood soy candle.', 'published', 'INR', '2026-02-15 00:00:00+00', '2026-02-15 00:00:00+00', '2026-02-15 00:00:00+00'),
  ('60100000-0000-4000-8000-000000000002', 'marigold-home-in', '60000000-0000-4000-8000-000000000001', 'cotton-throw', 'Cotton throw', 'Cotton throw for a quieter room.', 'published', 'INR', '2026-02-15 00:00:00+00', '2026-02-15 00:00:00+00', '2026-02-15 00:00:00+00'),
  ('60100000-0000-4000-8000-000000000003', 'marigold-home-in', '60000000-0000-4000-8000-000000000001', 'speckled-ceramic-mug', 'Speckled ceramic mug', 'Everyday ceramic mug.', 'published', 'INR', '2026-02-15 00:00:00+00', '2026-02-15 00:00:00+00', '2026-02-15 00:00:00+00')
on conflict (id) do update
set
  tenant_id = excluded.tenant_id,
  category_id = excluded.category_id,
  slug = excluded.slug,
  title = excluded.title,
  description = excluded.description,
  status = excluded.status,
  currency = excluded.currency,
  published_at = excluded.published_at,
  updated_at = excluded.updated_at
where (
  products.tenant_id,
  products.category_id,
  products.slug,
  products.title,
  products.description,
  products.status,
  products.currency,
  products.published_at
) is distinct from (
  excluded.tenant_id,
  excluded.category_id,
  excluded.slug,
  excluded.title,
  excluded.description,
  excluded.status,
  excluded.currency,
  excluded.published_at
);

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
values
  ('12000000-0000-4000-8000-000000000001', 'northstar-demo-in', '11000000-0000-4000-8000-000000000001', 'brewer.trailpress-steel-750', 'Steel travel press, 750 ml', 119900, 'INR', 'steel', array['trailpress', 'steel brewer', 'press', 'brewer'], 'published', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('12000000-0000-4000-8000-000000000002', 'northstar-demo-in', '11000000-0000-4000-8000-000000000002', 'grinder.pocket-lite', 'Hand grinder', 99900, 'INR', 'steel', array['pocketgrind lite', 'lite', 'manual grinder'], 'published', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('12000000-0000-4000-8000-000000000003', 'northstar-demo-in', '11000000-0000-4000-8000-000000000003', 'filters.travel-30', 'Paper filters, 30 pack', 24900, 'INR', 'paper', array['travel filters', 'filter paper'], 'published', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('12000000-0000-4000-8000-000000000004', 'northstar-demo-in', '11000000-0000-4000-8000-000000000004', 'grinder.pocket-pro', 'Pro hand grinder', 149900, 'INR', 'steel', array['pocketgrind pro', 'pro grinder'], 'published', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('12000000-0000-4000-8000-000000000005', 'northstar-demo-in', '11000000-0000-4000-8000-000000000005', 'brewer.clear-glass-500', 'Glass pour-over, 500 ml', 89900, 'INR', 'glass', array['cleargo glass brewer', 'glass brewer', 'pour over'], 'published', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('12000000-0000-4000-8000-000000000006', 'northstar-demo-in', '11000000-0000-4000-8000-000000000006', 'kettle.road-mini', 'Mini travel kettle', 129900, 'INR', 'other', array['road mini kettle', 'kettle'], 'published', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('22000000-0000-4000-8000-000000000001', 'indigo-desk-in', '21000000-0000-4000-8000-000000000001', 'note.ruled-a5', 'Ruled notebook, A5', 19900, 'INR', 'paper', array['notebook', 'copy', 'stationery', 'office', 'paper'], 'published', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('22000000-0000-4000-8000-000000000002', 'indigo-desk-in', '21000000-0000-4000-8000-000000000002', 'pen.fineliner-set', 'Fine liner set', 34900, 'INR', 'other', array['pens', 'markers', 'stationery'], 'published', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('22000000-0000-4000-8000-000000000003', 'indigo-desk-in', '21000000-0000-4000-8000-000000000003', 'lamp.desk-arm', 'Desk lamp', 129900, 'INR', 'other', array['lamp', 'light'], 'published', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('22000000-0000-4000-8000-000000000004', 'indigo-desk-in', '21000000-0000-4000-8000-000000000004', 'clip.binder-24', 'Binder clips, 24 pack', 8900, 'INR', 'other', array['clips'], 'published', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('32000000-0000-4000-8000-000000000001', 'harbor-spice-in', '31000000-0000-4000-8000-000000000001', 'spice.garam-100', 'Garam masala, 100 g', 14900, 'INR', 'other', array['masala', 'garam'], 'published', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('32000000-0000-4000-8000-000000000002', 'harbor-spice-in', '31000000-0000-4000-8000-000000000002', 'spice.cumin-200', 'Whole cumin, 200 g', 11900, 'INR', 'other', array['jeera', 'cumin'], 'published', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('32000000-0000-4000-8000-000000000003', 'harbor-spice-in', '31000000-0000-4000-8000-000000000003', 'mill.cast-iron', 'Cast iron mill', 89900, 'INR', 'other', array['grinder', 'mill'], 'published', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('32000000-0000-4000-8000-000000000004', 'harbor-spice-in', '31000000-0000-4000-8000-000000000004', 'jar.glass-spice', 'Glass spice jar', 24900, 'INR', 'glass', array['jar', 'glass jar'], 'published', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('40200000-0000-4000-8000-000000000001', 'sable-atelier-in', '40100000-0000-4000-8000-000000000001', 'tee.crew-cotton', 'Cotton crew tee', 129900, 'INR', 'other', array['tshirt', 't-shirt', 'tee', 'shirt', 'top'], 'published', '2026-02-01 00:00:00+00', '2026-02-01 00:00:00+00', '2026-02-01 00:00:00+00'),
  ('40200000-0000-4000-8000-000000000002', 'sable-atelier-in', '40100000-0000-4000-8000-000000000002', 'scarf.silk-sand', 'Sand silk scarf', 249900, 'INR', 'other', array['scarf', 'gift', 'silk'], 'published', '2026-02-01 00:00:00+00', '2026-02-01 00:00:00+00', '2026-02-01 00:00:00+00'),
  ('40200000-0000-4000-8000-000000000003', 'sable-atelier-in', '40100000-0000-4000-8000-000000000003', 'tote.canvas-day', 'Canvas day tote', 189900, 'INR', 'other', array['bag', 'tote', 'gift'], 'published', '2026-02-01 00:00:00+00', '2026-02-01 00:00:00+00', '2026-02-01 00:00:00+00'),
  ('50200000-0000-4000-8000-000000000001', 'lotus-gifting-in', '50100000-0000-4000-8000-000000000001', 'gift.chocolate-box', 'Assorted chocolate box', 79900, 'INR', 'other', array['gift', 'chocolate', 'present', 'gf', 'girlfriend'], 'published', '2026-02-08 00:00:00+00', '2026-02-08 00:00:00+00', '2026-02-08 00:00:00+00'),
  ('50200000-0000-4000-8000-000000000002', 'lotus-gifting-in', '50100000-0000-4000-8000-000000000002', 'gift.dried-flowers', 'Dried flower bunch', 64900, 'INR', 'other', array['flowers', 'bouquet', 'gift', 'girlfriend'], 'published', '2026-02-08 00:00:00+00', '2026-02-08 00:00:00+00', '2026-02-08 00:00:00+00'),
  ('50200000-0000-4000-8000-000000000003', 'lotus-gifting-in', '50100000-0000-4000-8000-000000000003', 'gift.brass-diya', 'Brass diya set', 54900, 'INR', 'other', array['diya', 'gift', 'brass'], 'published', '2026-02-08 00:00:00+00', '2026-02-08 00:00:00+00', '2026-02-08 00:00:00+00'),
  ('60200000-0000-4000-8000-000000000001', 'marigold-home-in', '60100000-0000-4000-8000-000000000001', 'home.soy-candle', 'Soy candle, sandalwood', 89900, 'INR', 'other', array['candle', 'gift', 'home'], 'published', '2026-02-15 00:00:00+00', '2026-02-15 00:00:00+00', '2026-02-15 00:00:00+00'),
  ('60200000-0000-4000-8000-000000000002', 'marigold-home-in', '60100000-0000-4000-8000-000000000002', 'home.cotton-throw', 'Cotton throw', 219900, 'INR', 'other', array['throw', 'blanket', 'gift'], 'published', '2026-02-15 00:00:00+00', '2026-02-15 00:00:00+00', '2026-02-15 00:00:00+00'),
  ('60200000-0000-4000-8000-000000000003', 'marigold-home-in', '60100000-0000-4000-8000-000000000003', 'home.ceramic-mug', 'Speckled ceramic mug', 49900, 'INR', 'other', array['mug', 'cup', 'gift'], 'published', '2026-02-15 00:00:00+00', '2026-02-15 00:00:00+00', '2026-02-15 00:00:00+00')
on conflict (id) do update
set
  tenant_id = excluded.tenant_id,
  product_id = excluded.product_id,
  sku = excluded.sku,
  title = excluded.title,
  price_minor = excluded.price_minor,
  currency = excluded.currency,
  material = excluded.material,
  aliases = excluded.aliases,
  status = excluded.status,
  published_at = excluded.published_at,
  updated_at = excluded.updated_at
where (
  variants.tenant_id,
  variants.product_id,
  variants.sku,
  variants.title,
  variants.price_minor,
  variants.currency,
  variants.material,
  variants.aliases,
  variants.status,
  variants.published_at
) is distinct from (
  excluded.tenant_id,
  excluded.product_id,
  excluded.sku,
  excluded.title,
  excluded.price_minor,
  excluded.currency,
  excluded.material,
  excluded.aliases,
  excluded.status,
  excluded.published_at
);

insert into catalog.inventory (
  tenant_id,
  variant_id,
  on_hand,
  reserved,
  version,
  updated_at
)
values
  ('northstar-demo-in', '12000000-0000-4000-8000-000000000001', 12, 0, 1, '2026-01-01 00:00:00+00'),
  ('northstar-demo-in', '12000000-0000-4000-8000-000000000002', 8, 0, 1, '2026-01-01 00:00:00+00'),
  ('northstar-demo-in', '12000000-0000-4000-8000-000000000003', 30, 0, 1, '2026-01-01 00:00:00+00'),
  ('northstar-demo-in', '12000000-0000-4000-8000-000000000004', 4, 0, 1, '2026-01-01 00:00:00+00'),
  ('northstar-demo-in', '12000000-0000-4000-8000-000000000005', 10, 0, 1, '2026-01-01 00:00:00+00'),
  ('northstar-demo-in', '12000000-0000-4000-8000-000000000006', 0, 0, 1, '2026-01-01 00:00:00+00'),
  ('indigo-desk-in', '22000000-0000-4000-8000-000000000001', 40, 0, 1, '2026-01-01 00:00:00+00'),
  ('indigo-desk-in', '22000000-0000-4000-8000-000000000002', 18, 0, 1, '2026-01-01 00:00:00+00'),
  ('indigo-desk-in', '22000000-0000-4000-8000-000000000003', 6, 0, 1, '2026-01-01 00:00:00+00'),
  ('indigo-desk-in', '22000000-0000-4000-8000-000000000004', 0, 0, 1, '2026-01-01 00:00:00+00'),
  ('harbor-spice-in', '32000000-0000-4000-8000-000000000001', 50, 0, 1, '2026-01-01 00:00:00+00'),
  ('harbor-spice-in', '32000000-0000-4000-8000-000000000002', 35, 0, 1, '2026-01-01 00:00:00+00'),
  ('harbor-spice-in', '32000000-0000-4000-8000-000000000003', 7, 0, 1, '2026-01-01 00:00:00+00'),
  ('harbor-spice-in', '32000000-0000-4000-8000-000000000004', 12, 0, 1, '2026-01-01 00:00:00+00'),
  ('sable-atelier-in', '40200000-0000-4000-8000-000000000001', 24, 0, 1, '2026-02-01 00:00:00+00'),
  ('sable-atelier-in', '40200000-0000-4000-8000-000000000002', 9, 0, 1, '2026-02-01 00:00:00+00'),
  ('sable-atelier-in', '40200000-0000-4000-8000-000000000003', 14, 0, 1, '2026-02-01 00:00:00+00'),
  ('lotus-gifting-in', '50200000-0000-4000-8000-000000000001', 30, 0, 1, '2026-02-08 00:00:00+00'),
  ('lotus-gifting-in', '50200000-0000-4000-8000-000000000002', 18, 0, 1, '2026-02-08 00:00:00+00'),
  ('lotus-gifting-in', '50200000-0000-4000-8000-000000000003', 22, 0, 1, '2026-02-08 00:00:00+00'),
  ('marigold-home-in', '60200000-0000-4000-8000-000000000001', 16, 0, 1, '2026-02-15 00:00:00+00'),
  ('marigold-home-in', '60200000-0000-4000-8000-000000000002', 8, 0, 1, '2026-02-15 00:00:00+00'),
  ('marigold-home-in', '60200000-0000-4000-8000-000000000003', 20, 0, 1, '2026-02-15 00:00:00+00')
on conflict (tenant_id, variant_id) do update
set
  on_hand = excluded.on_hand,
  reserved = excluded.reserved,
  version = excluded.version,
  updated_at = excluded.updated_at
where (inventory.on_hand, inventory.reserved, inventory.version)
  is distinct from
  (excluded.on_hand, excluded.reserved, excluded.version);

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
values
  ('11000000-0000-4000-8000-000000000007', 'northstar-demo-in', '10000000-0000-4000-8000-000000000001', 'steel-travel-mug', 'Steel travel mug', 'Insulated mug for the road.', 'published', 'INR', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('11000000-0000-4000-8000-000000000008', 'northstar-demo-in', '10000000-0000-4000-8000-000000000001', 'house-beans-250', 'House beans, 250 g', 'House roast for travel kits.', 'published', 'INR', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('21000000-0000-4000-8000-000000000005', 'indigo-desk-in', '20000000-0000-4000-8000-000000000001', 'cork-desk-mat', 'Cork desk mat', 'Cork mat for a small desk.', 'published', 'INR', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('21000000-0000-4000-8000-000000000006', 'indigo-desk-in', '20000000-0000-4000-8000-000000000001', 'washi-tape-set', 'Washi tape set', 'Washi tape for notes and wrapping.', 'published', 'INR', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('21000000-0000-4000-8000-000000000007', 'indigo-desk-in', '20000000-0000-4000-8000-000000000001', 'letter-tray', 'Letter tray', 'Tray for incoming paper.', 'published', 'INR', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('31000000-0000-4000-8000-000000000005', 'harbor-spice-in', '30000000-0000-4000-8000-000000000001', 'turmeric-100', 'Turmeric, 100 g', 'Everyday turmeric.', 'published', 'INR', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('31000000-0000-4000-8000-000000000006', 'harbor-spice-in', '30000000-0000-4000-8000-000000000001', 'red-chili-100', 'Red chili, 100 g', 'Ground red chili.', 'published', 'INR', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('31000000-0000-4000-8000-000000000007', 'harbor-spice-in', '30000000-0000-4000-8000-000000000001', 'assam-tea-200', 'Assam tea, 200 g', 'Everyday Assam leaf.', 'published', 'INR', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('40100000-0000-4000-8000-000000000004', 'sable-atelier-in', '40000000-0000-4000-8000-000000000001', 'sand-linen-shirt', 'Sand linen shirt', 'Light linen shirt in sand.', 'published', 'INR', '2026-02-01 00:00:00+00', '2026-02-01 00:00:00+00', '2026-02-01 00:00:00+00'),
  ('40100000-0000-4000-8000-000000000005', 'sable-atelier-in', '40000000-0000-4000-8000-000000000001', 'oat-wool-beanie', 'Oat wool beanie', 'Soft wool beanie in oat.', 'published', 'INR', '2026-02-01 00:00:00+00', '2026-02-01 00:00:00+00', '2026-02-01 00:00:00+00'),
  ('40100000-0000-4000-8000-000000000006', 'sable-atelier-in', '40000000-0000-4000-8000-000000000001', 'cotton-crew-socks', 'Cotton crew socks', 'Everyday cotton crew socks.', 'published', 'INR', '2026-02-01 00:00:00+00', '2026-02-01 00:00:00+00', '2026-02-01 00:00:00+00'),
  ('50100000-0000-4000-8000-000000000004', 'lotus-gifting-in', '50000000-0000-4000-8000-000000000001', 'tea-hamper', 'Tea hamper', 'A small tea hamper for gifting.', 'published', 'INR', '2026-02-08 00:00:00+00', '2026-02-08 00:00:00+00', '2026-02-08 00:00:00+00'),
  ('50100000-0000-4000-8000-000000000005', 'lotus-gifting-in', '50000000-0000-4000-8000-000000000001', 'handmade-note-card', 'Handmade note card', 'A card to go with a gift.', 'published', 'INR', '2026-02-08 00:00:00+00', '2026-02-08 00:00:00+00', '2026-02-08 00:00:00+00'),
  ('50100000-0000-4000-8000-000000000006', 'lotus-gifting-in', '50000000-0000-4000-8000-000000000001', 'oak-photo-frame', 'Oak photo frame', 'A small oak frame.', 'published', 'INR', '2026-02-08 00:00:00+00', '2026-02-08 00:00:00+00', '2026-02-08 00:00:00+00'),
  ('60100000-0000-4000-8000-000000000004', 'marigold-home-in', '60000000-0000-4000-8000-000000000001', 'sandal-incense', 'Sandal incense', 'Sandalwood incense sticks.', 'published', 'INR', '2026-02-15 00:00:00+00', '2026-02-15 00:00:00+00', '2026-02-15 00:00:00+00'),
  ('60100000-0000-4000-8000-000000000005', 'marigold-home-in', '60000000-0000-4000-8000-000000000001', 'ceramic-bud-vase', 'Ceramic bud vase', 'A small ceramic vase.', 'published', 'INR', '2026-02-15 00:00:00+00', '2026-02-15 00:00:00+00', '2026-02-15 00:00:00+00'),
  ('60100000-0000-4000-8000-000000000006', 'marigold-home-in', '60000000-0000-4000-8000-000000000001', 'linen-napkin-set', 'Linen napkin set', 'Linen napkins for the table.', 'published', 'INR', '2026-02-15 00:00:00+00', '2026-02-15 00:00:00+00', '2026-02-15 00:00:00+00')
on conflict (id) do update
set
  tenant_id = excluded.tenant_id,
  category_id = excluded.category_id,
  slug = excluded.slug,
  title = excluded.title,
  description = excluded.description,
  status = excluded.status,
  currency = excluded.currency,
  published_at = excluded.published_at,
  updated_at = excluded.updated_at
where (
  products.tenant_id,
  products.category_id,
  products.slug,
  products.title,
  products.description,
  products.status,
  products.currency,
  products.published_at
) is distinct from (
  excluded.tenant_id,
  excluded.category_id,
  excluded.slug,
  excluded.title,
  excluded.description,
  excluded.status,
  excluded.currency,
  excluded.published_at
);

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
values
  ('12000000-0000-4000-8000-000000000007', 'northstar-demo-in', '11000000-0000-4000-8000-000000000007', 'mug.steel-travel', 'Steel travel mug', 79900, 'INR', 'steel', array['mug', 'flask', 'cup', 'travel mug'], 'published', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('12000000-0000-4000-8000-000000000008', 'northstar-demo-in', '11000000-0000-4000-8000-000000000008', 'beans.house-250', 'House beans, 250 g', 44900, 'INR', 'other', array['coffee', 'beans', 'grounds'], 'published', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('22000000-0000-4000-8000-000000000005', 'indigo-desk-in', '21000000-0000-4000-8000-000000000005', 'mat.desk-cork', 'Cork desk mat', 89900, 'INR', 'other', array['mat', 'desk', 'stationery'], 'published', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('22000000-0000-4000-8000-000000000006', 'indigo-desk-in', '21000000-0000-4000-8000-000000000006', 'tape.washi-set', 'Washi tape set', 24900, 'INR', 'paper', array['tape', 'washi', 'stationery'], 'published', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('22000000-0000-4000-8000-000000000007', 'indigo-desk-in', '21000000-0000-4000-8000-000000000007', 'tray.letter', 'Letter tray', 59900, 'INR', 'other', array['tray', 'inbox', 'office'], 'published', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('32000000-0000-4000-8000-000000000005', 'harbor-spice-in', '31000000-0000-4000-8000-000000000005', 'spice.turmeric-100', 'Turmeric, 100 g', 12900, 'INR', 'other', array['haldi', 'turmeric'], 'published', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('32000000-0000-4000-8000-000000000006', 'harbor-spice-in', '31000000-0000-4000-8000-000000000006', 'spice.chili-100', 'Red chili, 100 g', 13900, 'INR', 'other', array['chili', 'chilli', 'mirch'], 'published', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('32000000-0000-4000-8000-000000000007', 'harbor-spice-in', '31000000-0000-4000-8000-000000000007', 'tea.assam-200', 'Assam tea, 200 g', 29900, 'INR', 'other', array['tea', 'chai'], 'published', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
  ('40200000-0000-4000-8000-000000000004', 'sable-atelier-in', '40100000-0000-4000-8000-000000000004', 'shirt.linen-sand', 'Sand linen shirt', 219900, 'INR', 'other', array['linen', 'shirt', 'top', 'gift'], 'published', '2026-02-01 00:00:00+00', '2026-02-01 00:00:00+00', '2026-02-01 00:00:00+00'),
  ('40200000-0000-4000-8000-000000000005', 'sable-atelier-in', '40100000-0000-4000-8000-000000000005', 'beanie.wool-oat', 'Oat wool beanie', 89900, 'INR', 'other', array['beanie', 'hat', 'wool', 'gift'], 'published', '2026-02-01 00:00:00+00', '2026-02-01 00:00:00+00', '2026-02-01 00:00:00+00'),
  ('40200000-0000-4000-8000-000000000006', 'sable-atelier-in', '40100000-0000-4000-8000-000000000006', 'sock.cotton-crew', 'Cotton crew socks', 49900, 'INR', 'other', array['socks', 'gift'], 'published', '2026-02-01 00:00:00+00', '2026-02-01 00:00:00+00', '2026-02-01 00:00:00+00'),
  ('50200000-0000-4000-8000-000000000004', 'lotus-gifting-in', '50100000-0000-4000-8000-000000000004', 'gift.tea-hamper', 'Tea hamper', 99900, 'INR', 'other', array['hamper', 'tea', 'gift'], 'published', '2026-02-08 00:00:00+00', '2026-02-08 00:00:00+00', '2026-02-08 00:00:00+00'),
  ('50200000-0000-4000-8000-000000000005', 'lotus-gifting-in', '50100000-0000-4000-8000-000000000005', 'gift.note-card', 'Handmade note card', 19900, 'INR', 'paper', array['card', 'note', 'gift'], 'published', '2026-02-08 00:00:00+00', '2026-02-08 00:00:00+00', '2026-02-08 00:00:00+00'),
  ('50200000-0000-4000-8000-000000000006', 'lotus-gifting-in', '50100000-0000-4000-8000-000000000006', 'gift.photo-frame', 'Oak photo frame', 79900, 'INR', 'other', array['frame', 'photo', 'gift'], 'published', '2026-02-08 00:00:00+00', '2026-02-08 00:00:00+00', '2026-02-08 00:00:00+00'),
  ('60200000-0000-4000-8000-000000000004', 'marigold-home-in', '60100000-0000-4000-8000-000000000004', 'home.incense-sandal', 'Sandal incense', 34900, 'INR', 'other', array['incense', 'agarbatti', 'gift'], 'published', '2026-02-15 00:00:00+00', '2026-02-15 00:00:00+00', '2026-02-15 00:00:00+00'),
  ('60200000-0000-4000-8000-000000000005', 'marigold-home-in', '60100000-0000-4000-8000-000000000005', 'home.ceramic-vase', 'Ceramic bud vase', 129900, 'INR', 'other', array['vase', 'home', 'gift'], 'published', '2026-02-15 00:00:00+00', '2026-02-15 00:00:00+00', '2026-02-15 00:00:00+00'),
  ('60200000-0000-4000-8000-000000000006', 'marigold-home-in', '60100000-0000-4000-8000-000000000006', 'home.napkin-set', 'Linen napkin set', 69900, 'INR', 'other', array['napkin', 'linen', 'table'], 'published', '2026-02-15 00:00:00+00', '2026-02-15 00:00:00+00', '2026-02-15 00:00:00+00')
on conflict (id) do update
set
  tenant_id = excluded.tenant_id,
  product_id = excluded.product_id,
  sku = excluded.sku,
  title = excluded.title,
  price_minor = excluded.price_minor,
  currency = excluded.currency,
  material = excluded.material,
  aliases = excluded.aliases,
  status = excluded.status,
  published_at = excluded.published_at,
  updated_at = excluded.updated_at
where (
  variants.tenant_id,
  variants.product_id,
  variants.sku,
  variants.title,
  variants.price_minor,
  variants.currency,
  variants.material,
  variants.aliases,
  variants.status,
  variants.published_at
) is distinct from (
  excluded.tenant_id,
  excluded.product_id,
  excluded.sku,
  excluded.title,
  excluded.price_minor,
  excluded.currency,
  excluded.material,
  excluded.aliases,
  excluded.status,
  excluded.published_at
);

insert into catalog.inventory (
  tenant_id,
  variant_id,
  on_hand,
  reserved,
  version,
  updated_at
)
values
  ('northstar-demo-in', '12000000-0000-4000-8000-000000000007', 16, 0, 1, '2026-01-01 00:00:00+00'),
  ('northstar-demo-in', '12000000-0000-4000-8000-000000000008', 22, 0, 1, '2026-01-01 00:00:00+00'),
  ('indigo-desk-in', '22000000-0000-4000-8000-000000000005', 14, 0, 1, '2026-01-01 00:00:00+00'),
  ('indigo-desk-in', '22000000-0000-4000-8000-000000000006', 20, 0, 1, '2026-01-01 00:00:00+00'),
  ('indigo-desk-in', '22000000-0000-4000-8000-000000000007', 9, 0, 1, '2026-01-01 00:00:00+00'),
  ('harbor-spice-in', '32000000-0000-4000-8000-000000000005', 40, 0, 1, '2026-01-01 00:00:00+00'),
  ('harbor-spice-in', '32000000-0000-4000-8000-000000000006', 38, 0, 1, '2026-01-01 00:00:00+00'),
  ('harbor-spice-in', '32000000-0000-4000-8000-000000000007', 24, 0, 1, '2026-01-01 00:00:00+00'),
  ('sable-atelier-in', '40200000-0000-4000-8000-000000000004', 11, 0, 1, '2026-02-01 00:00:00+00'),
  ('sable-atelier-in', '40200000-0000-4000-8000-000000000005', 16, 0, 1, '2026-02-01 00:00:00+00'),
  ('sable-atelier-in', '40200000-0000-4000-8000-000000000006', 28, 0, 1, '2026-02-01 00:00:00+00'),
  ('lotus-gifting-in', '50200000-0000-4000-8000-000000000004', 12, 0, 1, '2026-02-08 00:00:00+00'),
  ('lotus-gifting-in', '50200000-0000-4000-8000-000000000005', 40, 0, 1, '2026-02-08 00:00:00+00'),
  ('lotus-gifting-in', '50200000-0000-4000-8000-000000000006', 15, 0, 1, '2026-02-08 00:00:00+00'),
  ('marigold-home-in', '60200000-0000-4000-8000-000000000004', 26, 0, 1, '2026-02-15 00:00:00+00'),
  ('marigold-home-in', '60200000-0000-4000-8000-000000000005', 10, 0, 1, '2026-02-15 00:00:00+00'),
  ('marigold-home-in', '60200000-0000-4000-8000-000000000006', 18, 0, 1, '2026-02-15 00:00:00+00')
on conflict (tenant_id, variant_id) do update
set
  on_hand = excluded.on_hand,
  reserved = excluded.reserved,
  version = excluded.version,
  updated_at = excluded.updated_at
where (inventory.on_hand, inventory.reserved, inventory.version)
  is distinct from
  (excluded.on_hand, excluded.reserved, excluded.version);

insert into policy.shop_policies (
  tenant_id,
  currency,
  hard_cap_minor,
  autonomous_cap_minor,
  forbidden_materials,
  rules,
  version,
  updated_by,
  created_at,
  updated_at
)
values
  (
    'northstar-demo-in',
    'INR',
    300000,
    250000,
    array['glass'],
    '{
      "offers": [
        {
          "id": "filters_bundle",
          "discount_minor": 10000,
          "required_sku_groups": [
            ["brewer.trailpress-steel-750"],
            ["filters.travel-30"],
            ["grinder.pocket-lite", "grinder.pocket-pro"]
          ]
        }
      ]
    }'::jsonb,
    1,
    '01000000-0000-4000-8000-000000000001',
    '2026-01-01 00:00:00+00',
    '2026-01-01 00:00:00+00'
  ),
  (
    'indigo-desk-in',
    'INR',
    1500000,
    1500000,
    '{}',
    '{"offers":[]}'::jsonb,
    1,
    '01000000-0000-4000-8000-000000000002',
    '2026-01-01 00:00:00+00',
    '2026-01-01 00:00:00+00'
  ),
  (
    'harbor-spice-in',
    'INR',
    1500000,
    1500000,
    array['glass'],
    '{"offers":[]}'::jsonb,
    1,
    '01000000-0000-4000-8000-000000000003',
    '2026-01-01 00:00:00+00',
    '2026-01-01 00:00:00+00'
  ),
  (
    'sable-atelier-in',
    'INR',
    1500000,
    1500000,
    '{}',
    '{"offers":[]}'::jsonb,
    1,
    '01000000-0000-4000-8000-000000000004',
    '2026-02-01 00:00:00+00',
    '2026-02-01 00:00:00+00'
  ),
  (
    'lotus-gifting-in',
    'INR',
    1500000,
    1500000,
    array['glass'],
    '{"offers":[]}'::jsonb,
    1,
    '01000000-0000-4000-8000-000000000005',
    '2026-02-08 00:00:00+00',
    '2026-02-08 00:00:00+00'
  ),
  (
    'marigold-home-in',
    'INR',
    1500000,
    1500000,
    array['glass'],
    '{"offers":[]}'::jsonb,
    1,
    '01000000-0000-4000-8000-000000000006',
    '2026-02-15 00:00:00+00',
    '2026-02-15 00:00:00+00'
  )
on conflict (tenant_id) do update
set
  currency = excluded.currency,
  hard_cap_minor = excluded.hard_cap_minor,
  autonomous_cap_minor = excluded.autonomous_cap_minor,
  forbidden_materials = excluded.forbidden_materials,
  rules = excluded.rules,
  version = excluded.version,
  updated_by = excluded.updated_by,
  updated_at = excluded.updated_at
where (
  shop_policies.currency,
  shop_policies.hard_cap_minor,
  shop_policies.autonomous_cap_minor,
  shop_policies.forbidden_materials,
  shop_policies.rules,
  shop_policies.version,
  shop_policies.updated_by
) is distinct from (
  excluded.currency,
  excluded.hard_cap_minor,
  excluded.autonomous_cap_minor,
  excluded.forbidden_materials,
  excluded.rules,
  excluded.version,
  excluded.updated_by
);

commit;
