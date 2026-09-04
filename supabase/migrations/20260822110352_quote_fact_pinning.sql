-- Quote fact pinning and initial product-create audit.

alter table commerce.quotes
  add column catalog_version integer not null default 1 check (catalog_version > 0),
  add column policy_version integer not null default 1 check (policy_version > 0),
  add column fact_hash text not null default '' check (char_length(fact_hash) <= 128);

alter table catalog.product_audits
  drop constraint if exists product_audits_version_before_check;

alter table catalog.product_audits
  add constraint product_audits_version_before_check check (version_before >= 0);
