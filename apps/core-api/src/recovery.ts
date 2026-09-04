import { assertQuoteFactsFresh, getQuote } from '@charter/commerce';
import { isFactHash, getMerchant } from '@charter/catalog';
import { formatInr, money } from '@charter/domain-shared';
import { createAgentMailSender, type MailSender } from '@charter/notify';
import {
  paymentTruthCopy,
  reconcileCheckoutWithProvider,
  type CheckoutSession,
  type ReconciliationEvidence,
} from '@charter/payments';
import {
  attemptFailedPayRecovery,
  createRecoveryStore,
  type RecoveryAttempt,
  type RecoveryStore,
} from '@charter/recovery';
import type { AppConfig } from '@charter/config';
import type { RazorpayClient } from '@charter/razorpay';
import type { MoneyPersist } from './persist.js';
import type { TenantRepository } from './tenant/repository.js';

export type RecoveryRuntime = {
  store: RecoveryStore;
  mailer: MailSender | null;
  enabled: boolean;
  afterFailedPay(session: CheckoutSession): Promise<RecoveryAttempt>;
};

function toRecoveryEvidence(evidence: ReconciliationEvidence) {
  return {
    reconciledAt: evidence.reconciledAt,
    quoteId: evidence.quoteId,
    orderId: evidence.orderId,
    orderStatus: evidence.orderStatus,
    outcome: evidence.outcome,
    paymentAttempts: evidence.paymentAttempts,
  };
}

export function createRecoveryRuntime(
  config: AppConfig,
  fetchImpl: typeof fetch = fetch,
  repository: TenantRepository,
  razorpay: Pick<RazorpayClient, 'getOrder' | 'listOrderPayments'> | null = null,
  persist?: Pick<
    MoneyPersist,
    | 'persistWebhookTransition'
    | 'recordReconciliation'
    | 'saveCheckout'
    | 'loadQuote'
    | 'loadCheckout'
    | 'assertQuoteFacts'
  >,
): RecoveryRuntime {
  const store = createRecoveryStore();
  const mailer =
    config.AGENTMAIL_API_KEY && config.AGENTMAIL_INBOX
      ? createAgentMailSender(
          { apiKey: config.AGENTMAIL_API_KEY, inbox: config.AGENTMAIL_INBOX },
          fetchImpl,
        )
      : null;
  return {
    store,
    mailer,
    enabled: Boolean(mailer?.configured),
    async afterFailedPay(session) {
      const durable = persist?.loadCheckout
        ? await persist.loadCheckout(session.tenantId, session.id)
        : undefined;
      const live = durable ?? session;
      const quote =
        getQuote(live.quoteId) ?? (await persist?.loadQuote(live.tenantId, live.quoteId));
      if (live.status === 'FAILED_PROVISIONAL') {
        if (!quote || !isFactHash(quote.factHash)) {
          throw new Error('FACTS_UNPINNED');
        }
        if (getMerchant(quote.tenantId)) {
          assertQuoteFactsFresh(quote);
        }
        await persist?.assertQuoteFacts(quote);
      }
      return attemptFailedPayRecovery({
        repository,
        mailer,
        reconcile: async (recoverySession) => {
          if (!razorpay) {
            const unavailable: ReconciliationEvidence = {
              reconciledAt: new Date().toISOString(),
              quoteId: recoverySession.quoteId,
              orderId: recoverySession.razorpayOrderId,
              orderStatus: 'unknown',
              outcome: 'provider_unavailable',
              paymentAttempts: [],
            };
            await persist?.recordReconciliation(live, unavailable);
            throw new Error('RECONCILIATION_PROVIDER_UNAVAILABLE');
          }
          const evidence = await reconcileCheckoutWithProvider(
            {
              quoteId: recoverySession.quoteId,
              razorpayOrderId: recoverySession.razorpayOrderId,
              amountMinor: live.amountMinor,
              currency: live.currency,
            },
            razorpay,
          );
          if (evidence.outcome === 'captured') {
            const capturedPayment = evidence.paymentAttempts.find(
              (attempt) => attempt.status === 'captured',
            );
            live.paymentId = capturedPayment?.paymentId ?? live.paymentId;
            live.status = 'SETTLED';
            live.providerStatus = 'captured';
            live.copy = paymentTruthCopy('SETTLED');
            if (persist) {
              await persist.persistWebhookTransition(live);
            }
          } else if (evidence.outcome === 'refunded') {
            const refundedPayment = evidence.paymentAttempts.find(
              (attempt) => attempt.status === 'refunded',
            );
            live.paymentId = refundedPayment?.paymentId ?? live.paymentId;
            live.status = 'RECONCILING';
            live.providerStatus = 'refunded';
            live.copy = paymentTruthCopy('RECONCILING');
            if (persist) {
              await persist.persistWebhookTransition(live);
            }
          } else if (evidence.outcome === 'authorized') {
            const authorizedPayment = evidence.paymentAttempts.find(
              (attempt) => attempt.status === 'authorized',
            );
            live.paymentId = authorizedPayment?.paymentId ?? live.paymentId;
            live.status = 'CAPTURE_PENDING';
            live.providerStatus = 'authorized';
            live.copy = paymentTruthCopy('CAPTURE_PENDING');
            if (persist) {
              await persist.persistWebhookTransition(live);
            }
          } else if (evidence.outcome !== 'same_order_retry_safe') {
            live.status = 'RECONCILING';
            live.copy = paymentTruthCopy('RECONCILING');
            await persist?.saveCheckout(live);
          }
          await persist?.recordReconciliation(live, evidence);
          if (evidence.outcome === 'provider_unavailable') {
            throw new Error('RECONCILIATION_PROVIDER_UNAVAILABLE');
          }
          if (evidence.outcome === 'identity_mismatch') {
            throw new Error('RECONCILIATION_PROVIDER_IDENTITY_MISMATCH');
          }
          return toRecoveryEvidence(evidence);
        },
        session: live,
        merchant: quote?.merchant ?? 'Charter',
        totalDisplay: quote?.totalDisplay ?? formatInr(money(live.amountMinor)),
      });
    },
  };
}
