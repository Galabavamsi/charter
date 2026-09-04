alter table policy.approvals
  alter column cart_id drop not null,
  alter column from_sku drop not null,
  alter column to_sku drop not null,
  add column if not exists resource_id text,
  add column if not exists resource_version integer;

update policy.approvals
set resource_id = coalesce(resource_id, cart_id::text, id::text)
where resource_id is null;

alter table policy.approvals
  drop constraint if exists approvals_kind_shape_chk;

alter table policy.approvals
  add constraint approvals_kind_shape_chk check (
    (
      kind = 'cart_spend'
      and cart_id is not null
      and from_sku is not null
      and to_sku is not null
    )
    or (
      kind <> 'cart_spend'
      and resource_id is not null
    )
  );

drop index if exists policy.approvals_one_pending_per_cart_idx;

create unique index if not exists approvals_one_pending_cart_spend_idx
  on policy.approvals (tenant_id, cart_id)
  where status = 'pending' and kind = 'cart_spend';

create unique index if not exists approvals_one_pending_typed_resource_idx
  on policy.approvals (tenant_id, kind, resource_id)
  where status = 'pending'
    and kind <> 'cart_spend'
    and resource_id is not null;
