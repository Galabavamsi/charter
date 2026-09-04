import type { CheckoutStatus } from './checkout.js';

export type PaymentTruthLabel =
  | 'Payment not confirmed'
  | 'Reconciling'
  | 'Awaiting capture'
  | 'Captured'
  | 'Awaiting payment'
  | 'Verifying';

export function paymentTruth(status: string): {
  label: PaymentTruthLabel;
  paid: boolean;
  fulfillmentReady: boolean;
} {
  switch (status) {
    case 'SETTLED':
      return { label: 'Captured', paid: true, fulfillmentReady: true };
    case 'CAPTURE_PENDING':
      return { label: 'Awaiting capture', paid: false, fulfillmentReady: false };
    case 'RECONCILING':
      return { label: 'Reconciling', paid: false, fulfillmentReady: false };
    case 'VERIFYING':
      return { label: 'Verifying', paid: false, fulfillmentReady: false };
    case 'CREATED':
      return { label: 'Awaiting payment', paid: false, fulfillmentReady: false };
    default:
      return { label: 'Payment not confirmed', paid: false, fulfillmentReady: false };
  }
}

export function paymentTruthCopy(status: CheckoutStatus): string {
  switch (status) {
    case 'SETTLED':
      return 'Payment captured. One Charter order; inventory will commit once.';
    case 'CAPTURE_PENDING':
      return 'Awaiting capture. Authorized payment is not fulfilled and cannot be retried.';
    case 'RECONCILING':
    case 'VERIFYING':
      return 'Payment not confirmed. Reconciling provider state.';
    case 'FAILED_PROVISIONAL':
      return 'Payment not confirmed. Reconciling before any retry. Do not assume nothing was charged.';
    case 'CREATED':
      return 'Confirm this locked total, then pay in Razorpay Checkout. Fulfillment waits for capture.';
  }
}
