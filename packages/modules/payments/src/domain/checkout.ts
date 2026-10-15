import { randomUUID } from 'node:crypto';
import {
  assertQuoteFactsFresh,
  bindQuote,
  getQuote,
  settleQuote,
  type FrozenQuote,
} from '@charter/commerce';
import {
  buildRazorpayReceipt,
  RazorpayClient,
  ulid,
  verifyCheckoutSignature,
  type RazorpayPayment,
} from '@charter/razorpay';
import { reconcileCheckoutWithProvider } from './reconcile.js';
import { paymentTruthCopy } from './truth.js';

export type CheckoutStatus =
  'CREATED' | 'VERIFYING' | 'RECONCILING' | 'CAPTURE_PENDING' | 'SETTLED' | 'FAILED_PROVISIONAL';

export type CheckoutSession = {
  id: string;
  tenantId: string;
  quoteId: string;
  receipt: string;
  razorpayOrderId: string;
  amountMinor: number;
  currency: 'INR';
  status: CheckoutStatus;
  paymentId: string | null;
  providerStatus: string | null;
  copy: string;
};

const sessions = new Map<string, CheckoutSession>();
type StartedCheckout = { session: CheckoutSession; quote: FrozenQuote };
// One start per quote at a time: a double Pay click must not mint two Orders.
const inflight = new Map<string, Promise<StartedCheckout>>();

export function resetCheckouts(): void {
  sessions.clear();
  inflight.clear();
}

export function hydrateCheckout(session: CheckoutSession): CheckoutSession {
  const copy = { ...session };
  sessions.set(copy.id, copy);
  return copy;
}

export function getCheckout(id: string): CheckoutSession | undefined {
  return sessions.get(id);
}

export function listCheckouts(): CheckoutSession[] {
  return [...sessions.values()].reverse();
}

export function findCheckoutByQuote(quoteId: string): CheckoutSession | undefined {
  return [...sessions.values()].find((row) => row.quoteId === quoteId);
}

export function findCheckoutByOrderId(orderId: string): CheckoutSession | undefined {
  return [...sessions.values()].find((row) => row.razorpayOrderId === orderId);
}

function settleFromEvidence(
  session: CheckoutSession,
  evidence: Awaited<ReturnType<typeof reconcileCheckoutWithProvider>>,
): CheckoutSession {
  const capturedPayment = evidence.paymentAttempts.find((attempt) => attempt.status === 'captured');
  session.paymentId = capturedPayment?.paymentId ?? session.paymentId;
  session.status = 'SETTLED';
  session.providerStatus = 'captured';
  session.copy = paymentTruthCopy('SETTLED');
  settleQuote(session.quoteId);
  return session;
}

function markRefundedFromEvidence(
  session: CheckoutSession,
  evidence: Awaited<ReturnType<typeof reconcileCheckoutWithProvider>>,
): void {
  const refundedPayment = evidence.paymentAttempts.find((attempt) => attempt.status === 'refunded');
  session.paymentId = refundedPayment?.paymentId ?? session.paymentId;
  session.status = 'RECONCILING';
  session.providerStatus = 'refunded';
  session.copy = paymentTruthCopy('RECONCILING');
}

export function startCheckout(quoteId: string, client: RazorpayClient): Promise<StartedCheckout> {
  const running = inflight.get(quoteId);
  if (running) {
    return running;
  }
  const started = startCheckoutOnce(quoteId, client).finally(() => {
    inflight.delete(quoteId);
  });
  inflight.set(quoteId, started);
  return started;
}

async function startCheckoutOnce(
  quoteId: string,
  client: RazorpayClient,
): Promise<StartedCheckout> {
  const quote = getQuote(quoteId);
  if (!quote) {
    throw new Error('QUOTE_NOT_FOUND');
  }
  assertQuoteFactsFresh(quote);
  if (quote.boundCheckoutId) {
    const bound = getCheckout(quote.boundCheckoutId) ?? findCheckoutByQuote(quoteId);
    if (!bound || bound.id !== quote.boundCheckoutId) {
      throw new Error('BOUND_CHECKOUT_NOT_HYDRATED');
    }
  }
  const existing = findCheckoutByQuote(quoteId);
  if (existing?.status === 'SETTLED') {
    throw new Error('QUOTE_ALREADY_PAID');
  }
  if (existing?.status === 'CAPTURE_PENDING') {
    // Razorpay auto-captures a few seconds after the handler fires, so ask the
    // provider again instead of leaving the buyer on "Awaiting capture" forever.
    const evidence = await reconcileCheckoutWithProvider(existing, client);
    if (evidence.outcome === 'captured') {
      return { session: settleFromEvidence(existing, evidence), quote };
    }
    if (evidence.outcome === 'refunded') {
      markRefundedFromEvidence(existing, evidence);
      throw new Error('PAYMENT_REFUNDED');
    }
    throw new Error('PAYMENT_AUTHORIZED');
  }
  if (existing) {
    if (existing.status === 'FAILED_PROVISIONAL' || existing.status === 'RECONCILING') {
      const evidence = await reconcileCheckoutWithProvider(existing, client);
      if (evidence.outcome === 'captured') {
        return { session: settleFromEvidence(existing, evidence), quote };
      }
      if (evidence.outcome === 'refunded') {
        markRefundedFromEvidence(existing, evidence);
        throw new Error('PAYMENT_REFUNDED');
      }
      if (evidence.outcome === 'authorized') {
        const authorizedPayment = evidence.paymentAttempts.find(
          (attempt) => attempt.status === 'authorized',
        );
        existing.paymentId = authorizedPayment?.paymentId ?? existing.paymentId;
        existing.status = 'CAPTURE_PENDING';
        existing.providerStatus = 'authorized';
        existing.copy = paymentTruthCopy('CAPTURE_PENDING');
        throw new Error('PAYMENT_AUTHORIZED');
      }
      if (evidence.outcome !== 'same_order_retry_safe') {
        existing.status = 'RECONCILING';
        existing.copy = paymentTruthCopy('RECONCILING');
        throw new Error(
          evidence.outcome === 'identity_mismatch'
            ? 'RECONCILIATION_PROVIDER_IDENTITY_MISMATCH'
            : 'RECONCILIATION_REQUIRED',
        );
      }
      existing.status = 'CREATED';
      existing.copy =
        'Retry on the same Razorpay Order after authoritative reconciliation. Frozen quote unchanged.';
    }
    return { session: existing, quote };
  }
  if (quote.totalMinor < 0n || quote.totalMinor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('QUOTE_TOTAL_MINOR_UNSAFE');
  }
  const amountMinor = Number(quote.totalMinor);
  const receipt = buildRazorpayReceipt(ulid());
  const order = await client.createOrder({
    amountMinor,
    currency: 'INR',
    receipt,
  });
  const session: CheckoutSession = {
    id: randomUUID(),
    tenantId: quote.tenantId,
    quoteId: quote.id,
    receipt: order.receipt,
    razorpayOrderId: order.id,
    amountMinor,
    currency: 'INR',
    status: 'CREATED',
    paymentId: null,
    providerStatus: order.status,
    copy: paymentTruthCopy('CREATED'),
  };
  // Bind first: if another checkout already owns the quote, no orphan session
  // is left behind in listCheckouts or the operator views.
  bindQuote(quote.id, session.id);
  sessions.set(session.id, session);
  return { session, quote };
}

function projectPayment(session: CheckoutSession, payment: RazorpayPayment): CheckoutSession {
  if (payment.status === 'refunded') {
    session.paymentId = payment.id;
    session.providerStatus = 'refunded';
    session.status = 'RECONCILING';
    session.copy = paymentTruthCopy('RECONCILING');
    return session;
  }
  if (session.status === 'SETTLED') {
    return session;
  }
  if (
    session.status === 'CAPTURE_PENDING' &&
    payment.status !== 'authorized' &&
    payment.status !== 'captured'
  ) {
    return session;
  }
  session.paymentId = payment.id;
  session.providerStatus = payment.status;
  if (payment.status === 'captured') {
    settleQuote(session.quoteId);
    session.status = 'SETTLED';
    session.copy = paymentTruthCopy('SETTLED');
    return session;
  }
  if (payment.status === 'authorized') {
    session.status = 'CAPTURE_PENDING';
    session.copy = paymentTruthCopy('CAPTURE_PENDING');
    return session;
  }
  if (payment.status === 'failed') {
    session.status = 'FAILED_PROVISIONAL';
    session.copy = paymentTruthCopy('FAILED_PROVISIONAL');
    return session;
  }
  session.status = 'RECONCILING';
  session.copy = paymentTruthCopy('RECONCILING');
  return session;
}

export async function applyCheckoutCallback(
  checkoutId: string,
  input: { orderId: string; paymentId: string; signature: string },
  client: RazorpayClient,
  keySecret: string,
): Promise<CheckoutSession> {
  const session = sessions.get(checkoutId);
  if (!session) {
    throw new Error('CHECKOUT_NOT_FOUND');
  }
  if (input.orderId !== session.razorpayOrderId) {
    throw new Error('ORDER_MISMATCH');
  }
  const ok = verifyCheckoutSignature({
    orderId: input.orderId,
    paymentId: input.paymentId,
    signature: input.signature,
    secret: keySecret,
  });
  if (!ok) {
    throw new Error('INVALID_CHECKOUT_SIGNATURE');
  }
  if (session.status === 'SETTLED') {
    return session;
  }
  session.status = 'VERIFYING';
  let payment: RazorpayPayment;
  try {
    payment = await client.getPayment(input.paymentId);
  } catch (error) {
    // The signature proves a payment exists; never strand the session on
    // VERIFYING (which would relaunch a paid Order). Reconcile on the next look.
    if (session.status === 'VERIFYING') {
      session.paymentId = input.paymentId;
      session.status = 'RECONCILING';
      session.copy = paymentTruthCopy('RECONCILING');
    }
    throw error;
  }
  return projectPayment(session, payment);
}

export function applyProviderPayment(
  orderId: string,
  payment: Pick<RazorpayPayment, 'id' | 'status'>,
): CheckoutSession | undefined {
  const session = findCheckoutByOrderId(orderId);
  if (!session) {
    return undefined;
  }
  if (session.status === 'SETTLED' && payment.status !== 'refunded') {
    return session;
  }
  return projectPayment(session, {
    id: payment.id,
    order_id: orderId,
    amount: session.amountMinor,
    currency: session.currency,
    status: payment.status,
  });
}

export type RazorpayWebhookBody = {
  event?: string;
  payload?: {
    payment?: { entity?: { id?: string; order_id?: string; status?: string } };
  };
};

export function applyRazorpayWebhook(body: RazorpayWebhookBody): CheckoutSession | undefined {
  const payment = body.payload?.payment?.entity;
  if (!payment?.order_id || !payment.id || !payment.status) {
    return undefined;
  }
  return applyProviderPayment(payment.order_id, {
    id: payment.id,
    status: payment.status,
  });
}

export function markCheckoutDismissed(checkoutId: string): CheckoutSession {
  const session = sessions.get(checkoutId);
  if (!session) {
    throw new Error('CHECKOUT_NOT_FOUND');
  }
  // Closing the modal only says the buyer left the window. An authorized,
  // captured, or reconciling payment must not be downgraded to a failed one.
  if (session.status !== 'CREATED' && session.status !== 'VERIFYING') {
    return session;
  }
  session.status = 'FAILED_PROVISIONAL';
  session.copy = paymentTruthCopy('FAILED_PROVISIONAL');
  return session;
}
