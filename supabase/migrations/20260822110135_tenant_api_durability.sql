alter table identity.shop_memberships
  drop constraint if exists shop_memberships_role_check;

alter table identity.shop_memberships
  add constraint shop_memberships_role_check
  check (role in ('owner', 'admin', 'catalog', 'support', 'finance', 'viewer'));

alter table commerce.carts
  add column user_id uuid references identity.users (id);

create index carts_user_tenant_idx
  on commerce.carts (user_id, tenant_id, created_at desc)
  where user_id is not null;

alter table conversation.conversations
  add column state jsonb not null default '{}'::jsonb
  check (jsonb_typeof(state) = 'object');

create table recovery.checkout_consents (
  tenant_id text not null references identity.tenants (id) on delete cascade,
  checkout_id uuid not null,
  consent_id uuid not null,
  user_id uuid not null references identity.users (id),
  created_at timestamptz not null default now(),
  primary key (tenant_id, checkout_id),
  foreign key (tenant_id, checkout_id)
    references payments.checkout_sessions (tenant_id, id) on delete cascade,
  foreign key (tenant_id, consent_id)
    references recovery.consents (tenant_id, id) on delete cascade
);

create index checkout_consents_user_idx
  on recovery.checkout_consents (user_id, created_at desc);

create unique index checkout_sessions_order_uidx
  on payments.checkout_sessions (razorpay_order_id);

create function app_private.sync_auth_user(
  target_user_id uuid,
  target_email text
)
returns text
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  normalized_email text;
  resulting_status text;
begin
  if target_user_id is null or target_user_id <> app_private.current_user_id() then
    raise exception 'AUTH_SUBJECT_MISMATCH';
  end if;

  normalized_email := lower(btrim(target_email));
  if normalized_email = '' or position('@' in normalized_email) <= 1 then
    normalized_email := null;
  end if;
  if normalized_email is not null and exists (
    select 1
    from identity.users application_user
    where application_user.email = normalized_email
      and application_user.id <> target_user_id
  ) then
    normalized_email := null;
  end if;

  insert into identity.users (
    id,
    email,
    status,
    synthetic,
    auth_synced_at
  )
  values (
    target_user_id,
    normalized_email,
    'active',
    false,
    now()
  )
  on conflict (id) do update
  set email = excluded.email,
      auth_synced_at = now(),
      updated_at = now()
  where identity.users.status <> 'deleted';

  select application_user.status
  into resulting_status
  from identity.users application_user
  where application_user.id = target_user_id;

  return resulting_status;
end
$$;

create function app_private.provision_shop(
  target_tenant_id text,
  target_slug text,
  target_name text,
  target_blurb text
)
returns text
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  actor_id uuid := app_private.current_user_id();
begin
  if actor_id is null or not exists (
    select 1
    from identity.users application_user
    where application_user.id = actor_id
      and application_user.status = 'active'
  ) then
    raise exception 'AUTH_REQUIRED';
  end if;
  if target_tenant_id !~ '^[a-z0-9][a-z0-9-]{0,62}$' then
    raise exception 'TENANT_ID_INVALID';
  end if;
  if target_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' then
    raise exception 'SHOP_SLUG_INVALID';
  end if;
  if length(btrim(target_name)) not between 2 and 120 then
    raise exception 'SHOP_NAME_REQUIRED';
  end if;

  insert into identity.tenants (id, label, synthetic, status)
  values (target_tenant_id, btrim(target_name), false, 'active');

  insert into identity.shop_memberships (
    tenant_id,
    user_id,
    role,
    status,
    joined_at
  )
  values (
    target_tenant_id,
    actor_id,
    'owner',
    'active',
    now()
  );

  insert into catalog.shops (
    tenant_id,
    slug,
    name,
    label,
    blurb,
    currency,
    status,
    synthetic
  )
  values (
    target_tenant_id,
    target_slug,
    btrim(target_name),
    btrim(target_name),
    coalesce(nullif(btrim(target_blurb), ''), 'A shop on Charter.'),
    'INR',
    'draft',
    false
  );

  insert into policy.shop_policies (
    tenant_id,
    currency,
    hard_cap_minor,
    autonomous_cap_minor,
    forbidden_materials,
    rules,
    updated_by
  )
  values (
    target_tenant_id,
    'INR',
    500000,
    250000,
    '{}',
    '{"offers":[]}'::jsonb,
    actor_id
  );

  return target_tenant_id;
end
$$;

create function app_private.can_access_cart(
  target_tenant_id text,
  target_cart_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select
    app_private.current_tenant_id() = target_tenant_id
    and exists (
      select 1
      from commerce.carts cart
      join identity.users application_user
        on application_user.id = cart.user_id
       and application_user.status = 'active'
      join identity.tenants tenant
        on tenant.id = cart.tenant_id
       and tenant.status = 'active'
      where cart.tenant_id = target_tenant_id
        and cart.id = target_cart_id
        and cart.user_id = app_private.current_user_id()
    )
$$;

create function app_private.can_access_quote(
  target_tenant_id text,
  target_quote_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select exists (
    select 1
    from commerce.quotes quote
    where quote.tenant_id = target_tenant_id
      and quote.id = target_quote_id
      and app_private.can_access_cart(quote.tenant_id, quote.cart_id)
  )
$$;

create function app_private.can_access_checkout(
  target_tenant_id text,
  target_checkout_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select exists (
    select 1
    from payments.checkout_sessions checkout_session
    where checkout_session.tenant_id = target_tenant_id
      and checkout_session.id = target_checkout_id
      and app_private.can_access_quote(
        checkout_session.tenant_id,
        checkout_session.quote_id
      )
  )
$$;

create function app_private.is_checkout_killed(target_tenant_id text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select exists (
    select 1
    from operations.kill_switches kill_switch
    where kill_switch.feature = 'checkout'
      and kill_switch.enabled = true
      and (
        (kill_switch.scope = 'global' and kill_switch.tenant_id is null)
        or (
          kill_switch.scope = 'tenant'
          and kill_switch.tenant_id = target_tenant_id
        )
      )
  )
$$;

revoke all on function app_private.sync_auth_user(uuid, text) from public;
revoke all on function app_private.provision_shop(text, text, text, text) from public;
grant execute on function app_private.sync_auth_user(uuid, text) to public;
grant execute on function app_private.provision_shop(text, text, text, text) to public;
grant execute on function app_private.can_access_cart(text, uuid) to public;
grant execute on function app_private.can_access_quote(text, uuid) to public;
grant execute on function app_private.can_access_checkout(text, uuid) to public;
grant execute on function app_private.is_checkout_killed(text) to public;

drop policy carts_read on commerce.carts;
create policy carts_read on commerce.carts
  for select using (
    app_private.can_access_cart(tenant_id, id)
    or app_private.has_active_membership(tenant_id, null)
    or app_private.has_machine_tenant_access(tenant_id)
  );

drop policy quotes_read on commerce.quotes;
create policy quotes_read on commerce.quotes
  for select using (
    app_private.can_access_quote(tenant_id, id)
    or app_private.has_active_membership(tenant_id, null)
    or app_private.has_machine_tenant_access(tenant_id)
  );

drop policy checkout_sessions_read on payments.checkout_sessions;
create policy checkout_sessions_read on payments.checkout_sessions
  for select using (
    app_private.can_access_checkout(tenant_id, id)
    or app_private.has_active_membership(tenant_id, null)
    or app_private.has_machine_tenant_access(tenant_id)
  );

create policy checkout_sessions_webhook_resolve on payments.checkout_sessions
  for select using (app_private.has_webhook_intake_access());

create policy shop_policies_machine_read on policy.shop_policies
  for select using (app_private.has_machine_tenant_access(tenant_id));

create policy approvals_machine_select on policy.approvals
  for select using (app_private.has_machine_tenant_access(tenant_id));

create policy approvals_machine_insert on policy.approvals
  for insert with check (app_private.has_machine_tenant_access(tenant_id));

create policy approvals_machine_update on policy.approvals
  for update using (app_private.has_machine_tenant_access(tenant_id))
  with check (app_private.has_machine_tenant_access(tenant_id));

create policy consents_machine_select on recovery.consents
  for select using (app_private.has_machine_tenant_access(tenant_id));

create policy consents_machine_insert on recovery.consents
  for insert with check (app_private.has_machine_tenant_access(tenant_id));

create policy consents_machine_update on recovery.consents
  for update using (app_private.has_machine_tenant_access(tenant_id))
  with check (app_private.has_machine_tenant_access(tenant_id));

create policy attempts_machine_select on recovery.attempts
  for select using (app_private.has_machine_tenant_access(tenant_id));

create policy attempts_machine_insert on recovery.attempts
  for insert with check (app_private.has_machine_tenant_access(tenant_id));

create policy conversations_user_insert on conversation.conversations
  for insert with check (
    user_id = app_private.current_user_id()
    and tenant_id = app_private.current_tenant_id()
    and app_private.is_active_tenant(tenant_id)
  );

create policy conversations_user_update on conversation.conversations
  for update using (
    user_id = app_private.current_user_id()
    and tenant_id = app_private.current_tenant_id()
  )
  with check (
    user_id = app_private.current_user_id()
    and tenant_id = app_private.current_tenant_id()
  );

create policy messages_conversation_user_insert on conversation.messages
  for insert with check (
    app_private.can_access_conversation(tenant_id, conversation_id)
    and (
      (actor = 'user' and user_id = app_private.current_user_id())
      or (actor in ('assistant', 'system') and user_id is null)
    )
  );

create policy consents_user_insert on recovery.consents
  for insert with check (
    user_id = app_private.current_user_id()
    and tenant_id = app_private.current_tenant_id()
    and app_private.is_active_tenant(tenant_id)
  );

create policy attempts_user_insert on recovery.attempts
  for insert with check (
    user_id = app_private.current_user_id()
    and tenant_id = app_private.current_tenant_id()
    and app_private.is_active_tenant(tenant_id)
  );

alter table recovery.checkout_consents enable row level security;
alter table recovery.checkout_consents force row level security;

create policy checkout_consents_user_or_members_select on recovery.checkout_consents
  for select using (
    (
      user_id = app_private.current_user_id()
      and tenant_id = app_private.current_tenant_id()
    )
    or app_private.has_active_membership(tenant_id, null)
  );

create policy checkout_consents_user_insert on recovery.checkout_consents
  for insert with check (
    user_id = app_private.current_user_id()
    and tenant_id = app_private.current_tenant_id()
    and app_private.can_access_checkout(tenant_id, checkout_id)
  );

create policy checkout_consents_managers_delete on recovery.checkout_consents
  for delete using (app_private.can_manage_tenant(tenant_id));

create policy checkout_consents_machine_select on recovery.checkout_consents
  for select using (app_private.has_machine_tenant_access(tenant_id));

create policy checkout_consents_machine_insert on recovery.checkout_consents
  for insert with check (app_private.has_machine_tenant_access(tenant_id));

create policy checkout_consents_machine_update on recovery.checkout_consents
  for update using (app_private.has_machine_tenant_access(tenant_id))
  with check (app_private.has_machine_tenant_access(tenant_id));
