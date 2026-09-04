alter table payments.reconciliation_snapshots
  drop constraint if exists reconciliation_snapshots_outcome_check;

alter table payments.reconciliation_snapshots
  add constraint reconciliation_snapshots_outcome_check
    check (
      outcome in (
        'same_order_retry_safe',
        'authorized',
        'captured',
        'refunded',
        'provider_unavailable',
        'identity_mismatch',
        'unknown_attempts'
      )
    );

alter table recovery.attempts
  add column if not exists reconciliation_outcome text,
  add column if not exists reconciled_at timestamptz,
  add column if not exists reconciliation_correlation_id text;

alter table recovery.attempts
  drop constraint if exists attempts_reconciliation_outcome_check;

alter table recovery.attempts
  add constraint attempts_reconciliation_outcome_check
    check (
      reconciliation_outcome is null
      or reconciliation_outcome in (
        'same_order_retry_safe',
        'authorized',
        'captured',
        'refunded',
        'provider_unavailable',
        'identity_mismatch',
        'unknown_attempts'
      )
    );

create table commerce.offer_redemptions (
  tenant_id text not null,
  quote_id uuid not null,
  offer_id text not null check (length(btrim(offer_id)) between 1 and 80),
  discount_minor bigint not null check (discount_minor >= 0),
  created_at timestamptz not null default now(),
  primary key (tenant_id, quote_id, offer_id),
  foreign key (tenant_id, quote_id)
    references commerce.quotes (tenant_id, id) on delete cascade
);

alter table commerce.offer_redemptions enable row level security;
alter table commerce.offer_redemptions force row level security;

create policy offer_redemptions_read on commerce.offer_redemptions
  for select using (
    app_private.has_active_membership(tenant_id, null)
    or app_private.has_machine_tenant_access(tenant_id)
  );
create policy offer_redemptions_machine_insert on commerce.offer_redemptions
  for insert with check (app_private.has_machine_tenant_access(tenant_id));

grant select, insert, update, delete on table commerce.offer_redemptions to charter_app;
