-- Charter sandbox shipping sidecar. Not a courier integration.
-- keyed by tenant_id + checkout_id. Does not alter payments.checkout_sessions.

create table commerce.shipping_addresses (
  tenant_id text not null,
  checkout_id uuid not null,
  recipient_name text not null check (length(btrim(recipient_name)) between 1 and 120),
  street text not null check (length(btrim(street)) between 1 and 240),
  city text not null check (length(btrim(city)) between 1 and 80),
  state text not null check (length(btrim(state)) between 1 and 80),
  pincode text not null check (pincode ~ '^[0-9]{6}$'),
  phone text not null check (length(btrim(phone)) between 8 and 32),
  source text not null default 'sandbox_mock'
    check (source in ('sandbox_mock', 'buyer_confirmed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, checkout_id),
  foreign key (tenant_id, checkout_id)
    references payments.checkout_sessions (tenant_id, id) on delete cascade
);

create table commerce.fulfillment_shipments (
  tenant_id text not null,
  checkout_id uuid not null,
  tracking_id text not null check (tracking_id ~ '^CHR-TRK-[0-9A-F]{12}$'),
  status text not null check (status in ('confirmed', 'packed', 'dispatched', 'delivered')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, checkout_id),
  unique (tenant_id, tracking_id),
  foreign key (tenant_id, checkout_id)
    references payments.checkout_sessions (tenant_id, id) on delete cascade
);

create table commerce.fulfillment_events (
  id uuid not null default gen_random_uuid(),
  tenant_id text not null,
  checkout_id uuid not null,
  status text not null check (status in ('confirmed', 'packed', 'dispatched', 'delivered')),
  note text not null default '',
  occurred_at timestamptz not null default now(),
  primary key (id),
  unique (tenant_id, checkout_id, status),
  foreign key (tenant_id, checkout_id)
    references payments.checkout_sessions (tenant_id, id) on delete cascade
);

create index fulfillment_events_checkout_idx
  on commerce.fulfillment_events (tenant_id, checkout_id, occurred_at);

create trigger shipping_addresses_updated_at
  before update on commerce.shipping_addresses
  for each row execute function public.charter_set_updated_at();

create trigger fulfillment_shipments_updated_at
  before update on commerce.fulfillment_shipments
  for each row execute function public.charter_set_updated_at();

alter table commerce.shipping_addresses enable row level security;
alter table commerce.shipping_addresses force row level security;
alter table commerce.fulfillment_shipments enable row level security;
alter table commerce.fulfillment_shipments force row level security;
alter table commerce.fulfillment_events enable row level security;
alter table commerce.fulfillment_events force row level security;

create policy shipping_addresses_read on commerce.shipping_addresses
  for select using (
    app_private.has_active_membership(tenant_id, null)
    or app_private.has_machine_tenant_access(tenant_id)
  );
create policy shipping_addresses_write on commerce.shipping_addresses
  for insert with check (
    app_private.has_active_membership(tenant_id, null)
    or app_private.has_machine_tenant_access(tenant_id)
  );
create policy shipping_addresses_update on commerce.shipping_addresses
  for update using (
    app_private.has_active_membership(tenant_id, null)
    or app_private.has_machine_tenant_access(tenant_id)
  )
  with check (
    app_private.has_active_membership(tenant_id, null)
    or app_private.has_machine_tenant_access(tenant_id)
  );

create policy fulfillment_shipments_read on commerce.fulfillment_shipments
  for select using (
    app_private.has_active_membership(tenant_id, null)
    or app_private.has_machine_tenant_access(tenant_id)
  );
create policy fulfillment_shipments_write on commerce.fulfillment_shipments
  for insert with check (
    app_private.has_active_membership(tenant_id, null)
    or app_private.has_machine_tenant_access(tenant_id)
  );
create policy fulfillment_shipments_update on commerce.fulfillment_shipments
  for update using (
    app_private.has_active_membership(tenant_id, null)
    or app_private.has_machine_tenant_access(tenant_id)
  )
  with check (
    app_private.has_active_membership(tenant_id, null)
    or app_private.has_machine_tenant_access(tenant_id)
  );

create policy fulfillment_events_read on commerce.fulfillment_events
  for select using (
    app_private.has_active_membership(tenant_id, null)
    or app_private.has_machine_tenant_access(tenant_id)
  );
create policy fulfillment_events_write on commerce.fulfillment_events
  for insert with check (
    app_private.has_active_membership(tenant_id, null)
    or app_private.has_machine_tenant_access(tenant_id)
  );

grant select, insert, update, delete on table commerce.shipping_addresses to charter_app;
grant select, insert, update, delete on table commerce.fulfillment_shipments to charter_app;
grant select, insert, update, delete on table commerce.fulfillment_events to charter_app;
