alter table catalog.shops
  add column version integer not null default 1 check (version > 0);

alter table catalog.products
  add column version integer not null default 1 check (version > 0);

alter table catalog.variants
  add column version integer not null default 1 check (version > 0);

create table catalog.inventory_adjustments (
  id uuid primary key,
  tenant_id text not null references identity.tenants (id) on delete cascade,
  variant_id uuid not null,
  actor_id uuid not null references identity.users (id),
  delta integer not null check (delta <> 0),
  before_on_hand integer not null check (before_on_hand >= 0),
  after_on_hand integer not null check (after_on_hand >= 0),
  version_before integer not null check (version_before > 0),
  version_after integer not null check (version_after = version_before + 1),
  reason text not null check (length(btrim(reason)) between 3 and 500),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, variant_id)
    references catalog.variants (tenant_id, id) on delete cascade,
  check (after_on_hand = before_on_hand + delta)
);

create index inventory_adjustments_tenant_created_idx
  on catalog.inventory_adjustments (tenant_id, created_at desc, id desc);

create table catalog.product_audits (
  id uuid primary key,
  tenant_id text not null references identity.tenants (id) on delete cascade,
  product_id uuid not null,
  actor_id uuid not null references identity.users (id),
  version_before integer not null check (version_before > 0),
  version_after integer not null check (version_after = version_before + 1),
  reason text not null check (length(btrim(reason)) between 3 and 500),
  before_record jsonb not null check (jsonb_typeof(before_record) = 'object'),
  after_record jsonb not null check (jsonb_typeof(after_record) = 'object'),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, product_id)
    references catalog.products (tenant_id, id) on delete cascade
);

create index product_audits_tenant_created_idx
  on catalog.product_audits (tenant_id, created_at desc, id desc);

create table policy.shop_policy_audits (
  id uuid primary key,
  tenant_id text not null references identity.tenants (id) on delete cascade,
  actor_id uuid not null references identity.users (id),
  version_before integer not null check (version_before > 0),
  version_after integer not null check (version_after = version_before + 1),
  reason text not null check (length(btrim(reason)) between 3 and 500),
  before_record jsonb not null check (jsonb_typeof(before_record) = 'object'),
  after_record jsonb not null check (jsonb_typeof(after_record) = 'object'),
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create index shop_policy_audits_tenant_created_idx
  on policy.shop_policy_audits (tenant_id, created_at desc, id desc);

create table catalog.shop_audits (
  id uuid primary key,
  tenant_id text not null references identity.tenants (id) on delete cascade,
  actor_id uuid not null references identity.users (id),
  version_before integer not null check (version_before > 0),
  version_after integer not null check (version_after = version_before + 1),
  reason text not null check (length(btrim(reason)) between 3 and 500),
  before_record jsonb not null check (jsonb_typeof(before_record) = 'object'),
  after_record jsonb not null check (jsonb_typeof(after_record) = 'object'),
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create index shop_audits_tenant_created_idx
  on catalog.shop_audits (tenant_id, created_at desc, id desc);

create table recovery.suppressions (
  id uuid primary key,
  tenant_id text not null references identity.tenants (id) on delete cascade,
  contact_value text not null
    check (contact_value = lower(btrim(contact_value)) and position('@' in contact_value) > 1),
  purpose text not null check (purpose = 'payment_recovery'),
  channel text not null check (channel = 'email'),
  reason text not null check (length(btrim(reason)) between 3 and 500),
  active boolean not null default true,
  created_by uuid not null references identity.users (id),
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  unique (tenant_id, id),
  check (
    (active and ended_at is null)
    or (not active and ended_at is not null)
  )
);

create unique index recovery_suppressions_active_uidx
  on recovery.suppressions (tenant_id, contact_value, purpose, channel)
  where active;

create index recovery_suppressions_tenant_created_idx
  on recovery.suppressions (tenant_id, created_at desc, id desc);

create table operations.merchant_commands (
  actor_id uuid not null references identity.users (id),
  tenant_id text references identity.tenants (id) on delete cascade,
  operation text not null check (length(btrim(operation)) between 3 and 160),
  idempotency_key text not null
    check (
      length(idempotency_key) between 8 and 128
      and idempotency_key ~ '^[A-Za-z0-9._:-]+$'
    ),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  response jsonb not null check (jsonb_typeof(response) = 'object'),
  created_at timestamptz not null default now(),
  primary key (actor_id, operation, idempotency_key)
);

create index merchant_commands_tenant_created_idx
  on operations.merchant_commands (tenant_id, created_at desc)
  where tenant_id is not null;

create index checkout_sessions_tenant_created_idx
  on payments.checkout_sessions (tenant_id, created_at desc, id desc);

create index quotes_tenant_status_created_idx
  on commerce.quotes (tenant_id, status, created_at desc, id desc);

create index ledger_entries_tenant_kind_created_idx
  on ledger.ledger_entries (tenant_id, kind, created_at desc, id desc);

drop policy memberships_self_or_managers on identity.shop_memberships;
create policy memberships_members_read on identity.shop_memberships
  for select using (
    app_private.has_active_membership(tenant_id, null)
    or app_private.has_platform_role(array['admin', 'operator', 'auditor'])
  );

drop policy categories_managers_insert on catalog.categories;
drop policy categories_managers_update on catalog.categories;
create policy categories_catalog_writers_insert on catalog.categories
  for insert with check (
    app_private.has_active_membership(tenant_id, array['owner', 'admin', 'catalog'])
  );
create policy categories_catalog_writers_update on catalog.categories
  for update using (
    app_private.has_active_membership(tenant_id, array['owner', 'admin', 'catalog'])
  )
  with check (
    app_private.has_active_membership(tenant_id, array['owner', 'admin', 'catalog'])
  );

alter table catalog.inventory_adjustments enable row level security;
alter table catalog.inventory_adjustments force row level security;
create policy inventory_adjustments_members_read on catalog.inventory_adjustments
  for select using (app_private.has_active_membership(tenant_id, null));
create policy inventory_adjustments_catalog_writers_insert on catalog.inventory_adjustments
  for insert with check (
    actor_id = app_private.current_user_id()
    and app_private.has_active_membership(tenant_id, array['owner', 'admin', 'catalog'])
  );

alter table catalog.product_audits enable row level security;
alter table catalog.product_audits force row level security;
create policy product_audits_members_read on catalog.product_audits
  for select using (app_private.has_active_membership(tenant_id, null));
create policy product_audits_catalog_writers_insert on catalog.product_audits
  for insert with check (
    actor_id = app_private.current_user_id()
    and app_private.has_active_membership(tenant_id, array['owner', 'admin', 'catalog'])
  );

alter table policy.shop_policy_audits enable row level security;
alter table policy.shop_policy_audits force row level security;
create policy shop_policy_audits_members_read on policy.shop_policy_audits
  for select using (app_private.has_active_membership(tenant_id, null));
create policy shop_policy_audits_managers_insert on policy.shop_policy_audits
  for insert with check (
    actor_id = app_private.current_user_id()
    and app_private.has_active_membership(tenant_id, array['owner', 'admin'])
  );

alter table catalog.shop_audits enable row level security;
alter table catalog.shop_audits force row level security;
create policy shop_audits_members_read on catalog.shop_audits
  for select using (app_private.has_active_membership(tenant_id, null));
create policy shop_audits_managers_insert on catalog.shop_audits
  for insert with check (
    actor_id = app_private.current_user_id()
    and app_private.has_active_membership(tenant_id, array['owner', 'admin'])
  );

alter table recovery.suppressions enable row level security;
alter table recovery.suppressions force row level security;
create policy suppressions_recovery_read on recovery.suppressions
  for select using (
    app_private.has_active_membership(tenant_id, array['owner', 'admin', 'support'])
    or app_private.has_machine_tenant_access(tenant_id)
  );
create policy suppressions_recovery_insert on recovery.suppressions
  for insert with check (
    created_by = app_private.current_user_id()
    and app_private.has_active_membership(tenant_id, array['owner', 'admin', 'support'])
  );
create policy suppressions_managers_update on recovery.suppressions
  for update using (
    app_private.has_active_membership(tenant_id, array['owner', 'admin'])
  )
  with check (
    app_private.has_active_membership(tenant_id, array['owner', 'admin'])
  );

alter table operations.merchant_commands enable row level security;
alter table operations.merchant_commands force row level security;
create policy merchant_commands_actor_read on operations.merchant_commands
  for select using (
    actor_id = app_private.current_user_id()
    and (
      tenant_id is null
      or app_private.has_active_membership(tenant_id, null)
    )
  );
create policy merchant_commands_actor_insert on operations.merchant_commands
  for insert with check (
    actor_id = app_private.current_user_id()
    and (
      tenant_id is null
      or app_private.has_active_membership(tenant_id, null)
    )
  );

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'charter_app') then
    grant select, insert on
      catalog.inventory_adjustments,
      catalog.product_audits,
      policy.shop_policy_audits,
      catalog.shop_audits,
      recovery.suppressions,
      operations.merchant_commands
    to charter_app;
    grant update on recovery.suppressions to charter_app;
  end if;
end
$$;
