import { describe, expect, it } from 'vitest';
import { paymentTruth } from './truth.js';

describe('payment truth copy', () => {
  it('never labels unresolved or authorized checkouts as paid', () => {
    expect(paymentTruth('FAILED_PROVISIONAL')).toEqual({
      label: 'Payment not confirmed',
      paid: false,
      fulfillmentReady: false,
    });
    expect(paymentTruth('RECONCILING')).toEqual({
      label: 'Reconciling',
      paid: false,
      fulfillmentReady: false,
    });
    expect(paymentTruth('CAPTURE_PENDING')).toEqual({
      label: 'Awaiting capture',
      paid: false,
      fulfillmentReady: false,
    });
    expect(paymentTruth('SETTLED')).toEqual({
      label: 'Captured',
      paid: true,
      fulfillmentReady: true,
    });
  });
});
