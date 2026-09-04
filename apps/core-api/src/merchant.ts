import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Material } from '@charter/catalog';
import { isFulfillmentStatus } from '@charter/commerce';
import type { AppConfig } from '@charter/config';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireBuyer, requireBuyerPreValidation, type BuyerPrincipal } from './auth/context.js';
import { safeErrorCode } from './http-errors.js';
import { parseInrDecimalToPaise } from './merchant-money.js';
import { resolveMerchantDateRange } from './merchant-dates.js';
import type { RecoveryRuntime } from './recovery.js';
import type { MoneyPersist } from './persist.js';
import type {
  MerchantCatalogStatus,
  MerchantCursorPosition,
  MerchantOffer,
} from './tenant/merchant-repository.js';
import type { ShopRole, TenantRepository } from './tenant/repository.js';

const TENANT_ID_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 63,
  pattern: '^[a-z0-9][a-z0-9-]{0,62}$',
} as const;
const UUID_SCHEMA = { type: 'string', format: 'uuid' } as const;
const DATE_SCHEMA = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
const MONEY_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 15,
} as const;
const IDEMPOTENCY_HEADERS_SCHEMA = {
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
} as const;
const LIST_QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$' },
    cursor: { type: 'string', minLength: 16, maxLength: 1024 },
  },
} as const;

const ALL_MEMBER_ROLES = [
  'owner',
  'admin',
  'catalog',
  'support',
  'finance',
  'viewer',
] as const satisfies readonly ShopRole[];
const CATALOG_WRITERS = ['owner', 'admin', 'catalog'] as const satisfies readonly ShopRole[];
const ORDER_READERS = [
  'owner',
  'admin',
  'catalog',
  'support',
  'finance',
  'viewer',
] as const satisfies readonly ShopRole[];
const FULFILLMENT_WRITERS = [
  'owner',
  'admin',
  'catalog',
  'support',
] as const satisfies readonly ShopRole[];
const RECOVERY_READERS = ['owner', 'admin', 'support'] as const satisfies readonly ShopRole[];
const RECOVERY_SENDERS = ['owner', 'admin', 'support'] as const satisfies readonly ShopRole[];
const MANAGERS = ['owner', 'admin'] as const satisfies readonly ShopRole[];

type CursorPayload = {
  scope: string;
  sortValue: string;
  id: string;
};

function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function encodeCursor(
  scope: string,
  cursor: MerchantCursorPosition | null | undefined,
  secret: string,
): string | null {
  if (!cursor) {
    return null;
  }
  const payload = Buffer.from(
    JSON.stringify({ scope, sortValue: cursor.sortValue, id: cursor.id } satisfies CursorPayload),
  ).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function decodeCursor(
  token: string | undefined,
  scope: string,
  secret: string,
): MerchantCursorPosition | null {
  if (!token) {
    return null;
  }
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) {
    throw new Error('CURSOR_INVALID');
  }
  const expected = createHmac('sha256', secret).update(payload).digest();
  let received: Buffer;
  try {
    received = Buffer.from(signature, 'base64url');
  } catch {
    throw new Error('CURSOR_INVALID');
  }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new Error('CURSOR_INVALID');
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new Error('CURSOR_INVALID');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    (value as Partial<CursorPayload>).scope !== scope ||
    typeof (value as Partial<CursorPayload>).sortValue !== 'string' ||
    typeof (value as Partial<CursorPayload>).id !== 'string'
  ) {
    throw new Error('CURSOR_INVALID');
  }
  return {
    sortValue: (value as CursorPayload).sortValue,
    id: (value as CursorPayload).id,
  };
}

function defaultDateRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 29);
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  };
}

function idempotencyKey(request: FastifyRequest): string {
  return String(request.headers['idempotency-key']);
}

function listLimit(value: string | undefined): number {
  return value ? Number(value) : 25;
}

function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  fallback = 'MERCHANT_REQUEST_FAILED',
): FastifyReply {
  const code = safeErrorCode(
    error,
    [
      'CATALOG_VERSION_CONFLICT',
      'INVENTORY_VERSION_CONFLICT',
      'RULES_VERSION_CONFLICT',
      'SETTINGS_VERSION_CONFLICT',
      'IDEMPOTENCY_CONFLICT',
      'CURSOR_INVALID',
      'DATE_RANGE_INVALID',
      'MONEY_DECIMAL_INVALID',
      'CATALOG_PUBLISH_INVALID',
      'CATALOG_SKU_CONFLICT',
      'CATALOG_MATERIAL_INVALID',
      'CATALOG_PRODUCT_NOT_FOUND',
      'CATALOG_VARIANT_NOT_FOUND',
      'INVENTORY_ADJUSTMENT_INVALID',
      'INVENTORY_INSUFFICIENT',
      'RULES_INVALID',
      'SETTINGS_INVALID',
      'SHOP_POLICY_NOT_FOUND',
      'TENANT_UNKNOWN',
      'ORDER_NOT_FOUND',
      'FULFILLMENT_NOT_READY',
      'FULFILLMENT_STATUS_INVALID',
    ],
    fallback,
  );
  const status =
    code.endsWith('VERSION_CONFLICT') ||
    code === 'IDEMPOTENCY_CONFLICT' ||
    code === 'CATALOG_SKU_CONFLICT'
      ? 409
      : code === 'CATALOG_PRODUCT_NOT_FOUND' ||
          code === 'CATALOG_VARIANT_NOT_FOUND' ||
          code === 'SHOP_POLICY_NOT_FOUND' ||
          code === 'TENANT_UNKNOWN' ||
          code === 'ORDER_NOT_FOUND'
        ? 404
        : code === 'CATALOG_PUBLISH_INVALID' ||
            code === 'INVENTORY_INSUFFICIENT' ||
            code === 'FULFILLMENT_NOT_READY'
          ? 422
          : code === fallback
            ? 500
            : 400;
  return reply.status(status).send({ error: code, requestId: request.id });
}

async function requireMerchantCapability(
  request: FastifyRequest,
  reply: FastifyReply,
  repository: TenantRepository,
  tenantId: string,
  roles: readonly ShopRole[],
): Promise<{ principal: BuyerPrincipal; role: ShopRole } | undefined> {
  const principal = requireBuyer(request, reply);
  if (!principal) {
    return undefined;
  }
  const role = await repository.membershipRole(principal.userId, tenantId);
  if (!role) {
    reply.status(403).send({ error: 'SHOP_MEMBERSHIP_REQUIRED', requestId: request.id });
    return undefined;
  }
  if (!roles.includes(role)) {
    reply.status(403).send({ error: 'SHOP_CAPABILITY_REQUIRED', requestId: request.id });
    return undefined;
  }
  return { principal, role };
}

function material(value: string): Material {
  if (value === 'steel' || value === 'glass' || value === 'paper' || value === 'other') {
    return value;
  }
  throw new Error('CATALOG_MATERIAL_INVALID');
}

function offersWithMinor(
  offers: Array<{
    id: string;
    discount: string;
    requiredSkuGroups: string[][];
    stackable?: boolean;
    marginFloorMinor?: string | null;
    budgetRemainingMinor?: string | null;
    maxRedemptions?: number | null;
    redemptions?: number | null;
    expiresAt?: string | null;
  }>,
): Array<Omit<MerchantOffer, 'discountDisplay'> & { discountMinor: string }> {
  return offers.map((offer) => {
    const mapped: Omit<MerchantOffer, 'discountDisplay'> & { discountMinor: string } = {
      id: offer.id,
      discountMinor: parseInrDecimalToPaise(offer.discount).toString(),
      requiredSkuGroups: offer.requiredSkuGroups,
    };
    if (offer.stackable !== undefined) {
      mapped.stackable = offer.stackable;
    }
    if (offer.marginFloorMinor !== undefined) {
      mapped.marginFloorMinor = offer.marginFloorMinor;
    }
    if (offer.budgetRemainingMinor !== undefined) {
      mapped.budgetRemainingMinor = offer.budgetRemainingMinor;
    }
    if (offer.maxRedemptions !== undefined) {
      mapped.maxRedemptions = offer.maxRedemptions;
    }
    if (offer.redemptions !== undefined) {
      mapped.redemptions = offer.redemptions;
    }
    if (offer.expiresAt !== undefined) {
      mapped.expiresAt = offer.expiresAt;
    }
    return mapped;
  });
}

export async function registerMerchantRoutes(
  app: FastifyInstance,
  config: AppConfig,
  repository: TenantRepository,
  recovery: RecoveryRuntime,
  persist?: Pick<MoneyPersist, 'loadCheckout'>,
): Promise<void> {
  app.get(
    '/v1/merchant/shops/:tenantId/overview',
    {
      preValidation: requireBuyerPreValidation,
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['tenantId'],
          properties: { tenantId: TENANT_ID_SCHEMA },
        },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { from: DATE_SCHEMA, to: DATE_SCHEMA },
        },
      },
    },
    async (request, reply) => {
      const { tenantId } = request.params as { tenantId: string };
      const access = await requireMerchantCapability(
        request,
        reply,
        repository,
        tenantId,
        ALL_MEMBER_ROLES,
      );
      if (!access) return;
      const query = request.query as { from?: string; to?: string };
      try {
        const range = resolveMerchantDateRange(query.from, query.to, defaultDateRange());
        return {
          ...(await repository.getMerchantOverview({
            userId: access.principal.userId,
            tenantId,
            from: range.from,
            to: range.to,
          })),
          requestId: request.id,
        };
      } catch (error) {
        return sendError(request, reply, error);
      }
    },
  );

  app.get(
    '/v1/merchant/shops/:tenantId/catalog',
    {
      preValidation: requireBuyerPreValidation,
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['tenantId'],
          properties: { tenantId: TENANT_ID_SCHEMA },
        },
        querystring: LIST_QUERY_SCHEMA,
      },
    },
    async (request, reply) => {
      const { tenantId } = request.params as { tenantId: string };
      const access = await requireMerchantCapability(
        request,
        reply,
        repository,
        tenantId,
        ALL_MEMBER_ROLES,
      );
      if (!access) return;
      const query = request.query as { limit?: string; cursor?: string };
      const scope = `merchant:${tenantId}:catalog`;
      try {
        const page = await repository.listMerchantCatalog({
          userId: access.principal.userId,
          tenantId,
          limit: listLimit(query.limit),
          after: decodeCursor(query.cursor, scope, config.CHARTER_CURSOR_SECRET),
        });
        return {
          items: page.items,
          nextCursor: encodeCursor(scope, page.cursor, config.CHARTER_CURSOR_SECRET),
          requestId: request.id,
        };
      } catch (error) {
        return sendError(request, reply, error);
      }
    },
  );

  app.post(
    '/v1/merchant/shops/:tenantId/catalog/products',
    {
      preValidation: requireBuyerPreValidation,
      schema: {
        headers: IDEMPOTENCY_HEADERS_SCHEMA,
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['tenantId'],
          properties: { tenantId: TENANT_ID_SCHEMA },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: [
            'title',
            'description',
            'category',
            'sku',
            'material',
            'price',
            'stock',
            'status',
          ],
          properties: {
            title: { type: 'string', minLength: 2, maxLength: 180 },
            description: { type: 'string', maxLength: 2000 },
            category: { type: 'string', maxLength: 120 },
            sku: { type: 'string', minLength: 1, maxLength: 160 },
            material: { type: 'string', enum: ['steel', 'glass', 'paper', 'other'] },
            price: MONEY_SCHEMA,
            stock: { type: 'integer', minimum: 0, maximum: 1_000_000_000 },
            status: { type: 'string', enum: ['draft', 'published', 'archived'] },
          },
        },
      },
    },
    async (request, reply) => {
      const { tenantId } = request.params as { tenantId: string };
      const access = await requireMerchantCapability(
        request,
        reply,
        repository,
        tenantId,
        CATALOG_WRITERS,
      );
      if (!access) return;
      const body = request.body as {
        title: string;
        description: string;
        category: string;
        sku: string;
        material: Material;
        price: string;
        stock: number;
        status: MerchantCatalogStatus;
      };
      try {
        const item = await repository.createMerchantProduct({
          userId: access.principal.userId,
          tenantId,
          title: body.title,
          description: body.description,
          category: body.category,
          sku: body.sku,
          material: material(body.material),
          priceMinor: parseInrDecimalToPaise(body.price).toString(),
          stock: body.stock,
          status: body.status,
          idempotencyKey: idempotencyKey(request),
          requestHash: requestHash(body),
        });
        return reply.status(201).send({ item, requestId: request.id });
      } catch (error) {
        return sendError(request, reply, error, 'CATALOG_CREATE_FAILED');
      }
    },
  );

  app.patch(
    '/v1/merchant/shops/:tenantId/catalog/products/:productId',
    {
      preValidation: requireBuyerPreValidation,
      schema: {
        headers: IDEMPOTENCY_HEADERS_SCHEMA,
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['tenantId', 'productId'],
          properties: { tenantId: TENANT_ID_SCHEMA, productId: UUID_SCHEMA },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: [
            'expectedVersion',
            'title',
            'description',
            'category',
            'sku',
            'material',
            'price',
            'status',
            'reason',
          ],
          properties: {
            expectedVersion: { type: 'integer', minimum: 1 },
            title: { type: 'string', minLength: 2, maxLength: 180 },
            description: { type: 'string', maxLength: 2000 },
            category: { type: 'string', maxLength: 120 },
            sku: { type: 'string', minLength: 1, maxLength: 160 },
            material: { type: 'string', enum: ['steel', 'glass', 'paper', 'other'] },
            price: MONEY_SCHEMA,
            status: { type: 'string', enum: ['draft', 'published', 'archived'] },
            reason: { type: 'string', minLength: 3, maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const { tenantId, productId } = request.params as {
        tenantId: string;
        productId: string;
      };
      const access = await requireMerchantCapability(
        request,
        reply,
        repository,
        tenantId,
        CATALOG_WRITERS,
      );
      if (!access) return;
      const body = request.body as {
        expectedVersion: number;
        title: string;
        description: string;
        category: string;
        sku: string;
        material: Material;
        price: string;
        status: MerchantCatalogStatus;
        reason: string;
      };
      try {
        return {
          item: await repository.updateMerchantProduct({
            userId: access.principal.userId,
            tenantId,
            productId,
            expectedVersion: body.expectedVersion,
            title: body.title,
            description: body.description,
            category: body.category,
            sku: body.sku,
            material: material(body.material),
            priceMinor: parseInrDecimalToPaise(body.price).toString(),
            status: body.status,
            reason: body.reason,
            idempotencyKey: idempotencyKey(request),
            requestHash: requestHash(body),
          }),
          requestId: request.id,
        };
      } catch (error) {
        return sendError(request, reply, error, 'CATALOG_UPDATE_FAILED');
      }
    },
  );

  app.post(
    '/v1/merchant/shops/:tenantId/catalog/variants/:variantId/stock-adjustments',
    {
      preValidation: requireBuyerPreValidation,
      schema: {
        headers: IDEMPOTENCY_HEADERS_SCHEMA,
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['tenantId', 'variantId'],
          properties: { tenantId: TENANT_ID_SCHEMA, variantId: UUID_SCHEMA },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['expectedVersion', 'delta', 'reason'],
          properties: {
            expectedVersion: { type: 'integer', minimum: 1 },
            delta: {
              type: 'integer',
              minimum: -1_000_000_000,
              maximum: 1_000_000_000,
              not: { const: 0 },
            },
            reason: { type: 'string', minLength: 3, maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const { tenantId, variantId } = request.params as {
        tenantId: string;
        variantId: string;
      };
      const access = await requireMerchantCapability(
        request,
        reply,
        repository,
        tenantId,
        CATALOG_WRITERS,
      );
      if (!access) return;
      const body = request.body as { expectedVersion: number; delta: number; reason: string };
      try {
        return {
          inventory: await repository.adjustMerchantStock({
            userId: access.principal.userId,
            tenantId,
            variantId,
            expectedVersion: body.expectedVersion,
            delta: body.delta,
            reason: body.reason,
            idempotencyKey: idempotencyKey(request),
            requestHash: requestHash(body),
          }),
          requestId: request.id,
        };
      } catch (error) {
        return sendError(request, reply, error, 'INVENTORY_ADJUSTMENT_FAILED');
      }
    },
  );

  app.get(
    '/v1/merchant/shops/:tenantId/orders',
    {
      preValidation: requireBuyerPreValidation,
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['tenantId'],
          properties: { tenantId: TENANT_ID_SCHEMA },
        },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            q: { type: 'string', maxLength: 160 },
            status: { type: 'string', maxLength: 40 },
            from: DATE_SCHEMA,
            to: DATE_SCHEMA,
            limit: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$' },
            cursor: { type: 'string', minLength: 16, maxLength: 1024 },
          },
        },
      },
    },
    async (request, reply) => {
      const { tenantId } = request.params as { tenantId: string };
      const access = await requireMerchantCapability(
        request,
        reply,
        repository,
        tenantId,
        ORDER_READERS,
      );
      if (!access) return;
      const query = request.query as {
        q?: string;
        status?: string;
        from?: string;
        to?: string;
        limit?: string;
        cursor?: string;
      };
      if (query.from || query.to) {
        try {
          const range = resolveMerchantDateRange(query.from, query.to, {
            from: query.from ?? query.to ?? defaultDateRange().from,
            to: query.to ?? query.from ?? defaultDateRange().to,
          });
          query.from = range.from;
          query.to = range.to;
        } catch (error) {
          return sendError(request, reply, error);
        }
      }
      const scope = `merchant:${tenantId}:orders:${requestHash({
        q: query.q ?? '',
        status: query.status ?? '',
        from: query.from ?? null,
        to: query.to ?? null,
      })}`;
      try {
        const page = await repository.listMerchantOrders({
          userId: access.principal.userId,
          tenantId,
          query: query.q?.trim() ?? '',
          status: query.status ?? '',
          from: query.from ?? null,
          to: query.to ?? null,
          limit: listLimit(query.limit),
          after: decodeCursor(query.cursor, scope, config.CHARTER_CURSOR_SECRET),
        });
        return {
          items: page.items,
          nextCursor: encodeCursor(scope, page.cursor, config.CHARTER_CURSOR_SECRET),
          requestId: request.id,
        };
      } catch (error) {
        return sendError(request, reply, error);
      }
    },
  );

  app.get(
    '/v1/merchant/shops/:tenantId/orders/:orderId',
    {
      preValidation: requireBuyerPreValidation,
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['tenantId', 'orderId'],
          properties: { tenantId: TENANT_ID_SCHEMA, orderId: UUID_SCHEMA },
        },
      },
    },
    async (request, reply) => {
      const { tenantId, orderId } = request.params as { tenantId: string; orderId: string };
      const access = await requireMerchantCapability(
        request,
        reply,
        repository,
        tenantId,
        ORDER_READERS,
      );
      if (!access) return;
      const order = await repository.getMerchantOrder({
        userId: access.principal.userId,
        tenantId,
        orderId,
      });
      return order
        ? { ...order, requestId: request.id }
        : reply.status(404).send({ error: 'ORDER_NOT_FOUND', requestId: request.id });
    },
  );

  app.post(
    '/v1/merchant/shops/:tenantId/orders/:orderId/fulfillment',
    {
      preValidation: requireBuyerPreValidation,
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['tenantId', 'orderId'],
          properties: { tenantId: TENANT_ID_SCHEMA, orderId: UUID_SCHEMA },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['status'],
          properties: {
            status: {
              type: 'string',
              enum: ['confirmed', 'packed', 'dispatched', 'delivered'],
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { tenantId, orderId } = request.params as { tenantId: string; orderId: string };
      const { status } = request.body as { status: string };
      const access = await requireMerchantCapability(
        request,
        reply,
        repository,
        tenantId,
        FULFILLMENT_WRITERS,
      );
      if (!access) return;
      if (!isFulfillmentStatus(status) || status === 'confirmed') {
        return reply
          .status(400)
          .send({ error: 'FULFILLMENT_STATUS_INVALID', requestId: request.id });
      }
      try {
        const order = await repository.advanceMerchantFulfillment({
          userId: access.principal.userId,
          tenantId,
          orderId,
          status,
        });
        return { ...order, requestId: request.id };
      } catch (error) {
        return sendError(request, reply, error);
      }
    },
  );

  app.get(
    '/v1/merchant/shops/:tenantId/recovery',
    {
      preValidation: requireBuyerPreValidation,
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['tenantId'],
          properties: { tenantId: TENANT_ID_SCHEMA },
        },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', maxLength: 40 },
            limit: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$' },
            cursor: { type: 'string', minLength: 16, maxLength: 1024 },
          },
        },
      },
    },
    async (request, reply) => {
      const { tenantId } = request.params as { tenantId: string };
      const access = await requireMerchantCapability(
        request,
        reply,
        repository,
        tenantId,
        RECOVERY_READERS,
      );
      if (!access) return;
      const query = request.query as { status?: string; limit?: string; cursor?: string };
      const scope = `merchant:${tenantId}:recovery:${query.status ?? ''}`;
      try {
        const page = await repository.listMerchantRecovery({
          userId: access.principal.userId,
          tenantId,
          status: query.status ?? '',
          limit: listLimit(query.limit),
          after: decodeCursor(query.cursor, scope, config.CHARTER_CURSOR_SECRET),
        });
        return {
          items: page.items,
          nextCursor: encodeCursor(scope, page.cursor, config.CHARTER_CURSOR_SECRET),
          requestId: request.id,
        };
      } catch (error) {
        return sendError(request, reply, error);
      }
    },
  );

  app.post(
    '/v1/merchant/shops/:tenantId/recovery/:checkoutId/send',
    {
      preValidation: requireBuyerPreValidation,
      schema: {
        headers: IDEMPOTENCY_HEADERS_SCHEMA,
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['tenantId', 'checkoutId'],
          properties: { tenantId: TENANT_ID_SCHEMA, checkoutId: UUID_SCHEMA },
        },
      },
    },
    async (request, reply) => {
      const { tenantId, checkoutId } = request.params as {
        tenantId: string;
        checkoutId: string;
      };
      const access = await requireMerchantCapability(
        request,
        reply,
        repository,
        tenantId,
        RECOVERY_SENDERS,
      );
      if (!access) return;
      const record = await repository.getMerchantRecovery({
        userId: access.principal.userId,
        tenantId,
        checkoutId,
      });
      if (!record) {
        return reply.status(404).send({ error: 'RECOVERY_NOT_FOUND', requestId: request.id });
      }
      if (!record.canSend && record.blockedReason !== 'RECONCILIATION_REQUIRED') {
        return reply.status(409).send({
          action: 'blocked',
          reason: record.blockedReason ?? 'RECOVERY_BLOCKED',
          requestId: request.id,
        });
      }
      const session = persist ? await persist.loadCheckout(tenantId, checkoutId) : undefined;
      if (!session) {
        return reply.status(409).send({
          action: 'blocked',
          reason: 'CHECKOUT_NOT_FOUND',
          requestId: request.id,
        });
      }
      const result = await recovery.afterFailedPay(session);
      if (result.action === 'sent') {
        return { ...result, requestId: request.id };
      }
      if (result.action === 'skipped') {
        return reply.status(409).send({
          action: 'blocked',
          reason: result.reason,
          requestId: request.id,
        });
      }
      return reply
        .status(502)
        .send({ action: 'failed', reason: 'RECOVERY_SEND_FAILED', requestId: request.id });
    },
  );

  app.get(
    '/v1/merchant/shops/:tenantId/rules',
    {
      preValidation: requireBuyerPreValidation,
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
      const access = await requireMerchantCapability(
        request,
        reply,
        repository,
        tenantId,
        ALL_MEMBER_ROLES,
      );
      if (!access) return;
      const rules = await repository.getMerchantRules({
        userId: access.principal.userId,
        tenantId,
      });
      return rules
        ? { ...rules, requestId: request.id }
        : reply.status(404).send({ error: 'SHOP_POLICY_NOT_FOUND', requestId: request.id });
    },
  );

  app.get(
    '/v1/merchant/shops/:tenantId/rules/preview',
    {
      preValidation: requireBuyerPreValidation,
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
      const access = await requireMerchantCapability(
        request,
        reply,
        repository,
        tenantId,
        ALL_MEMBER_ROLES,
      );
      if (!access) return;
      return {
        ...(await repository.previewMerchantRules({
          userId: access.principal.userId,
          tenantId,
        })),
        requestId: request.id,
      };
    },
  );

  app.put(
    '/v1/merchant/shops/:tenantId/rules',
    {
      preValidation: requireBuyerPreValidation,
      schema: {
        headers: IDEMPOTENCY_HEADERS_SCHEMA,
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['tenantId'],
          properties: { tenantId: TENANT_ID_SCHEMA },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: [
            'expectedVersion',
            'hardCap',
            'autonomousCap',
            'forbiddenMaterials',
            'offers',
            'reason',
          ],
          properties: {
            expectedVersion: { type: 'integer', minimum: 1 },
            hardCap: MONEY_SCHEMA,
            autonomousCap: MONEY_SCHEMA,
            forbiddenMaterials: {
              type: 'array',
              maxItems: 20,
              uniqueItems: true,
              items: { type: 'string', minLength: 1, maxLength: 80 },
            },
            offers: {
              type: 'array',
              maxItems: 50,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'discount', 'requiredSkuGroups'],
                properties: {
                  id: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 80,
                    pattern: '^[a-z0-9][a-z0-9._-]*$',
                  },
                  discount: MONEY_SCHEMA,
                  requiredSkuGroups: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 20,
                    items: {
                      type: 'array',
                      minItems: 1,
                      maxItems: 20,
                      items: { type: 'string', minLength: 1, maxLength: 160 },
                    },
                  },
                  stackable: { type: 'boolean' },
                  marginFloorMinor: { type: ['string', 'null'], maxLength: 20 },
                  budgetRemainingMinor: { type: ['string', 'null'], maxLength: 20 },
                  maxRedemptions: { type: ['integer', 'null'], minimum: 0, maximum: 1_000_000 },
                  redemptions: { type: ['integer', 'null'], minimum: 0, maximum: 1_000_000 },
                  expiresAt: { type: ['string', 'null'], maxLength: 40 },
                },
              },
            },
            reason: { type: 'string', minLength: 3, maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const { tenantId } = request.params as { tenantId: string };
      const access = await requireMerchantCapability(
        request,
        reply,
        repository,
        tenantId,
        MANAGERS,
      );
      if (!access) return;
      const body = request.body as {
        expectedVersion: number;
        hardCap: string;
        autonomousCap: string;
        forbiddenMaterials: string[];
        offers: Array<{
          id: string;
          discount: string;
          requiredSkuGroups: string[][];
          stackable?: boolean;
          marginFloorMinor?: string | null;
          budgetRemainingMinor?: string | null;
          maxRedemptions?: number | null;
          redemptions?: number | null;
          expiresAt?: string | null;
        }>;
        reason: string;
      };
      try {
        return {
          rules: await repository.updateMerchantRules({
            userId: access.principal.userId,
            tenantId,
            expectedVersion: body.expectedVersion,
            hardCapMinor: parseInrDecimalToPaise(body.hardCap).toString(),
            autonomousCapMinor: parseInrDecimalToPaise(body.autonomousCap).toString(),
            forbiddenMaterials: body.forbiddenMaterials,
            offers: offersWithMinor(body.offers),
            reason: body.reason,
            idempotencyKey: idempotencyKey(request),
            requestHash: requestHash(body),
          }),
          requestId: request.id,
        };
      } catch (error) {
        return sendError(request, reply, error, 'RULES_UPDATE_FAILED');
      }
    },
  );

  app.get(
    '/v1/merchant/shops/:tenantId/settings',
    {
      preValidation: requireBuyerPreValidation,
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
      const access = await requireMerchantCapability(
        request,
        reply,
        repository,
        tenantId,
        ALL_MEMBER_ROLES,
      );
      if (!access) return;
      const settings = await repository.getMerchantSettings({
        userId: access.principal.userId,
        tenantId,
        testMode: config.RAZORPAY_MODE === 'test',
      });
      return settings
        ? { ...settings, requestId: request.id }
        : reply.status(404).send({ error: 'TENANT_UNKNOWN', requestId: request.id });
    },
  );

  app.patch(
    '/v1/merchant/shops/:tenantId/settings',
    {
      preValidation: requireBuyerPreValidation,
      schema: {
        headers: IDEMPOTENCY_HEADERS_SCHEMA,
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['tenantId'],
          properties: { tenantId: TENANT_ID_SCHEMA },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['expectedVersion', 'name', 'blurb', 'reason'],
          properties: {
            expectedVersion: { type: 'integer', minimum: 1 },
            name: { type: 'string', minLength: 2, maxLength: 120 },
            blurb: { type: 'string', maxLength: 500 },
            gstin: { type: 'string', maxLength: 15, pattern: '^$|^[0-9A-Za-z]{15}$' },
            addressLine: { type: 'string', maxLength: 300 },
            refundPolicy: { type: 'string', maxLength: 2000 },
            reason: { type: 'string', minLength: 3, maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const { tenantId } = request.params as { tenantId: string };
      const access = await requireMerchantCapability(
        request,
        reply,
        repository,
        tenantId,
        MANAGERS,
      );
      if (!access) return;
      const body = request.body as {
        expectedVersion: number;
        name: string;
        blurb: string;
        gstin?: string;
        addressLine?: string;
        refundPolicy?: string;
        reason: string;
      };
      try {
        return {
          settings: await repository.updateMerchantSettings({
            userId: access.principal.userId,
            tenantId,
            expectedVersion: body.expectedVersion,
            name: body.name,
            blurb: body.blurb,
            ...(body.gstin === undefined ? {} : { gstin: body.gstin }),
            ...(body.addressLine === undefined ? {} : { addressLine: body.addressLine }),
            ...(body.refundPolicy === undefined ? {} : { refundPolicy: body.refundPolicy }),
            reason: body.reason,
            testMode: config.RAZORPAY_MODE === 'test',
            idempotencyKey: idempotencyKey(request),
            requestHash: requestHash(body),
          }),
          requestId: request.id,
        };
      } catch (error) {
        return sendError(request, reply, error, 'SETTINGS_UPDATE_FAILED');
      }
    },
  );
}
