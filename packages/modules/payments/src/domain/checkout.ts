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

export function resetCheckouts(): void {
  sessions.clear();
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

export async function startCheckout(
  quoteId: string,
  client: RazorpayClient,
): Promise<{ session: CheckoutSession; quote: FrozenQuote }> {
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
    throw new Error('PAYMENT_AUTHORIZED');
  }
  if (existing) {
    if (existing.status === 'FAILED_PROVISIONAL' || existing.status === 'RECONCILING') {
      const evidence = await reconcileCheckoutWithProvider(existing, client);
      if (evidence.outcome === 'captured') {
        const capturedPayment = evidence.paymentAttempts.find(
          (attempt) => attempt.status === 'captured',
        );
        existing.paymentId = capturedPayment?.paymentId ?? existing.paymentId;
        existing.status = 'SETTLED';
        existing.providerStatus = 'captured';
        existing.copy = paymentTruthCopy('SETTLED');
        settleQuote(existing.quoteId);
        return { session: existing, quote };
      }
      if (evidence.outcome === 'refunded') {
        const refundedPayment = evidence.paymentAttempts.find(
          (attempt) => attempt.status === 'refunded',
        );
        existing.paymentId = refundedPayment?.paymentId ?? existing.paymentId;
        existing.status = 'RECONCILING';
        existing.providerStatus = 'refunded';
        existing.copy = paymentTruthCopy('RECONCILING');
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
  sessions.set(session.id, session);
  bindQuote(quote.id, session.id);
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
  session.status = 'VERIFYING';
  const payment = await client.getPayment(input.paymentId);
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
  if (session.status === 'SETTLED') {
    return session;
  }
  session.status = 'FAILED_PROVISIONAL';
  session.copy = paymentTruthCopy('FAILED_PROVISIONAL');
  return session;
}
