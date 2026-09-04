import type { RazorpayClient, RazorpayOrder, RazorpayPayment } from '@charter/razorpay';
import type { CheckoutSession } from './checkout.js';

export type ReconciliationOutcome =
  | 'same_order_retry_safe'
  | 'authorized'
  | 'captured'
  | 'refunded'
  | 'provider_unavailable'
  | 'identity_mismatch'
  | 'unknown_attempts';

export type ReconciliationEvidence = {
  reconciledAt: string;
  quoteId: string;
  orderId: string;
  orderStatus: string;
  outcome: ReconciliationOutcome;
  paymentAttempts: Array<{ paymentId: string; status: string }>;
};

export type ReconciliationReader = Pick<RazorpayClient, 'getOrder' | 'listOrderPayments'>;

const TERMINAL_FAILURE = new Set(['failed']);

export function classifyReconciliation(input: {
  session: Pick<CheckoutSession, 'quoteId' | 'razorpayOrderId' | 'amountMinor' | 'currency'>;
  order: RazorpayOrder;
  payments: RazorpayPayment[];
}): Omit<ReconciliationEvidence, 'reconciledAt'> {
  if (
    input.order.id !== input.session.razorpayOrderId ||
    input.order.amount !== input.session.amountMinor ||
    input.order.currency !== input.session.currency ||
    input.payments.some((payment) => payment.order_id !== input.order.id)
  ) {
    return {
      quoteId: input.session.quoteId,
      orderId: input.order.id,
      orderStatus: input.order.status,
      outcome: 'identity_mismatch',
      paymentAttempts: input.payments.map((payment) => ({
        paymentId: payment.id,
        status: payment.status,
      })),
    };
  }

  const paymentAttempts = input.payments.map((payment) => ({
    paymentId: payment.id,
    status: payment.status,
  }));
  if (paymentAttempts.some((attempt) => attempt.status === 'captured')) {
    return {
      quoteId: input.session.quoteId,
      orderId: input.order.id,
      orderStatus: input.order.status,
      outcome: 'captured',
      paymentAttempts,
    };
  }
  if (paymentAttempts.some((attempt) => attempt.status === 'refunded')) {
    return {
      quoteId: input.session.quoteId,
      orderId: input.order.id,
      orderStatus: input.order.status,
      outcome: 'refunded',
      paymentAttempts,
    };
  }
  if (paymentAttempts.some((attempt) => attempt.status === 'authorized')) {
    return {
      quoteId: input.session.quoteId,
      orderId: input.order.id,
      orderStatus: input.order.status,
      outcome: 'authorized',
      paymentAttempts,
    };
  }
  if (
    paymentAttempts.length === 0 ||
    paymentAttempts.some((attempt) => !TERMINAL_FAILURE.has(attempt.status))
  ) {
    return {
      quoteId: input.session.quoteId,
      orderId: input.order.id,
      orderStatus: input.order.status,
      outcome: 'unknown_attempts',
      paymentAttempts,
    };
  }
  return {
    quoteId: input.session.quoteId,
    orderId: input.order.id,
    orderStatus: input.order.status,
    outcome: 'same_order_retry_safe',
    paymentAttempts,
  };
}

export async function reconcileCheckoutWithProvider(
  session: Pick<CheckoutSession, 'quoteId' | 'razorpayOrderId' | 'amountMinor' | 'currency'>,
  razorpay: ReconciliationReader,
): Promise<ReconciliationEvidence> {
  let order: RazorpayOrder;
  let payments: RazorpayPayment[];
  try {
    [order, payments] = await Promise.all([
      razorpay.getOrder(session.razorpayOrderId),
      razorpay.listOrderPayments(session.razorpayOrderId),
    ]);
  } catch {
    return {
      reconciledAt: new Date().toISOString(),
      quoteId: session.quoteId,
      orderId: session.razorpayOrderId,
      orderStatus: 'unknown',
      outcome: 'provider_unavailable',
      paymentAttempts: [],
    };
  }
  return {
    reconciledAt: new Date().toISOString(),
    ...classifyReconciliation({ session, order, payments }),
  };
}
