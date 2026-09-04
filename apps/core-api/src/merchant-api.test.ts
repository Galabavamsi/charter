import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { buildCanonicalKit, resetKernel, type FrozenQuote } from '@charter/commerce';
import type { CheckoutSession } from '@charter/payments';
import type { AuthVerifier, VerifiedIdentity } from './auth/verifier.js';
import type { MoneyPersist } from './persist.js';
import { buildServer } from './server.js';
import type { MerchantRecoveryRecord } from './tenant/merchant-repository.js';
import { createMemoryTenantRepository } from './testing/memory-tenant-repository.js';

const USERS = {
  owner: '91000000-0000-4000-8000-000000000001',
  catalog: '91000000-0000-4000-8000-000000000002',
  support: '91000000-0000-4000-8000-000000000003',
  finance: '91000000-0000-4000-8000-000000000004',
  viewer: '91000000-0000-4000-8000-000000000005',
  outsider: '91000000-0000-4000-8000-000000000006',
} as const;

const TENANT_ID = 'northstar-demo-in';
const CHECKOUT_ID = '92000000-0000-4000-8000-000000000001';
const CONSENT_ID = '93000000-0000-4000-8000-000000000001';

function authVerifier(): AuthVerifier {
  const identities = new Map<string, VerifiedIdentity>(
    Object.entries(USERS).map(([token, userId]) => [
      token,
      { userId, email: `${token}@example.invalid` },
    ]),
  );
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

function bearer(token: keyof typeof USERS) {
  return { authorization: `Bearer ${token}` };
}

function merchantRepository() {
  const repository = createMemoryTenantRepository({
    memberships: [
      { userId: USERS.owner, tenantId: TENANT_ID, role: 'owner' },
      { userId: USERS.catalog, tenantId: TENANT_ID, role: 'catalog' },
      { userId: USERS.support, tenantId: TENANT_ID, role: 'support' },
      { userId: USERS.finance, tenantId: TENANT_ID, role: 'finance' },
      { userId: USERS.viewer, tenantId: TENANT_ID, role: 'viewer' },
    ],
  });
  const catalogItem = {
    productId: '94000000-0000-4000-8000-000000000001',
    productVersion: 1,
    title: 'PocketGrind Lite',
    description: 'A compact steel hand grinder.',
    status: 'published',
    category: { id: '95000000-0000-4000-8000-000000000001', slug: 'grinders', title: 'Grinders' },
    variantId: '96000000-0000-4000-8000-000000000001',
    variantVersion: 1,
    sku: 'grinder.pocket-lite',
    material: 'steel',
    priceMinor: '99900',
    priceDisplay: '₹999.00',
    inventory: { onHand: 8, reserved: 0, available: 8, version: 1 },
    updatedAt: '2026-08-23T10:00:00.000Z',
  };
  const recoveryRecord: MerchantRecoveryRecord = {
    checkoutId: CHECKOUT_ID,
    quoteId: '97000000-0000-4000-8000-000000000001',
    razorpayOrderId: 'order_test_safe',
    amountMinor: '234700',
    amountDisplay: '₹2,347.00',
    checkoutStatus: 'FAILED_PROVISIONAL',
    reconciliationStatus: 'unresolved',
    consentStatus: 'granted',
    sendStatus: 'not_sent',
    stopStatus: 'clear',
    canSend: true,
    blockedReason: null,
    updatedAt: '2026-08-23T10:00:00.000Z',
  };
  const methods = {
    getMerchantOverview: vi.fn(async () => ({
      range: { from: '2026-08-01', to: '2026-08-23' },
      capturedGmvMinor: '234700',
      capturedGmvDisplay: '₹2,347.00',
      capturedOrders: 1,
      validFrozenQuotes: 2,
      conversion: { numerator: 1, denominator: 2, rate: 0.5 },
      failedUnresolvedPays: 1,
      recoveredAmountMinor: '0',
      recoveredAmountDisplay: '₹0.00',
      inventoryUnits: 8,
      lowStockVariants: 0,
      synthetic: true,
      attributionNote: 'Observed captures after recovery; no incremental lift claim.',
      searches: 0,
      recommendationsBySku: [],
      recommendationsBySource: [],
    })),
    listMerchantCatalog: vi.fn(async () => ({
      items: [catalogItem],
      cursor: { sortValue: catalogItem.updatedAt, id: catalogItem.productId },
    })),
    createMerchantProduct: vi.fn(async () => catalogItem),
    updateMerchantProduct: vi.fn(async () => ({ ...catalogItem, productVersion: 2 })),
    adjustMerchantStock: vi.fn(async () => ({
      ...catalogItem.inventory,
      onHand: 10,
      available: 10,
      version: 2,
    })),
    listMerchantOrders: vi.fn(async () => ({
      items: [
        {
          id: CHECKOUT_ID,
          receipt: 'cht_test_order',
          razorpayOrderId: 'order_test_safe',
          status: 'SETTLED',
          paymentState: 'captured',
          totalMinor: '234700',
          totalDisplay: '₹2,347.00',
          customerLabel: 'Buyer',
          createdAt: '2026-08-23T10:00:00.000Z',
          updatedAt: '2026-08-23T10:02:00.000Z',
          paid: true,
          fulfillmentReady: true,
        },
      ],
      cursor: null as { sortValue: string; id: string } | null,
    })),
    getMerchantOrder: vi.fn(async () => ({
      id: CHECKOUT_ID,
      status: 'SETTLED',
      paid: true,
      fulfillmentReady: true,
      paymentTruth: 'Captured',
      totalMinor: '234700',
      totalDisplay: '₹2,347.00',
      quote: { id: '97000000-0000-4000-8000-000000000001', lines: [] },
      provider: {
        razorpayOrderId: 'order_test_safe',
        paymentId: 'pay_test_safe',
        status: 'captured',
      },
      timeline: [
        {
          id: 'capture',
          at: '2026-08-23T10:02:00.000Z',
          status: 'captured',
          label: 'Payment captured',
          detail: 'Captured ledger evidence. Eligible for fulfillment.',
        },
      ],
    })),
    listMerchantRecovery: vi.fn(async () => ({
      items: [
        {
          checkoutId: CHECKOUT_ID,
          quoteId: '97000000-0000-4000-8000-000000000001',
          razorpayOrderId: 'order_test_safe',
          amountMinor: '234700',
          amountDisplay: '₹2,347.00',
          checkoutStatus: 'FAILED_PROVISIONAL',
          reconciliationStatus: 'unresolved',
          consentStatus: 'granted',
          sendStatus: 'not_sent',
          stopStatus: 'clear',
          canSend: true,
          blockedReason: null,
          updatedAt: '2026-08-23T10:00:00.000Z',
        },
      ],
      cursor: null as { sortValue: string; id: string } | null,
    })),
    getMerchantRecovery: vi.fn(async (): Promise<MerchantRecoveryRecord> => recoveryRecord),
    getMerchantRules: vi.fn(async () => ({
      version: 1,
      hardCapMinor: '300000',
      hardCapDisplay: '₹3,000.00',
      autonomousCapMinor: '250000',
      autonomousCapDisplay: '₹2,500.00',
      forbiddenMaterials: ['glass'],
      offers: [],
      updatedAt: '2026-08-23T10:00:00.000Z',
    })),
    previewMerchantRules: vi.fn(async () => ({
      version: 1,
      items: [{ sku: 'grinder.pocket-lite', outcome: 'allow', reason: 'WITHIN_POLICY' }],
    })),
    updateMerchantRules: vi.fn(async () => ({
      version: 2,
      hardCapMinor: '300000',
      hardCapDisplay: '₹3,000.00',
      autonomousCapMinor: '250000',
      autonomousCapDisplay: '₹2,500.00',
      forbiddenMaterials: ['glass'],
      offers: [],
      updatedAt: '2026-08-23T10:00:00.000Z',
    })),
    getMerchantSettings: vi.fn(async () => ({
      version: 1,
      name: 'Northstar Travel Coffee',
      blurb: 'Coffee gear for the road.',
      slug: 'northstar',
      publicPath: '/shops/northstar',
      synthetic: true,
      testMode: true,
      paymentAccountDisclosure: 'Razorpay test mode. No live money.',
      gstin: '29AAAAA0000A1Z5',
      addressLine: '12 Brigade Road, Bengaluru 560001 (demo — not a live premises)',
      refundPolicy:
        'Unused kit in original packaging within 7 days of capture. Evaluator mock — not a live GST or Razorpay refund SLA.',
      profileVerified: false,
      members: [{ userId: USERS.owner, role: 'owner', status: 'active', label: 'Owner' }],
    })),
    updateMerchantSettings: vi.fn(async () => ({
      version: 2,
      name: 'Northstar Travel Coffee',
      blurb: 'Coffee gear for every road.',
      slug: 'northstar',
      publicPath: '/shops/northstar',
      synthetic: true,
      testMode: true,
      paymentAccountDisclosure: 'Razorpay test mode. No live money.',
      gstin: '29AAAAA0000A1Z5',
      addressLine: '12 Brigade Road, Bengaluru 560001 (demo — not a live premises)',
      refundPolicy:
        'Unused kit in original packaging within 7 days of capture. Evaluator mock — not a live GST or Razorpay refund SLA.',
      profileVerified: false,
      members: [{ userId: USERS.owner, role: 'owner', status: 'active', label: 'Owner' }],
    })),
  };
  Object.assign(repository, methods);
  return { repository, methods };
}

const env = {
  DATABASE_URL: 'postgres://unused',
  CHARTER_ENV: 'test',
  RAZORPAY_MODE: 'test',
  AGENTMAIL_API_KEY: 'agentmail-test',
  AGENTMAIL_INBOX: 'recovery@example.invalid',
} as const;

const TEST_CURSOR_SECRET = 'charter-test-cursor-secret-not-for-deployment';

function signMerchantCursor(
  scope: string,
  sortValue: string,
  id: string,
  secret = TEST_CURSOR_SECRET,
) {
  const payload = Buffer.from(JSON.stringify({ scope, sortValue, id })).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function durableRecoveryPersist(quote: FrozenQuote): MoneyPersist {
  const checkout: CheckoutSession = {
    id: CHECKOUT_ID,
    tenantId: TENANT_ID,
    quoteId: quote.id,
    receipt: 'cht_recovery',
    razorpayOrderId: 'order_test_safe',
    amountMinor: Number(quote.totalMinor),
    currency: 'INR',
    status: 'FAILED_PROVISIONAL',
    paymentId: 'pay_failed_recovery',
    providerStatus: 'failed',
    copy: 'Payment unresolved.',
  };
  return {
    loadCheckout: async () => checkout,
    loadQuote: async () => quote,
    assertQuoteFacts: async () => undefined,
    persistWebhookTransition: async (session: CheckoutSession) => session,
    recordReconciliation: async () => undefined,
    saveCheckout: async () => undefined,
  } as unknown as MoneyPersist;
}

describe('member-scoped merchant API', () => {
  it('requires and replays an idempotency key for first-shop onboarding', async () => {
    const { repository } = merchantRepository();
    const { app } = await buildServer(env, {
      authVerifier: authVerifier(),
      tenantRepository: repository,
    });
    const payload = { name: 'First Record Shop', blurb: 'Calm operational goods.' };
    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/shops',
      headers: bearer('outsider'),
      payload,
    });
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/shops',
      headers: { ...bearer('outsider'), 'idempotency-key': 'first-shop-api-001' },
      payload,
    });
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/shops',
      headers: { ...bearer('outsider'), 'idempotency-key': 'first-shop-api-001' },
      payload,
    });

    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toBe('VALIDATION_ERROR');
    expect(first.statusCode, first.body).toBe(201);
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.json().shop.tenantId).toBe(first.json().shop.tenantId);
    await app.close();
  });

  it.each([
    ['owner', 'overview', 200],
    ['viewer', 'catalog', 200],
    ['support', 'orders', 200],
    ['support', 'recovery', 200],
    ['finance', 'orders', 200],
    ['catalog', 'orders', 200],
    ['finance', 'recovery', 403],
    ['outsider', 'overview', 403],
  ] as const)('enforces %s capability on %s', async (token, section, expectedStatus) => {
    const { repository } = merchantRepository();
    const { app } = await buildServer(env, {
      authVerifier: authVerifier(),
      tenantRepository: repository,
    });
    const query = section === 'overview' ? '?from=2026-08-01&to=2026-08-23' : '';

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/merchant/shops/${TENANT_ID}/${section}${query}`,
      headers: bearer(token),
    });

    expect(response.statusCode, response.body).toBe(expectedStatus);
    expect(response.headers['x-request-id']).toBeTruthy();
    await app.close();
  });

  it('accepts an exact decimal string and rejects float-shaped catalog prices', async () => {
    const { repository, methods } = merchantRepository();
    const { app } = await buildServer(env, {
      authVerifier: authVerifier(),
      tenantRepository: repository,
    });
    const valid = await app.inject({
      method: 'POST',
      url: `/api/v1/merchant/shops/${TENANT_ID}/catalog/products`,
      headers: { ...bearer('catalog'), 'idempotency-key': 'catalog-create-001' },
      payload: {
        title: 'Road press',
        description: 'Compact steel press.',
        category: 'Brewers',
        sku: 'brewer.road-press',
        material: 'steel',
        price: '2347.00',
        stock: 3,
        status: 'published',
      },
    });
    const tooPrecise = await app.inject({
      method: 'POST',
      url: `/api/v1/merchant/shops/${TENANT_ID}/catalog/products`,
      headers: { ...bearer('catalog'), 'idempotency-key': 'catalog-create-002' },
      payload: {
        title: 'Ambiguous press',
        description: 'Must not pass a float boundary.',
        category: 'Brewers',
        sku: 'brewer.ambiguous',
        material: 'steel',
        price: '23.001',
        stock: 3,
        status: 'published',
      },
    });
    const numeric = await app.inject({
      method: 'POST',
      url: `/api/v1/merchant/shops/${TENANT_ID}/catalog/products`,
      headers: { ...bearer('catalog'), 'idempotency-key': 'catalog-create-003' },
      payload: {
        title: 'Numeric press',
        description: 'Numbers are not accepted for money.',
        category: 'Brewers',
        sku: 'brewer.numeric',
        material: 'steel',
        price: 23.01,
        stock: 3,
        status: 'published',
      },
    });

    expect(valid.statusCode, valid.body).toBe(201);
    expect(methods.createMerchantProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USERS.catalog,
        tenantId: TENANT_ID,
        priceMinor: '234700',
        idempotencyKey: 'catalog-create-001',
      }),
    );
    expect(tooPrecise.statusCode).toBe(400);
    expect(tooPrecise.json().error).toBe('MONEY_DECIMAL_INVALID');
    expect(numeric.statusCode).toBe(400);
    expect(numeric.json().error).toBe('VALIDATION_ERROR');
    await app.close();
  });

  it('keeps viewers read-only and returns a stable version conflict', async () => {
    const { repository, methods } = merchantRepository();
    methods.updateMerchantRules.mockRejectedValueOnce(new Error('RULES_VERSION_CONFLICT'));
    const { app } = await buildServer(env, {
      authVerifier: authVerifier(),
      tenantRepository: repository,
    });
    const viewerWrite = await app.inject({
      method: 'PUT',
      url: `/api/v1/merchant/shops/${TENANT_ID}/rules`,
      headers: { ...bearer('viewer'), 'idempotency-key': 'rules-viewer-001' },
      payload: {
        expectedVersion: 1,
        hardCap: '3000.00',
        autonomousCap: '2500.00',
        forbiddenMaterials: ['glass'],
        offers: [],
        reason: 'No viewer writes.',
      },
    });
    const conflict = await app.inject({
      method: 'PUT',
      url: `/api/v1/merchant/shops/${TENANT_ID}/rules`,
      headers: { ...bearer('owner'), 'idempotency-key': 'rules-owner-001' },
      payload: {
        expectedVersion: 1,
        hardCap: '3000.00',
        autonomousCap: '2500.00',
        forbiddenMaterials: ['glass'],
        offers: [],
        reason: 'Publish reviewed limits.',
      },
    });

    expect(viewerWrite.statusCode).toBe(403);
    expect(viewerWrite.json().error).toBe('SHOP_CAPABILITY_REQUIRED');
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: 'RULES_VERSION_CONFLICT' });
    expect(conflict.json().requestId).toBeTruthy();
    await app.close();
  });

  it('supports focused detail, preview, stock, and immutable-slug settings routes', async () => {
    const { repository, methods } = merchantRepository();
    const { app } = await buildServer(env, {
      authVerifier: authVerifier(),
      tenantRepository: repository,
    });
    const firstCatalog = await app.inject({
      method: 'GET',
      url: `/api/v1/merchant/shops/${TENANT_ID}/catalog?limit=1`,
      headers: bearer('viewer'),
    });
    expect(firstCatalog.statusCode, firstCatalog.body).toBe(200);
    expect(firstCatalog.json().nextCursor).toEqual(expect.any(String));
    const secondCatalog = await app.inject({
      method: 'GET',
      url: `/api/v1/merchant/shops/${TENANT_ID}/catalog?limit=1&cursor=${encodeURIComponent(
        firstCatalog.json().nextCursor,
      )}`,
      headers: bearer('viewer'),
    });
    expect(secondCatalog.statusCode, secondCatalog.body).toBe(200);
    expect(methods.listMerchantCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({
        after: expect.objectContaining({
          id: '94000000-0000-4000-8000-000000000001',
        }),
      }),
    );

    const order = await app.inject({
      method: 'GET',
      url: `/api/v1/merchant/shops/${TENANT_ID}/orders/${CHECKOUT_ID}`,
      headers: bearer('finance'),
    });
    const preview = await app.inject({
      method: 'GET',
      url: `/api/v1/merchant/shops/${TENANT_ID}/rules/preview`,
      headers: bearer('viewer'),
    });
    const stock = await app.inject({
      method: 'POST',
      url: `/api/v1/merchant/shops/${TENANT_ID}/catalog/variants/96000000-0000-4000-8000-000000000001/stock-adjustments`,
      headers: { ...bearer('catalog'), 'idempotency-key': 'stock-adjust-001' },
      payload: { expectedVersion: 1, delta: 2, reason: 'Cycle count correction.' },
    });
    const settings = await app.inject({
      method: 'GET',
      url: `/api/v1/merchant/shops/${TENANT_ID}/settings`,
      headers: bearer('viewer'),
    });
    const changed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/merchant/shops/${TENANT_ID}/settings`,
      headers: { ...bearer('owner'), 'idempotency-key': 'settings-update-001' },
      payload: {
        expectedVersion: 1,
        name: 'Northstar Travel Coffee',
        blurb: 'Coffee gear for every road.',
        gstin: '29AAAAA0000A1Z5',
        reason: 'Clarify public copy.',
      },
    });
    const slugMutation = await app.inject({
      method: 'PATCH',
      url: `/api/v1/merchant/shops/${TENANT_ID}/settings`,
      headers: { ...bearer('owner'), 'idempotency-key': 'settings-update-002' },
      payload: {
        expectedVersion: 1,
        name: 'Northstar Travel Coffee',
        blurb: 'Coffee gear for every road.',
        slug: 'changed-slug',
        reason: 'This slice keeps slugs immutable.',
      },
    });

    expect(order.statusCode, order.body).toBe(200);
    expect(order.json()).toMatchObject({ paid: true, fulfillmentReady: true });
    expect(JSON.stringify(order.json())).not.toContain('payload');
    expect(preview.statusCode, preview.body).toBe(200);
    expect(stock.statusCode, stock.body).toBe(200);
    expect(methods.adjustMerchantStock).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: 1, delta: 2 }),
    );
    expect(settings.statusCode, settings.body).toBe(200);
    expect(settings.json()).toMatchObject({ synthetic: true });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(methods.updateMerchantSettings).toHaveBeenCalledWith(
      expect.objectContaining({ gstin: '29AAAAA0000A1Z5' }),
    );
    expect(changed.json()).toMatchObject({
      settings: {
        name: 'Northstar Travel Coffee',
        synthetic: true,
      },
    });
    expect(slugMutation.statusCode).toBe(400);
    expect(slugMutation.json().error).toBe('VALIDATION_ERROR');
    await app.close();
  });

  it('pages orders and recovery with cursor= and rejects leftover after=', async () => {
    const { repository, methods } = merchantRepository();
    const orderOne = {
      id: CHECKOUT_ID,
      receipt: 'cht_test_order',
      razorpayOrderId: 'order_test_safe',
      status: 'SETTLED',
      paymentState: 'captured',
      totalMinor: '234700',
      totalDisplay: '₹2,347.00',
      customerLabel: 'Buyer',
      createdAt: '2026-08-23T10:00:00.000Z',
      updatedAt: '2026-08-23T10:02:00.000Z',
      paid: true,
      fulfillmentReady: true,
    };
    const orderTwo = {
      ...orderOne,
      id: '92000000-0000-4000-8000-000000000002',
      receipt: 'cht_test_order_two',
      razorpayOrderId: 'order_test_two',
      updatedAt: '2026-08-22T10:02:00.000Z',
    };
    const recoveryOne = {
      checkoutId: CHECKOUT_ID,
      quoteId: '97000000-0000-4000-8000-000000000001',
      razorpayOrderId: 'order_test_safe',
      amountMinor: '234700',
      amountDisplay: '₹2,347.00',
      checkoutStatus: 'FAILED_PROVISIONAL',
      reconciliationStatus: 'unresolved',
      consentStatus: 'granted',
      sendStatus: 'not_sent',
      stopStatus: 'clear',
      canSend: true,
      blockedReason: null,
      updatedAt: '2026-08-23T10:00:00.000Z',
    };
    const recoveryTwo = {
      ...recoveryOne,
      checkoutId: '92000000-0000-4000-8000-000000000002',
      razorpayOrderId: 'order_test_two',
      updatedAt: '2026-08-22T10:00:00.000Z',
    };
    methods.listMerchantOrders.mockImplementation(
      async (input?: { after?: { id: string } | null }) =>
        input?.after
          ? { items: [orderTwo], cursor: null }
          : { items: [orderOne], cursor: { sortValue: orderOne.updatedAt, id: orderOne.id } },
    );
    methods.listMerchantRecovery.mockImplementation(
      async (input?: { after?: { id: string } | null }) =>
        input?.after
          ? { items: [recoveryTwo], cursor: null }
          : {
              items: [recoveryOne],
              cursor: { sortValue: recoveryOne.updatedAt, id: recoveryOne.checkoutId },
            },
    );
    const { app } = await buildServer(env, {
      authVerifier: authVerifier(),
      tenantRepository: repository,
    });

    const firstOrders = await app.inject({
      method: 'GET',
      url: `/api/v1/merchant/shops/${TENANT_ID}/orders?limit=1`,
      headers: bearer('viewer'),
    });
    expect(firstOrders.statusCode, firstOrders.body).toBe(200);
    expect(firstOrders.json().items).toEqual([expect.objectContaining({ id: orderOne.id })]);
    expect(firstOrders.json().nextCursor).toEqual(expect.any(String));
    const secondOrders = await app.inject({
      method: 'GET',
      url: `/api/v1/merchant/shops/${TENANT_ID}/orders?limit=1&cursor=${encodeURIComponent(
        firstOrders.json().nextCursor,
      )}`,
      headers: bearer('viewer'),
    });
    expect(secondOrders.statusCode, secondOrders.body).toBe(200);
    expect(secondOrders.json().items).toEqual([expect.objectContaining({ id: orderTwo.id })]);
    expect(methods.listMerchantOrders).toHaveBeenLastCalledWith(
      expect.objectContaining({ after: expect.objectContaining({ id: orderOne.id }) }),
    );

    const firstRecovery = await app.inject({
      method: 'GET',
      url: `/api/v1/merchant/shops/${TENANT_ID}/recovery?limit=1`,
      headers: bearer('support'),
    });
    expect(firstRecovery.statusCode, firstRecovery.body).toBe(200);
    expect(firstRecovery.json().items).toEqual([
      expect.objectContaining({ checkoutId: recoveryOne.checkoutId }),
    ]);
    const secondRecovery = await app.inject({
      method: 'GET',
      url: `/api/v1/merchant/shops/${TENANT_ID}/recovery?limit=1&cursor=${encodeURIComponent(
        firstRecovery.json().nextCursor,
      )}`,
      headers: bearer('support'),
    });
    expect(secondRecovery.statusCode, secondRecovery.body).toBe(200);
    expect(secondRecovery.json().items).toEqual([
      expect.objectContaining({ checkoutId: recoveryTwo.checkoutId }),
    ]);

    for (const section of ['catalog', 'orders', 'recovery'] as const) {
      const rejected = await app.inject({
        method: 'GET',
        url: `/api/v1/merchant/shops/${TENANT_ID}/${section}?limit=1&after=not-a-cursor`,
        headers: bearer(section === 'recovery' ? 'support' : 'viewer'),
      });
      expect(rejected.statusCode, rejected.body).toBe(400);
      expect(rejected.json().error).toBe('VALIDATION_ERROR');
    }
    await app.close();
  });

  it('sends one consented recovery email and exposes a safe blocked reason', async () => {
    resetKernel();
    const { quote } = buildCanonicalKit();
    const { repository, methods } = merchantRepository();
    const sendableRecovery = {
      ...(await methods.getMerchantRecovery()),
      quoteId: quote.id,
      amountMinor: String(quote.totalMinor),
      amountDisplay: quote.totalDisplay,
    };
    methods.getMerchantRecovery.mockReset();
    methods.getMerchantRecovery.mockResolvedValueOnce(sendableRecovery).mockResolvedValueOnce({
      ...sendableRecovery,
      checkoutStatus: 'SETTLED',
      canSend: false,
      blockedReason: 'PAYMENT_CAPTURED',
      stopStatus: 'captured',
    });
    await repository.saveRecoveryConsent({
      id: CONSENT_ID,
      tenantId: TENANT_ID,
      userId: USERS.support,
      email: 'buyer@example.invalid',
      purpose: 'payment_recovery',
      channel: 'email',
      grantedAt: '2026-08-23T09:00:00.000Z',
    });
    await repository.bindRecoveryConsent({
      tenantId: TENANT_ID,
      checkoutId: CHECKOUT_ID,
      consentId: CONSENT_ID,
      userId: USERS.support,
    });
    const sender = vi.fn(
      async () =>
        new Response(JSON.stringify({ message_id: 'msg_recovery_001' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof fetch;
    const { app } = await buildServer(env, {
      authVerifier: authVerifier(),
      tenantRepository: repository,
      fetch: sender,
      persist: durableRecoveryPersist(quote),
      razorpay: {
        async getOrder(orderId: string) {
          return {
            id: orderId,
            amount: Number(quote.totalMinor),
            currency: 'INR',
            receipt: 'cht_recovery',
            status: 'attempted',
          };
        },
        async listOrderPayments(orderId: string) {
          return [
            {
              id: 'pay_failed_recovery',
              order_id: orderId,
              amount: Number(quote.totalMinor),
              currency: 'INR',
              status: 'failed',
            },
          ];
        },
      },
    });
    const sent = await app.inject({
      method: 'POST',
      url: `/api/v1/merchant/shops/${TENANT_ID}/recovery/${CHECKOUT_ID}/send`,
      headers: { ...bearer('support'), 'idempotency-key': 'recovery-send-001' },
    });
    const blocked = await app.inject({
      method: 'POST',
      url: `/api/v1/merchant/shops/${TENANT_ID}/recovery/${CHECKOUT_ID}/send`,
      headers: { ...bearer('support'), 'idempotency-key': 'recovery-send-002' },
    });

    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json()).toEqual({
      action: 'sent',
      messageId: 'msg_recovery_001',
      requestId: sent.headers['x-request-id'],
    });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({
      action: 'blocked',
      reason: 'PAYMENT_CAPTURED',
    });
    expect(sender).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('reconciles and writes the first snapshot when listing canSend is false for RECONCILIATION_REQUIRED', async () => {
    resetKernel();
    const { quote } = buildCanonicalKit();
    const { repository, methods } = merchantRepository();
    methods.getMerchantRecovery.mockResolvedValue({
      checkoutId: CHECKOUT_ID,
      quoteId: quote.id,
      razorpayOrderId: 'order_test_safe',
      amountMinor: String(quote.totalMinor),
      amountDisplay: quote.totalDisplay,
      checkoutStatus: 'FAILED_PROVISIONAL',
      reconciliationStatus: 'unresolved',
      consentStatus: 'granted',
      sendStatus: 'not_sent',
      stopStatus: 'clear',
      canSend: false,
      blockedReason: 'RECONCILIATION_REQUIRED',
      updatedAt: '2026-08-23T10:00:00.000Z',
    });
    await repository.saveRecoveryConsent({
      id: CONSENT_ID,
      tenantId: TENANT_ID,
      userId: USERS.support,
      email: 'buyer@example.invalid',
      purpose: 'payment_recovery',
      channel: 'email',
      grantedAt: '2026-08-23T09:00:00.000Z',
    });
    await repository.bindRecoveryConsent({
      tenantId: TENANT_ID,
      checkoutId: CHECKOUT_ID,
      consentId: CONSENT_ID,
      userId: USERS.support,
    });
    const sender = vi.fn(
      async () =>
        new Response(JSON.stringify({ message_id: 'msg_recovery_first_snapshot' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof fetch;
    const { app } = await buildServer(env, {
      authVerifier: authVerifier(),
      tenantRepository: repository,
      fetch: sender,
      persist: durableRecoveryPersist(quote),
      razorpay: {
        async getOrder(orderId: string) {
          return {
            id: orderId,
            amount: Number(quote.totalMinor),
            currency: 'INR',
            receipt: 'cht_recovery',
            status: 'attempted',
          };
        },
        async listOrderPayments(orderId: string) {
          return [
            {
              id: 'pay_failed_recovery',
              order_id: orderId,
              amount: Number(quote.totalMinor),
              currency: 'INR',
              status: 'failed',
            },
          ];
        },
      },
    });
    const sent = await app.inject({
      method: 'POST',
      url: `/api/v1/merchant/shops/${TENANT_ID}/recovery/${CHECKOUT_ID}/send`,
      headers: { ...bearer('support'), 'idempotency-key': 'recovery-send-reconcile-001' },
    });
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json()).toMatchObject({ action: 'sent', messageId: 'msg_recovery_first_snapshot' });
    expect(sender).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('blocks recovery send with 409 when durable checkout is missing', async () => {
    resetKernel();
    const { quote } = buildCanonicalKit();
    const { repository, methods } = merchantRepository();
    methods.getMerchantRecovery.mockResolvedValue({
      ...(await methods.getMerchantRecovery()),
      quoteId: quote.id,
      amountMinor: String(quote.totalMinor),
      amountDisplay: quote.totalDisplay,
      canSend: true,
      blockedReason: null,
    });
    await repository.saveRecoveryConsent({
      id: CONSENT_ID,
      tenantId: TENANT_ID,
      userId: USERS.support,
      email: 'buyer@example.invalid',
      purpose: 'payment_recovery',
      channel: 'email',
      grantedAt: '2026-08-23T09:00:00.000Z',
    });
    await repository.bindRecoveryConsent({
      tenantId: TENANT_ID,
      checkoutId: CHECKOUT_ID,
      consentId: CONSENT_ID,
      userId: USERS.support,
    });
    const { app } = await buildServer(env, {
      authVerifier: authVerifier(),
      tenantRepository: repository,
      persist: {
        loadCheckout: async () => undefined,
      } as unknown as MoneyPersist,
      razorpay: {
        async getOrder() {
          throw new Error('RAZORPAY_SHOULD_NOT_BE_CALLED');
        },
        async listOrderPayments() {
          throw new Error('RAZORPAY_SHOULD_NOT_BE_CALLED');
        },
      },
    });
    const blocked = await app.inject({
      method: 'POST',
      url: `/api/v1/merchant/shops/${TENANT_ID}/recovery/${CHECKOUT_ID}/send`,
      headers: { ...bearer('support'), 'idempotency-key': 'recovery-send-missing-checkout' },
    });

    expect(blocked.statusCode, blocked.body).toBe(409);
    expect(blocked.json()).toMatchObject({
      action: 'blocked',
      reason: 'CHECKOUT_NOT_FOUND',
    });
    await app.close();
  });

  it('rejects tampered and cross-scope merchant cursors', async () => {
    const { repository, methods } = merchantRepository();
    const orderCursor = {
      sortValue: '2026-08-23T10:02:00.000Z',
      id: CHECKOUT_ID,
    };
    methods.listMerchantOrders.mockResolvedValue({
      items: [
        {
          id: CHECKOUT_ID,
          receipt: 'cht_test_order',
          razorpayOrderId: 'order_test_safe',
          status: 'SETTLED',
          paymentState: 'captured',
          totalMinor: '234700',
          totalDisplay: '₹2,347.00',
          customerLabel: 'Buyer',
          createdAt: '2026-08-23T10:00:00.000Z',
          updatedAt: orderCursor.sortValue,
          paid: true,
          fulfillmentReady: true,
        },
      ],
      cursor: orderCursor,
    });
    methods.listMerchantRecovery.mockResolvedValue({
      items: [],
      cursor: { sortValue: '2026-08-23T10:00:00.000Z', id: CHECKOUT_ID },
    });
    const { app } = await buildServer(env, {
      authVerifier: authVerifier(),
      tenantRepository: repository,
    });

    const catalog = await app.inject({
      method: 'GET',
      url: `/api/v1/merchant/shops/${TENANT_ID}/catalog?limit=1`,
      headers: bearer('viewer'),
    });
    expect(catalog.statusCode, catalog.body).toBe(200);
    const catalogCursor = catalog.json().nextCursor as string;
    expect(catalogCursor).toEqual(expect.any(String));

    const tampered = await app.inject({
      method: 'GET',
      url: `/api/v1/merchant/shops/${TENANT_ID}/catalog?limit=1&cursor=${encodeURIComponent(
        `${catalogCursor}x`,
      )}`,
      headers: bearer('viewer'),
    });
    expect(tampered.statusCode, tampered.body).toBe(400);
    expect(tampered.json().error).toBe('CURSOR_INVALID');

    const catalogOnOrders = await app.inject({
      method: 'GET',
      url: `/api/v1/merchant/shops/${TENANT_ID}/orders?limit=1&cursor=${encodeURIComponent(
        catalogCursor,
      )}`,
      headers: bearer('viewer'),
    });
    expect(catalogOnOrders.statusCode, catalogOnOrders.body).toBe(400);
    expect(catalogOnOrders.json().error).toBe('CURSOR_INVALID');

    const otherShop = signMerchantCursor(
      'merchant:harbor-spice-in:catalog',
      '2026-08-23T10:00:00.000Z',
      '94000000-0000-4000-8000-000000000001',
    );
    const otherShopCatalog = await app.inject({
      method: 'GET',
      url: `/api/v1/merchant/shops/${TENANT_ID}/catalog?limit=1&cursor=${encodeURIComponent(
        otherShop,
      )}`,
      headers: bearer('viewer'),
    });
    expect(otherShopCatalog.statusCode, otherShopCatalog.body).toBe(400);
    expect(otherShopCatalog.json().error).toBe('CURSOR_INVALID');

    const orders = await app.inject({
      method: 'GET',
      url: `/api/v1/merchant/shops/${TENANT_ID}/orders?limit=1`,
      headers: bearer('viewer'),
    });
    expect(orders.statusCode, orders.body).toBe(200);
    const ordersCursor = orders.json().nextCursor as string;
    const filteredOrders = await app.inject({
      method: 'GET',
      url: `/api/v1/merchant/shops/${TENANT_ID}/orders?limit=1&status=SETTLED&cursor=${encodeURIComponent(
        ordersCursor,
      )}`,
      headers: bearer('viewer'),
    });
    expect(filteredOrders.statusCode, filteredOrders.body).toBe(400);
    expect(filteredOrders.json().error).toBe('CURSOR_INVALID');

    const recovery = await app.inject({
      method: 'GET',
      url: `/api/v1/merchant/shops/${TENANT_ID}/recovery?limit=1`,
      headers: bearer('support'),
    });
    expect(recovery.statusCode, recovery.body).toBe(200);
    const recoveryCursor = recovery.json().nextCursor as string;
    const filteredRecovery = await app.inject({
      method: 'GET',
      url: `/api/v1/merchant/shops/${TENANT_ID}/recovery?limit=1&status=RECONCILING&cursor=${encodeURIComponent(
        recoveryCursor,
      )}`,
      headers: bearer('support'),
    });
    expect(filteredRecovery.statusCode, filteredRecovery.body).toBe(400);
    expect(filteredRecovery.json().error).toBe('CURSOR_INVALID');
    await app.close();
  });

  it('applies the same semantic date contract on overview and orders', async () => {
    const { repository } = merchantRepository();
    const { app } = await buildServer(env, {
      authVerifier: authVerifier(),
      tenantRepository: repository,
    });

    const leapDay = await app.inject({
      method: 'GET',
      url: `/api/v1/merchant/shops/${TENANT_ID}/overview?from=2024-02-29&to=2024-03-01`,
      headers: bearer('viewer'),
    });
    expect(leapDay.statusCode, leapDay.body).toBe(200);

    for (const [path, query] of [
      ['overview', 'from=2025-02-29&to=2025-03-01'],
      ['overview', 'from=2026-08-31&to=2026-08-01'],
      ['overview', 'from=2024-01-01&to=2025-01-01'],
      ['overview', 'from=2026-02-31&to=2026-03-01'],
      ['orders', 'from=2025-02-29&to=2025-03-01'],
      ['orders', 'from=2026-08-31&to=2026-08-01'],
      ['orders', 'from=2024-01-01&to=2025-01-01'],
      ['orders', 'to=2026-02-30'],
    ] as const) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/merchant/shops/${TENANT_ID}/${path}?${query}`,
        headers: bearer('viewer'),
      });
      expect(response.statusCode, `${path}?${query} ${response.body}`).toBe(400);
      expect(response.json().error).toBe('DATE_RANGE_INVALID');
    }

    const oneSidedOverview = await app.inject({
      method: 'GET',
      url: `/api/v1/merchant/shops/${TENANT_ID}/overview?from=2026-01-01`,
      headers: bearer('viewer'),
    });
    expect(oneSidedOverview.statusCode, oneSidedOverview.body).toBe(200);
    const oneSidedOrders = await app.inject({
      method: 'GET',
      url: `/api/v1/merchant/shops/${TENANT_ID}/orders?from=2026-01-01`,
      headers: bearer('viewer'),
    });
    expect(oneSidedOrders.statusCode, oneSidedOrders.body).toBe(200);
    await app.close();
  });
});
