create schema identity;
create schema commerce;
create schema payments;
create schema ledger;
create schema integration;

create table identity.tenants (
  id text primary key,
  label text not null check (length(btrim(label)) > 0),
  synthetic boolean not null default true,
  created_at timestamptz not null default now(),
  unique (id, created_at)
);

create table commerce.carts (
  id uuid primary key,
  tenant_id text not null references identity.tenants (id),
  version integer not null check (version > 0),
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create index carts_tenant_created_idx on commerce.carts (tenant_id, created_at desc);

create table commerce.cart_lines (
  tenant_id text not null,
  cart_id uuid not null,
  sku text not null check (length(btrim(sku)) > 0),
  quantity integer not null check (quantity > 0),
  primary key (tenant_id, cart_id, sku),
  foreign key (tenant_id, cart_id) references commerce.carts (tenant_id, id) on delete cascade
);

create table commerce.quotes (
  id uuid primary key,
  tenant_id text not null references identity.tenants (id),
  cart_id uuid not null,
  cart_version integer not null check (cart_version > 0),
  status text not null check (status in ('FROZEN', 'BOUND', 'SETTLED')),
  bound_checkout_id uuid,
  currency text not null check (currency = 'INR'),
  subtotal_minor bigint not null check (subtotal_minor >= 0),
  discount_minor bigint not null check (discount_minor >= 0),
  total_minor bigint not null check (total_minor >= 0),
  delivery_by date not null,
  merchant text not null check (length(btrim(merchant)) > 0),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, cart_id) references commerce.carts (tenant_id, id),
  check (discount_minor <= subtotal_minor),
  check (total_minor = subtotal_minor - discount_minor),
  check (
    (status = 'FROZEN' and bound_checkout_id is null)
    or (status in ('BOUND', 'SETTLED') and bound_checkout_id is not null)
  )
);

create unique index quotes_bound_checkout_uidx
  on commerce.quotes (tenant_id, bound_checkout_id)
  where bound_checkout_id is not null;
create index quotes_tenant_created_idx on commerce.quotes (tenant_id, created_at desc);
create index quotes_cart_idx on commerce.quotes (tenant_id, cart_id, cart_version);

create table commerce.quote_lines (
  tenant_id text not null,
  quote_id uuid not null,
  sku text not null check (length(btrim(sku)) > 0),
  title text not null check (length(btrim(title)) > 0),
  quantity integer not null check (quantity > 0),
  unit_minor bigint not null check (unit_minor >= 0),
  line_minor bigint not null check (line_minor >= 0),
  primary key (tenant_id, quote_id, sku),
  foreign key (tenant_id, quote_id) references commerce.quotes (tenant_id, id) on delete cascade,
  check (line_minor = unit_minor * quantity)
);

create table payments.checkout_sessions (
  id uuid primary key,
  tenant_id text not null references identity.tenants (id),
  quote_id uuid not null,
  receipt text not null check (length(btrim(receipt)) > 0),
  razorpay_order_id text not null check (length(btrim(razorpay_order_id)) > 0),
  amount_minor bigint not null check (amount_minor >= 0),
  currency text not null check (currency = 'INR'),
  status text not null check (
    status in (
      'CREATED',
      'VERIFYING',
      'RECONCILING',
      'CAPTURE_PENDING',
      'SETTLED',
      'FAILED_PROVISIONAL'
    )
  ),
  payment_id text,
  provider_status text,
  copy text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, razorpay_order_id),
  unique (tenant_id, quote_id),
  foreign key (tenant_id, quote_id) references commerce.quotes (tenant_id, id)
);

create index checkout_sessions_status_idx
  on payments.checkout_sessions (tenant_id, status, updated_at desc);

create table integration.inbox_events (
  tenant_id text references identity.tenants (id),
  provider text not null check (length(btrim(provider)) > 0),
  event_id text not null check (length(btrim(event_id)) > 0),
  event_type text not null check (length(btrim(event_type)) > 0),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  state text not null default 'unresolved'
    check (state in ('unresolved', 'attributed', 'quarantined')),
  order_id text,
  quarantine_reason text,
  resolved_at timestamptz,
  received_at timestamptz not null default now(),
  primary key (provider, event_id),
  check (
    (
      state = 'unresolved'
      and tenant_id is null
      and quarantine_reason is null
      and resolved_at is null
    )
    or (
      state = 'attributed'
      and tenant_id is not null
      and quarantine_reason is null
      and resolved_at is not null
    )
    or (
      state = 'quarantined'
      and tenant_id is null
      and quarantine_reason is not null
      and resolved_at is not null
    )
  )
);

create index inbox_events_received_idx
  on integration.inbox_events (state, received_at desc);
create index inbox_events_tenant_idx
  on integration.inbox_events (tenant_id, received_at desc)
  where tenant_id is not null;

create table ledger.ledger_entries (
  id uuid primary key,
  tenant_id text not null references identity.tenants (id),
  checkout_id uuid not null,
  quote_id uuid not null,
  kind text not null check (length(btrim(kind)) > 0),
  amount_minor bigint not null check (amount_minor >= 0),
  currency text not null check (currency = 'INR'),
  provider_payment_id text,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, checkout_id, kind),
  foreign key (tenant_id, checkout_id)
    references payments.checkout_sessions (tenant_id, id),
  foreign key (tenant_id, quote_id)
    references commerce.quotes (tenant_id, id)
);

create index ledger_entries_tenant_created_idx
  on ledger.ledger_entries (tenant_id, created_at desc);
create index ledger_entries_payment_idx
  on ledger.ledger_entries (tenant_id, provider_payment_id)
  where provider_payment_id is not null;

create function public.charter_set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger checkout_sessions_updated_at
  before update on payments.checkout_sessions
  for each row execute function public.charter_set_updated_at();

alter table identity.tenants enable row level security;
alter table identity.tenants force row level security;

alter table commerce.carts enable row level security;
alter table commerce.carts force row level security;

alter table commerce.cart_lines enable row level security;
alter table commerce.cart_lines force row level security;

alter table commerce.quotes enable row level security;
alter table commerce.quotes force row level security;

alter table commerce.quote_lines enable row level security;
alter table commerce.quote_lines force row level security;

alter table payments.checkout_sessions enable row level security;
alter table payments.checkout_sessions force row level security;

alter table integration.inbox_events enable row level security;
alter table integration.inbox_events force row level security;

alter table ledger.ledger_entries enable row level security;
alter table ledger.ledger_entries force row level security;
