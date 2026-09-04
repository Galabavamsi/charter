-- Evaluator-real shop profile (mock GST/address/refund — not verified KYC)
-- and discovery impression logs for merchant plots.

alter table catalog.shops
  add column if not exists gstin text not null default ''
    check (gstin = '' or gstin ~ '^[0-9A-Z]{15}$'),
  add column if not exists address_line text not null default ''
    check (length(address_line) <= 300),
  add column if not exists refund_policy text not null default ''
    check (length(refund_policy) <= 2000),
  add column if not exists profile_verified boolean not null default false;

comment on column catalog.shops.gstin is
  'Mock GSTIN for evaluator onboarding. profile_verified is always false until live KYC.';
comment on column catalog.shops.refund_policy is
  'Merchant-authored refund copy Concierge may quote. Empty means do not invent a policy.';

create table catalog.search_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references identity.tenants (id) on delete cascade,
  request_id text not null check (length(btrim(request_id)) between 1 and 80),
  query_text text not null default '' check (length(query_text) <= 400),
  surface text not null check (surface in ('shops.search', 'catalog.search')),
  agent_source text not null check (
    agent_source in ('concierge_web', 'concierge_voice', 'mcp', 'directory_http')
  ),
  created_at timestamptz not null default now()
);

create index search_events_tenant_created_idx
  on catalog.search_events (tenant_id, created_at desc);

create table catalog.recommendation_impressions (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references identity.tenants (id) on delete cascade,
  request_id text not null check (length(btrim(request_id)) between 1 and 80),
  shop_slug text not null,
  sku text,
  rank integer not null check (rank >= 1),
  surface text not null check (surface in ('shops.search', 'catalog.search')),
  agent_source text not null check (
    agent_source in ('concierge_web', 'concierge_voice', 'mcp', 'directory_http')
  ),
  query_text text not null default '' check (length(query_text) <= 400),
  created_at timestamptz not null default now()
);

create index recommendation_impressions_tenant_created_idx
  on catalog.recommendation_impressions (tenant_id, created_at desc);
create index recommendation_impressions_tenant_sku_idx
  on catalog.recommendation_impressions (tenant_id, sku)
  where sku is not null;

alter table catalog.search_events enable row level security;
alter table catalog.search_events force row level security;
alter table catalog.recommendation_impressions enable row level security;
alter table catalog.recommendation_impressions force row level security;

create policy search_events_read on catalog.search_events
  for select using (
    app_private.has_active_membership(tenant_id, null)
    or app_private.has_machine_tenant_access(tenant_id)
  );
create policy search_events_write on catalog.search_events
  for insert with check (
    app_private.has_machine_tenant_access(tenant_id)
    or current_setting('app.service_context', true) = 'public_catalog'
  );

create policy recommendation_impressions_read on catalog.recommendation_impressions
  for select using (
    app_private.has_active_membership(tenant_id, null)
    or app_private.has_machine_tenant_access(tenant_id)
  );
create policy recommendation_impressions_write on catalog.recommendation_impressions
  for insert with check (
    app_private.has_machine_tenant_access(tenant_id)
    or current_setting('app.service_context', true) = 'public_catalog'
  );

grant select, insert on table catalog.search_events to charter_app;
grant select, insert on table catalog.recommendation_impressions to charter_app;
