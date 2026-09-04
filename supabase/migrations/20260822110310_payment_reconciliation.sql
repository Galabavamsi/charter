create table payments.payment_transitions (
  id uuid primary key,
  tenant_id text not null references identity.tenants (id) on delete cascade,
  checkout_id uuid not null,
  source text not null check (
    source in (
      'webhook',
      'provider_read',
      'callback',
      'dismiss',
      'recovery',
      'checkout_start',
      'persist'
    )
  ),
  provider_reference text not null check (length(btrim(provider_reference)) > 0),
  observed_provider_status text not null check (length(btrim(observed_provider_status)) > 0),
  from_checkout_status text,
  to_checkout_status text not null,
  applied boolean not null,
  occurred_at timestamptz not null,
  observed_at timestamptz not null default now(),
  correlation_id text not null check (length(btrim(correlation_id)) > 0),
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (
    tenant_id,
    checkout_id,
    source,
    provider_reference,
    observed_provider_status
  ),
  foreign key (tenant_id, checkout_id)
    references payments.checkout_sessions (tenant_id, id) on delete cascade
);

create index payment_transitions_checkout_observed_idx
  on payments.payment_transitions (tenant_id, checkout_id, observed_at, id);

create table payments.reconciliation_snapshots (
  tenant_id text not null,
  checkout_id uuid not null,
  quote_id uuid not null,
  order_id text not null check (length(btrim(order_id)) > 0),
  order_status text not null,
  outcome text not null check (
    outcome in (
      'same_order_retry_safe',
      'authorized',
      'captured',
      'provider_unavailable',
      'identity_mismatch',
      'unknown_attempts'
    )
  ),
  payment_attempts jsonb not null check (jsonb_typeof(payment_attempts) = 'array'),
  reconciled_at timestamptz not null,
  correlation_id text not null check (length(btrim(correlation_id)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, checkout_id),
  foreign key (tenant_id, checkout_id)
    references payments.checkout_sessions (tenant_id, id) on delete cascade,
  foreign key (tenant_id, quote_id)
    references commerce.quotes (tenant_id, id)
);

create trigger reconciliation_snapshots_updated_at
  before update on payments.reconciliation_snapshots
  for each row execute function public.charter_set_updated_at();

alter table payments.payment_transitions enable row level security;
alter table payments.payment_transitions force row level security;
alter table payments.reconciliation_snapshots enable row level security;
alter table payments.reconciliation_snapshots force row level security;

create policy payment_transitions_read on payments.payment_transitions
  for select using (
    app_private.has_active_membership(tenant_id, null)
    or app_private.has_machine_tenant_access(tenant_id)
  );
create policy payment_transitions_machine_insert on payments.payment_transitions
  for insert with check (app_private.has_machine_tenant_access(tenant_id));

create policy reconciliation_snapshots_read on payments.reconciliation_snapshots
  for select using (
    app_private.has_active_membership(tenant_id, null)
    or app_private.has_machine_tenant_access(tenant_id)
  );
create policy reconciliation_snapshots_machine_insert on payments.reconciliation_snapshots
  for insert with check (app_private.has_machine_tenant_access(tenant_id));
create policy reconciliation_snapshots_machine_update on payments.reconciliation_snapshots
  for update using (app_private.has_machine_tenant_access(tenant_id))
  with check (app_private.has_machine_tenant_access(tenant_id));
