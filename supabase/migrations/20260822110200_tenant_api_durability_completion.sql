update recovery.attempts
set status = 'failed',
    failure_code = coalesce(failure_code, 'RECOVERY_RESERVATION_MIGRATED'),
    completed_at = coalesce(completed_at, now())
where status = 'queued';

alter table recovery.attempts
  alter column status set default 'pending';

alter table recovery.attempts
  drop constraint if exists attempts_status_check,
  drop constraint if exists attempts_check;

alter table recovery.attempts
  add constraint attempts_status_check
    check (status in ('pending', 'sent', 'delivered', 'failed', 'suppressed')),
  add constraint attempts_completion_check
    check (
      (status = 'pending' and completed_at is null)
      or (status <> 'pending' and completed_at is not null)
    );

with ranked_successes as (
  select id,
         row_number() over (
           partition by tenant_id, checkout_id, consent_id
           order by attempted_at, id
         ) as success_number
  from recovery.attempts
  where status in ('sent', 'delivered')
    and checkout_id is not null
)
update recovery.attempts attempt
set status = 'suppressed',
    failure_code = coalesce(attempt.failure_code, 'RECOVERY_DUPLICATE_MIGRATED'),
    completed_at = coalesce(attempt.completed_at, now())
from ranked_successes ranked
where attempt.id = ranked.id
  and ranked.success_number > 1;

create unique index recovery_attempts_checkout_active_uidx
  on recovery.attempts (tenant_id, checkout_id, consent_id)
  where status in ('pending', 'sent', 'delivered');

create policy attempts_machine_update on recovery.attempts
  for update using (app_private.has_machine_tenant_access(tenant_id))
  with check (app_private.has_machine_tenant_access(tenant_id));

create policy consents_user_update on recovery.consents
  for update using (
    user_id = app_private.current_user_id()
    and tenant_id = app_private.current_tenant_id()
  )
  with check (
    user_id = app_private.current_user_id()
    and tenant_id = app_private.current_tenant_id()
    and status = 'granted'
  );

create policy checkout_consents_user_update on recovery.checkout_consents
  for update using (
    user_id = app_private.current_user_id()
    and tenant_id = app_private.current_tenant_id()
    and app_private.can_access_checkout(tenant_id, checkout_id)
  )
  with check (
    user_id = app_private.current_user_id()
    and tenant_id = app_private.current_tenant_id()
    and app_private.can_access_checkout(tenant_id, checkout_id)
  );

create policy variants_machine_read on catalog.variants
  for select using (app_private.has_machine_tenant_access(tenant_id));
