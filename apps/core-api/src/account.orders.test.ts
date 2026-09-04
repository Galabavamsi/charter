import { beforeEach, describe, expect, it } from 'vitest';
import { resetKernel } from '@charter/commerce';
import { resetCheckouts } from '@charter/payments';
import { resetConversations } from '@charter/orchestrator';
import type { AuthVerifier, VerifiedIdentity } from './auth/verifier.js';
import { buildServer } from './server.js';
import { createMemoryTenantRepository } from './testing/memory-tenant-repository.js';

const OWNER = '61000000-0000-4000-8000-000000000011';
const BUYER_A = '61000000-0000-4000-8000-000000000012';
const BUYER_B = '61000000-0000-4000-8000-000000000013';
const ORDER_ID = '62000000-0000-4000-8000-000000000001';
const TENANT_ID = 'northstar-demo-in';

const testEnv = {
  DATABASE_URL: 'postgres://unused',
  CHARTER_ENV: 'test',
  RAZORPAY_MODE: 'test',
} as const;

function verifier(): AuthVerifier {
  const identities = new Map<string, VerifiedIdentity>([
    ['owner', { userId: OWNER, email: 'owner@example.invalid' }],
    ['buyer-a', { userId: BUYER_A, email: 'buyer-a@example.invalid' }],
    ['buyer-b', { userId: BUYER_B, email: 'buyer-b@example.invalid' }],
  ]);
  return {
    async verify(token) {
      const identity = identities.get(token);
      if (!identity) {
        throw new Error('AUTH_INVALID_TOKEN');
      }
      return identity;
    },
  };
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

function repository() {
  const store = createMemoryTenantRepository({
    memberships: [{ userId: OWNER, tenantId: TENANT_ID, role: 'owner' }],
  });
  store.state.merchantQuotes.set(TENANT_ID, [
    {
      id: 'q-account',
      status: 'BOUND',
      createdAt: '2026-08-23T10:00:00.000Z',
      subtotalMinor: '234700',
      discountMinor: '0',
      totalMinor: '234700',
      lines: [
        {
          sku: 'grinder.pocket-lite',
          title: 'PocketGrind Lite',
          quantity: 1,
          unitMinor: '99900',
          lineMinor: '99900',
        },
      ],
    },
  ]);
  store.state.merchantOrders.set(TENANT_ID, [
    {
      id: ORDER_ID,
      quoteId: 'q-account',
      receipt: 'cht_account_receipt',
      razorpayOrderId: 'order_account_same',
      amountMinor: '234700',
      status: 'SETTLED',
      paymentId: 'pay_account',
      providerStatus: 'captured',
      copy: 'Captured.',
      createdAt: '2026-08-23T10:00:00.000Z',
      updatedAt: '2026-08-23T10:02:00.000Z',
      capturedAt: '2026-08-23T10:02:00.000Z',
      recovered: false,
    },
  ]);
  return store;
}

describe('buyer account orders', () => {
  beforeEach(() => {
    resetKernel();
    resetCheckouts();
    resetConversations();
  });

  it('keeps order history account-scoped and aligned with the merchant timeline', async () => {
    const store = repository();
    await store.claimResource('checkout', TENANT_ID, ORDER_ID, BUYER_A);
    const { app } = await buildServer(testEnv, {
      authVerifier: verifier(),
      tenantRepository: store,
    });

    const missing = await app.inject({ method: 'GET', url: '/api/v1/orders' });
    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/orders',
      headers: bearer('buyer-a'),
    });
    const hidden = await app.inject({
      method: 'GET',
      url: '/api/v1/orders',
      headers: bearer('buyer-b'),
    });
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/orders/${ORDER_ID}`,
      headers: bearer('buyer-a'),
    });
    const denied = await app.inject({
      method: 'GET',
      url: `/api/v1/orders/${ORDER_ID}`,
      headers: bearer('buyer-b'),
    });
    const merchant = await app.inject({
      method: 'GET',
      url: `/api/v1/merchant/shops/${TENANT_ID}/orders/${ORDER_ID}`,
      headers: bearer('owner'),
    });

    expect(missing.statusCode).toBe(401);
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toEqual([
      expect.objectContaining({
        id: ORDER_ID,
        receipt: 'cht_account_receipt',
        razorpayOrderId: 'order_account_same',
        shop: expect.objectContaining({ tenantId: TENANT_ID, slug: 'northstar' }),
      }),
    ]);
    expect(hidden.json().items).toEqual([]);
    expect(detail.statusCode).toBe(200);
    expect(denied.statusCode).toBe(404);
    expect(merchant.statusCode).toBe(200);
    expect(detail.json().paymentTruth).toBe(merchant.json().paymentTruth);
    expect(detail.json().totalMinor).toBe(merchant.json().totalMinor);
    expect(detail.json().razorpayOrderId).toBe(merchant.json().razorpayOrderId);
    expect(detail.json().quote.lines).toEqual(merchant.json().quote.lines);
    expect(detail.json().timeline.map((event: { label: string }) => event.label)).toEqual(
      merchant.json().timeline.map((event: { label: string }) => event.label),
    );
    expect(detail.json().trackingId).toBe('CHR-TRK-620000000000');
    expect(merchant.json().trackingId).toBe('CHR-TRK-620000000000');
    expect(detail.json().shippingAddress).toMatchObject({
      recipientName: 'Charter Demo Recipient',
      city: 'Bengaluru',
      source: 'sandbox_mock',
    });
    expect(listed.json().items[0].trackingId).toBe('CHR-TRK-620000000000');

    const packed = await app.inject({
      method: 'POST',
      url: `/api/v1/merchant/shops/${TENANT_ID}/orders/${ORDER_ID}/fulfillment`,
      headers: bearer('owner'),
      payload: { status: 'packed' },
    });
    const skipped = await app.inject({
      method: 'POST',
      url: `/api/v1/merchant/shops/${TENANT_ID}/orders/${ORDER_ID}/fulfillment`,
      headers: bearer('buyer-a'),
      payload: { status: 'dispatched' },
    });
    const again = await app.inject({
      method: 'GET',
      url: `/api/v1/orders/${ORDER_ID}`,
      headers: bearer('buyer-a'),
    });

    expect(packed.statusCode, packed.body).toBe(200);
    expect(packed.json().fulfillmentStatus).toBe('packed');
    expect(packed.json().trackingId).toBe('CHR-TRK-620000000000');
    expect(skipped.statusCode).toBe(403);
    expect(again.json().fulfillmentStatus).toBe('packed');
    expect(again.json().trackingId).toBe('CHR-TRK-620000000000');
    expect(again.json().timeline.map((event: { status: string }) => event.status)).toEqual(
      expect.arrayContaining(['captured', 'confirmed', 'packed']),
    );
    await app.close();
  });
});
