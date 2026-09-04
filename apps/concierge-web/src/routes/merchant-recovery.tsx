import { useMemo, useState } from 'react';
import { useApi } from '../account';
import {
  FormNotice,
  MerchantEmpty,
  MerchantError,
  MerchantLoading,
  MerchantPageHeader,
  RecordStatus,
} from '../merchant-components';
import { useMerchantShop } from '../merchant-context';
import {
  merchantCommandKey,
  merchantErrorMessage,
  useMerchantPagedResource,
  type MerchantRecoveryRecord,
} from '../merchant-api';

const BLOCKED_REASON: Record<string, string> = {
  PAYMENT_CAPTURED: 'Payment already captured',
  PAYMENT_AUTHORIZED: 'Awaiting capture. Recovery is paused.',
  RECONCILIATION_REQUIRED: 'Payment not confirmed. Reconcile before sending.',
  QUOTE_CHANGED: 'Frozen quote facts changed. Recovery is blocked.',
  CHECKOUT_KILLED: 'Checkout or recovery is stopped',
  SUPPRESSED: 'Contact is suppressed',
  CONSENT_REVOKED: 'Payment-recovery email consent was revoked',
  NO_CONSENT: 'No granted payment-recovery email consent',
  NOT_FAILED_PROVISIONAL: 'Checkout is not in a recoverable failed state',
  ALREADY_PENDING: 'Recovery email is already reserved',
  ALREADY_SENT: 'Recovery email was already sent',
  RETRY_LIMIT_REACHED: 'Recovery attempt limit reached',
  NOT_CONFIGURED: 'Recovery email provider is unavailable',
  PAYMENT_REFUNDED: 'Payment was refunded. Recovery is blocked.',
};

function blockedCopy(reason: string | null): string {
  return reason ? (BLOCKED_REASON[reason] ?? `Recovery blocked: ${reason}`) : 'Eligible to send';
}

export function MerchantRecoveryPage() {
  const api = useApi();
  const shop = useMerchantShop();
  const [status, setStatus] = useState('');
  const [sent, setSent] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const path = useMemo(() => {
    const query = new URLSearchParams({ limit: '50' });
    if (status) query.set('status', status);
    return `/v1/merchant/shops/${shop.tenantId}/recovery?${query.toString()}`;
  }, [shop.tenantId, status]);
  const resource = useMerchantPagedResource<MerchantRecoveryRecord>(
    path,
    (record) => record.checkoutId,
  );

  async function send(checkoutId: string) {
    setSending(checkoutId);
    setNotice(null);
    try {
      await api(`/v1/merchant/shops/${shop.tenantId}/recovery/${checkoutId}/send`, {
        method: 'POST',
        headers: { 'idempotency-key': merchantCommandKey('recovery-email') },
      });
      setSent((current) => new Set(current).add(checkoutId));
      setNotice({ kind: 'success', text: 'Recovery email sent' });
    } catch (cause) {
      setNotice({ kind: 'error', text: merchantErrorMessage(cause) });
    } finally {
      setSending(null);
    }
  }

  return (
    <section className="merchant-page merchant-recovery-page">
      <MerchantPageHeader
        eyebrow="Consent-gated queue"
        title="Recovery"
        description="One checkout at a time. Every send rechecks capture, reconciliation, consent, suppression, and stop state."
        actions={
          <label className="merchant-compact-field">
            Queue status
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">All recoverable records</option>
              <option value="FAILED_PROVISIONAL">Failed / unresolved</option>
              <option value="RECONCILING">Reconciling</option>
              <option value="sent">Sent</option>
              <option value="suppressed">Suppressed</option>
            </select>
          </label>
        }
      />
      <p className="merchant-guardrail">
        There is no bulk send. Charter sends only with durable payment_recovery/email consent and an
        atomic reservation.
      </p>
      {notice ? <FormNotice kind={notice.kind}>{notice.text}</FormNotice> : null}
      {resource.loading ? <MerchantLoading label="Loading recovery queue" /> : null}
      {resource.error ? <MerchantError error={resource.error} retry={resource.reload} /> : null}
      {resource.loadMoreError ? (
        <MerchantError error={resource.loadMoreError} retry={resource.loadMore} />
      ) : null}
      {!resource.loading && !resource.error && resource.items.length === 0 ? (
        <MerchantEmpty
          title="No recovery work"
          body="No failed or unresolved checkouts match this queue filter."
        />
      ) : null}
      {resource.items.length > 0 ? (
        <div className="recovery-records" role="list" aria-label="Recovery queue">
          {resource.items.map((record) => {
            const wasSent = sent.has(record.checkoutId);
            return (
              <article key={record.checkoutId} className="recovery-record" role="listitem">
                <header>
                  <div>
                    <p className="record-id">{record.razorpayOrderId}</p>
                    <strong>{record.amountDisplay}</strong>
                  </div>
                  <RecordStatus
                    label={wasSent ? 'Sent' : record.checkoutStatus}
                    tone={
                      wasSent
                        ? 'ok'
                        : record.canSend
                          ? 'warning'
                          : record.stopStatus === 'captured'
                            ? 'ok'
                            : 'danger'
                    }
                  />
                </header>
                <dl>
                  <div>
                    <dt>Reconciliation</dt>
                    <dd>{record.reconciliationStatus}</dd>
                  </div>
                  <div>
                    <dt>Consent</dt>
                    <dd>{record.consentStatus}</dd>
                  </div>
                  <div>
                    <dt>Send</dt>
                    <dd>{wasSent ? 'sent' : record.sendStatus}</dd>
                  </div>
                  <div>
                    <dt>Stop state</dt>
                    <dd>{record.stopStatus}</dd>
                  </div>
                </dl>
                {!record.canSend ? (
                  <p className="recovery-blocked">
                    <strong>Blocked</strong>
                    <span>{blockedCopy(record.blockedReason)}</span>
                  </p>
                ) : null}
                {record.canSend && !wasSent ? (
                  <button
                    type="button"
                    disabled={sending === record.checkoutId}
                    onClick={() => void send(record.checkoutId)}
                  >
                    {sending === record.checkoutId ? 'Reserving send…' : 'Send recovery email'}
                  </button>
                ) : null}
                <small>
                  Updated{' '}
                  <time dateTime={record.updatedAt}>
                    {new Date(record.updatedAt).toLocaleString('en-IN')}
                  </time>
                </small>
              </article>
            );
          })}
        </div>
      ) : null}
      {resource.nextCursor ? (
        <button
          type="button"
          onClick={() => void resource.loadMore()}
          disabled={resource.loadingMore}
        >
          {resource.loadingMore ? 'Loading more recovery…' : 'Load more recovery'}
        </button>
      ) : null}
    </section>
  );
}
