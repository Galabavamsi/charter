import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetKernel } from '@charter/commerce';
import { resetCheckouts } from '@charter/payments';
import { getConversation, resetConversations, type ChatMessage } from '@charter/orchestrator';
import { AuthTokenError, type AuthVerifier, type VerifiedIdentity } from './auth/verifier.js';
import {
  createMemoryTenantRepository,
  type MemoryTenantRepository,
} from './testing/memory-tenant-repository.js';
import { buildServer } from './server.js';

const OWNER_A = '61000000-0000-4000-8000-000000000001';
const OWNER_B = '61000000-0000-4000-8000-000000000002';
const BUYER_A = '61000000-0000-4000-8000-000000000003';
const BUYER_B = '61000000-0000-4000-8000-000000000004';
const PLATFORM = '61000000-0000-4000-8000-000000000005';
const VIEWER_A = '61000000-0000-4000-8000-000000000006';
const SUPPORT_A = '61000000-0000-4000-8000-000000000007';

const testEnv = {
  DATABASE_URL: 'postgres://unused',
  CHARTER_ENV: 'test',
  RAZORPAY_MODE: 'test',
} as const;

function verifier(): AuthVerifier {
  const identities = new Map<string, VerifiedIdentity>([
    ['owner-a', { userId: OWNER_A, email: 'shared@example.com' }],
    ['owner-b', { userId: OWNER_B, email: 'shared@example.com' }],
    ['buyer-a', { userId: BUYER_A, email: 'buyer-a@example.com' }],
    ['buyer-b', { userId: BUYER_B, email: 'buyer-b@example.com' }],
    ['platform', { userId: PLATFORM, email: 'operator@example.com' }],
    ['escalated', { userId: BUYER_A, email: 'owner-a@example.com' }],
  ]);
  return {
    async verify(token) {
      if (token === 'expired') {
        throw new AuthTokenError('AUTH_TOKEN_EXPIRED');
      }
      if (token === 'forged') {
        throw new AuthTokenError('AUTH_INVALID_TOKEN');
      }
      const identity = identities.get(token);
      if (!identity) {
        throw new AuthTokenError('AUTH_INVALID_TOKEN');
      }
      return identity;
    },
  };
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

function repository(): MemoryTenantRepository {
  return createMemoryTenantRepository({
    memberships: [
      { userId: OWNER_A, tenantId: 'northstar-demo-in', role: 'owner' },
      { userId: OWNER_B, tenantId: 'indigo-desk-in', role: 'owner' },
      { userId: VIEWER_A, tenantId: 'northstar-demo-in', role: 'viewer' },
      { userId: SUPPORT_A, tenantId: 'northstar-demo-in', role: 'support' },
    ],
    platformRoles: [{ userId: PLATFORM, role: 'admin' }],
  });
}

describe('tenant API authorization boundary', () => {
  beforeEach(() => {
    resetKernel();
    resetCheckouts();
    resetConversations();
  });

  it('returns stable 401 codes for missing, expired, and forged access tokens', async () => {
    const { app } = await buildServer(testEnv, {
      authVerifier: verifier(),
      tenantRepository: repository(),
    });

    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/carts',
      payload: { shopSlug: 'northstar' },
    });
    const expired = await app.inject({
      method: 'POST',
      url: '/api/v1/carts',
      headers: bearer('expired'),
      payload: { shopSlug: 'northstar' },
    });
    const forged = await app.inject({
      method: 'POST',
      url: '/api/v1/carts',
      headers: bearer('forged'),
      payload: { shopSlug: 'northstar' },
    });

    expect(missing.statusCode).toBe(401);
    expect(missing.json().error).toBe('AUTH_REQUIRED');
    expect(expired.statusCode).toBe(401);
    expect(expired.json().error).toBe('AUTH_TOKEN_EXPIRED');
    expect(forged.statusCode).toBe(401);
    expect(forged.json().error).toBe('AUTH_INVALID_TOKEN');
    expect(missing.headers['x-request-id']).toBeTruthy();
    await app.close();
  });

  it('does not grant authentication implicitly in server test mode', async () => {
    const store = repository();
    const { app } = await buildServer(testEnv, { tenantRepository: store });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/carts',
      headers: bearer('buyer-a'),
      payload: { shopSlug: 'northstar' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('AUTH_INVALID_TOKEN');
    expect(store.state.identities.size).toBe(0);
    await app.close();
  });

  it('rate limits invalid tokens by IP before verification and identity sync', async () => {
    let verificationCalls = 0;
    const store = repository();
    const { app } = await buildServer(testEnv, {
      authVerifier: {
        async verify() {
          verificationCalls += 1;
          throw new AuthTokenError('AUTH_INVALID_TOKEN');
        },
      },
      tenantRepository: store,
    });

    for (let requestNumber = 0; requestNumber < 120; requestNumber += 1) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/shops',
        headers: bearer(`forged-${requestNumber}`),
      });
      expect(response.statusCode).toBe(401);
    }
    const limited = await app.inject({
      method: 'GET',
      url: '/api/v1/shops',
      headers: bearer('forged-final'),
    });

    expect(limited.statusCode, limited.body).toBe(429);
    expect(limited.json().error).toBe('RATE_LIMITED');
    expect(verificationCalls).toBe(120);
    expect(store.state.identities.size).toBe(0);
    await app.close();
  });

  it('ignores forwarded IPs by default and trusts one Render proxy hop deliberately', async () => {
    const direct = await buildServer(testEnv, {
      authVerifier: verifier(),
      tenantRepository: repository(),
    });
    for (let requestNumber = 0; requestNumber < 120; requestNumber += 1) {
      const response = await direct.app.inject({
        method: 'GET',
        url: '/api/v1/shops',
        headers: { 'x-forwarded-for': '198.51.100.10' },
      });
      expect(response.statusCode).toBe(200);
    }
    const spoofed = await direct.app.inject({
      method: 'GET',
      url: '/api/v1/shops',
      headers: { 'x-forwarded-for': '203.0.113.20' },
    });
    expect(spoofed.statusCode).toBe(429);
    await direct.app.close();

    const proxied = await buildServer(
      { ...testEnv, RENDER: 'true' },
      {
        authVerifier: verifier(),
        tenantRepository: repository(),
      },
    );
    for (let requestNumber = 0; requestNumber < 120; requestNumber += 1) {
      const response = await proxied.app.inject({
        method: 'GET',
        url: '/api/v1/shops',
        headers: { 'x-forwarded-for': '198.51.100.10' },
      });
      expect(response.statusCode).toBe(200);
    }
    const otherClient = await proxied.app.inject({
      method: 'GET',
      url: '/api/v1/shops',
      headers: { 'x-forwarded-for': '203.0.113.20' },
    });
    expect(otherClient.statusCode).toBe(200);
    await proxied.app.close();
  });

  it('authenticates protected routes before checking config or resource existence', async () => {
    const { app } = await buildServer(testEnv, {
      authVerifier: verifier(),
      tenantRepository: repository(),
    });
    const resourceId = '81000000-0000-4000-8000-000000000099';
    const requests = [
      {
        method: 'POST' as const,
        url: `/api/v1/conversations/${resourceId}/turns`,
        payload: { shopSlug: 'northstar', text: 'hello' },
      },
      {
        method: 'POST' as const,
        url: `/api/v1/quotes/${resourceId}/checkout`,
        payload: { shopSlug: 'northstar' },
      },
      {
        method: 'POST' as const,
        url: `/api/v1/checkouts/${resourceId}/callback`,
        payload: {
          shopSlug: 'northstar',
          razorpay_order_id: 'order_test',
          razorpay_payment_id: 'pay_test',
          razorpay_signature: 'signature',
        },
      },
      {
        method: 'GET' as const,
        url: `/api/v1/checkouts/${resourceId}?shopSlug=unknown-shop`,
      },
      {
        method: 'POST' as const,
        url: `/api/v1/checkouts/${resourceId}/recovery`,
        payload: {
          shopSlug: 'unknown-shop',
          consentId: '82000000-0000-4000-8000-000000000099',
        },
      },
      {
        method: 'POST' as const,
        url: `/api/v1/voice/${resourceId}/chat/completions`,
        payload: { messages: [] },
      },
    ];

    for (const request of requests) {
      const response = await app.inject(request);
      expect(response.statusCode, `${request.method} ${request.url}: ${response.body}`).toBe(401);
      expect(response.json().error).toBe('AUTH_REQUIRED');
    }
    await app.close();
  });

  it('validates privileged request bodies and redacts repository failures', async () => {
    const store = repository();
    const { app } = await buildServer(testEnv, {
      authVerifier: verifier(),
      tenantRepository: store,
    });

    const extraCatalogField = await app.inject({
      method: 'POST',
      url: '/api/v1/shops/northstar-demo-in/items',
      headers: bearer('owner-a'),
      payload: {
        title: 'Schema item',
        priceRupees: 99,
        stock: 1,
        unexpected: 'ignored-before',
      },
    });
    const coercedStock = await app.inject({
      method: 'PATCH',
      url: '/api/v1/shops/northstar-demo-in/items/grinder.pocket-lite',
      headers: bearer('owner-a'),
      payload: { stock: '4' },
    });
    const invalidApproval = await app.inject({
      method: 'POST',
      url: '/api/v1/register/approvals/83000000-0000-4000-8000-000000000099',
      headers: bearer('owner-a'),
      payload: { tenantId: 'northstar-demo-in', decision: 'approve' },
    });
    const extraKillField = await app.inject({
      method: 'POST',
      url: '/api/v1/control/kill',
      headers: bearer('platform'),
      payload: { scope: 'global', on: true, unexpected: true },
    });

    expect(extraCatalogField.statusCode).toBe(400);
    expect(extraCatalogField.json().error).toBe('VALIDATION_ERROR');
    expect(coercedStock.statusCode).toBe(400);
    expect(coercedStock.json().error).toBe('VALIDATION_ERROR');
    expect(invalidApproval.statusCode).toBe(400);
    expect(invalidApproval.json().error).toBe('VALIDATION_ERROR');
    expect(extraKillField.statusCode).toBe(400);
    expect(extraKillField.json().error).toBe('VALIDATION_ERROR');

    store.createMerchantProduct = async () => {
      throw new Error('duplicate key value violates unique constraint variants_tenant_id_sku_key');
    };
    const failedCatalogWrite = await app.inject({
      method: 'POST',
      url: '/api/v1/merchant/shops/northstar-demo-in/catalog/products',
      headers: { ...bearer('owner-a'), 'idempotency-key': 'safe-catalog-failure' },
      payload: {
        title: 'Safe failure',
        description: 'Safe failure record.',
        category: 'Safety',
        sku: 'safe.failure',
        material: 'other',
        price: '99.00',
        stock: 1,
        status: 'published',
      },
    });
    expect(failedCatalogWrite.statusCode).toBe(500);
    expect(failedCatalogWrite.json().error).toBe('CATALOG_CREATE_FAILED');
    expect(failedCatalogWrite.body).not.toContain('duplicate key');
    await app.close();
  });

  it('rejects malformed route parameters and ambiguous query values', async () => {
    const { app } = await buildServer(testEnv, {
      authVerifier: verifier(),
      tenantRepository: repository(),
    });

    const malformedTenant = await app.inject({
      method: 'GET',
      url: '/api/v1/merchants/INVALID_TENANT',
    });
    const malformedCart = await app.inject({
      method: 'GET',
      url: '/api/v1/carts/not-a-uuid?shopSlug=northstar',
      headers: bearer('buyer-a'),
    });
    const malformedQuote = await app.inject({
      method: 'GET',
      url: '/api/v1/quotes/not-a-uuid?shopSlug=northstar',
      headers: bearer('buyer-a'),
    });
    const ambiguousShop = await app.inject({
      method: 'GET',
      url: '/api/v1/shops?slug=northstar&slug=indigo-desk',
    });

    for (const response of [malformedTenant, malformedCart, malformedQuote, ambiguousShop]) {
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error).toBe('VALIDATION_ERROR');
    }
    await app.close();
  });

  it('requires member context for unpublished catalog reads and writes', async () => {
    const store = repository();

    await expect(
      store.findShopByTenantIdForMember(VIEWER_A, 'northstar-demo-in'),
    ).resolves.toMatchObject({ tenantId: 'northstar-demo-in' });
    await expect(store.listCatalogForMember(VIEWER_A, 'northstar-demo-in')).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ published: true })]),
    );
    await expect(store.listCatalogForMember(BUYER_A, 'northstar-demo-in')).rejects.toThrow(
      'SHOP_MEMBERSHIP_REQUIRED',
    );
    await expect(
      store.addCatalogItem(VIEWER_A, 'northstar-demo-in', {
        title: 'Viewer write',
        priceRupees: 10,
        stock: 1,
      }),
    ).rejects.toThrow('SHOP_MEMBERSHIP_REQUIRED');
    await expect(
      store.setCatalogStock(SUPPORT_A, 'northstar-demo-in', 'grinder.pocket-lite', 99),
    ).rejects.toThrow('SHOP_MEMBERSHIP_REQUIRED');

    const item = await store.addCatalogItem(OWNER_A, 'northstar-demo-in', {
      title: 'Owner item',
      priceRupees: 10,
      stock: 1,
    });
    await expect(
      store.setCatalogStock(OWNER_A, 'northstar-demo-in', item.sku, 3),
    ).resolves.toMatchObject({ stock: 3 });
  });

  it('retires legacy float-price and blind-stock HTTP writes', async () => {
    const { app } = await buildServer(testEnv, {
      authVerifier: verifier(),
      tenantRepository: repository(),
    });
    const legacyCreate = await app.inject({
      method: 'POST',
      url: '/api/v1/shops/northstar-demo-in/items',
      headers: bearer('owner-a'),
      payload: { title: 'Legacy item', priceRupees: 99.99, stock: 1 },
    });
    const legacyStock = await app.inject({
      method: 'PATCH',
      url: '/api/v1/shops/northstar-demo-in/items/grinder.pocket-lite',
      headers: bearer('owner-a'),
      payload: { stock: 12 },
    });

    expect(legacyCreate.statusCode).toBe(410);
    expect(legacyCreate.json().error).toBe('CATALOG_ROUTE_REPLACED');
    expect(legacyStock.statusCode).toBe(410);
    expect(legacyStock.json().error).toBe('CATALOG_ROUTE_REPLACED');
    await app.close();
  });

  it('filters malformed persisted messages at text and voice hydration boundaries', async () => {
    const store = repository();
    const textConversationId = '81000000-0000-4000-8000-000000000001';
    const voiceConversationId = '81000000-0000-4000-8000-000000000002';
    const persistedMessages: unknown[] = [
      { role: 'system', content: 'System context', ignored: 'strip me' },
      { role: 'user', content: 'Find a grinder' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_catalog',
            type: 'function',
            function: { name: 'search_catalog', arguments: '{"query":"grinder"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_catalog', content: '{"items":[]}' },
      { role: 'user', content: { injected: true } },
      {
        role: 'assistant',
        content: 'unsafe tool shape',
        tool_calls: [
          {
            id: 'call_remote',
            type: 'remote',
            function: { name: 'fetch', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 42, content: 'wrong id type' },
      null,
    ];
    const expectedMessages: ChatMessage[] = [
      { role: 'system', content: 'System context' },
      { role: 'user', content: 'Find a grinder' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_catalog',
            type: 'function',
            function: { name: 'search_catalog', arguments: '{"query":"grinder"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_catalog', content: '{"items":[]}' },
    ];
    for (const id of [textConversationId, voiceConversationId]) {
      await store.saveConversation({
        id,
        tenantId: 'northstar-demo-in',
        userId: BUYER_A,
        expectedRevision: 0,
        state: {
          cartId: null,
          quoteId: null,
          catalogLoaded: false,
          pendingCheckout: null,
          messages: persistedMessages,
        },
      });
    }
    const { app } = await buildServer(
      { ...testEnv, FIREWORKS_API_KEY: 'fw_test' },
      {
        authVerifier: verifier(),
        tenantRepository: store,
      },
    );

    const textResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${textConversationId}?shopSlug=northstar`,
      headers: bearer('buyer-a'),
    });
    const voiceResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/voice/${voiceConversationId}/chat/completions`,
      headers: bearer('buyer-a'),
      payload: { shopSlug: 'northstar', messages: [] },
    });

    expect(textResponse.statusCode).toBe(200);
    expect(voiceResponse.statusCode).toBe(200);
    expect(voiceResponse.json().requestId).toBe(voiceResponse.headers['x-request-id']);
    expect(getConversation(textConversationId)?.messages).toEqual(expectedMessages);
    expect(getConversation(voiceConversationId)?.messages).toEqual(expectedMessages);
    await app.close();
  });

  it('persists pending checkout consumption before returning so restart cannot redeliver it', async () => {
    const store = repository();
    const conversationId = '81000000-0000-4000-8000-000000000003';
    const pendingCheckout = {
      checkoutId: '82000000-0000-4000-8000-000000000003',
      orderId: 'order_pending_once',
      amount: 234700,
      currency: 'INR',
    };
    await store.saveConversation({
      id: conversationId,
      tenantId: 'northstar-demo-in',
      userId: BUYER_A,
      expectedRevision: 0,
      state: {
        cartId: null,
        quoteId: null,
        catalogLoaded: false,
        pendingCheckout,
        messages: [],
      },
    });
    const { app } = await buildServer(testEnv, {
      authVerifier: verifier(),
      tenantRepository: store,
    });

    resetConversations();
    const first = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conversationId}?shopSlug=northstar&takeCheckout=1`,
      headers: bearer('buyer-a'),
    });
    resetConversations();
    const afterRestart = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conversationId}?shopSlug=northstar&takeCheckout=1`,
      headers: bearer('buyer-a'),
    });

    expect(first.statusCode).toBe(200);
    expect(first.json().checkout).toEqual(pendingCheckout);
    expect(afterRestart.statusCode).toBe(200);
    expect(afterRestart.json().checkout).toBeNull();
    expect(
      (
        await store.loadConversation({
          id: conversationId,
          tenantId: 'northstar-demo-in',
          userId: BUYER_A,
        })
      )?.state.pendingCheckout,
    ).toBeNull();
    await app.close();
  });

  it('serializes concurrent pending checkout consumers in the memory repository', async () => {
    const store = repository();
    const input = {
      id: '81000000-0000-4000-8000-000000000004',
      tenantId: 'northstar-demo-in',
      userId: BUYER_A,
    };
    const pendingCheckout = {
      checkoutId: '82000000-0000-4000-8000-000000000004',
      orderId: 'order_memory_concurrent',
      amount: 234700,
      currency: 'INR',
    };
    await store.saveConversation({
      ...input,
      expectedRevision: 0,
      state: {
        cartId: null,
        quoteId: null,
        catalogLoaded: false,
        pendingCheckout,
        messages: [],
      },
    });

    const consumed = await Promise.all([
      store.consumePendingCheckout(input),
      store.consumePendingCheckout(input),
    ]);

    expect(
      consumed.map((result) => result?.checkout).filter((checkout) => checkout !== null),
    ).toEqual([pendingCheckout]);
    expect(
      consumed.map((result) => result?.checkout).filter((checkout) => checkout === null),
    ).toHaveLength(1);
  });

  it('rejects a stale memory save racing a pending checkout consumption', async () => {
    const store = repository();
    const input = {
      id: '81000000-0000-4000-8000-000000000006',
      tenantId: 'northstar-demo-in',
      userId: BUYER_A,
    };
    const pendingCheckout = {
      checkoutId: '82000000-0000-4000-8000-000000000006',
      orderId: 'order_memory_stale_save',
      amount: 234700,
      currency: 'INR',
    };
    const initialRevision = await store.saveConversation({
      ...input,
      expectedRevision: 0,
      state: {
        cartId: null,
        quoteId: null,
        catalogLoaded: false,
        pendingCheckout,
        messages: [],
      },
    });
    const stale = await store.loadConversation(input);
    expect(stale?.revision).toBe(initialRevision);

    const [firstConsumer, secondConsumer, staleSave] = await Promise.allSettled([
      store.consumePendingCheckout(input),
      store.consumePendingCheckout(input),
      store.saveConversation({
        ...input,
        expectedRevision: stale!.revision,
        state: {
          ...stale!.state,
          messages: [{ role: 'user', content: 'stale turn' }],
        },
      }),
    ]);

    const consumedCheckouts = [firstConsumer, secondConsumer].flatMap((result) =>
      result.status === 'fulfilled' ? [result.value?.checkout ?? null] : [],
    );
    expect(consumedCheckouts.filter((checkout) => checkout !== null)).toEqual([pendingCheckout]);
    expect(consumedCheckouts.filter((checkout) => checkout === null)).toHaveLength(1);
    expect(staleSave).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: 'CONVERSATION_VERSION_CONFLICT' }),
    });
    const latest = await store.loadConversation(input);
    expect(latest?.state.pendingCheckout).toBeNull();
    expect(latest?.state.messages).toEqual([]);
  });

  it('uses repository authority for two concurrent pending checkout requests', async () => {
    const store = repository();
    const conversationId = '81000000-0000-4000-8000-000000000005';
    const pendingCheckout = {
      checkoutId: '82000000-0000-4000-8000-000000000005',
      orderId: 'order_route_concurrent',
      amount: 234700,
      currency: 'INR',
    };
    await store.saveConversation({
      id: conversationId,
      tenantId: 'northstar-demo-in',
      userId: BUYER_A,
      expectedRevision: 0,
      state: {
        cartId: null,
        quoteId: null,
        catalogLoaded: false,
        pendingCheckout,
        messages: [],
      },
    });
    const consumePendingCheckout = vi.spyOn(store, 'consumePendingCheckout');
    const { app } = await buildServer(testEnv, {
      authVerifier: verifier(),
      tenantRepository: store,
    });
    resetConversations();
    const hydrated = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conversationId}?shopSlug=northstar`,
      headers: bearer('buyer-a'),
    });
    expect(hydrated.json().checkout).toEqual(pendingCheckout);

    const responses = await Promise.all([
      app.inject({
        method: 'GET',
        url: `/api/v1/conversations/${conversationId}?shopSlug=northstar&takeCheckout=1`,
        headers: bearer('buyer-a'),
      }),
      app.inject({
        method: 'GET',
        url: `/api/v1/conversations/${conversationId}?shopSlug=northstar&takeCheckout=1`,
        headers: bearer('buyer-a'),
      }),
    ]);

    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    expect(responses.map((response) => response.json().checkout).filter(Boolean)).toEqual([
      pendingCheckout,
    ]);
    expect(consumePendingCheckout).toHaveBeenCalledTimes(2);
    expect(getConversation(conversationId)?.pendingCheckout).toBeNull();
    await app.close();
  });

  it('persists text and voice mutations even when the model call fails', async () => {
    const store = repository();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unavailable', { status: 503 })),
    );
    const { app } = await buildServer(
      { ...testEnv, FIREWORKS_API_KEY: 'fw_test' },
      {
        authVerifier: verifier(),
        tenantRepository: store,
      },
    );
    try {
      const textCreated = await app.inject({
        method: 'POST',
        url: '/api/v1/conversations',
        headers: bearer('buyer-a'),
        payload: { shopSlug: 'northstar' },
      });
      const voiceCreated = await app.inject({
        method: 'POST',
        url: '/api/v1/conversations',
        headers: bearer('buyer-a'),
        payload: { shopSlug: 'northstar' },
      });
      const textId = textCreated.json().id as string;
      const voiceId = voiceCreated.json().id as string;

      const textFailed = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${textId}/turns`,
        headers: bearer('buyer-a'),
        payload: { shopSlug: 'northstar', text: 'Remember this text turn' },
      });
      const voiceFailed = await app.inject({
        method: 'POST',
        url: `/api/v1/voice/${voiceId}/chat/completions`,
        headers: bearer('buyer-a'),
        payload: {
          shopSlug: 'northstar',
          messages: [{ role: 'user', content: 'Remember this voice turn' }],
        },
      });

      expect(textFailed.statusCode).toBe(200);
      expect(voiceFailed.statusCode).toBe(200);
      resetConversations();
      for (const [id, expectedText] of [
        [textId, 'Remember this text turn'],
        [voiceId, 'Remember this voice turn'],
      ] as const) {
        const rehydrated = await app.inject({
          method: 'GET',
          url: `/api/v1/conversations/${id}?shopSlug=northstar`,
          headers: bearer('buyer-a'),
        });
        expect(rehydrated.statusCode).toBe(200);
        expect(getConversation(id)?.messages).toContainEqual({
          role: 'user',
          content: expectedText,
        });
      }
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  });

  it('ignores claimed email and role, then denies cross-tenant catalog writes', async () => {
    const store = repository();
    const { app } = await buildServer(testEnv, {
      authVerifier: verifier(),
      tenantRepository: store,
    });

    const escalated = await app.inject({
      method: 'POST',
      url: '/api/v1/shops/northstar-demo-in/items',
      headers: bearer('escalated'),
      payload: { title: 'Forged Owner Item', priceRupees: 99, stock: 1 },
    });
    const crossTenant = await app.inject({
      method: 'POST',
      url: '/api/v1/shops/indigo-desk-in/items',
      headers: bearer('owner-a'),
      payload: { title: 'Cross Tenant Item', priceRupees: 99, stock: 1 },
    });

    expect(escalated.statusCode).toBe(403);
    expect(escalated.json().error).toBe('SHOP_MEMBERSHIP_REQUIRED');
    expect(crossTenant.statusCode).toBe(403);
    expect(crossTenant.json().error).toBe('SHOP_MEMBERSHIP_REQUIRED');
    expect(await store.listCatalogForMember(OWNER_B, 'indigo-desk-in')).not.toContainEqual(
      expect.objectContaining({ title: 'Cross Tenant Item' }),
    );
    await app.close();
  });

  it('derives cart tenancy from a canonical shop slug and enforces buyer ownership', async () => {
    const { app } = await buildServer(testEnv, {
      authVerifier: verifier(),
      tenantRepository: repository(),
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/carts',
      headers: bearer('buyer-a'),
      payload: { shopSlug: 'indigo-desk' },
    });

    expect(created.statusCode).toBe(200);
    expect(created.json().tenantId).toBe('indigo-desk-in');
    const cartId = created.json().id as string;

    const own = await app.inject({
      method: 'GET',
      url: `/api/v1/carts/${cartId}?shopSlug=indigo-desk`,
      headers: bearer('buyer-a'),
    });
    const otherBuyer = await app.inject({
      method: 'GET',
      url: `/api/v1/carts/${cartId}?shopSlug=indigo-desk`,
      headers: bearer('buyer-b'),
    });
    const wrongTenant = await app.inject({
      method: 'GET',
      url: `/api/v1/carts/${cartId}?shopSlug=northstar`,
      headers: bearer('buyer-a'),
    });

    expect(own.statusCode).toBe(200);
    expect(otherBuyer.statusCode).toBe(403);
    expect(otherBuyer.json().error).toBe('RESOURCE_FORBIDDEN');
    expect(wrongTenant.statusCode).toBe(404);
    expect(wrongTenant.json().error).toBe('CART_NOT_FOUND');
    await app.close();
  });

  it('provisions a shop with the authenticated subject as owner and a default policy', async () => {
    const store = repository();
    const { app } = await buildServer(testEnv, {
      authVerifier: verifier(),
      tenantRepository: store,
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/shops',
      headers: { ...bearer('buyer-a'), 'idempotency-key': 'tenant-shop-create-001' },
      payload: { name: 'Evaluator Tea', blurb: 'Leaf and cups.' },
    });

    expect(created.statusCode).toBe(201);
    const tenantId = created.json().shop.tenantId as string;
    await expect(store.membershipRole(BUYER_A, tenantId)).resolves.toBe('owner');
    await expect(store.getPolicy(tenantId)).resolves.toMatchObject({
      hardCapMinor: 500000n,
      autonomousCapMinor: 250000n,
    });
    await app.close();
  });

  it('denies Control to buyers and scopes kill switches to the selected tenant', async () => {
    const store = repository();
    const { app } = await buildServer(testEnv, {
      authVerifier: verifier(),
      tenantRepository: store,
    });

    const denied = await app.inject({
      method: 'GET',
      url: '/api/v1/control',
      headers: bearer('buyer-a'),
    });
    const killed = await app.inject({
      method: 'POST',
      url: '/api/v1/control/kill',
      headers: bearer('platform'),
      payload: { scope: 'tenant', tenantId: 'indigo-desk-in', on: true },
    });

    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe('PLATFORM_ROLE_REQUIRED');
    expect(killed.statusCode).toBe(200);
    await expect(store.isCheckoutKilled('indigo-desk-in')).resolves.toBe(true);
    await expect(store.isCheckoutKilled('northstar-demo-in')).resolves.toBe(false);
    await app.close();
  });

  it('returns verified account identity and repository-owned roles from /me', async () => {
    const store = repository();
    const { app } = await buildServer(testEnv, {
      authVerifier: verifier(),
      tenantRepository: store,
    });

    const missing = await app.inject({ method: 'GET', url: '/api/v1/me' });
    const owner = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: bearer('owner-a'),
    });
    const platform = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: bearer('platform'),
    });

    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toMatchObject({ error: 'AUTH_REQUIRED' });
    expect(owner.statusCode).toBe(200);
    expect(owner.json()).toEqual({
      profile: { userId: OWNER_A, email: 'shared@example.com' },
      shops: [
        expect.objectContaining({
          tenantId: 'northstar-demo-in',
          slug: 'northstar',
          role: 'owner',
        }),
      ],
      platformRoles: [],
    });
    expect(platform.statusCode).toBe(200);
    expect(platform.json()).toEqual({
      profile: { userId: PLATFORM, email: 'operator@example.com' },
      shops: [],
      platformRoles: ['admin'],
    });
    await app.close();
  });

  it('keeps public reads open and returns JSON for unknown API routes', async () => {
    const { app } = await buildServer(testEnv, {
      authVerifier: verifier(),
      tenantRepository: repository(),
    });

    const directory = await app.inject({ method: 'GET', url: '/api/v1/shops' });
    const catalog = await app.inject({
      method: 'GET',
      url: '/api/v1/merchants/northstar-demo-in/catalog',
    });
    const missing = await app.inject({ method: 'GET', url: '/api/v1/not-real' });

    expect(directory.statusCode).toBe(200);
    expect(catalog.statusCode).toBe(200);
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['content-type']).toContain('application/json');
    expect(missing.json().error).toBe('NOT_FOUND');
    await app.close();
  });

  it('rejects client-supplied tenant fields through route schemas', async () => {
    const { app } = await buildServer(testEnv, {
      authVerifier: verifier(),
      tenantRepository: repository(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/carts',
      headers: bearer('buyer-a'),
      payload: { tenantId: 'northstar-demo-in' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('VALIDATION_ERROR');
    await app.close();
  });
});
