import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NORTHSTAR_TENANT } from '@charter/catalog';
import {
  addLine,
  bindQuote,
  buildCanonicalKit,
  createCart,
  getCart,
  hydrateCart,
  resetKernel,
  type Cart,
} from '@charter/commerce';
import { createConversation, resetConversations } from '@charter/orchestrator';
import { hydrateCheckout, resetCheckouts, type CheckoutSession } from '@charter/payments';
import { RazorpayClient } from '@charter/razorpay';
import { loadConfig } from '@charter/config';
import { registerAuthContext } from './auth/context.js';
import { conversationHooks, registerConversationRoutes } from './conversations.js';
import type { MoneyPersist } from './persist.js';
import { persistedConversationState } from './tenant/conversation-state.js';
import {
  authHeaders,
  TEST_USERS,
  testAuthVerifier,
  testTenantRepository,
} from './testing/security.js';

const baseEnv = {
  DATABASE_URL: 'postgres://unused',
  CHARTER_ENV: 'test',
  RAZORPAY_MODE: 'test',
};

async function ownedConversation(
  repository: ReturnType<typeof testTenantRepository>,
  setup?: (conversation: ReturnType<typeof createConversation>) => void,
) {
  const conversation = createConversation(NORTHSTAR_TENANT);
  setup?.(conversation);
  await repository.claimResource(
    'conversation',
    NORTHSTAR_TENANT,
    conversation.id,
    TEST_USERS.buyer,
  );
  conversation.revision = await repository.saveConversation({
    id: conversation.id,
    tenantId: NORTHSTAR_TENANT,
    userId: TEST_USERS.buyer,
    expectedRevision: 0,
    state: persistedConversationState(conversation),
  });
  return conversation;
}

describe('conversation routes', () => {
  beforeEach(() => {
    resetKernel();
    resetCheckouts();
    resetConversations();
  });

  it('caps model turns per buyer per day but still lets Buy now through', async () => {
    const config = loadConfig({ ...baseEnv, CHARTER_DAILY_TURNS_PER_USER: '1' });
    const repository = testTenantRepository();
    const conversation = await ownedConversation(repository);
    const app = Fastify();
    await registerAuthContext(app, testAuthVerifier(), repository);
    await registerConversationRoutes(app, config, null, repository);
    const turn = (text: string) =>
      app.inject({
        method: 'POST',
        url: `/v1/conversations/${conversation.id}/turns`,
        headers: authHeaders('buyer'),
        payload: { shopSlug: 'northstar', text },
      });

    const first = await turn('I want a grinder');
    const capped = await turn('what else do you have');
    const buyNow = await turn('Buy now');
    const tooLong = await turn('a'.repeat(1_001));

    expect(first.statusCode, first.body).toBe(200);
    expect(capped.statusCode).toBe(429);
    expect(capped.json()).toEqual({ error: 'DAILY_LIMIT_REACHED' });
    expect(buyNow.statusCode, buyNow.body).toBe(200);
    expect(buyNow.json().quote?.totalDisplay).toBeTruthy();
    expect(tooLong.statusCode).toBe(400);
    await app.close();
  });

  it('answers an unknown or foreign conversation with CONVERSATION_NOT_FOUND', async () => {
    const config = loadConfig(baseEnv);
    const repository = testTenantRepository();
    const app = Fastify();
    await registerAuthContext(app, testAuthVerifier(), repository);
    await registerConversationRoutes(app, config, null, repository);
    const missing = '81000000-0000-4000-8000-000000000999';
    const get = await app.inject({
      method: 'GET',
      url: `/v1/conversations/${missing}?shopSlug=northstar`,
      headers: authHeaders('buyer'),
    });
    const turn = await app.inject({
      method: 'POST',
      url: `/v1/conversations/${missing}/turns`,
      headers: authHeaders('buyer'),
      payload: { shopSlug: 'northstar', text: 'hello' },
    });
    expect(get.statusCode).toBe(404);
    expect(get.json().error).toBe('CONVERSATION_NOT_FOUND');
    expect(turn.statusCode).toBe(404);
    expect(turn.json().error).toBe('CONVERSATION_NOT_FOUND');
    await app.close();
  });

  it('reloads the durable cart on GET after a restart', async () => {
    const config = loadConfig(baseEnv);
    const repository = testTenantRepository();
    const cart = createCart(NORTHSTAR_TENANT);
    addLine(cart.id, 'filters.travel-30');
    const durable: Cart = { ...cart, lines: cart.lines.map((line) => ({ ...line })) };
    const conversation = await ownedConversation(repository, (row) => {
      row.cartId = cart.id;
    });
    const persist = {
      loadCart: vi.fn(async (_tenantId: string, id: string) =>
        id === durable.id
          ? hydrateCart({ ...durable, lines: durable.lines.map((line) => ({ ...line })) })
          : undefined,
      ),
      loadQuote: async () => undefined,
      loadCheckout: async () => undefined,
    } as unknown as MoneyPersist;
    const app = Fastify();
    await registerAuthContext(app, testAuthVerifier(), repository);
    await registerConversationRoutes(app, config, null, repository, persist);

    resetKernel();
    resetConversations();
    expect(getCart(cart.id)).toBeUndefined();
    const snapshot = await app.inject({
      method: 'GET',
      url: `/v1/conversations/${conversation.id}?shopSlug=northstar`,
      headers: authHeaders('buyer'),
    });

    expect(snapshot.statusCode, snapshot.body).toBe(200);
    expect(snapshot.json().cart).toMatchObject({
      id: cart.id,
      lines: [{ sku: 'filters.travel-30', quantity: 1 }],
    });
    expect(persist.loadCart).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('hands back a receipt, not a pay window, when chat pay finds a capture', async () => {
    const { quote } = buildCanonicalKit();
    const session: CheckoutSession = {
      id: '82000000-0000-4000-8000-000000000071',
      tenantId: NORTHSTAR_TENANT,
      quoteId: quote.id,
      receipt: 'cht_captured',
      razorpayOrderId: 'order_captured',
      amountMinor: Number(quote.totalMinor),
      currency: 'INR',
      status: 'FAILED_PROVISIONAL',
      paymentId: null,
      providerStatus: 'created',
      copy: 'Payment not confirmed.',
    };
    hydrateCheckout(session);
    bindQuote(quote.id, session.id);
    const razorpay = new RazorpayClient({ keyId: 'rzp_test_key', keySecret: 'secret' }, (async (
      url: string | URL,
    ) => {
      const href = String(url);
      if (href.endsWith('/orders/order_captured/payments')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: 'pay_captured',
                order_id: 'order_captured',
                amount: session.amountMinor,
                currency: 'INR',
                status: 'captured',
              },
            ],
          }),
        );
      }
      if (href.endsWith('/orders/order_captured')) {
        return new Response(
          JSON.stringify({
            id: 'order_captured',
            amount: session.amountMinor,
            currency: 'INR',
            receipt: session.receipt,
            status: 'paid',
          }),
        );
      }
      throw new Error(`unexpected ${href}`);
    }) as typeof fetch);
    const rememberCapture = vi.fn(async () => undefined);
    const saveCheckout = vi.fn(async () => undefined);
    const persist = {
      assertQuoteFacts: async () => undefined,
      loadCheckout: async () => undefined,
      rememberCapture,
      saveCheckout,
    } as unknown as MoneyPersist;
    const hooks = conversationHooks(
      loadConfig({
        ...baseEnv,
        RAZORPAY_KEY_ID: 'rzp_test_key',
        RAZORPAY_KEY_SECRET: 'secret',
      }),
      razorpay,
      testTenantRepository(),
      TEST_USERS.buyer,
      persist,
    );

    const launch = await hooks.startCheckout?.(quote.id);

    expect(launch).toMatchObject({ checkoutId: session.id, status: 'SETTLED' });
    expect(launch?.keyId).toBeUndefined();
    expect(rememberCapture).toHaveBeenCalledTimes(1);
    expect(saveCheckout).not.toHaveBeenCalled();
  });
});
