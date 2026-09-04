-- Quote fact pins must be sha256 hex. Drop the empty default that allowed unpinned rows.

update commerce.quotes
set fact_hash = repeat('0', 64)
where fact_hash is null
   or fact_hash !~ '^[a-f0-9]{64}$';

alter table commerce.quotes
  alter column fact_hash drop default;

alter table commerce.quotes
  drop constraint if exists quotes_fact_hash_check;

alter table commerce.quotes
  add constraint quotes_fact_hash_check check (fact_hash ~ '^[a-f0-9]{64}$');
