import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NORTHSTAR_TENANT } from '@charter/catalog';
import {
  buildCanonicalKit,
  getCart,
  getQuote,
  hydrateCart,
  hydrateQuote,
  resetKernel,
  type Cart,
  type FrozenQuote,
} from '@charter/commerce';
import { createConversation, getConversation, resetConversations } from '@charter/orchestrator';
import {
  getCheckout,
  hydrateCheckout,
  resetCheckouts,
  type CheckoutSession,
} from '@charter/payments';
import { RazorpayClient } from '@charter/razorpay';
import { loadConfig } from '@charter/config';
import { registerAuthContext } from './auth/context.js';
import { registerConversationRoutes } from './conversations.js';
import { registerVoiceRoutes } from './voice.js';
import type { MoneyPersist } from './persist.js';
import { persistedConversationState } from './tenant/conversation-state.js';
import {
  authHeaders,
  TEST_USERS,
  testAuthVerifier,
  testTenantRepository,
} from './testing/security.js';

const config = loadConfig({
  DATABASE_URL: 'postgres://unused',
  CHARTER_ENV: 'test',
  FIREWORKS_API_KEY: 'fw_test',
  RAZORPAY_MODE: 'test',
});

function fireworksResponse(message: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ choices: [{ message }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function durableMoneyAdapter(input: {
  cart: Cart;
  quote: FrozenQuote;
  checkout?: CheckoutSession;
}): MoneyPersist {
  const durableCart = {
    ...input.cart,
    lines: input.cart.lines.map((line) => ({ ...line })),
  };
  const durableQuote = {
    ...input.quote,
    lines: input.quote.lines.map((line) => ({ ...line })),
  };
  const durableCheckout = input.checkout ? { ...input.checkout } : undefined;
  return {
    loadCart: async (tenantId: string, id: string) =>
      tenantId === durableCart.tenantId && id === durableCart.id
        ? hydrateCart({
            ...durableCart,
            lines: durableCart.lines.map((line) => ({ ...line })),
          })
        : undefined,
    loadQuote: async (tenantId: string, id: string) =>
      tenantId === durableQuote.tenantId && id === durableQuote.id
        ? hydrateQuote({
            ...durableQuote,
            lines: durableQuote.lines.map((line) => ({ ...line })),
          })
        : undefined,
    loadCheckout: async (tenantId: string, id: string) =>
      durableCheckout && tenantId === durableCheckout.tenantId && id === durableCheckout.id
        ? hydrateCheckout({ ...durableCheckout })
        : undefined,
    saveCart: async () => undefined,
    saveQuote: async () => undefined,
    saveCheckout: async () => undefined,
    saveApproval: async () => undefined,
    assertQuoteFacts: async () => undefined,
  } as unknown as MoneyPersist;
}

describe('conversation durability', () => {
  beforeEach(() => {
    resetKernel();
    resetCheckouts();
    resetConversations();
    vi.unstubAllGlobals();
  });

  it('consumes a checkout returned by a text turn before saving the conversation', async () => {
    const repository = testTenantRepository();
    const { cart, quote } = buildCanonicalKit();
    const conversation = createConversation(NORTHSTAR_TENANT);
    conversation.cartId = cart.id;
    conversation.quoteId = quote.id;
    conversation.pendingCheckout = {
      checkoutId: '82000000-0000-4000-8000-000000000040',
      orderId: 'order_consumed_while_text_runs',
      amount: Number(quote.totalMinor),
      currency: 'INR',
    };
    await repository.claimResource(
      'conversation',
      NORTHSTAR_TENANT,
      conversation.id,
      TEST_USERS.buyer,
    );
    const originalSaveConversation = repository.saveConversation.bind(repository);
    conversation.revision = await originalSaveConversation({
      id: conversation.id,
      tenantId: NORTHSTAR_TENANT,
      userId: TEST_USERS.buyer,
      expectedRevision: 0,
      state: persistedConversationState(conversation),
    });
    let consumeBeforeSave = true;
    repository.saveConversation = async (input) => {
      if (consumeBeforeSave) {
        consumeBeforeSave = false;
        await repository.consumePendingCheckout({
          id: conversation.id,
          tenantId: NORTHSTAR_TENANT,
          userId: TEST_USERS.buyer,
        });
      }
      return originalSaveConversation(input);
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fireworksResponse({ role: 'assistant', content: 'Opening the frozen quote.' }),
      ),
    );
    const createRazorpayOrder = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const body =
          init?.method === 'POST'
            ? {
                id: 'order_once',
                amount: Number(quote.totalMinor),
                currency: 'INR',
                receipt: 'cht_once',
                status: 'created',
              }
            : { items: [] };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    );
    const razorpay = new RazorpayClient(
      { keyId: 'rzp_test_key', keySecret: 'rzp_test_secret' },
      createRazorpayOrder as typeof fetch,
    );
    const money = durableMoneyAdapter({ cart, quote });
    const app = Fastify();
    await registerAuthContext(app, testAuthVerifier(), repository);
    await registerConversationRoutes(
      app,
      { ...config, RAZORPAY_KEY_ID: 'rzp_test_key', RAZORPAY_KEY_SECRET: 'rzp_test_secret' },
      razorpay,
      repository,
      money,
    );

    const turn = await app.inject({
      method: 'POST',
      url: `/v1/conversations/${conversation.id}/turns`,
      headers: authHeaders('buyer'),
      payload: { shopSlug: 'northstar', text: 'yes, pay now' },
    });
    resetConversations();
    const afterRestart = await app.inject({
      method: 'GET',
      url: `/v1/conversations/${conversation.id}?shopSlug=northstar&takeCheckout=1`,
      headers: authHeaders('buyer'),
    });

    expect(turn.statusCode, turn.body).toBe(200);
    expect(turn.json().checkout).toMatchObject({ orderId: 'order_once' });
    expect(
      createRazorpayOrder.mock.calls.filter(([, init]) => init?.method === 'POST'),
    ).toHaveLength(1);
    expect(afterRestart.statusCode, afterRestart.body).toBe(200);
    expect(afterRestart.json().checkout).toBeNull();
    expect(
      (
        await repository.loadConversation({
          id: conversation.id,
          tenantId: NORTHSTAR_TENANT,
          userId: TEST_USERS.buyer,
        })
      )?.state.pendingCheckout,
    ).toBeNull();
    await app.close();
  });

  it('reconciles a voice save conflict without replaying the model turn', async () => {
    const repository = testTenantRepository();
    const conversation = createConversation(NORTHSTAR_TENANT);
    conversation.pendingCheckout = {
      checkoutId: '82000000-0000-4000-8000-000000000043',
      orderId: 'order_consumed_while_voice_runs',
      amount: 234700,
      currency: 'INR',
    };
    await repository.claimResource(
      'conversation',
      NORTHSTAR_TENANT,
      conversation.id,
      TEST_USERS.buyer,
    );
    const originalSaveConversation = repository.saveConversation.bind(repository);
    conversation.revision = await originalSaveConversation({
      id: conversation.id,
      tenantId: NORTHSTAR_TENANT,
      userId: TEST_USERS.buyer,
      expectedRevision: 0,
      state: persistedConversationState(conversation),
    });
    let consumeBeforeSave = true;
    repository.saveConversation = async (input) => {
      if (consumeBeforeSave) {
        consumeBeforeSave = false;
        await repository.consumePendingCheckout({
          id: conversation.id,
          tenantId: NORTHSTAR_TENANT,
          userId: TEST_USERS.buyer,
        });
      }
      return originalSaveConversation(input);
    };
    const model = vi.fn(async () =>
      fireworksResponse({ role: 'assistant', content: 'Voice turn persisted once.' }),
    );
    vi.stubGlobal('fetch', model);
    const app = Fastify();
    await registerAuthContext(app, testAuthVerifier(), repository);
    await registerVoiceRoutes(app, config, null, repository);

    const response = await app.inject({
      method: 'POST',
      url: `/v1/voice/${conversation.id}/chat/completions`,
      headers: authHeaders('buyer'),
      payload: {
        shopSlug: 'northstar',
        messages: [{ role: 'user', content: 'persist this voice turn once' }],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(model).toHaveBeenCalledTimes(1);
    const latest = await repository.loadConversation({
      id: conversation.id,
      tenantId: NORTHSTAR_TENANT,
      userId: TEST_USERS.buyer,
    });
    expect(latest?.state.pendingCheckout).toBeNull();
    expect(latest?.state.messages).toContainEqual({
      role: 'user',
      content: 'persist this voice turn once',
    });
    await app.close();
  });

  it('reloads durable state after a terminal text conversation conflict', async () => {
    const repository = testTenantRepository();
    const conversation = createConversation(NORTHSTAR_TENANT);
    conversation.pendingCheckout = {
      checkoutId: '82000000-0000-4000-8000-000000000044',
      orderId: 'order_terminal_text_conflict',
      amount: 234700,
      currency: 'INR',
    };
    conversation.messages.push({ role: 'system', content: 'base text message' });
    await repository.claimResource(
      'conversation',
      NORTHSTAR_TENANT,
      conversation.id,
      TEST_USERS.buyer,
    );
    const originalSaveConversation = repository.saveConversation.bind(repository);
    conversation.revision = await originalSaveConversation({
      id: conversation.id,
      tenantId: NORTHSTAR_TENANT,
      userId: TEST_USERS.buyer,
      expectedRevision: 0,
      state: persistedConversationState(conversation),
    });
    let forceTerminalConflict = true;
    repository.saveConversation = async (input) => {
      if (forceTerminalConflict) {
        forceTerminalConflict = false;
        await repository.consumePendingCheckout({
          id: conversation.id,
          tenantId: NORTHSTAR_TENANT,
          userId: TEST_USERS.buyer,
        });
        const latest = await repository.loadConversation({
          id: conversation.id,
          tenantId: NORTHSTAR_TENANT,
          userId: TEST_USERS.buyer,
        });
        await originalSaveConversation({
          ...input,
          expectedRevision: latest!.revision,
          state: {
            ...latest!.state,
            messages: [{ role: 'system', content: 'durable text replacement' }],
          },
        });
      }
      return originalSaveConversation(input);
    };
    const model = vi.fn(async () =>
      fireworksResponse({ role: 'assistant', content: 'Uncommitted text reply.' }),
    );
    vi.stubGlobal('fetch', model);
    const app = Fastify();
    await registerAuthContext(app, testAuthVerifier(), repository);
    await registerConversationRoutes(app, config, null, repository);

    const failedTurn = await app.inject({
      method: 'POST',
      url: `/v1/conversations/${conversation.id}/turns`,
      headers: authHeaders('buyer'),
      payload: { shopSlug: 'northstar', text: 'uncommitted text input' },
    });
    const durableGet = await app.inject({
      method: 'GET',
      url: `/v1/conversations/${conversation.id}?shopSlug=northstar`,
      headers: authHeaders('buyer'),
    });

    expect(failedTurn.statusCode, failedTurn.body).toBe(409);
    expect(failedTurn.json()).toEqual({ error: 'CONVERSATION_VERSION_CONFLICT' });
    expect(model).toHaveBeenCalledTimes(1);
    expect(durableGet.statusCode, durableGet.body).toBe(200);
    expect(durableGet.json().checkout).toBeNull();
    expect(getConversation(conversation.id)?.messages).toEqual([
      { role: 'system', content: 'durable text replacement' },
    ]);
    await app.close();
  });

  it('reloads durable state after a terminal voice conversation conflict', async () => {
    const repository = testTenantRepository();
    const conversation = createConversation(NORTHSTAR_TENANT);
    conversation.pendingCheckout = {
      checkoutId: '82000000-0000-4000-8000-000000000045',
      orderId: 'order_terminal_voice_conflict',
      amount: 234700,
      currency: 'INR',
    };
    conversation.messages.push({ role: 'system', content: 'base voice message' });
    await repository.claimResource(
      'conversation',
      NORTHSTAR_TENANT,
      conversation.id,
      TEST_USERS.buyer,
    );
    const originalSaveConversation = repository.saveConversation.bind(repository);
    conversation.revision = await originalSaveConversation({
      id: conversation.id,
      tenantId: NORTHSTAR_TENANT,
      userId: TEST_USERS.buyer,
      expectedRevision: 0,
      state: persistedConversationState(conversation),
    });
    let forceTerminalConflict = true;
    repository.saveConversation = async (input) => {
      if (forceTerminalConflict) {
        forceTerminalConflict = false;
        await repository.consumePendingCheckout({
          id: conversation.id,
          tenantId: NORTHSTAR_TENANT,
          userId: TEST_USERS.buyer,
        });
        const latest = await repository.loadConversation({
          id: conversation.id,
          tenantId: NORTHSTAR_TENANT,
          userId: TEST_USERS.buyer,
        });
        await originalSaveConversation({
          ...input,
          expectedRevision: latest!.revision,
          state: {
            ...latest!.state,
            messages: [{ role: 'system', content: 'durable voice replacement' }],
          },
        });
      }
      return originalSaveConversation(input);
    };
    const model = vi.fn(async () =>
      fireworksResponse({ role: 'assistant', content: 'Uncommitted voice reply.' }),
    );
    vi.stubGlobal('fetch', model);
    const app = Fastify();
    await registerAuthContext(app, testAuthVerifier(), repository);
    await registerConversationRoutes(app, config, null, repository);
    await registerVoiceRoutes(app, config, null, repository);

    const failedTurn = await app.inject({
      method: 'POST',
      url: `/v1/voice/${conversation.id}/chat/completions`,
      headers: authHeaders('buyer'),
      payload: {
        shopSlug: 'northstar',
        messages: [{ role: 'user', content: 'uncommitted voice input' }],
      },
    });
    const durableGet = await app.inject({
      method: 'GET',
      url: `/v1/conversations/${conversation.id}?shopSlug=northstar`,
      headers: authHeaders('buyer'),
    });

    expect(failedTurn.statusCode, failedTurn.body).toBe(409);
    expect(failedTurn.json()).toEqual({ error: 'CONVERSATION_VERSION_CONFLICT' });
    expect(model).toHaveBeenCalledTimes(1);
    expect(durableGet.statusCode, durableGet.body).toBe(200);
    expect(durableGet.json().checkout).toBeNull();
    expect(getConversation(conversation.id)?.messages).toEqual([
      { role: 'system', content: 'durable voice replacement' },
    ]);
    await app.close();
  });

  it('hydrates durable cart, quote, and pending checkout before resumed text and voice tools', async () => {
    const repository = testTenantRepository();
    const { cart, quote } = buildCanonicalKit();
    const checkout: CheckoutSession = {
      id: '82000000-0000-4000-8000-000000000041',
      tenantId: NORTHSTAR_TENANT,
      quoteId: quote.id,
      receipt: 'cht_resume',
      razorpayOrderId: 'order_resume',
      amountMinor: Number(quote.totalMinor),
      currency: 'INR',
      status: 'CREATED',
      paymentId: null,
      providerStatus: 'created',
      copy: 'Resume checkout.',
    };
    const ids = [
      '81000000-0000-4000-8000-000000000041',
      '81000000-0000-4000-8000-000000000042',
    ] as const;
    for (const id of ids) {
      await repository.claimResource('conversation', NORTHSTAR_TENANT, id, TEST_USERS.buyer);
      await repository.saveConversation({
        id,
        tenantId: NORTHSTAR_TENANT,
        userId: TEST_USERS.buyer,
        expectedRevision: 0,
        state: {
          cartId: cart.id,
          quoteId: quote.id,
          catalogLoaded: true,
          pendingCheckout: {
            checkoutId: checkout.id,
            orderId: checkout.razorpayOrderId,
            amount: checkout.amountMinor,
            currency: checkout.currency,
          },
          messages: [],
        },
      });
    }
    const scripts = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_text_cart',
            type: 'function',
            function: { name: 'cart.get', arguments: '{}' },
          },
        ],
      },
      { role: 'assistant', content: 'Text cart loaded.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_voice_cart',
            type: 'function',
            function: { name: 'cart.get', arguments: '{}' },
          },
        ],
      },
      { role: 'assistant', content: 'Voice cart loaded.' },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const next = scripts.shift();
        if (!next) {
          throw new Error('FIREWORKS_SCRIPT_EXHAUSTED');
        }
        return fireworksResponse(next);
      }),
    );
    const money = durableMoneyAdapter({ cart, quote, checkout });
    resetKernel();
    resetCheckouts();
    resetConversations();
    const app = Fastify();
    await registerAuthContext(app, testAuthVerifier(), repository);
    await registerConversationRoutes(app, config, null, repository, money);
    await registerVoiceRoutes(app, config, null, repository, money);

    const text = await app.inject({
      method: 'POST',
      url: `/v1/conversations/${ids[0]}/turns`,
      headers: authHeaders('buyer'),
      payload: { shopSlug: 'northstar', text: 'show my cart' },
    });
    expect(text.statusCode, text.body).toBe(200);
    expect(text.json().traces[0].result.cart.id).toBe(cart.id);
    expect(getCart(cart.id)).toBeDefined();
    expect(getQuote(quote.id)).toBeDefined();
    expect(getCheckout(checkout.id)).toBeDefined();

    resetKernel();
    resetCheckouts();
    resetConversations();
    const voice = await app.inject({
      method: 'POST',
      url: `/v1/voice/${ids[1]}/chat/completions`,
      headers: authHeaders('buyer'),
      payload: {
        shopSlug: 'northstar',
        messages: [{ role: 'user', content: 'show my cart by voice' }],
      },
    });

    expect(voice.statusCode, voice.body).toBe(200);
    expect(voice.json().choices[0].message.content).toBe('Voice cart loaded.');
    expect(getCart(cart.id)).toBeDefined();
    expect(getQuote(quote.id)).toBeDefined();
    expect(getCheckout(checkout.id)).toBeDefined();
    expect(
      getConversation(ids[1])?.messages.some(
        (message) =>
          message.role === 'tool' &&
          typeof message.content === 'string' &&
          message.content.includes(`"id":"${cart.id}"`),
      ),
    ).toBe(true);
    await app.close();
  });
});
