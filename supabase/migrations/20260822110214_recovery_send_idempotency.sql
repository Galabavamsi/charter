alter table recovery.attempts
  add column purpose text,
  add column channel text;

update recovery.attempts attempt
set purpose = consent.purpose,
    channel = consent.channel
from recovery.consents consent
where consent.tenant_id = attempt.tenant_id
  and consent.id = attempt.consent_id;

alter table recovery.attempts
  alter column purpose set not null,
  alter column channel set not null,
  add constraint attempts_purpose_check
    check (purpose = 'payment_recovery'),
  add constraint attempts_channel_check
    check (channel = 'email');

alter table recovery.consents
  add constraint consents_attempt_dimensions_key
    unique (tenant_id, id, purpose, channel);

alter table recovery.attempts
  add constraint attempts_consent_dimensions_fkey
    foreign key (tenant_id, consent_id, purpose, channel)
    references recovery.consents (tenant_id, id, purpose, channel);

drop index recovery.recovery_attempts_checkout_active_uidx;

create unique index recovery_attempts_checkout_active_uidx
  on recovery.attempts (tenant_id, checkout_id, consent_id, purpose, channel)
  where status in ('pending', 'sent', 'delivered');

create index recovery_attempts_retry_policy_idx
  on recovery.attempts (
    tenant_id,
    checkout_id,
    consent_id,
    purpose,
    channel,
    attempt_number desc
  )
  where status <> 'suppressed';
