import { describe, expect, it } from 'vitest';
import { classifyReconciliation, reconcileCheckoutWithProvider } from './reconcile.js';

const session = {
  quoteId: 'quote_1',
  razorpayOrderId: 'order_1',
  amountMinor: 234700,
  currency: 'INR' as const,
};

describe('provider reconciliation classification', () => {
  it('permits one same-Order retry only when every attempt failed', () => {
    expect(
      classifyReconciliation({
        session,
        order: {
          id: 'order_1',
          amount: 234700,
          currency: 'INR',
          receipt: 'cht_1',
          status: 'attempted',
        },
        payments: [
          {
            id: 'pay_failed',
            order_id: 'order_1',
            amount: 234700,
            currency: 'INR',
            status: 'failed',
          },
        ],
      }).outcome,
    ).toBe('same_order_retry_safe');
  });

  it('fails closed on identity mismatch, authorized, captured, and empty attempts', () => {
    expect(
      classifyReconciliation({
        session,
        order: {
          id: 'order_other',
          amount: 234700,
          currency: 'INR',
          receipt: 'cht_1',
          status: 'attempted',
        },
        payments: [],
      }).outcome,
    ).toBe('identity_mismatch');
    expect(
      classifyReconciliation({
        session,
        order: {
          id: 'order_1',
          amount: 234700,
          currency: 'INR',
          receipt: 'cht_1',
          status: 'attempted',
        },
        payments: [
          {
            id: 'pay_auth',
            order_id: 'order_1',
            amount: 234700,
            currency: 'INR',
            status: 'authorized',
          },
        ],
      }).outcome,
    ).toBe('authorized');
    expect(
      classifyReconciliation({
        session,
        order: {
          id: 'order_1',
          amount: 234700,
          currency: 'INR',
          receipt: 'cht_1',
          status: 'paid',
        },
        payments: [
          {
            id: 'pay_cap',
            order_id: 'order_1',
            amount: 234700,
            currency: 'INR',
            status: 'captured',
          },
        ],
      }).outcome,
    ).toBe('captured');
    expect(
      classifyReconciliation({
        session,
        order: {
          id: 'order_1',
          amount: 234700,
          currency: 'INR',
          receipt: 'cht_1',
          status: 'created',
        },
        payments: [],
      }).outcome,
    ).toBe('unknown_attempts');
  });

  it('does not treat a sibling created payment as a terminal failure', () => {
    expect(
      classifyReconciliation({
        session,
        order: {
          id: 'order_1',
          amount: 234700,
          currency: 'INR',
          receipt: 'cht_1',
          status: 'attempted',
        },
        payments: [
          {
            id: 'pay_failed',
            order_id: 'order_1',
            amount: 234700,
            currency: 'INR',
            status: 'failed',
          },
          {
            id: 'pay_created',
            order_id: 'order_1',
            amount: 234700,
            currency: 'INR',
            status: 'created',
          },
        ],
      }).outcome,
    ).toBe('unknown_attempts');
  });

  it('fails closed when a payment attempt has an empty status', () => {
    expect(
      classifyReconciliation({
        session,
        order: {
          id: 'order_1',
          amount: 234700,
          currency: 'INR',
          receipt: 'cht_1',
          status: 'attempted',
        },
        payments: [
          {
            id: 'pay_blank',
            order_id: 'order_1',
            amount: 234700,
            currency: 'INR',
            status: '',
          },
        ],
      }).outcome,
    ).toBe('unknown_attempts');
  });

  it('keeps unknown or undocumented attempt statuses as unknown_attempts', () => {
    expect(
      classifyReconciliation({
        session,
        order: {
          id: 'order_1',
          amount: 234700,
          currency: 'INR',
          receipt: 'cht_1',
          status: 'attempted',
        },
        payments: [
          {
            id: 'pay_created_only',
            order_id: 'order_1',
            amount: 234700,
            currency: 'INR',
            status: 'created',
          },
        ],
      }).outcome,
    ).toBe('unknown_attempts');
    expect(
      classifyReconciliation({
        session,
        order: {
          id: 'order_1',
          amount: 234700,
          currency: 'INR',
          receipt: 'cht_1',
          status: 'attempted',
        },
        payments: [
          {
            id: 'pay_pending',
            order_id: 'order_1',
            amount: 234700,
            currency: 'INR',
            status: 'pending',
          },
        ],
      }).outcome,
    ).toBe('unknown_attempts');
  });

  it('does not treat a refund-only attempt as captured', () => {
    expect(
      classifyReconciliation({
        session,
        order: {
          id: 'order_1',
          amount: 234700,
          currency: 'INR',
          receipt: 'cht_1',
          status: 'paid',
        },
        payments: [
          {
            id: 'pay_refunded',
            order_id: 'order_1',
            amount: 234700,
            currency: 'INR',
            status: 'refunded',
          },
        ],
      }).outcome,
    ).toBe('refunded');
  });

  it('records provider unavailability without inventing attempts', async () => {
    const evidence = await reconcileCheckoutWithProvider(session, {
      async getOrder() {
        throw new Error('RAZORPAY_ORDER_LOOKUP_FAILED:503');
      },
      async listOrderPayments() {
        throw new Error('RAZORPAY_ORDER_PAYMENTS_LOOKUP_FAILED:503');
      },
    });
    expect(evidence.outcome).toBe('provider_unavailable');
    expect(evidence.paymentAttempts).toEqual([]);
  });
});
