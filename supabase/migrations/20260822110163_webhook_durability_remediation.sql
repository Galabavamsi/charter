drop policy checkout_sessions_webhook_resolve on payments.checkout_sessions;

create function app_private.resolve_webhook_checkout_by_order(target_order_id text)
returns table(tenant_id text, checkout_id uuid)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select checkout_session.tenant_id, checkout_session.id
  from payments.checkout_sessions checkout_session
  where current_setting('app.service_context', true) = 'webhook'
    and nullif(current_setting('app.user_id', true), '') is null
    and nullif(current_setting('app.tenant_id', true), '') is null
    and target_order_id is not null
    and length(target_order_id) between 1 and 255
    and target_order_id = btrim(target_order_id)
    and checkout_session.razorpay_order_id = target_order_id
$$;

revoke all on function app_private.resolve_webhook_checkout_by_order(text) from public;
