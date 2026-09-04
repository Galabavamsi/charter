import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { RazorpayClient } from './client.js';
import { verifyCheckoutSignature } from './checkout-signature.js';
import { buildRazorpayReceipt } from './webhook.js';
import { ulid } from './ulid.js';

describe('RazorpayClient.createOrder', () => {
  it('sends automatic capture and no Idempotency-Key', async () => {
    const httpFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.payment_capture).toBe(1);
      expect(body.receipt).toBe('cht_01ARZ3NDEKTSV4RRFFQ69G5FAV');
      expect(init?.headers).not.toHaveProperty('Idempotency-Key');
      const headers = init?.headers as Record<string, string>;
      expect(JSON.stringify(headers).toLowerCase()).not.toContain('idempotency');
      return new Response(
        JSON.stringify({
          id: 'order_test',
          amount: 234700,
          currency: 'INR',
          receipt: body.receipt,
          status: 'created',
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = new RazorpayClient({ keyId: 'rzp_test_x', keySecret: 'secret' }, httpFetch);
    const order = await client.createOrder({
      amountMinor: 234700,
      currency: 'INR',
      receipt: 'cht_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    });
    expect(order.id).toBe('order_test');
  });
});

describe('RazorpayClient reconciliation reads', () => {
  it('loads the order and every known payment attempt', async () => {
    const httpFetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/orders/order_1')) {
        return new Response(
          JSON.stringify({
            id: 'order_1',
            amount: 234700,
            currency: 'INR',
            receipt: 'cht_recovery',
            status: 'attempted',
          }),
        );
      }
      if (url.endsWith('/orders/order_1/payments')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: 'pay_failed',
                order_id: 'order_1',
                amount: 234700,
                currency: 'INR',
                status: 'failed',
              },
            ],
          }),
        );
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
    const client = new RazorpayClient({ keyId: 'rzp_test_x', keySecret: 'secret' }, httpFetch);

    await expect(client.getOrder('order_1')).resolves.toMatchObject({
      id: 'order_1',
      status: 'attempted',
    });
    await expect(client.listOrderPayments('order_1')).resolves.toEqual([
      expect.objectContaining({ id: 'pay_failed', status: 'failed' }),
    ]);
  });
});

describe('checkout signature', () => {
  it('accepts HMAC of order_id|payment_id', () => {
    const secret = 'secret';
    const signature = createHmac('sha256', secret).update('order_1|pay_1').digest('hex');
    expect(
      verifyCheckoutSignature({
        orderId: 'order_1',
        paymentId: 'pay_1',
        signature,
        secret,
      }),
    ).toBe(true);
  });
});

describe('receipt', () => {
  it('cht_ + ULID stays at 30 characters', () => {
    const receipt = buildRazorpayReceipt(ulid());
    expect(receipt.startsWith('cht_')).toBe(true);
    expect(receipt.length).toBe(30);
    expect(receipt.length).toBeLessThanOrEqual(40);
  });
});
