import { createHmac } from 'node:crypto';
import { describe, expect, it, beforeEach } from 'vitest';
import { buildCanonicalKit, resetKernel } from '@charter/commerce';
import { RazorpayClient } from '@charter/razorpay';
import {
  applyCheckoutCallback,
  applyRazorpayWebhook,
  hydrateCheckout,
  markCheckoutDismissed,
  resetCheckouts,
  startCheckout,
} from './checkout.js';
import { paymentTruth } from './truth.js';

function mockOrders(
  orderId: string,
  payments: Array<{ id: string; status: string }> = [{ id: 'pay_failed', status: 'failed' }],
) {
  return async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.includes('/orders') && init?.method === 'POST') {
      return new Response(
        JSON.stringify({
          id: orderId,
          amount: 234700,
          currency: 'INR',
          receipt: JSON.parse(String(init.body)).receipt,
          status: 'created',
        }),
      );
    }
    if (href.includes(`/orders/${orderId}/payments`)) {
      return new Response(
        JSON.stringify({
          items: payments.map((payment) => ({
            id: payment.id,
            order_id: orderId,
            amount: 234700,
            currency: 'INR',
            status: payment.status,
          })),
        }),
      );
    }
    if (href.includes(`/orders/${orderId}`)) {
      return new Response(
        JSON.stringify({
          id: orderId,
          amount: 234700,
          currency: 'INR',
          receipt: 'cht_test',
          status: 'attempted',
        }),
      );
    }
    if (href.includes('/orders')) {
      return new Response(JSON.stringify({ items: [] }));
    }
    throw new Error(href);
  };
}

describe('checkout capture rule', () => {
  beforeEach(() => {
    resetKernel();
    resetCheckouts();
  });

  it('creates a Razorpay Order without looking up a brand-new receipt', async () => {
    const { quote } = buildCanonicalKit();
    const calls: string[] = [];
    const client = new RazorpayClient({ keyId: 'rzp_test_x', keySecret: 'secret' }, (async (
      url: string | URL,
      init?: RequestInit,
    ) => {
      const href = String(url);
      calls.push(`${init?.method ?? 'GET'} ${href}`);
      if (href.includes('/orders') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            id: 'order_fresh',
            amount: 234700,
            currency: 'INR',
            receipt: JSON.parse(String(init.body)).receipt,
            status: 'created',
          }),
        );
      }
      throw new Error(`unexpected ${href}`);
    }) as typeof fetch);
    const started = await startCheckout(quote.id, client);
    expect(started.session.razorpayOrderId).toBe('order_fresh');
    expect(calls).toEqual([expect.stringMatching(/^POST /)]);
    expect(calls.some((row) => row.startsWith('GET '))).toBe(false);
  });

  it('rehydrates a bound checkout instead of minting a new Razorpay Order', async () => {
    const { quote } = buildCanonicalKit();
    let created = 0;
    const client = new RazorpayClient({ keyId: 'rzp_test_x', keySecret: 'secret' }, (async (
      url: string | URL,
      init?: RequestInit,
    ) => {
      const href = String(url);
      if (href.includes('/orders') && init?.method === 'POST') {
        created += 1;
        return new Response(
          JSON.stringify({
            id: `order_bound_${created}`,
            amount: 234700,
            currency: 'INR',
            receipt: JSON.parse(String(init.body)).receipt,
            status: 'created',
          }),
        );
      }
      if (href.includes('/orders/order_bound_1/payments')) {
        return new Response(JSON.stringify({ items: [] }));
      }
      if (href.includes('/orders/order_bound_1')) {
        return new Response(
          JSON.stringify({
            id: 'order_bound_1',
            amount: 234700,
            currency: 'INR',
            receipt: 'cht_bound',
            status: 'created',
          }),
        );
      }
      if (href.includes('/orders')) {
        return new Response(JSON.stringify({ items: [] }));
      }
      throw new Error(href);
    }) as typeof fetch);
    const first = await startCheckout(quote.id, client);
    const snapshot = { ...first.session };
    resetCheckouts();
    expect(quote.boundCheckoutId).toBe(first.session.id);
    await expect(startCheckout(quote.id, client)).rejects.toThrow('BOUND_CHECKOUT_NOT_HYDRATED');
    expect(created).toBe(1);
    hydrateCheckout(snapshot);
    const second = await startCheckout(quote.id, client);
    expect(second.session.id).toBe(first.session.id);
    expect(second.session.razorpayOrderId).toBe(first.session.razorpayOrderId);
    expect(created).toBe(1);
  });

  it('does not settle or fulfill from refund-only provider evidence', async () => {
    const { quote } = buildCanonicalKit();
    const client = new RazorpayClient(
      { keyId: 'rzp_test_x', keySecret: 'secret' },
      mockOrders('order_refunded', [{ id: 'pay_refunded', status: 'refunded' }]) as typeof fetch,
    );
    const first = await startCheckout(quote.id, client);
    markCheckoutDismissed(first.session.id);
    await expect(startCheckout(quote.id, client)).rejects.toThrow('PAYMENT_REFUNDED');
    expect(first.session.status).not.toBe('SETTLED');
    expect(first.session.status).toBe('RECONCILING');
    expect(first.session.providerStatus).toBe('refunded');
    expect(first.session.paymentId).toBe('pay_refunded');
  });

  it('copies refund paymentId when the failed session still has a null paymentId', async () => {
    const { quote } = buildCanonicalKit();
    const client = new RazorpayClient(
      { keyId: 'rzp_test_x', keySecret: 'secret' },
      mockOrders('order_refund_null', [
        { id: 'pay_refunded_late', status: 'refunded' },
      ]) as typeof fetch,
    );
    const first = await startCheckout(quote.id, client);
    expect(first.session.paymentId).toBeNull();
    markCheckoutDismissed(first.session.id);
    expect(first.session.paymentId).toBeNull();
    await expect(startCheckout(quote.id, client)).rejects.toThrow('PAYMENT_REFUNDED');
    expect(first.session.paymentId).toBe('pay_refunded_late');
    expect(first.session.status).toBe('RECONCILING');
    expect(first.session.providerStatus).toBe('refunded');
  });

  it('reuses one Razorpay order after a provisional failure', async () => {
    const { quote } = buildCanonicalKit();
    const client = new RazorpayClient(
      { keyId: 'rzp_test_x', keySecret: 'secret' },
      mockOrders('order_once') as typeof fetch,
    );
    const first = await startCheckout(quote.id, client);
    markCheckoutDismissed(first.session.id);
    const second = await startCheckout(quote.id, client);
    expect(second.session.razorpayOrderId).toBe(first.session.razorpayOrderId);
    expect(second.session.id).toBe(first.session.id);
    expect(second.session.status).toBe('CREATED');
  });

  it('does not reuse the Order while a sibling payment is still created', async () => {
    const { quote } = buildCanonicalKit();
    const client = new RazorpayClient(
      { keyId: 'rzp_test_x', keySecret: 'secret' },
      mockOrders('order_created', [
        { id: 'pay_failed', status: 'failed' },
        { id: 'pay_open', status: 'created' },
      ]) as typeof fetch,
    );
    const first = await startCheckout(quote.id, client);
    markCheckoutDismissed(first.session.id);
    await expect(startCheckout(quote.id, client)).rejects.toThrow('RECONCILIATION_REQUIRED');
  });

  it('blocks same-Order retry while an attempt is authorized', async () => {
    const { quote } = buildCanonicalKit();
    const client = new RazorpayClient(
      { keyId: 'rzp_test_x', keySecret: 'secret' },
      mockOrders('order_auth', [{ id: 'pay_auth', status: 'authorized' }]) as typeof fetch,
    );
    const first = await startCheckout(quote.id, client);
    markCheckoutDismissed(first.session.id);
    await expect(startCheckout(quote.id, client)).rejects.toThrow('PAYMENT_AUTHORIZED');
  });

  it('rejects a quote amount that cannot be represented safely', async () => {
    const { quote } = buildCanonicalKit();
    quote.totalMinor = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    const client = new RazorpayClient({ keyId: 'rzp_test_x', keySecret: 'secret' }, (async () => {
      throw new Error('RAZORPAY_SHOULD_NOT_BE_CALLED');
    }) as typeof fetch);

    await expect(startCheckout(quote.id, client)).rejects.toThrow('QUOTE_TOTAL_MINOR_UNSAFE');
  });

  it('does not create another order after capture', async () => {
    const { quote } = buildCanonicalKit();
    const httpFetch = async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/orders') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            id: 'order_cap',
            amount: 234700,
            currency: 'INR',
            receipt: JSON.parse(String(init.body)).receipt,
            status: 'created',
          }),
        );
      }
      if (href.includes('/orders')) {
        return new Response(JSON.stringify({ items: [] }));
      }
      if (href.includes('/payments/pay_ok')) {
        return new Response(
          JSON.stringify({
            id: 'pay_ok',
            order_id: 'order_cap',
            amount: 234700,
            currency: 'INR',
            status: 'captured',
          }),
        );
      }
      throw new Error(href);
    };
    const client = new RazorpayClient(
      { keyId: 'rzp_test_x', keySecret: 'secret' },
      httpFetch as typeof fetch,
    );
    const { session } = await startCheckout(quote.id, client);
    const secret = 'secret';
    await applyCheckoutCallback(
      session.id,
      {
        orderId: 'order_cap',
        paymentId: 'pay_ok',
        signature: createHmac('sha256', secret).update('order_cap|pay_ok').digest('hex'),
      },
      client,
      secret,
    );
    await expect(startCheckout(quote.id, client)).rejects.toThrow('QUOTE_ALREADY_PAID');
  });

  it('projects a signed webhook capture onto the same session', async () => {
    const { quote } = buildCanonicalKit();
    const client = new RazorpayClient(
      { keyId: 'rzp_test_x', keySecret: 'secret' },
      mockOrders('order_wh') as typeof fetch,
    );
    const { session } = await startCheckout(quote.id, client);
    markCheckoutDismissed(session.id);
    const updated = applyRazorpayWebhook({
      event: 'payment.failed',
      payload: {
        payment: { entity: { id: 'pay_fail', order_id: 'order_wh', status: 'failed' } },
      },
    });
    expect(updated?.status).toBe('FAILED_PROVISIONAL');
    const captured = applyRazorpayWebhook({
      event: 'payment.captured',
      payload: {
        payment: { entity: { id: 'pay_ok', order_id: 'order_wh', status: 'captured' } },
      },
    });
    expect(captured?.status).toBe('SETTLED');
  });

  it('keeps authorized and captured provider transitions monotonic', async () => {
    const { quote } = buildCanonicalKit();
    const client = new RazorpayClient(
      { keyId: 'rzp_test_x', keySecret: 'secret' },
      mockOrders('order_monotonic') as typeof fetch,
    );
    await startCheckout(quote.id, client);

    const authorized = applyRazorpayWebhook({
      event: 'payment.authorized',
      payload: {
        payment: {
          entity: {
            id: 'pay_authorized',
            order_id: 'order_monotonic',
            status: 'authorized',
          },
        },
      },
    });
    expect(authorized?.status).toBe('CAPTURE_PENDING');

    const lateFailure = applyRazorpayWebhook({
      event: 'payment.failed',
      payload: {
        payment: {
          entity: { id: 'pay_failed', order_id: 'order_monotonic', status: 'failed' },
        },
      },
    });
    expect(lateFailure?.status).toBe('CAPTURE_PENDING');
    expect(lateFailure?.paymentId).toBe('pay_authorized');

    const captured = applyRazorpayWebhook({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: { id: 'pay_captured', order_id: 'order_monotonic', status: 'captured' },
        },
      },
    });
    expect(captured?.status).toBe('SETTLED');

    const failureAfterCapture = applyRazorpayWebhook({
      event: 'payment.failed',
      payload: {
        payment: {
          entity: { id: 'pay_failed_late', order_id: 'order_monotonic', status: 'failed' },
        },
      },
    });
    expect(failureAfterCapture?.status).toBe('SETTLED');
    expect(failureAfterCapture?.paymentId).toBe('pay_captured');
  });

  it('does not keep a captured checkout fulfilled after a refund webhook', async () => {
    const { quote } = buildCanonicalKit();
    const client = new RazorpayClient(
      { keyId: 'rzp_test_x', keySecret: 'secret' },
      mockOrders('order_refund_captured') as typeof fetch,
    );
    const { session } = await startCheckout(quote.id, client);
    const captured = applyRazorpayWebhook({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: { id: 'pay_ok', order_id: session.razorpayOrderId, status: 'captured' },
        },
      },
    });
    expect(captured?.status).toBe('SETTLED');
    expect(paymentTruth(captured!.status)).toMatchObject({
      paid: true,
      fulfillmentReady: true,
    });

    const refunded = applyRazorpayWebhook({
      event: 'payment.refunded',
      payload: {
        payment: {
          entity: { id: 'pay_ok', order_id: session.razorpayOrderId, status: 'refunded' },
        },
      },
    });
    expect(refunded?.providerStatus).toBe('refunded');
    expect(refunded?.status).toBe('RECONCILING');
    expect(paymentTruth(refunded!.status)).toMatchObject({
      paid: false,
      fulfillmentReady: false,
    });
  });
});
