import { describe, expect, it } from 'vitest';
import { buildFailedPayRecoveryCopy } from './copy.js';

describe('failed-pay recovery copy', () => {
  const copy = buildFailedPayRecoveryCopy({
    merchant: 'Northstar Travel Coffee',
    totalDisplay: '₹2,347.00',
    quoteId: 'quote_1',
    orderId: 'order_1',
  });

  it('states payment is not confirmed and not assumed uncharged', () => {
    expect(copy.subject).toContain('payment not confirmed');
    expect(copy.text).toContain('Payment is not confirmed');
    expect(copy.text).toContain('Do not assume nothing was charged.');
    expect(copy.text).toContain('same Razorpay Order');
    expect(copy.text).toContain('₹2,347.00');
  });

  it('does not claim a zero charge or leak provider secrets', () => {
    expect(copy.text).not.toMatch(/(?<!Do not assume )nothing was charged/);
    expect(copy.text.toLowerCase()).not.toContain('rzp_test_');
    expect(copy.text.toLowerCase()).not.toContain('card');
  });
});
