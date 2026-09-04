alter table catalog.shops
  add column if not exists rating_milli integer not null default 0
    check (rating_milli between 0 and 5000),
  add column if not exists review_count integer not null default 0
    check (review_count >= 0);

comment on column catalog.shops.rating_milli is
  'Directory ranking input, thousandths of a star (0–5000). Seeded demo shops use synthetic fixtures, not live reviews.';
comment on column catalog.shops.review_count is
  'Directory ranking input. Seeded demo shops use synthetic fixtures, not live reviews.';

create index if not exists shops_public_rating_idx
  on catalog.shops (rating_milli desc, review_count desc, lower(name), tenant_id)
  where status = 'published';
