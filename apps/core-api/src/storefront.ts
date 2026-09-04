import { createHash } from 'node:crypto';
import {
  addLine,
  buildCanonicalKit,
  createCart,
  freezeQuote,
  getCart,
  getQuote,
  previewReplace,
  serializeCart,
  assertQuoteFactsFresh,
} from '@charter/commerce';
import {
  applyCheckoutCallback,
  findCheckoutByQuote,
  getCheckout,
  markCheckoutDismissed,
  startCheckout,
} from '@charter/payments';
import { RazorpayClient } from '@charter/razorpay';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '@charter/config';
import { hydrateBoundCheckout, persistReconciledCheckout, type MoneyPersist } from './persist.js';
import type { RecoveryRuntime } from './recovery.js';
import type { TenantRepository } from './tenant/repository.js';
import {
  CAPABILITIES,
  requireOwnedResource,
  requirePlatformRole,
  requireShopMember,
} from './auth/guards.js';
import { requireBuyer, requireBuyerPreValidation } from './auth/context.js';
import { hydrateCatalogCache } from './tenant/catalog-cache.js';
import { safeErrorCode } from './http-errors.js';
import {
  nextPublicCatalogCursor,
  parsePublicCatalogQuery,
  PUBLIC_CATALOG_QUERY_SCHEMA,
  PublicCatalogQueryError,
  type RawPublicCatalogQuery,
} from './tenant/public-catalog-query.js';

const SHOP_SLUG_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 64,
  pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
} as const;

const TENANT_ID_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 63,
  pattern: '^[a-z0-9][a-z0-9-]{0,62}$',
} as const;

const SKU_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 160,
} as const;

const UUID_SCHEMA = { type: 'string', format: 'uuid' } as const;

function serializeQuote(quote: ReturnType<typeof freezeQuote>) {
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
    catalogVersion: quote.catalogVersion,
    policyVersion: quote.policyVersion,
    factHash: quote.factHash,
    lines: quote.lines.map((line) => ({
      ...line,
      unitMinor: line.unitMinor.toString(),
      lineMinor: line.lineMinor.toString(),
    })),
  };
}

async function canonicalShop(
  request: FastifyRequest,
  reply: FastifyReply,
  repository: TenantRepository,
) {
  const query = request.query as { shopSlug?: string };
  const body =
    request.body && typeof request.body === 'object'
      ? (request.body as { shopSlug?: string })
      : undefined;
  const shopSlug = query.shopSlug ?? body?.shopSlug;
  if (!shopSlug) {
    reply.status(400).send({ error: 'SHOP_SLUG_REQUIRED' });
    return undefined;
  }
  const shop = await repository.findShopBySlug(shopSlug);
  if (!shop) {
    reply.status(404).send({ error: 'SHOP_UNKNOWN' });
    return undefined;
  }
  await hydrateCatalogCache(repository, shop);
  return shop;
}

async function tenantCart(tenantId: string, cartId: string, persist?: MoneyPersist) {
  const cached = getCart(cartId);
  if (cached?.tenantId === tenantId) {
    return cached;
  }
  return persist?.loadCart(tenantId, cartId);
}

async function tenantQuote(tenantId: string, quoteId: string, persist?: MoneyPersist) {
  const cached = getQuote(quoteId);
  const cachedCart = cached ? getCart(cached.cartId) : undefined;
  if (cached && cachedCart?.tenantId === tenantId) {
    return cached;
  }
  return persist?.loadQuote(tenantId, quoteId);
}

async function tenantCheckout(tenantId: string, checkoutId: string, persist?: MoneyPersist) {
  const cached = getCheckout(checkoutId);
  const cachedQuote = cached ? await tenantQuote(tenantId, cached.quoteId, persist) : undefined;
  if (cached && cachedQuote) {
    return cached;
  }
  return persist?.loadCheckout(tenantId, checkoutId);
}

function publicCatalogQuery(
  request: FastifyRequest,
  reply: FastifyReply,
  scope: string,
  secret: string,
) {
  try {
    return parsePublicCatalogQuery(request.query as RawPublicCatalogQuery, scope, secret);
  } catch (error) {
    const code = error instanceof PublicCatalogQueryError ? error.code : 'QUERY_INVALID';
    reply.status(400).send({ error: code });
    return undefined;
  }
}

export async function registerStorefrontRoutes(
  app: FastifyInstance,
  config: AppConfig,
  razorpay: RazorpayClient | null,
  repository: TenantRepository,
  persist?: MoneyPersist,
  recovery?: RecoveryRuntime,
): Promise<void> {
  app.get('/.well-known/agent-commerce', async () => ({
    name: 'Charter',
    protocol: 'charter-commerce',
    protocolStatus: 'evaluator-http-contract',
    discovery: '/.well-known/charter-commerce.json',
    shops: '/api/v1/shops',
    mcp: { tools: '/mcp/tools', call: '/mcp/call' },
    tools: [
      'catalog.search',
      'catalog.detail',
      'cart.create',
      'cart.get',
      'cart.update',
      'quote.create',
      'checkout.complete',
      'checkout.resume',
      'order.status',
    ],
    pay: 'razorpay',
    currency: 'INR',
    notCertified: ['UCP', 'ACP', 'AP2', 'Gemini', 'Alexa'],
    note: 'Open a published shop, then use the same catalog and checkout tools as Concierge. Canonical discovery is /.well-known/charter-commerce.json.',
  }));

  app.get(
    '/v1/shops',
    {
      schema: {
        querystring: PUBLIC_CATALOG_QUERY_SCHEMA,
      },
    },
    async (request, reply) => {
      const query = publicCatalogQuery(request, reply, 'shops', config.CHARTER_CURSOR_SECRET);
      if (!query) {
        return;
      }
      const result = await repository.searchPublicShops(query);
      void repository
        .recordDiscovery({
          requestId: request.id,
          query: query.q,
          surface: 'shops.search',
          agentSource: 'directory_http',
          hits: result.items.map((shop, index) => ({
            tenantId: shop.tenantId,
            shopSlug: shop.slug,
            rank: index + 1,
          })),
        })
        .catch(() => undefined);
      const { cursor, ...response } = result;
      return {
        ...response,
        nextCursor: nextPublicCatalogCursor(query, cursor, config.CHARTER_CURSOR_SECRET),
      };
    },
  );

  app.get(
    '/v1/shops/:slug',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['slug'],
          properties: { slug: SHOP_SLUG_SCHEMA },
        },
        querystring: PUBLIC_CATALOG_QUERY_SCHEMA,
      },
    },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const query = publicCatalogQuery(
        request,
        reply,
        `shop:${slug}`,
        config.CHARTER_CURSOR_SECRET,
      );
      if (!query) {
        return;
      }
      const result = await repository.searchPublicCatalog(slug, query);
      if (!result) {
        return reply.status(404).send({ error: 'SHOP_UNKNOWN' });
      }
      void repository
        .recordDiscovery({
          requestId: request.id,
          query: query.q,
          surface: 'catalog.search',
          agentSource: 'directory_http',
          hits: result.items.map((item, index) => ({
            tenantId: result.shop.tenantId,
            shopSlug: result.shop.slug,
            sku: item.sku,
            rank: index + 1,
          })),
        })
        .catch(() => undefined);
      const { cursor, ...response } = result;
      return {
        ...response,
        merchant: {
          tenantId: result.shop.tenantId,
          name: result.shop.name,
          slug: result.shop.slug,
          blurb: result.shop.blurb,
          currency: result.shop.currency,
        },
        nextCursor: nextPublicCatalogCursor(query, cursor, config.CHARTER_CURSOR_SECRET),
      };
    },
  );

  app.post(
    '/v1/shops',
    {
      preValidation: requireBuyerPreValidation,
      schema: {
        headers: {
          type: 'object',
          required: ['idempotency-key'],
          properties: {
            'idempotency-key': {
              type: 'string',
              minLength: 8,
              maxLength: 128,
              pattern: '^[A-Za-z0-9._:-]+$',
            },
          },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 2, maxLength: 120 },
            blurb: { type: 'string', maxLength: 500 },
          },
        },
      },
      config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
    },
    async (request, reply) => {
      const principal = requireBuyer(request, reply);
      if (!principal) {
        return;
      }
      const body = request.body as { name: string; blurb?: string };
      try {
        const shop = await repository.provisionShop(
          principal,
          {
            name: body.name,
            ...(body.blurb === undefined ? {} : { blurb: body.blurb }),
          },
          {
            idempotencyKey: String(request.headers['idempotency-key']),
            requestHash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
          },
        );
        return reply.status(201).send({ shop, requestId: request.id });
      } catch (error) {
        const code = safeErrorCode(
          error,
          ['SHOP_NAME_REQUIRED', 'IDEMPOTENCY_CONFLICT'],
          'SHOP_CREATE_FAILED',
        );
        return reply
          .status(code === 'IDEMPOTENCY_CONFLICT' ? 409 : 400)
          .send({ error: code, requestId: request.id });
      }
    },
  );

  app.post(
    '/v1/shops/:tenantId/items',
    {
      preValidation: requireBuyerPreValidation,
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['tenantId'],
          properties: { tenantId: TENANT_ID_SCHEMA },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'priceRupees', 'stock'],
          properties: {
            title: { type: 'string', minLength: 2, maxLength: 180 },
            priceRupees: { type: 'number', exclusiveMinimum: 0, maximum: 10_000_000 },
            stock: { type: 'integer', minimum: 0, maximum: 2_147_483_647 },
            material: { type: 'string', enum: ['steel', 'glass', 'paper', 'other'] },
          },
        },
      },
    },
    async (request, reply) => {
      const { tenantId } = request.params as { tenantId: string };
      const principal = await requireShopMember(
        request,
        reply,
        repository,
        tenantId,
        CAPABILITIES.catalogWrite,
      );
      if (!principal) {
        return;
      }
      return reply.status(410).send({
        error: 'CATALOG_ROUTE_REPLACED',
        replacement: `/v1/merchant/shops/${tenantId}/catalog/products`,
        requestId: request.id,
      });
    },
  );

  app.patch(
    '/v1/shops/:tenantId/items/:sku',
    {
      preValidation: requireBuyerPreValidation,
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['tenantId', 'sku'],
          properties: { tenantId: TENANT_ID_SCHEMA, sku: SKU_SCHEMA },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['stock'],
          properties: {
            stock: { type: 'integer', minimum: 0, maximum: 2_147_483_647 },
          },
        },
      },
    },
    async (request, reply) => {
      const { tenantId } = request.params as { tenantId: string; sku: string };
      const principal = await requireShopMember(
        request,
        reply,
        repository,
        tenantId,
        CAPABILITIES.catalogWrite,
      );
      if (!principal) {
        return;
      }
      return reply.status(410).send({
        error: 'CATALOG_ROUTE_REPLACED',
        replacement: `/v1/merchant/shops/${tenantId}/catalog/variants/:variantId/stock-adjustments`,
        requestId: request.id,
      });
    },
  );

  app.get('/v1/merchants', async () => ({
    items: (await repository.listPublicShops()).map((row) => ({
      tenantId: row.tenantId,
      slug: row.slug,
      name: row.name,
      blurb: row.blurb,
      currency: row.currency,
      href: row.href,
    })),
  }));

  app.get(
    '/v1/merchants/:tenantId',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['tenantId'],
          properties: { tenantId: TENANT_ID_SCHEMA },
        },
      },
    },
    async (request, reply) => {
      const { tenantId } = request.params as { tenantId: string };
      const shop = await repository.findShopByTenantId(tenantId);
      if (!shop) {
        return reply.status(404).send({ error: 'TENANT_UNKNOWN' });
      }
      return {
        tenantId: shop.tenantId,
        slug: shop.slug,
        name: shop.name,
        blurb: shop.blurb,
        currency: shop.currency,
        href: `/shops/${shop.slug}`,
      };
    },
  );

  app.get(
    '/v1/merchants/:tenantId/catalog',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['tenantId'],
          properties: { tenantId: TENANT_ID_SCHEMA },
        },
      },
    },
    async (request, reply) => {
      const { tenantId } = request.params as { tenantId: string };
      if (!(await repository.findShopByTenantId(tenantId))) {
        return reply.status(404).send({ error: 'TENANT_UNKNOWN' });
      }
      return { items: await repository.listCatalog(tenantId) };
    },
  );

  app.post(
    '/v1/carts',
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
      const { shopSlug } = request.body as { shopSlug: string };
      const shop = await repository.findShopBySlug(shopSlug);
      if (!shop) {
        return reply.status(404).send({ error: 'SHOP_UNKNOWN' });
      }
      await hydrateCatalogCache(repository, shop);
      const cart = createCart(shop.tenantId);
      await persist?.saveCart(cart, principal.userId);
      await repository.claimResource('cart', cart.tenantId, cart.id, principal.userId);
      return serializeCart(cart);
    },
  );

  app.get(
    '/v1/carts/:id',
    {
      preValidation: requireBuyerPreValidation,
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: UUID_SCHEMA },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const query = request.query as { shopSlug?: string };
      if (!query.shopSlug) {
        return reply.status(400).send({ error: 'SHOP_SLUG_REQUIRED' });
      }
      const shop = await repository.findShopBySlug(query.shopSlug);
      if (!shop) {
        return reply.status(404).send({ error: 'SHOP_UNKNOWN' });
      }
      const cart =
        (getCart(id)?.tenantId === shop.tenantId ? getCart(id) : undefined) ??
        (await persist?.loadCart(shop.tenantId, id));
      if (!cart || cart.tenantId !== shop.tenantId) {
        return reply.status(404).send({ error: 'CART_NOT_FOUND' });
      }
      const principal = await requireOwnedResource(request, reply, repository, {
        kind: 'cart',
        tenantId: shop.tenantId,
        resourceId: id,
      });
      if (!principal) {
        return;
      }
      return serializeCart(cart);
    },
  );

  app.post(
    '/v1/carts/:id/lines',
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
          required: ['shopSlug', 'sku'],
          properties: { shopSlug: SHOP_SLUG_SCHEMA, sku: SKU_SCHEMA },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const shop = await canonicalShop(request, reply, repository);
      if (!shop) {
        return;
      }
      const cart = await tenantCart(shop.tenantId, id, persist);
      if (!cart) {
        return reply.status(404).send({ error: 'CART_NOT_FOUND' });
      }
      const principal = await requireOwnedResource(request, reply, repository, {
        kind: 'cart',
        tenantId: shop.tenantId,
        resourceId: id,
      });
      if (!principal) {
        return;
      }
      const { sku } = request.body as { sku?: string; shopSlug?: string };
      if (!sku) {
        return reply.status(400).send({ error: 'SKU_REQUIRED' });
      }
      try {
        const result = addLine(id, sku);
        await persist?.saveCart(result.cart);
        return { ...result, cart: serializeCart(result.cart) };
      } catch (error) {
        const code = safeErrorCode(error, ['CART_NOT_FOUND', 'SKU_UNKNOWN'], 'CART_ERROR');
        return reply.status(404).send({ error: code });
      }
    },
  );

  app.post(
    '/v1/carts/:id/quotes',
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
          required: ['shopSlug'],
          properties: { shopSlug: SHOP_SLUG_SCHEMA },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const shop = await canonicalShop(request, reply, repository);
      if (!shop) {
        return;
      }
      const cart = await tenantCart(shop.tenantId, id, persist);
      if (!cart) {
        return reply.status(404).send({ error: 'CART_NOT_FOUND' });
      }
      const principal = await requireOwnedResource(request, reply, repository, {
        kind: 'cart',
        tenantId: shop.tenantId,
        resourceId: id,
      });
      if (!principal) {
        return;
      }
      try {
        const quote = freezeQuote(id);
        assertQuoteFactsFresh(quote);
        await persist?.assertQuoteFacts(quote);
        await persist?.saveQuote(quote);
        await repository.claimResource('quote', shop.tenantId, quote.id, principal.userId);
        return serializeQuote(quote);
      } catch (error) {
        const code = safeErrorCode(
          error,
          [
            'CART_NOT_FOUND',
            'SKU_UNKNOWN',
            'AUTHORITY_APPROVAL_REQUIRED',
            'PRODUCT_MATERIAL_FORBIDDEN',
            'OUT_OF_STOCK',
            'HARD_CAP_EXCEEDED',
            'FACTS_STALE',
            'FACTS_UNPINNED',
            'OFFER_MARGIN_FLOOR',
            'OFFER_BUDGET_EXHAUSTED',
            'OFFER_FREQUENCY_EXHAUSTED',
          ],
          'QUOTE_ERROR',
        );
        return reply.status(409).send({ error: code });
      }
    },
  );

  app.post(
    '/v1/carts/:id/preview-replace',
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
          required: ['shopSlug', 'fromSku', 'toSku'],
          properties: {
            shopSlug: SHOP_SLUG_SCHEMA,
            fromSku: SKU_SCHEMA,
            toSku: SKU_SCHEMA,
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const shop = await canonicalShop(request, reply, repository);
      if (!shop) {
        return;
      }
      const cart = await tenantCart(shop.tenantId, id, persist);
      if (!cart) {
        return reply.status(404).send({ error: 'CART_NOT_FOUND' });
      }
      const principal = await requireOwnedResource(request, reply, repository, {
        kind: 'cart',
        tenantId: shop.tenantId,
        resourceId: id,
      });
      if (!principal) {
        return;
      }
      const { fromSku, toSku } = request.body as {
        fromSku?: string;
        toSku?: string;
        shopSlug?: string;
      };
      if (!fromSku || !toSku) {
        return reply.status(400).send({ error: 'SKU_REQUIRED' });
      }
      try {
        const preview = previewReplace(id, fromSku, toSku);
        if (preview.approval) {
          await persist?.saveApproval(preview.approval, principal.userId);
        }
        return {
          decision: preview.decision,
          proposedDisplay: preview.proposedDisplay,
          proposedTotalMinor: preview.proposedTotalMinor.toString(),
          cartUnchanged: preview.cartUnchanged,
          approval: preview.approval
            ? {
                id: preview.approval.id,
                status: preview.approval.status,
                proposedDisplay: preview.approval.proposedDisplay,
              }
            : null,
        };
      } catch (error) {
        const code = safeErrorCode(error, ['CART_NOT_FOUND', 'SKU_UNKNOWN'], 'CART_ERROR');
        return reply.status(404).send({ error: code });
      }
    },
  );

  app.post('/v1/demo/canonical-kit', async (request, reply) => {
    if (config.CHARTER_ENV === 'production' || config.CHARTER_ENV === 'staging') {
      const platform = await requirePlatformRole(request, reply, repository, ['admin', 'operator']);
      if (!platform) {
        return;
      }
    }
    const result = buildCanonicalKit();
    await persist?.saveCart(result.cart);
    await persist?.saveQuote(result.quote);
    return {
      cart: serializeCart(result.cart),
      quote: serializeQuote(result.quote),
      glass: result.glass,
      kettle: result.kettle,
    };
  });

  app.get(
    '/v1/quotes/:id',
    {
      preValidation: requireBuyerPreValidation,
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: UUID_SCHEMA },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const shop = await canonicalShop(request, reply, repository);
      if (!shop) {
        return;
      }
      const quote = await tenantQuote(shop.tenantId, id, persist);
      if (!quote) {
        return reply.status(404).send({ error: 'QUOTE_NOT_FOUND' });
      }
      if (
        !(await requireOwnedResource(request, reply, repository, {
          kind: 'quote',
          tenantId: shop.tenantId,
          resourceId: id,
        }))
      ) {
        return;
      }
      return serializeQuote(quote);
    },
  );

  app.post(
    '/v1/quotes/:id/checkout',
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
          required: ['shopSlug'],
          properties: { shopSlug: SHOP_SLUG_SCHEMA },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const shop = await canonicalShop(request, reply, repository);
      if (!shop) {
        return;
      }
      const principal = await requireOwnedResource(request, reply, repository, {
        kind: 'quote',
        tenantId: shop.tenantId,
        resourceId: id,
      });
      if (!principal) {
        return;
      }
      if (!razorpay || !config.RAZORPAY_KEY_ID || !config.RAZORPAY_KEY_SECRET) {
        return reply.status(503).send({ error: 'CONFIG_PAYMENTS_NOT_READY' });
      }
      const quote = await tenantQuote(shop.tenantId, id, persist);
      if (!quote) {
        return reply.status(404).send({ error: 'QUOTE_NOT_FOUND' });
      }
      try {
        if (await repository.isCheckoutKilled(shop.tenantId)) {
          throw new Error('CHECKOUT_KILLED');
        }
        await persist?.assertQuoteFacts(quote);
        await hydrateBoundCheckout(persist, shop.tenantId, quote);
        const prior = findCheckoutByQuote(id);
        const priorStatus = prior?.status;
        const priorId = prior?.id;
        const { session, quote: checkoutQuote } = await startCheckout(id, razorpay);
        const retryAllowed =
          (priorStatus === 'FAILED_PROVISIONAL' || priorStatus === 'RECONCILING') &&
          session.status === 'CREATED' &&
          session.id === priorId;
        if (session.status === 'SETTLED') {
          await persist?.rememberCapture(session);
          return {
            checkoutId: session.id,
            orderId: session.razorpayOrderId,
            amount: session.amountMinor,
            currency: session.currency,
            status: session.status,
            copy: session.copy,
            quote: serializeQuote(checkoutQuote),
            retryAllowed: false,
            reconciliationOutcome: 'captured',
          };
        }
        await persist?.saveCheckout(session);
        await repository.claimResource('checkout', shop.tenantId, session.id, principal.userId);
        return {
          checkoutId: session.id,
          keyId: config.RAZORPAY_KEY_ID,
          orderId: session.razorpayOrderId,
          amount: session.amountMinor,
          currency: session.currency,
          name: checkoutQuote.merchant,
          description: 'Locked total',
          receipt: session.receipt,
          quote: serializeQuote(checkoutQuote),
          copy: session.copy,
          status: session.status,
          retryAllowed,
          reconciliationOutcome: retryAllowed ? 'same_order_retry_safe' : undefined,
        };
      } catch (error) {
        const existing = findCheckoutByQuote(id);
        if (existing) {
          await persistReconciledCheckout(persist, existing);
        }
        const code = safeErrorCode(
          error,
          [
            'QUOTE_NOT_FOUND',
            'QUOTE_ALREADY_BOUND',
            'QUOTE_ALREADY_PAID',
            'PAYMENT_AUTHORIZED',
            'RECONCILIATION_REQUIRED',
            'RECONCILIATION_PROVIDER_IDENTITY_MISMATCH',
            'CHECKOUT_KILLED',
            'FACTS_STALE',
            'FACTS_UNPINNED',
            'BOUND_CHECKOUT_NOT_HYDRATED',
            'PAYMENT_REFUNDED',
            'OFFER_MARGIN_FLOOR',
          ],
          'CHECKOUT_ERROR',
        );
        const status = code === 'QUOTE_NOT_FOUND' ? 404 : code === 'CHECKOUT_KILLED' ? 423 : 409;
        return reply.status(status).send({ error: code });
      }
    },
  );

  app.post(
    '/v1/checkouts/:id/callback',
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
          required: ['shopSlug', 'razorpay_order_id', 'razorpay_payment_id', 'razorpay_signature'],
          properties: {
            shopSlug: SHOP_SLUG_SCHEMA,
            razorpay_order_id: { type: 'string', minLength: 1, maxLength: 255 },
            razorpay_payment_id: { type: 'string', minLength: 1, maxLength: 255 },
            razorpay_signature: { type: 'string', minLength: 1, maxLength: 512 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const shop = await canonicalShop(request, reply, repository);
      if (!shop) {
        return;
      }
      if (
        !(await requireOwnedResource(request, reply, repository, {
          kind: 'checkout',
          tenantId: shop.tenantId,
          resourceId: id,
        }))
      ) {
        return;
      }
      if (!razorpay || !config.RAZORPAY_KEY_SECRET) {
        return reply.status(503).send({ error: 'CONFIG_PAYMENTS_NOT_READY' });
      }
      const checkout = await tenantCheckout(shop.tenantId, id, persist);
      if (!checkout) {
        return reply.status(404).send({ error: 'CHECKOUT_NOT_FOUND' });
      }
      const body = request.body as {
        razorpay_order_id: string;
        razorpay_payment_id: string;
        razorpay_signature: string;
      };
      try {
        const session = await applyCheckoutCallback(
          id,
          {
            orderId: body.razorpay_order_id,
            paymentId: body.razorpay_payment_id,
            signature: body.razorpay_signature,
          },
          razorpay,
          config.RAZORPAY_KEY_SECRET,
        );
        if (session.status === 'SETTLED') {
          await persist?.rememberCapture(session);
        } else {
          await persist?.saveCheckout(session);
        }
        const recoveryAttempt =
          session.status === 'FAILED_PROVISIONAL'
            ? await recovery?.afterFailedPay(session)
            : undefined;
        return { ...session, recovery: recoveryAttempt ?? null };
      } catch (error) {
        const code = safeErrorCode(
          error,
          ['INVALID_CHECKOUT_SIGNATURE', 'CHECKOUT_NOT_FOUND'],
          'CALLBACK_ERROR',
        );
        const status = code === 'INVALID_CHECKOUT_SIGNATURE' ? 400 : 409;
        return reply.status(status).send({ error: code });
      }
    },
  );

  app.get(
    '/v1/checkouts/:id',
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
          properties: { shopSlug: SHOP_SLUG_SCHEMA },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const shop = await canonicalShop(request, reply, repository);
      if (!shop) {
        return;
      }
      if (
        !(await requireOwnedResource(request, reply, repository, {
          kind: 'checkout',
          tenantId: shop.tenantId,
          resourceId: id,
        }))
      ) {
        return;
      }
      const session = await tenantCheckout(shop.tenantId, id, persist);
      if (!session) {
        return reply.status(404).send({ error: 'CHECKOUT_NOT_FOUND' });
      }
      return session;
    },
  );

  app.post(
    '/v1/checkouts/:id/dismissed',
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
          required: ['shopSlug'],
          properties: { shopSlug: SHOP_SLUG_SCHEMA },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const shop = await canonicalShop(request, reply, repository);
      if (!shop) {
        return;
      }
      if (
        !(await requireOwnedResource(request, reply, repository, {
          kind: 'checkout',
          tenantId: shop.tenantId,
          resourceId: id,
        }))
      ) {
        return;
      }
      const checkout = await tenantCheckout(shop.tenantId, id, persist);
      if (!checkout) {
        return reply.status(404).send({ error: 'CHECKOUT_NOT_FOUND' });
      }
      try {
        const session = markCheckoutDismissed(id);
        await persist?.saveCheckout(session);
        const recoveryAttempt = await recovery?.afterFailedPay(session);
        return { ...session, recovery: recoveryAttempt ?? null };
      } catch (error) {
        const code = safeErrorCode(error, ['CHECKOUT_NOT_FOUND'], 'CHECKOUT_ERROR');
        return reply.status(404).send({ error: code });
      }
    },
  );

  app.post(
    '/v1/recovery/consent',
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
            purpose: { type: 'string' },
            channel: { type: 'string' },
            checkoutId: { type: 'string', format: 'uuid' },
          },
        },
      },
      config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    },
    async (request, reply) => {
      if (!recovery) {
        return reply.status(503).send({ error: 'RECOVERY_NOT_READY' });
      }
      const principal = requireBuyer(request, reply);
      if (!principal) {
        return;
      }
      const shop = await canonicalShop(request, reply, repository);
      if (!shop) {
        return;
      }
      const body = request.body as {
        purpose?: string;
        channel?: string;
        checkoutId?: string;
        shopSlug?: string;
      };
      if (!principal.email) {
        return reply.status(400).send({ error: 'AUTH_EMAIL_REQUIRED' });
      }
      try {
        let consent = recovery.store.grant({
          email: principal.email,
          ...(body.purpose === undefined ? {} : { purpose: body.purpose }),
          ...(body.channel === undefined ? {} : { channel: body.channel }),
        });
        const durableConsent = await repository.saveRecoveryConsent({
          id: consent.id,
          tenantId: shop.tenantId,
          userId: principal.userId,
          email: consent.email,
          purpose: consent.purpose,
          channel: consent.channel,
          grantedAt: consent.grantedAt,
        });
        if (durableConsent.id !== consent.id) {
          consent = recovery.store.hydrate({
            id: durableConsent.id,
            email: durableConsent.email,
            purpose: durableConsent.purpose,
            channel: durableConsent.channel,
            grantedAt: durableConsent.grantedAt,
          });
        }
        if (body.checkoutId) {
          if (
            !(await requireOwnedResource(request, reply, repository, {
              kind: 'checkout',
              tenantId: shop.tenantId,
              resourceId: body.checkoutId,
            }))
          ) {
            return;
          }
          const checkout = await tenantCheckout(shop.tenantId, body.checkoutId, persist);
          if (!checkout) {
            return reply.status(404).send({ error: 'CHECKOUT_NOT_FOUND' });
          }
          await repository.bindRecoveryConsent({
            tenantId: shop.tenantId,
            checkoutId: body.checkoutId,
            consentId: consent.id,
            userId: principal.userId,
          });
          recovery.store.bind(body.checkoutId, consent.id);
          const session = await tenantCheckout(shop.tenantId, body.checkoutId, persist);
          const attempt = session ? await recovery.afterFailedPay(session) : null;
          return {
            consentId: consent.id,
            purpose: consent.purpose,
            channel: consent.channel,
            recovery: attempt,
          };
        }
        return {
          consentId: consent.id,
          purpose: consent.purpose,
          channel: consent.channel,
          recovery: null,
        };
      } catch (error) {
        const code = safeErrorCode(
          error,
          [
            'CONSENT_PURPOSE_REQUIRED',
            'CONSENT_CHANNEL_REQUIRED',
            'CONSENT_NOT_FOUND',
            'AUTH_EMAIL_REQUIRED',
          ],
          'CONSENT_ERROR',
        );
        return reply.status(400).send({ error: code });
      }
    },
  );

  app.post(
    '/v1/checkouts/:id/recovery',
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
          required: ['shopSlug', 'consentId'],
          properties: {
            shopSlug: {
              type: 'string',
              minLength: 1,
              maxLength: 64,
              pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
            },
            consentId: { type: 'string', format: 'uuid' },
          },
        },
      },
      config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const shop = await canonicalShop(request, reply, repository);
      if (!shop) {
        return;
      }
      const principal = await requireOwnedResource(request, reply, repository, {
        kind: 'checkout',
        tenantId: shop.tenantId,
        resourceId: id,
      });
      if (!principal) {
        return;
      }
      if (!recovery) {
        return reply.status(503).send({ error: 'RECOVERY_NOT_READY' });
      }
      const { consentId } = request.body as { consentId?: string; shopSlug?: string };
      if (!consentId) {
        return reply.status(400).send({ error: 'CONSENT_ID_REQUIRED' });
      }
      const checkout = await tenantCheckout(shop.tenantId, id, persist);
      if (!checkout) {
        return reply.status(404).send({ error: 'CHECKOUT_NOT_FOUND' });
      }
      try {
        await repository.bindRecoveryConsent({
          tenantId: shop.tenantId,
          checkoutId: id,
          consentId,
          userId: principal.userId,
        });
        const consent = await repository.loadRecoveryConsent({
          tenantId: shop.tenantId,
          checkoutId: id,
          userId: principal.userId,
        });
        if (!consent || consent.userId !== principal.userId) {
          return reply.status(404).send({ error: 'CONSENT_NOT_FOUND' });
        }
        recovery.store.hydrate({
          id: consent.id,
          email: consent.email,
          purpose: consent.purpose,
          channel: consent.channel,
          grantedAt: consent.grantedAt,
        });
        recovery.store.bind(id, consent.id);
        const session = getCheckout(id);
        const attempt = session ? await recovery.afterFailedPay(session) : null;
        return { checkoutId: id, bound: true, recovery: attempt };
      } catch (error) {
        const code = safeErrorCode(error, ['CONSENT_NOT_FOUND'], 'CONSENT_ERROR');
        return reply.status(400).send({ error: code });
      }
    },
  );
}
