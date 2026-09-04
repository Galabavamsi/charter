alter table conversation.conversations
  add column revision bigint not null default 0
  check (revision >= 0);
