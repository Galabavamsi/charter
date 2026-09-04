import {
  conversationQuote,
  createConversation,
  createFireworksClient,
  createResilientModelClient,
  usesStructuredCheckout,
  evictConversation,
  FIREWORKS_DEFAULT_MODEL,
  getConversation,
  runTurn,
  takePendingCheckout,
  type Conversation,
  type OrchestratorHooks,
} from '@charter/orchestrator';
import { observeTurn } from './observe.js';
import { hydrateBoundCheckout, persistReconciledCheckout, type MoneyPersist } from './persist.js';
import {
  assertQuoteFactsFresh,
  cartTotals,
  getApproval,
  getCart,
  getQuote,
} from '@charter/commerce';
import { getCheckout, findCheckoutByQuote, startCheckout } from '@charter/payments';
import { RazorpayClient } from '@charter/razorpay';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '@charter/config';
import type { PersistedConversationSnapshot, TenantRepository } from './tenant/repository.js';
import { requireBuyer, requireBuyerPreValidation } from './auth/context.js';
import { requireOwnedResource } from './auth/guards.js';
import { hydrateCatalogCache } from './tenant/catalog-cache.js';
import {
  hydratePersistedConversation,
  persistedConversationState,
  reconcilePersistedConversationState,
} from './tenant/conversation-state.js';
import { safeErrorCode } from './http-errors.js';

const SHOP_SLUG_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 64,
  pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
} as const;

const UUID_SCHEMA = { type: 'string', format: 'uuid' } as const;

function serializeQuote(quote: NonNullable<ReturnType<typeof getQuote>>) {
  return {
    id: quote.id,
    tenantId: quote.tenantId,
    cartId: quote.cartId,
    cartVersion: quote.cartVersion,
    status: quote.status,
    boundCheckoutId: quote.boundCheckoutId,
    currency: quote.currency,
    subtotalMinor: quote.subtotalMinor.toString(),
    discountMinor: quote.discountMinor.toString(),
    totalMinor: quote.totalMinor.toString(),
    totalDisplay: quote.totalDisplay,
    deliveryBy: quote.deliveryBy,
    merchant: quote.merchant,
    lines: quote.lines.map((line) => ({
      sku: line.sku,
      title: line.title,
      quantity: line.quantity,
      unitMinor: line.unitMinor.toString(),
      lineMinor: line.lineMinor.toString(),
    })),
  };
}

function serializeBuyerCart(conversation: Conversation) {
  if (!conversation.cartId) {
    return null;
  }
  const cart = getCart(conversation.cartId);
  if (!cart) {
    return null;
  }
  const totals = cartTotals(conversation.cartId);
  return {
    id: cart.id,
    lines: cart.lines.map((line) => ({ sku: line.sku, quantity: line.quantity })),
    totalDisplay: totals?.totalDisplay ?? null,
  };
}

type DiscoveryContext = {
  requestId: string;
  tenantId: string;
  shopSlug: string;
  agentSource: 'concierge_web' | 'concierge_voice';
};

function hooksFor(
  config: AppConfig,
  razorpay: RazorpayClient | null,
  repository: TenantRepository,
  userId?: string,
  persist?: MoneyPersist,
  discovery?: DiscoveryContext,
): OrchestratorHooks {
  return {
    persistCart: async (cartId) => {
      const cart = getCart(cartId);
      if (cart) {
        await persist?.saveCart(cart, userId);
        if (userId) {
          await repository.claimResource('cart', cart.tenantId, cart.id, userId);
        }
      }
    },
    persistQuote: async (quoteId) => {
      const quote = getQuote(quoteId);
      if (quote) {
        assertQuoteFactsFresh(quote);
        await persist?.assertQuoteFacts(quote);
        await persist?.saveQuote(quote);
        const cart = getCart(quote.cartId);
        if (cart && userId) {
          await repository.claimResource('quote', cart.tenantId, quote.id, userId);
        }
      }
    },
    persistCheckout: async (checkoutId) => {
      const session = getCheckout(checkoutId);
      if (session) {
        await persist?.saveCheckout(session);
        const quote = getQuote(session.quoteId);
        const cart = quote ? getCart(quote.cartId) : undefined;
        if (cart && userId) {
          await repository.claimResource('checkout', cart.tenantId, session.id, userId);
        }
      }
    },
    persistApproval: async (approvalId) => {
      if (!persist || !userId) {
        return;
      }
      const approval = getApproval(approvalId);
      if (approval) {
        await persist.saveApproval(approval, userId);
      }
    },
    startCheckout:
      razorpay && config.RAZORPAY_KEY_ID
        ? async (quoteId) => {
            const quote = getQuote(quoteId);
            if (!quote) {
              throw new Error('QUOTE_NOT_FOUND');
            }
            const cart = getCart(quote.cartId);
            if (!cart) {
              throw new Error('QUOTE_NOT_FOUND');
            }
            if (await repository.isCheckoutKilled(cart.tenantId)) {
              throw new Error('CHECKOUT_KILLED');
            }
            await persist?.assertQuoteFacts?.(quote);
            await hydrateBoundCheckout(persist, cart.tenantId, quote);
            const prior = findCheckoutByQuote(quoteId);
            const priorStatus = prior?.status;
            const priorId = prior?.id;
            try {
              const { session } = await startCheckout(quoteId, razorpay);
              await persist?.saveCheckout?.(session);
              const retryAllowed =
                (priorStatus === 'FAILED_PROVISIONAL' || priorStatus === 'RECONCILING') &&
                session.status === 'CREATED' &&
                session.id === priorId;
              return {
                checkoutId: session.id,
                keyId: config.RAZORPAY_KEY_ID,
                orderId: session.razorpayOrderId,
                amount: session.amountMinor,
                currency: session.currency,
                name: getQuote(quoteId)?.merchant ?? 'Charter',
                description: 'Locked total',
                receipt: session.receipt,
                copy: session.copy,
                retryAllowed,
                reconciliationOutcome: retryAllowed ? 'same_order_retry_safe' : undefined,
              };
            } catch (error) {
              const existing = findCheckoutByQuote(quoteId);
              if (existing) {
                await persistReconciledCheckout(persist, existing);
              }
              throw error;
            }
          }
        : undefined,
    recordCatalogSearch: discovery
      ? async ({ query, items }) => {
          await repository
            .recordDiscovery({
              requestId: discovery.requestId,
              query,
              surface: 'catalog.search',
              agentSource: discovery.agentSource,
              hits: items.map((item, index) => ({
                tenantId: discovery.tenantId,
                shopSlug: discovery.shopSlug,
                sku: item.sku,
                rank: index + 1,
              })),
            })
            .catch(() => undefined);
        }
      : undefined,
  };
}

export async function hydrateConversationMoney(
  conversation: ReturnType<typeof createConversation>,
  persist?: MoneyPersist,
): Promise<void> {
  if (!persist) {
    return;
  }
  if (conversation.cartId) {
    await persist.loadCart(conversation.tenantId, conversation.cartId);
  }
  if (conversation.quoteId) {
    const quote = await persist.loadQuote(conversation.tenantId, conversation.quoteId);
    if (quote) {
      await hydrateBoundCheckout(persist, conversation.tenantId, quote);
    }
  }
  const pending = conversation.pendingCheckout;
  const checkoutId =
    pending &&
    typeof pending === 'object' &&
    'checkoutId' in pending &&
    typeof pending.checkoutId === 'string'
      ? pending.checkoutId
      : undefined;
  if (checkoutId) {
    await persist.loadCheckout(conversation.tenantId, checkoutId);
  }
}

function isConversationVersionConflict(error: unknown): boolean {
  return error instanceof Error && error.message === 'CONVERSATION_VERSION_CONFLICT';
}

export async function persistConversationAfterTurn(input: {
  repository: TenantRepository;
  conversation: Conversation;
  userId: string;
  base: PersistedConversationSnapshot;
}): Promise<void> {
  const local = persistedConversationState(input.conversation);
  let candidate = local;
  let expectedRevision = input.base.revision;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const revision = await input.repository.saveConversation({
        id: input.conversation.id,
        tenantId: input.conversation.tenantId,
        userId: input.userId,
        expectedRevision,
        state: candidate,
      });
      input.conversation.revision = revision;
      hydratePersistedConversation({
        id: input.conversation.id,
        tenantId: input.conversation.tenantId,
        revision,
        state: candidate,
      });
      return;
    } catch (error) {
      if (!isConversationVersionConflict(error)) {
        throw error;
      }
      const latest = await input.repository.loadConversation({
        id: input.conversation.id,
        tenantId: input.conversation.tenantId,
        userId: input.userId,
      });
      if (!latest) {
        throw error;
      }
      candidate = reconcilePersistedConversationState(input.base.state, local, latest.state);
      expectedRevision = latest.revision;
    }
  }
  throw new Error('CONVERSATION_VERSION_CONFLICT');
}

export async function registerConversationRoutes(
  app: FastifyInstance,
  config: AppConfig,
  razorpay: RazorpayClient | null,
  repository: TenantRepository,
  persist?: MoneyPersist,
): Promise<void> {
  app.get('/v1/concierge/config', async () => {
    const publicUrl = config.CHARTER_PUBLIC_URL.replace(/\/$/, '');
    return {
      vapiPublicKey: config.VAPI_PUBLIC_KEY || null,
      voiceEnabled: Boolean(config.VAPI_PUBLIC_KEY && publicUrl),
      voiceModelBase: publicUrl ? `${publicUrl}/api/v1/voice` : null,
      langfuseEnabled: Boolean(config.LANGFUSE_PUBLIC_KEY && config.LANGFUSE_SECRET_KEY),
      recoveryEnabled: Boolean(config.AGENTMAIL_API_KEY && config.AGENTMAIL_INBOX),
      razorpayMode: config.RAZORPAY_MODE,
    };
  });

  app.post(
    '/v1/conversations',
    {
      preValidation: requireBuyerPreValidation,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['shopSlug'],
          properties: {
            shopSlug: {
              type: 'string',
              minLength: 1,
              maxLength: 64,
              pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
            },
          },
        },
      },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const principal = requireBuyer(request, reply);
      if (!principal) {
        return;
      }
      const body = (request.body ?? {}) as { shopSlug?: string };
      if (!body.shopSlug) {
        return reply.status(400).send({ error: 'SHOP_SLUG_REQUIRED' });
      }
      const shop = await repository.findShopBySlug(body.shopSlug);
      if (!shop) {
        return reply.status(404).send({ error: 'SHOP_UNKNOWN' });
      }
      try {
        await hydrateCatalogCache(repository, shop);
        const conversation = createConversation(shop.tenantId);
        await repository.claimResource(
          'conversation',
          shop.tenantId,
          conversation.id,
          principal.userId,
        );
        conversation.revision = await repository.saveConversation({
          id: conversation.id,
          tenantId: conversation.tenantId,
          userId: principal.userId,
          expectedRevision: conversation.revision,
          state: persistedConversationState(conversation),
        });
        return { id: conversation.id, tenantId: conversation.tenantId };
      } catch (error) {
        const code = safeErrorCode(
          error,
          ['TENANT_UNKNOWN', 'SHOP_POLICY_NOT_FOUND'],
          'CONVERSATION_CREATE_FAILED',
        );
        return reply.status(400).send({ error: code });
      }
    },
  );

  app.get(
    '/v1/conversations/:id',
    {
      preValidation: requireBuyerPreValidation,
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: UUID_SCHEMA },
        },
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['shopSlug'],
          properties: {
            shopSlug: SHOP_SLUG_SCHEMA,
            takeCheckout: { type: 'string', enum: ['0', '1'] },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { shopSlug, takeCheckout } = request.query as {
        shopSlug: string;
        takeCheckout?: string;
      };
      const buyer = requireBuyer(request, reply);
      if (!buyer) {
        return;
      }
      const shop = await repository.findShopBySlug(shopSlug);
      if (!shop) {
        return reply.status(404).send({ error: 'SHOP_UNKNOWN' });
      }
      if (
        !(await requireOwnedResource(request, reply, repository, {
          kind: 'conversation',
          tenantId: shop.tenantId,
          resourceId: id,
        }))
      ) {
        return;
      }
      let conversation = getConversation(id);
      if (!conversation) {
        const snapshot = await repository.loadConversation({
          id,
          tenantId: shop.tenantId,
          userId: buyer.userId,
        });
        if (snapshot) {
          conversation = hydratePersistedConversation({
            id,
            tenantId: shop.tenantId,
            ...snapshot,
          });
        }
      }
      if (!conversation || conversation.tenantId !== shop.tenantId) {
        return reply.status(404).send({ error: 'CONVERSATION_NOT_FOUND' });
      }
      const quote = conversationQuote(conversation);
      let checkout = conversation.pendingCheckout;
      if (takeCheckout === '1') {
        const consumed = await repository.consumePendingCheckout({
          id: conversation.id,
          tenantId: shop.tenantId,
          userId: buyer.userId,
        });
        checkout = consumed?.checkout ?? null;
        if (consumed) {
          conversation.revision = consumed.revision;
        }
        takePendingCheckout(conversation);
      }
      return {
        id: conversation.id,
        quote: quote ? serializeQuote(quote) : null,
        cart: serializeBuyerCart(conversation),
        checkout,
      };
    },
  );

  app.post(
    '/v1/conversations/:id/turns',
    {
      preValidation: requireBuyerPreValidation,
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: UUID_SCHEMA },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['shopSlug', 'text'],
          properties: {
            shopSlug: {
              type: 'string',
              minLength: 1,
              maxLength: 64,
              pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
            },
            text: { type: 'string', minLength: 1, maxLength: 8_000 },
          },
        },
      },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { text: string; shopSlug: string };
      const buyer = requireBuyer(request, reply);
      if (!buyer) {
        return;
      }
      const shop = await repository.findShopBySlug(body.shopSlug);
      if (!shop) {
        return reply.status(404).send({ error: 'SHOP_UNKNOWN' });
      }
      const principal = await requireOwnedResource(request, reply, repository, {
        kind: 'conversation',
        tenantId: shop.tenantId,
        resourceId: id,
      });
      if (!principal) {
        return;
      }
      const base = await repository.loadConversation({
        id,
        tenantId: shop.tenantId,
        userId: buyer.userId,
      });
      const conversation = base
        ? hydratePersistedConversation({
            id,
            tenantId: shop.tenantId,
            ...base,
          })
        : undefined;
      if (!base || !conversation || conversation.tenantId !== shop.tenantId) {
        return reply.status(404).send({ error: 'CONVERSATION_NOT_FOUND' });
      }
      await hydrateCatalogCache(repository, shop);
      await hydrateConversationMoney(conversation, persist);
      const { text } = body;
      if (!text?.trim()) {
        return reply.status(400).send({ error: 'TEXT_REQUIRED' });
      }
      const hooks = hooksFor(config, razorpay, repository, principal.userId, persist, {
        requestId: request.id,
        tenantId: shop.tenantId,
        shopSlug: shop.slug,
        agentSource: 'concierge_web',
      });
      let turn: Awaited<ReturnType<typeof runConversationTurn>>;
      try {
        turn = await runConversationTurn(config, conversation, text.trim(), hooks, 'text');
      } catch (error) {
        try {
          await persistConversationAfterTurn({
            repository,
            conversation,
            userId: principal.userId,
            base,
          });
        } catch (persistenceError) {
          if (isConversationVersionConflict(persistenceError)) {
            evictConversation(conversation.id);
            return reply.status(409).send({ error: 'CONVERSATION_VERSION_CONFLICT' });
          }
          throw persistenceError;
        }
        const code = safeErrorCode(
          error,
          [
            'CHECKOUT_KILLED',
            'FACTS_STALE',
            'OFFER_MARGIN_FLOOR',
            'CART_NOT_FOUND',
            'QUOTE_NOT_FOUND',
            'SKU_UNKNOWN',
            'AUTHORITY_APPROVAL_REQUIRED',
            'PRODUCT_MATERIAL_FORBIDDEN',
            'OUT_OF_STOCK',
            'HARD_CAP_EXCEEDED',
          ],
          'ORCHESTRATOR_ERROR',
        );
        return reply.status(502).send({ error: code });
      }
      const checkout = turn.checkout ? takePendingCheckout(conversation) : turn.checkout;
      const quote = conversationQuote(conversation);
      try {
        await persistConversationAfterTurn({
          repository,
          conversation,
          userId: principal.userId,
          base,
        });
      } catch (error) {
        if (isConversationVersionConflict(error)) {
          evictConversation(conversation.id);
          return reply.status(409).send({ error: 'CONVERSATION_VERSION_CONFLICT' });
        }
        throw error;
      }
      return {
        reply: turn.reply,
        traces: turn.traces,
        cartId: turn.cartId,
        cart: serializeBuyerCart(conversation),
        quote: quote ? serializeQuote(quote) : null,
        checkout,
      };
    },
  );
}

export async function runConversationTurn(
  config: AppConfig,
  conversation: ReturnType<typeof createConversation>,
  text: string,
  hooks: OrchestratorHooks,
  channel: 'text' | 'voice',
) {
  const client = createResilientModelClient(
    config.FIREWORKS_API_KEY && !usesStructuredCheckout(text)
      ? createFireworksClient(
          config.FIREWORKS_API_KEY,
          config.FIREWORKS_MODEL || FIREWORKS_DEFAULT_MODEL,
        )
      : null,
  );
  const turn = await runTurn(conversation, text, client, hooks);
  if (turn.checkout) {
    conversation.pendingCheckout = turn.checkout;
  }
  const quote = conversationQuote(conversation);
  void observeTurn(config, {
    conversationId: conversation.id,
    channel,
    input: text,
    reply: turn.reply,
    traces: turn.traces,
    quoteTotal: quote?.totalDisplay ?? null,
  }).catch(() => undefined);
  return turn;
}

export function conversationHooks(
  config: AppConfig,
  razorpay: RazorpayClient | null,
  repository: TenantRepository,
  userId?: string,
  persist?: MoneyPersist,
  discovery?: DiscoveryContext,
): OrchestratorHooks {
  return hooksFor(config, razorpay, repository, userId, persist, discovery);
}
