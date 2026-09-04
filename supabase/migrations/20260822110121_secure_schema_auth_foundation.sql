create schema app_private;
create schema catalog;
create schema policy;
create schema conversation;
create schema recovery;
create schema operations;

revoke all on schema app_private from public;
grant usage on schema app_private to public;

create function app_private.current_user_id()
returns uuid
language sql
stable
security invoker
set search_path = pg_catalog
as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

create function app_private.current_tenant_id()
returns text
language sql
stable
security invoker
set search_path = pg_catalog
as $$
  select nullif(current_setting('app.tenant_id', true), '')
$$;

create table identity.users (
  id uuid primary key,
  email text,
  status text not null default 'active' check (status in ('active', 'disabled', 'deleted')),
  synthetic boolean not null default false,
  auth_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (email is null or (email = lower(btrim(email)) and position('@' in email) > 1))
);

comment on column identity.users.id is
  'Application identity UUID mirrored from the Supabase Auth user UUID.';
comment on column identity.users.email is
  'Contact and display data only; authorization is derived from membership rows.';

create index users_status_idx on identity.users (status, created_at desc);
create unique index users_email_uidx on identity.users (email) where email is not null;

create table identity.profiles (
  user_id uuid primary key references identity.users (id) on delete cascade,
  display_name text not null check (length(btrim(display_name)) between 1 and 120),
  avatar_url text,
  locale text not null default 'en-IN',
  time_zone text not null default 'Asia/Kolkata',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table identity.tenants
  add column status text not null default 'active'
    check (status in ('active', 'suspended', 'archived')),
  add column updated_at timestamptz not null default now();

create table identity.shop_memberships (
  tenant_id text not null references identity.tenants (id) on delete cascade,
  user_id uuid not null references identity.users (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member', 'support')),
  status text not null default 'active' check (status in ('invited', 'active', 'suspended')),
  invited_by uuid references identity.users (id),
  joined_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id),
  check ((status = 'active' and joined_at is not null) or status <> 'active')
);

create index shop_memberships_user_idx
  on identity.shop_memberships (user_id, status, tenant_id);
create index shop_memberships_tenant_role_idx
  on identity.shop_memberships (tenant_id, role, status);

create table identity.platform_roles (
  user_id uuid not null references identity.users (id) on delete cascade,
  role text not null check (role in ('admin', 'operator', 'auditor')),
  granted_by uuid references identity.users (id),
  created_at timestamptz not null default now(),
  primary key (user_id, role)
);

create index platform_roles_role_idx on identity.platform_roles (role, user_id);

alter table commerce.carts
  add column approved_through_minor bigint not null default 0
    check (approved_through_minor >= 0);

create table catalog.shops (
  tenant_id text primary key references identity.tenants (id) on delete cascade,
  slug text not null unique
    check (slug = lower(slug) and slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null check (length(btrim(name)) between 2 and 120),
  label text not null check (length(btrim(label)) between 2 and 160),
  blurb text not null default '',
  currency text not null default 'INR' check (currency = 'INR'),
  status text not null default 'draft' check (status in ('draft', 'published', 'suspended', 'archived')),
  synthetic boolean not null default false,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'published' and published_at is not null) or status <> 'published')
);

create index shops_public_idx
  on catalog.shops (status, slug)
  where status = 'published';

create table catalog.categories (
  id uuid primary key,
  tenant_id text not null references identity.tenants (id) on delete cascade,
  slug text not null check (slug = lower(slug) and slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  title text not null check (length(btrim(title)) between 1 and 120),
  status text not null default 'active' check (status in ('active', 'archived')),
  position integer not null default 0 check (position >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, slug)
);

create index categories_tenant_position_idx
  on catalog.categories (tenant_id, status, position, title);

create table catalog.products (
  id uuid primary key,
  tenant_id text not null references identity.tenants (id) on delete cascade,
  category_id uuid,
  slug text not null check (slug = lower(slug) and slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  title text not null check (length(btrim(title)) between 1 and 180),
  description text not null default '',
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  currency text not null default 'INR' check (currency = 'INR'),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, slug),
  foreign key (tenant_id, category_id)
    references catalog.categories (tenant_id, id),
  check ((status = 'published' and published_at is not null) or status <> 'published')
);

create index products_tenant_status_idx
  on catalog.products (tenant_id, status, updated_at desc);
create index products_category_idx
  on catalog.products (tenant_id, category_id, status);

create table catalog.variants (
  id uuid primary key,
  tenant_id text not null references identity.tenants (id) on delete cascade,
  product_id uuid not null,
  sku text not null check (length(btrim(sku)) between 1 and 160),
  title text not null check (length(btrim(title)) between 1 and 180),
  price_minor bigint not null check (price_minor >= 0),
  currency text not null default 'INR' check (currency = 'INR'),
  material text not null default 'other' check (material in ('steel', 'glass', 'paper', 'other')),
  aliases text[] not null default '{}',
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, sku),
  foreign key (tenant_id, product_id)
    references catalog.products (tenant_id, id) on delete cascade,
  check ((status = 'published' and published_at is not null) or status <> 'published')
);

create index variants_product_idx
  on catalog.variants (tenant_id, product_id, status);
create index variants_public_idx
  on catalog.variants (tenant_id, status, sku)
  where status = 'published';

create table catalog.inventory (
  tenant_id text not null,
  variant_id uuid not null,
  on_hand integer not null default 0 check (on_hand >= 0),
  reserved integer not null default 0 check (reserved >= 0),
  available integer generated always as (on_hand - reserved) stored,
  version integer not null default 1 check (version > 0),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, variant_id),
  foreign key (tenant_id, variant_id)
    references catalog.variants (tenant_id, id) on delete cascade,
  check (reserved <= on_hand)
);

create index inventory_available_idx
  on catalog.inventory (tenant_id, available, variant_id);

create table policy.shop_policies (
  tenant_id text primary key references identity.tenants (id) on delete cascade,
  currency text not null default 'INR' check (currency = 'INR'),
  hard_cap_minor bigint not null check (hard_cap_minor >= 0),
  autonomous_cap_minor bigint not null check (autonomous_cap_minor >= 0),
  forbidden_materials text[] not null default '{}',
  rules jsonb not null default '{}'::jsonb check (jsonb_typeof(rules) = 'object'),
  version integer not null default 1 check (version > 0),
  updated_by uuid references identity.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (autonomous_cap_minor <= hard_cap_minor)
);

create index shop_policies_rules_idx on policy.shop_policies using gin (rules);

create table policy.approvals (
  id uuid primary key,
  tenant_id text not null references identity.tenants (id) on delete cascade,
  cart_id uuid not null,
  from_sku text not null,
  to_sku text not null,
  proposed_total_minor bigint not null check (proposed_total_minor >= 0),
  approved_through_minor bigint check (approved_through_minor >= 0),
  requested_by uuid not null references identity.users (id),
  decided_by uuid references identity.users (id),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'denied', 'expired')),
  reason text,
  expires_at timestamptz,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, cart_id)
    references commerce.carts (tenant_id, id) on delete cascade,
  foreign key (tenant_id, from_sku)
    references catalog.variants (tenant_id, sku),
  foreign key (tenant_id, to_sku)
    references catalog.variants (tenant_id, sku),
  check (
    (status = 'pending' and decided_by is null and decided_at is null)
    or (status <> 'pending' and decided_at is not null)
  ),
  check (
    status <> 'approved'
    or approved_through_minor is not null
  )
);

create unique index approvals_one_pending_per_cart_idx
  on policy.approvals (tenant_id, cart_id)
  where status = 'pending';
create index approvals_tenant_status_idx
  on policy.approvals (tenant_id, status, created_at desc);
create index approvals_requester_idx
  on policy.approvals (requested_by, status, created_at desc);

create table conversation.conversations (
  id uuid primary key,
  tenant_id text not null references identity.tenants (id) on delete cascade,
  user_id uuid not null references identity.users (id),
  channel text not null check (channel in ('web', 'voice', 'mcp')),
  status text not null default 'open' check (status in ('open', 'closed')),
  external_session_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, external_session_id)
);

create index conversations_user_idx
  on conversation.conversations (user_id, status, updated_at desc);
create index conversations_tenant_idx
  on conversation.conversations (tenant_id, status, updated_at desc);

create table conversation.messages (
  id uuid primary key,
  tenant_id text not null references identity.tenants (id) on delete cascade,
  conversation_id uuid not null,
  user_id uuid references identity.users (id),
  actor text not null check (actor in ('user', 'assistant', 'system', 'operator')),
  content text not null check (length(content) > 0),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, conversation_id)
    references conversation.conversations (tenant_id, id) on delete cascade,
  check (
    (actor in ('user', 'operator') and user_id is not null)
    or (actor in ('assistant', 'system') and user_id is null)
  )
);

create index messages_conversation_idx
  on conversation.messages (tenant_id, conversation_id, created_at, id);
create index messages_user_idx
  on conversation.messages (user_id, created_at desc)
  where user_id is not null;

create table recovery.consents (
  id uuid primary key,
  tenant_id text not null references identity.tenants (id) on delete cascade,
  user_id uuid references identity.users (id),
  purpose text not null check (purpose = 'payment_recovery'),
  channel text not null check (channel = 'email'),
  contact_value text not null
    check (contact_value = lower(btrim(contact_value)) and position('@' in contact_value) > 1),
  status text not null default 'granted' check (status in ('granted', 'revoked')),
  granted_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (
    (status = 'granted' and revoked_at is null)
    or (status = 'revoked' and revoked_at is not null)
  )
);

create unique index recovery_active_consent_uidx
  on recovery.consents (tenant_id, contact_value, purpose, channel)
  where status = 'granted';
create index recovery_consents_user_idx
  on recovery.consents (user_id, status, created_at desc)
  where user_id is not null;

create table recovery.attempts (
  id uuid primary key,
  tenant_id text not null references identity.tenants (id) on delete cascade,
  consent_id uuid not null,
  user_id uuid references identity.users (id),
  checkout_id uuid,
  attempt_number integer not null check (attempt_number > 0),
  status text not null default 'queued'
    check (status in ('queued', 'sent', 'delivered', 'failed', 'suppressed')),
  provider text not null,
  provider_message_id text,
  failure_code text,
  attempted_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, consent_id, attempt_number),
  foreign key (tenant_id, consent_id)
    references recovery.consents (tenant_id, id),
  foreign key (tenant_id, checkout_id)
    references payments.checkout_sessions (tenant_id, id),
  check (
    (status = 'queued' and completed_at is null)
    or (status <> 'queued' and completed_at is not null)
  )
);

create index recovery_attempts_status_idx
  on recovery.attempts (tenant_id, status, attempted_at);
create index recovery_attempts_user_idx
  on recovery.attempts (user_id, attempted_at desc)
  where user_id is not null;

create table operations.kill_switches (
  id uuid primary key,
  scope text not null check (scope in ('global', 'tenant')),
  tenant_id text references identity.tenants (id) on delete cascade,
  feature text not null check (length(btrim(feature)) between 1 and 80),
  enabled boolean not null default false,
  reason text,
  changed_by uuid not null references identity.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (scope = 'global' and tenant_id is null)
    or (scope = 'tenant' and tenant_id is not null)
  )
);

create unique index kill_switches_global_uidx
  on operations.kill_switches (feature)
  where scope = 'global';
create unique index kill_switches_tenant_uidx
  on operations.kill_switches (tenant_id, feature)
  where scope = 'tenant';
create index kill_switches_enabled_idx
  on operations.kill_switches (enabled, scope, tenant_id)
  where enabled;

create function app_private.has_active_membership(
  target_tenant_id text,
  allowed_roles text[] default null
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select
    app_private.current_user_id() is not null
    and app_private.current_tenant_id() = target_tenant_id
    and exists (
      select 1
      from identity.shop_memberships membership
      join identity.users application_user
        on application_user.id = membership.user_id
       and application_user.status = 'active'
      join identity.tenants tenant
        on tenant.id = membership.tenant_id
       and tenant.status = 'active'
      where membership.tenant_id = target_tenant_id
        and membership.user_id = app_private.current_user_id()
        and membership.status = 'active'
        and (allowed_roles is null or membership.role = any(allowed_roles))
    )
$$;

create function app_private.has_platform_role(allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select
    app_private.current_user_id() is not null
    and exists (
      select 1
      from identity.platform_roles platform_role
      join identity.users application_user
        on application_user.id = platform_role.user_id
       and application_user.status = 'active'
      where platform_role.user_id = app_private.current_user_id()
        and platform_role.role = any(allowed_roles)
    )
$$;

create function app_private.can_access_user(target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select
    (
      target_user_id = app_private.current_user_id()
      and exists (
        select 1
        from identity.users application_user
        where application_user.id = target_user_id
          and application_user.status = 'active'
      )
    )
    or app_private.has_platform_role(array['admin', 'operator', 'auditor'])
$$;

create function app_private.can_manage_tenant(target_tenant_id text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select
    app_private.has_active_membership(target_tenant_id, array['owner', 'admin'])
    or app_private.has_platform_role(array['admin'])
$$;

create function app_private.is_active_tenant(target_tenant_id text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select exists (
    select 1
    from identity.tenants tenant
    where tenant.id = target_tenant_id
      and tenant.status = 'active'
  )
$$;

create function app_private.has_machine_tenant_access(target_tenant_id text)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog
as $$
  select
    current_setting('app.service_context', true) = 'machine'
    and app_private.current_tenant_id() = target_tenant_id
    and (
      current_user::text = 'charter_app'
      or (
        current_user::text ~ '^charter_ci_[a-z0-9_]+$'
        and current_database() ~ '^charter_schema_auth_[a-f0-9]+$'
      )
    )
$$;

create function app_private.has_webhook_intake_access()
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog
as $$
  select
    current_setting('app.service_context', true) = 'webhook'
    and (
      current_user::text = 'charter_app'
      or (
        current_user::text ~ '^charter_ci_[a-z0-9_]+$'
        and current_database() ~ '^charter_schema_auth_[a-f0-9]+$'
      )
    )
$$;

create function app_private.is_public_shop(
  target_tenant_id text,
  target_status text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select target_status = 'published'
    and exists (
      select 1
      from catalog.shops shop
      join identity.tenants tenant
        on tenant.id = shop.tenant_id
       and tenant.status = 'active'
      where shop.tenant_id = target_tenant_id
        and shop.status = 'published'
    )
$$;

create function app_private.is_public_product(
  target_tenant_id text,
  target_status text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select target_status = 'published'
    and exists (
      select 1
      from catalog.shops shop
      join identity.tenants tenant
        on tenant.id = shop.tenant_id
       and tenant.status = 'active'
      where shop.tenant_id = target_tenant_id
        and shop.status = 'published'
    )
$$;

create function app_private.is_public_variant(
  target_tenant_id text,
  target_product_id uuid,
  target_status text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select target_status = 'published'
    and exists (
      select 1
      from catalog.shops shop
      join identity.tenants tenant
        on tenant.id = shop.tenant_id
       and tenant.status = 'active'
      join catalog.products product
        on product.tenant_id = shop.tenant_id
       and product.id = target_product_id
      where shop.tenant_id = target_tenant_id
        and shop.status = 'published'
        and product.status = 'published'
    )
$$;

create function app_private.can_access_conversation(
  target_tenant_id text,
  target_conversation_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select
    (
      app_private.current_tenant_id() = target_tenant_id
      and exists (
        select 1
        from conversation.conversations conversation
        where conversation.tenant_id = target_tenant_id
          and conversation.id = target_conversation_id
          and conversation.user_id = app_private.current_user_id()
          and app_private.can_access_user(conversation.user_id)
          and app_private.is_active_tenant(conversation.tenant_id)
      )
    )
    or app_private.has_active_membership(target_tenant_id, null)
$$;

revoke all on all functions in schema app_private from public;
grant execute on function app_private.current_user_id() to public;
grant execute on function app_private.current_tenant_id() to public;
grant execute on function app_private.has_active_membership(text, text[]) to public;
grant execute on function app_private.has_platform_role(text[]) to public;
grant execute on function app_private.can_access_user(uuid) to public;
grant execute on function app_private.can_manage_tenant(text) to public;
grant execute on function app_private.is_active_tenant(text) to public;
grant execute on function app_private.has_machine_tenant_access(text) to public;
grant execute on function app_private.has_webhook_intake_access() to public;
grant execute on function app_private.is_public_shop(text, text) to public;
grant execute on function app_private.is_public_product(text, text) to public;
grant execute on function app_private.is_public_variant(text, uuid, text) to public;
grant execute on function app_private.can_access_conversation(text, uuid) to public;

create trigger users_updated_at
  before update on identity.users
  for each row execute function public.charter_set_updated_at();
create trigger profiles_updated_at
  before update on identity.profiles
  for each row execute function public.charter_set_updated_at();
create trigger tenants_updated_at
  before update on identity.tenants
  for each row execute function public.charter_set_updated_at();
create trigger shop_memberships_updated_at
  before update on identity.shop_memberships
  for each row execute function public.charter_set_updated_at();
create trigger shops_updated_at
  before update on catalog.shops
  for each row execute function public.charter_set_updated_at();
create trigger categories_updated_at
  before update on catalog.categories
  for each row execute function public.charter_set_updated_at();
create trigger products_updated_at
  before update on catalog.products
  for each row execute function public.charter_set_updated_at();
create trigger variants_updated_at
  before update on catalog.variants
  for each row execute function public.charter_set_updated_at();
create trigger inventory_updated_at
  before update on catalog.inventory
  for each row execute function public.charter_set_updated_at();
create trigger shop_policies_updated_at
  before update on policy.shop_policies
  for each row execute function public.charter_set_updated_at();
create trigger approvals_updated_at
  before update on policy.approvals
  for each row execute function public.charter_set_updated_at();
create trigger conversations_updated_at
  before update on conversation.conversations
  for each row execute function public.charter_set_updated_at();
create trigger recovery_consents_updated_at
  before update on recovery.consents
  for each row execute function public.charter_set_updated_at();
create trigger kill_switches_updated_at
  before update on operations.kill_switches
  for each row execute function public.charter_set_updated_at();

alter table identity.users enable row level security;
alter table identity.users force row level security;
create policy users_self_select on identity.users
  for select using (app_private.can_access_user(id));
create policy users_platform_insert on identity.users
  for insert with check (app_private.has_platform_role(array['admin']));
create policy users_platform_update on identity.users
  for update using (app_private.has_platform_role(array['admin']))
  with check (app_private.has_platform_role(array['admin']));
create policy users_platform_delete on identity.users
  for delete using (app_private.has_platform_role(array['admin']));

alter table identity.profiles enable row level security;
alter table identity.profiles force row level security;
create policy profiles_self_select on identity.profiles
  for select using (app_private.can_access_user(user_id));
create policy profiles_self_insert on identity.profiles
  for insert with check (
    user_id = app_private.current_user_id()
    and app_private.can_access_user(user_id)
  );
create policy profiles_self_update on identity.profiles
  for update using (
    user_id = app_private.current_user_id()
    and app_private.can_access_user(user_id)
  )
  with check (
    user_id = app_private.current_user_id()
    and app_private.can_access_user(user_id)
  );
create policy profiles_platform_delete on identity.profiles
  for delete using (app_private.has_platform_role(array['admin']));

create policy tenants_members_select on identity.tenants
  for select using (
    app_private.has_active_membership(id, null)
    or app_private.has_platform_role(array['admin', 'operator', 'auditor'])
  );
create policy tenants_platform_insert on identity.tenants
  for insert with check (app_private.has_platform_role(array['admin']));
create policy tenants_platform_update on identity.tenants
  for update using (app_private.has_platform_role(array['admin']))
  with check (app_private.has_platform_role(array['admin']));
create policy tenants_platform_delete on identity.tenants
  for delete using (app_private.has_platform_role(array['admin']));

alter table identity.shop_memberships enable row level security;
alter table identity.shop_memberships force row level security;
create policy memberships_self_or_managers on identity.shop_memberships
  for select using (
    (
      user_id = app_private.current_user_id()
      and tenant_id = app_private.current_tenant_id()
      and status = 'active'
    )
    or app_private.has_active_membership(tenant_id, array['owner', 'admin'])
    or app_private.has_platform_role(array['admin', 'operator', 'auditor'])
  );
create policy memberships_managers_insert on identity.shop_memberships
  for insert with check (app_private.can_manage_tenant(tenant_id));
create policy memberships_managers_update on identity.shop_memberships
  for update using (app_private.can_manage_tenant(tenant_id))
  with check (app_private.can_manage_tenant(tenant_id));
create policy memberships_managers_delete on identity.shop_memberships
  for delete using (app_private.can_manage_tenant(tenant_id));

alter table identity.platform_roles enable row level security;
alter table identity.platform_roles force row level security;
create policy platform_roles_self_select on identity.platform_roles
  for select using (
    app_private.can_access_user(user_id)
    or app_private.has_platform_role(array['admin', 'auditor'])
  );
create policy platform_roles_admin_insert on identity.platform_roles
  for insert with check (app_private.has_platform_role(array['admin']));
create policy platform_roles_admin_update on identity.platform_roles
  for update using (app_private.has_platform_role(array['admin']))
  with check (app_private.has_platform_role(array['admin']));
create policy platform_roles_admin_delete on identity.platform_roles
  for delete using (app_private.has_platform_role(array['admin']));

create policy carts_read on commerce.carts
  for select using (
    app_private.has_active_membership(tenant_id, null)
    or app_private.has_machine_tenant_access(tenant_id)
  );
create policy carts_machine_or_managers_insert on commerce.carts
  for insert with check (
    app_private.can_manage_tenant(tenant_id)
    or app_private.has_machine_tenant_access(tenant_id)
  );
create policy carts_machine_or_managers_update on commerce.carts
  for update using (
    app_private.can_manage_tenant(tenant_id)
    or app_private.has_machine_tenant_access(tenant_id)
  )
  with check (
    app_private.can_manage_tenant(tenant_id)
    or app_private.has_machine_tenant_access(tenant_id)
  );
create policy carts_machine_or_managers_delete on commerce.carts
  for delete using (
    app_private.can_manage_tenant(tenant_id)
    or app_private.has_machine_tenant_access(tenant_id)
  );

create policy cart_lines_read on commerce.cart_lines
  for select using (
    app_private.has_active_membership(tenant_id, null)
    or app_private.has_machine_tenant_access(tenant_id)
  );
create policy cart_lines_machine_or_managers_insert on commerce.cart_lines
  for insert with check (
    app_private.can_manage_tenant(tenant_id)
    or app_private.has_machine_tenant_access(tenant_id)
  );
create policy cart_lines_machine_or_managers_update on commerce.cart_lines
  for update using (
    app_private.can_manage_tenant(tenant_id)
    or app_private.has_machine_tenant_access(tenant_id)
  )
  with check (
    app_private.can_manage_tenant(tenant_id)
    or app_private.has_machine_tenant_access(tenant_id)
  );
create policy cart_lines_machine_or_managers_delete on commerce.cart_lines
  for delete using (
    app_private.can_manage_tenant(tenant_id)
    or app_private.has_machine_tenant_access(tenant_id)
  );

create policy quotes_read on commerce.quotes
  for select using (
    app_private.has_active_membership(tenant_id, null)
    or app_private.has_machine_tenant_access(tenant_id)
  );
create policy quotes_machine_or_managers_insert on commerce.quotes
  for insert with check (
    app_private.can_manage_tenant(tenant_id)
    or app_private.has_machine_tenant_access(tenant_id)
  );
create policy quotes_machine_or_managers_update on commerce.quotes
  for update using (
    app_private.can_manage_tenant(tenant_id)
    or app_private.has_machine_tenant_access(tenant_id)
  )
  with check (
    app_private.can_manage_tenant(tenant_id)
    or app_private.has_machine_tenant_access(tenant_id)
  );
create policy quotes_machine_or_managers_delete on commerce.quotes
  for delete using (
    app_private.can_manage_tenant(tenant_id)
    or app_private.has_machine_tenant_access(tenant_id)
  );

create policy quote_lines_read on commerce.quote_lines
  for select using (
    app_private.has_active_membership(tenant_id, null)
    or app_private.has_machine_tenant_access(tenant_id)
  );
create policy quote_lines_machine_or_managers_insert on commerce.quote_lines
  for insert with check (
    app_private.can_manage_tenant(tenant_id)
    or app_private.has_machine_tenant_access(tenant_id)
  );
create policy quote_lines_machine_or_managers_update on commerce.quote_lines
  for update using (
    app_private.can_manage_tenant(tenant_id)
    or app_private.has_machine_tenant_access(tenant_id)
  )
  with check (
    app_private.can_manage_tenant(tenant_id)
    or app_private.has_machine_tenant_access(tenant_id)
  );
create policy quote_lines_machine_or_managers_delete on commerce.quote_lines
  for delete using (
    app_private.can_manage_tenant(tenant_id)
    or app_private.has_machine_tenant_access(tenant_id)
  );

create policy checkout_sessions_read on payments.checkout_sessions
  for select using (
    app_private.has_active_membership(tenant_id, null)
    or app_private.has_machine_tenant_access(tenant_id)
  );
create policy checkout_sessions_machine_or_managers_insert on payments.checkout_sessions
  for insert with check (
    app_private.can_manage_tenant(tenant_id)
    or app_private.has_machine_tenant_access(tenant_id)
  );
create policy checkout_sessions_machine_or_managers_update on payments.checkout_sessions
  for update using (
    app_private.can_manage_tenant(tenant_id)
    or app_private.has_machine_tenant_access(tenant_id)
  )
  with check (
    app_private.can_manage_tenant(tenant_id)
    or app_private.has_machine_tenant_access(tenant_id)
  );
create policy checkout_sessions_machine_or_managers_delete on payments.checkout_sessions
  for delete using (
    app_private.can_manage_tenant(tenant_id)
    or app_private.has_machine_tenant_access(tenant_id)
  );

create policy ledger_entries_read on ledger.ledger_entries
  for select using (
    app_private.has_active_membership(tenant_id, null)
    or app_private.has_machine_tenant_access(tenant_id)
  );
create policy ledger_entries_machine_insert on ledger.ledger_entries
  for insert with check (app_private.has_machine_tenant_access(tenant_id));
create policy ledger_entries_admin_delete on ledger.ledger_entries
  for delete using (app_private.has_platform_role(array['admin']));

create policy inbox_events_read on integration.inbox_events
  for select using (
    (tenant_id is not null and app_private.has_machine_tenant_access(tenant_id))
    or app_private.has_webhook_intake_access()
    or app_private.has_platform_role(array['admin', 'operator', 'auditor'])
  );
create policy inbox_events_webhook_insert on integration.inbox_events
  for insert with check (
    app_private.has_webhook_intake_access()
    and tenant_id is null
    and state = 'unresolved'
  );
create policy inbox_events_webhook_update on integration.inbox_events
  for update using (
    app_private.has_webhook_intake_access()
    and (
      tenant_id is null
      or tenant_id = app_private.current_tenant_id()
    )
  )
  with check (
    app_private.has_webhook_intake_access()
    and (
      (
        state = 'attributed'
        and tenant_id = app_private.current_tenant_id()
        and app_private.is_active_tenant(tenant_id)
      )
      or (
        state = 'quarantined'
        and tenant_id is null
        and quarantine_reason is not null
      )
    )
  );
create policy inbox_events_admin_delete on integration.inbox_events
  for delete using (app_private.has_platform_role(array['admin']));

alter table catalog.shops enable row level security;
alter table catalog.shops force row level security;
create policy shops_public_read on catalog.shops
  for select using (
    app_private.is_public_shop(tenant_id, status)
    or app_private.has_active_membership(tenant_id, null)
  );
create policy shops_managers_insert on catalog.shops
  for insert with check (app_private.can_manage_tenant(tenant_id));
create policy shops_managers_update on catalog.shops
  for update using (app_private.can_manage_tenant(tenant_id))
  with check (app_private.can_manage_tenant(tenant_id));
create policy shops_managers_delete on catalog.shops
  for delete using (app_private.can_manage_tenant(tenant_id));

alter table catalog.categories enable row level security;
alter table catalog.categories force row level security;
create policy categories_members_select on catalog.categories
  for select using (app_private.has_active_membership(tenant_id, null));
create policy categories_managers_insert on catalog.categories
  for insert with check (app_private.can_manage_tenant(tenant_id));
create policy categories_managers_update on catalog.categories
  for update using (app_private.can_manage_tenant(tenant_id))
  with check (app_private.can_manage_tenant(tenant_id));
create policy categories_managers_delete on catalog.categories
  for delete using (app_private.can_manage_tenant(tenant_id));

alter table catalog.products enable row level security;
alter table catalog.products force row level security;
create policy products_public_read on catalog.products
  for select using (
    app_private.is_public_product(tenant_id, status)
    or app_private.has_active_membership(tenant_id, null)
  );
create policy products_managers_insert on catalog.products
  for insert with check (app_private.can_manage_tenant(tenant_id));
create policy products_managers_update on catalog.products
  for update using (app_private.can_manage_tenant(tenant_id))
  with check (app_private.can_manage_tenant(tenant_id));
create policy products_managers_delete on catalog.products
  for delete using (app_private.can_manage_tenant(tenant_id));

alter table catalog.variants enable row level security;
alter table catalog.variants force row level security;
create policy variants_public_read on catalog.variants
  for select using (
    app_private.is_public_variant(tenant_id, product_id, status)
    or app_private.has_active_membership(tenant_id, null)
  );
create policy variants_managers_insert on catalog.variants
  for insert with check (app_private.can_manage_tenant(tenant_id));
create policy variants_managers_update on catalog.variants
  for update using (app_private.can_manage_tenant(tenant_id))
  with check (app_private.can_manage_tenant(tenant_id));
create policy variants_managers_delete on catalog.variants
  for delete using (app_private.can_manage_tenant(tenant_id));

alter table catalog.inventory enable row level security;
alter table catalog.inventory force row level security;
create policy inventory_members_select on catalog.inventory
  for select using (app_private.has_active_membership(tenant_id, null));
create policy inventory_managers_insert on catalog.inventory
  for insert with check (app_private.can_manage_tenant(tenant_id));
create policy inventory_managers_update on catalog.inventory
  for update using (app_private.can_manage_tenant(tenant_id))
  with check (app_private.can_manage_tenant(tenant_id));
create policy inventory_managers_delete on catalog.inventory
  for delete using (app_private.can_manage_tenant(tenant_id));

alter table policy.shop_policies enable row level security;
alter table policy.shop_policies force row level security;
create policy shop_policies_members_select on policy.shop_policies
  for select using (app_private.has_active_membership(tenant_id, null));
create policy shop_policies_managers_insert on policy.shop_policies
  for insert with check (app_private.can_manage_tenant(tenant_id));
create policy shop_policies_managers_update on policy.shop_policies
  for update using (app_private.can_manage_tenant(tenant_id))
  with check (app_private.can_manage_tenant(tenant_id));
create policy shop_policies_managers_delete on policy.shop_policies
  for delete using (app_private.can_manage_tenant(tenant_id));

alter table policy.approvals enable row level security;
alter table policy.approvals force row level security;
create policy approvals_members_select on policy.approvals
  for select using (app_private.has_active_membership(tenant_id, null));
create policy approvals_managers_insert on policy.approvals
  for insert with check (app_private.can_manage_tenant(tenant_id));
create policy approvals_managers_update on policy.approvals
  for update using (app_private.can_manage_tenant(tenant_id))
  with check (app_private.can_manage_tenant(tenant_id));
create policy approvals_managers_delete on policy.approvals
  for delete using (app_private.can_manage_tenant(tenant_id));

alter table conversation.conversations enable row level security;
alter table conversation.conversations force row level security;
create policy conversations_user_or_members_select on conversation.conversations
  for select
  using (
    (
      user_id = app_private.current_user_id()
      and tenant_id = app_private.current_tenant_id()
      and app_private.can_access_user(user_id)
      and app_private.is_active_tenant(tenant_id)
    )
    or app_private.has_active_membership(tenant_id, null)
  );
create policy conversations_managers_insert on conversation.conversations
  for insert with check (app_private.can_manage_tenant(tenant_id));
create policy conversations_managers_update on conversation.conversations
  for update using (app_private.can_manage_tenant(tenant_id))
  with check (app_private.can_manage_tenant(tenant_id));
create policy conversations_managers_delete on conversation.conversations
  for delete using (app_private.can_manage_tenant(tenant_id));

alter table conversation.messages enable row level security;
alter table conversation.messages force row level security;
create policy messages_user_or_members_select on conversation.messages
  for select using (app_private.can_access_conversation(tenant_id, conversation_id));
create policy messages_managers_insert on conversation.messages
  for insert with check (app_private.can_manage_tenant(tenant_id));
create policy messages_managers_update on conversation.messages
  for update using (app_private.can_manage_tenant(tenant_id))
  with check (app_private.can_manage_tenant(tenant_id));
create policy messages_managers_delete on conversation.messages
  for delete using (app_private.can_manage_tenant(tenant_id));

alter table recovery.consents enable row level security;
alter table recovery.consents force row level security;
create policy consents_user_or_members_select on recovery.consents
  for select
  using (
    (
      user_id = app_private.current_user_id()
      and tenant_id = app_private.current_tenant_id()
      and app_private.can_access_user(user_id)
      and app_private.is_active_tenant(tenant_id)
    )
    or app_private.has_active_membership(tenant_id, null)
  );
create policy consents_managers_insert on recovery.consents
  for insert with check (app_private.can_manage_tenant(tenant_id));
create policy consents_managers_update on recovery.consents
  for update using (app_private.can_manage_tenant(tenant_id))
  with check (app_private.can_manage_tenant(tenant_id));
create policy consents_managers_delete on recovery.consents
  for delete using (app_private.can_manage_tenant(tenant_id));

alter table recovery.attempts enable row level security;
alter table recovery.attempts force row level security;
create policy attempts_user_or_members_select on recovery.attempts
  for select
  using (
    (
      user_id = app_private.current_user_id()
      and tenant_id = app_private.current_tenant_id()
      and app_private.can_access_user(user_id)
      and app_private.is_active_tenant(tenant_id)
    )
    or app_private.has_active_membership(tenant_id, null)
  );
create policy attempts_managers_insert on recovery.attempts
  for insert with check (app_private.can_manage_tenant(tenant_id));
create policy attempts_managers_update on recovery.attempts
  for update using (app_private.can_manage_tenant(tenant_id))
  with check (app_private.can_manage_tenant(tenant_id));
create policy attempts_managers_delete on recovery.attempts
  for delete using (app_private.can_manage_tenant(tenant_id));

alter table operations.kill_switches enable row level security;
alter table operations.kill_switches force row level security;
create policy kill_switches_read on operations.kill_switches
  for select using (
    app_private.has_platform_role(array['admin', 'operator', 'auditor'])
    or (
      tenant_id is not null
      and app_private.has_active_membership(tenant_id, array['owner', 'admin'])
    )
  );
create policy kill_switches_admin_insert on operations.kill_switches
  for insert with check (app_private.has_platform_role(array['admin']));
create policy kill_switches_admin_update on operations.kill_switches
  for update using (app_private.has_platform_role(array['admin']))
  with check (app_private.has_platform_role(array['admin']));
create policy kill_switches_admin_delete on operations.kill_switches
  for delete using (app_private.has_platform_role(array['admin']));
