import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '@charter/config';
import { requireBuyer, requireBuyerPreValidation } from './auth/context.js';
import { safeErrorCode } from './http-errors.js';
import type { MerchantCursorPosition } from './tenant/merchant-repository.js';
import type { TenantRepository } from './tenant/repository.js';

const UUID_SCHEMA = { type: 'string', format: 'uuid' } as const;

type CursorPayload = MerchantCursorPosition & { scope: string };

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

export async function registerAccountRoutes(
  app: FastifyInstance,
  repository: TenantRepository,
  config: AppConfig,
): Promise<void> {
  app.get('/v1/me', { preValidation: requireBuyerPreValidation }, async (request, reply) => {
    const principal = requireBuyer(request, reply);
    if (!principal) {
      return;
    }

    return {
      profile: {
        userId: principal.userId,
        ...(principal.email === undefined ? {} : { email: principal.email }),
      },
      shops: await repository.listMemberShops(principal.userId),
      platformRoles: await repository.platformRoles(principal.userId),
    };
  });

  app.get(
    '/v1/orders',
    {
      preValidation: requireBuyerPreValidation,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            limit: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$' },
            cursor: { type: 'string', minLength: 16, maxLength: 1024 },
          },
        },
      },
    },
    async (request, reply) => {
      const principal = requireBuyer(request, reply);
      if (!principal) {
        return;
      }
      const query = request.query as { limit?: string; cursor?: string };
      const scope = `buyer:${principal.userId}:orders`;
      try {
        const page = await repository.listBuyerOrders({
          userId: principal.userId,
          limit: query.limit ? Number(query.limit) : 25,
          after: decodeCursor(query.cursor, scope, config.CHARTER_CURSOR_SECRET),
        });
        return {
          items: page.items,
          nextCursor: encodeCursor(scope, page.cursor, config.CHARTER_CURSOR_SECRET),
          requestId: request.id,
        };
      } catch (error) {
        const code = safeErrorCode(error, ['CURSOR_INVALID'], 'ORDERS_UNAVAILABLE');
        return reply.status(code === 'CURSOR_INVALID' ? 400 : 500).send({ error: code });
      }
    },
  );

  app.get(
    '/v1/orders/:id',
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
      const principal = requireBuyer(request, reply);
      if (!principal) {
        return;
      }
      const { id } = request.params as { id: string };
      const order = await repository.getBuyerOrder({
        userId: principal.userId,
        orderId: id,
      });
      if (!order) {
        return reply.status(404).send({ error: 'ORDER_NOT_FOUND' });
      }
      return order;
    },
  );
}
