import {
  APPROVAL_KINDS,
  decideApproval,
  decideTypedApproval,
  getApproval,
  hydrateApproval,
  isApprovalKind,
  listApprovals,
  listQuotes,
  serializeApproval,
  type ApprovalKind,
} from '@charter/commerce';
import { formatInr, money } from '@charter/domain-shared';
import { listCheckouts } from '@charter/payments';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '@charter/config';
import type { MoneyPersist } from './persist.js';
import type { TenantRepository } from './tenant/repository.js';
import {
  CAPABILITIES,
  requirePlatformRole,
  requireShopMember,
  shopRolesForApprovalKind,
} from './auth/guards.js';
import { hydrateCatalogCache } from './tenant/catalog-cache.js';
import { requireBuyerPreValidation, type BuyerPrincipal } from './auth/context.js';
import { safeErrorCode } from './http-errors.js';

const TENANT_ID_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 63,
  pattern: '^[a-z0-9][a-z0-9-]{0,62}$',
} as const;

const UUID_SCHEMA = { type: 'string', format: 'uuid' } as const;

const REFUNDS_UNAVAILABLE = {
  available: false,
  note: 'Refunds are Register-only. Not enabled in v1.',
} as const;

const TYPED_APPROVAL_ERRORS = [
  'APPROVAL_NOT_FOUND',
  'APPROVAL_ALREADY_DECIDED',
  'APPROVAL_CHECKOUT_LOCKED',
  'APPROVAL_STALE',
  'APPROVAL_SELF_DECISION',
  'APPROVAL_EXPIRED',
  'APPROVAL_ROLE_DENIED',
  'APPROVAL_AMOUNT_CHANGED',
  'APPROVAL_KIND_MISMATCH',
  'SHOP_MEMBERSHIP_REQUIRED',
  'SKU_UNKNOWN',
  'PRODUCT_MATERIAL_FORBIDDEN',
  'OUT_OF_STOCK',
  'HARD_CAP_EXCEEDED',
] as const;

function formatPaise(amountMinor: string): string {
  return formatInr(money(BigInt(amountMinor)));
}

function typedApprovalStatus(code: string): number {
  if (code === 'APPROVAL_NOT_FOUND') {
    return 404;
  }
  if (
    code === 'SHOP_MEMBERSHIP_REQUIRED' ||
    code === 'APPROVAL_ROLE_DENIED' ||
    code === 'APPROVAL_SELF_DECISION'
  ) {
    return 403;
  }
  return 409;
}

async function decideTypedApprovalHttp(
  request: FastifyRequest,
  reply: FastifyReply,
  input: {
    persist?: MoneyPersist | undefined;
    repository: TenantRepository;
    tenantId: string;
    id: string;
    decision: 'approved' | 'denied';
    kind: ApprovalKind;
    principal: BuyerPrincipal;
  },
) {
  try {
    const loadedApproval = input.persist
      ? await input.persist.loadApproval(input.tenantId, input.id)
      : getApproval(input.id);
    if (!loadedApproval || loadedApproval.tenantId !== input.tenantId) {
      return reply.status(404).send({ error: 'APPROVAL_NOT_FOUND' });
    }
    if (loadedApproval.kind !== input.kind) {
      return reply.status(409).send({ error: 'APPROVAL_KIND_MISMATCH' });
    }
    hydrateApproval(loadedApproval);
    const shopRole = await input.repository.membershipRole(input.principal.userId, input.tenantId);
    const platformRoles = await input.repository.platformRoles(input.principal.userId);
    const approval = input.persist?.decideTypedApproval
      ? (
          await input.persist.decideTypedApproval(
            input.tenantId,
            input.id,
            input.decision,
            input.principal.userId,
            input.kind,
          )
        ).approval
      : decideTypedApproval(input.id, input.decision, {
          decidedBy: input.principal.userId,
          shopRole,
          platformRoles,
          expectedKind: input.kind,
        });
    return {
      approval: serializeApproval(approval),
      refunds: REFUNDS_UNAVAILABLE,
    };
  } catch (error) {
    const code = safeErrorCode(error, TYPED_APPROVAL_ERRORS, 'APPROVAL_ERROR');
    return reply.status(typedApprovalStatus(code)).send({ error: code });
  }
}

export async function registerOperatorRoutes(
  app: FastifyInstance,
  config: AppConfig,
  repository: TenantRepository,
  persist?: MoneyPersist,
): Promise<void> {
  app.get(
    '/v1/register/:tenantId',
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
      const principal = await requireShopMember(
        request,
        reply,
        repository,
        tenantId,
        CAPABILITIES.registerRead,
      );
      if (!principal) {
        return;
      }
      const shop = await repository.findShopByTenantIdForMember(principal.userId, tenantId);
      if (!shop) {
        return reply.status(404).send({ error: 'TENANT_UNKNOWN' });
      }
      await hydrateCatalogCache(repository, shop, principal.userId);
      const durableSnapshot = persist ? await persist.loadRegisterSnapshot(tenantId) : undefined;
      const quoteRows =
        durableSnapshot?.quotes ?? listQuotes().filter((quote) => quote.tenantId === tenantId);
      const checkoutRows =
        durableSnapshot?.checkouts ??
        listCheckouts().filter((session) => session.tenantId === tenantId);
      const approvalRows =
        durableSnapshot?.approvals ??
        listApprovals().filter((approval) => approval.tenantId === tenantId);
      const policy = await repository.getPolicy(tenantId);
      if (!policy) {
        return reply.status(404).send({ error: 'SHOP_POLICY_NOT_FOUND' });
      }
      const quotes = quoteRows.map((quote) => ({
        id: quote.id,
        status: quote.status,
        totalDisplay: quote.totalDisplay,
        deliveryBy: quote.deliveryBy,
        boundCheckoutId: quote.boundCheckoutId,
        lines: quote.lines.map((line) => ({
          sku: line.sku,
          title: line.title,
          quantity: line.quantity,
        })),
      }));
      const checkouts = checkoutRows.map((session) => ({
        id: session.id,
        quoteId: session.quoteId,
        status: session.status,
        razorpayOrderId: session.razorpayOrderId,
        receipt: session.receipt,
        paymentId: session.paymentId,
        providerStatus: session.providerStatus,
        copy: session.copy,
      }));
      const captures = persist
        ? (await persist.listCaptures(tenantId)).map((row) => ({
            ...row,
            amountDisplay: formatPaise(row.amountMinor),
          }))
        : [];
      const catalog = await repository.listCatalogForMember(principal.userId, tenantId);
      return {
        merchant: {
          tenantId: shop.tenantId,
          slug: shop.slug,
          name: shop.name,
          label: shop.label,
          blurb: shop.blurb,
          href: `/shops/${shop.slug}`,
          synthetic: shop.synthetic,
        },
        authority: {
          hardCapDisplay: formatPaise(policy.hardCapMinor.toString()),
          autonomousCapDisplay: formatPaise(policy.autonomousCapMinor.toString()),
          forbiddenMaterials: [...policy.forbiddenMaterials],
        },
        catalog,
        quotes,
        checkouts,
        captures,
        failedPays: checkouts.filter((session) => session.status === 'FAILED_PROVISIONAL').length,
        uniqueOrders: checkouts.length,
        unitsInStock: catalog.reduce((sum, row) => sum + row.stock, 0),
        approvals: approvalRows.map(serializeApproval),
        refunds: REFUNDS_UNAVAILABLE,
      };
    },
  );

  app.post(
    '/v1/register/approvals/:id',
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
          required: ['decision', 'tenantId'],
          properties: {
            decision: { type: 'string', enum: ['approved', 'denied'] },
            tenantId: TENANT_ID_SCHEMA,
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { decision, tenantId } = request.body as {
        decision: 'approved' | 'denied';
        tenantId: string;
      };
      const principal = await requireShopMember(
        request,
        reply,
        repository,
        tenantId,
        CAPABILITIES.approvalWrite,
      );
      if (!principal) {
        return;
      }
      try {
        const shop = await repository.findShopByTenantIdForMember(principal.userId, tenantId);
        if (!shop) {
          return reply.status(404).send({ error: 'TENANT_UNKNOWN' });
        }
        await hydrateCatalogCache(repository, shop, principal.userId);
        const loadedApproval = persist ? await persist.loadApproval(tenantId, id) : getApproval(id);
        if (!loadedApproval || loadedApproval.tenantId !== tenantId) {
          return reply.status(404).send({ error: 'APPROVAL_NOT_FOUND' });
        }
        if (loadedApproval.kind !== 'cart_spend') {
          return reply.status(409).send({ error: 'APPROVAL_KIND_MISMATCH' });
        }
        hydrateApproval(loadedApproval);
        const shopRole = await repository.membershipRole(principal.userId, tenantId);
        const platformRoles = await repository.platformRoles(principal.userId);
        const result = persist
          ? await persist.decideApproval(tenantId, id, decision, principal.userId)
          : decideApproval(id, decision, {
              decidedBy: principal.userId,
              shopRole,
              platformRoles,
            });
        return {
          approval: serializeApproval(result.approval),
          cart: {
            id: result.cart.id,
            version: result.cart.version,
            lines: result.cart.lines,
          },
        };
      } catch (error) {
        const code = safeErrorCode(error, TYPED_APPROVAL_ERRORS, 'APPROVAL_ERROR');
        const status =
          code === 'APPROVAL_NOT_FOUND'
            ? 404
            : code === 'SHOP_MEMBERSHIP_REQUIRED' ||
                code === 'APPROVAL_ROLE_DENIED' ||
                code === 'APPROVAL_SELF_DECISION'
              ? 403
              : 409;
        return reply.status(status).send({ error: code });
      }
    },
  );

  app.get(
    '/v1/register/:tenantId/approvals',
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
            kind: { type: 'string', enum: [...APPROVAL_KINDS] },
          },
        },
      },
    },
    async (request, reply) => {
      const { tenantId } = request.params as { tenantId: string };
      const { kind } = request.query as { kind?: string };
      if (kind !== undefined && !isApprovalKind(kind)) {
        return reply.status(400).send({ error: 'APPROVAL_KIND_INVALID' });
      }
      const principal = await requireShopMember(
        request,
        reply,
        repository,
        tenantId,
        CAPABILITIES.registerRead,
      );
      if (!principal) {
        return;
      }
      const rows = persist
        ? await persist.hydrateApprovals(tenantId)
        : listApprovals().filter((approval) => approval.tenantId === tenantId);
      return {
        kind: kind ?? null,
        approvals: rows
          .filter((approval) => !kind || approval.kind === kind)
          .map(serializeApproval),
        refunds: REFUNDS_UNAVAILABLE,
      };
    },
  );

  app.post(
    '/v1/register/:tenantId/approvals/:id',
    {
      preValidation: requireBuyerPreValidation,
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['tenantId', 'id'],
          properties: {
            tenantId: TENANT_ID_SCHEMA,
            id: UUID_SCHEMA,
          },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['decision', 'kind'],
          properties: {
            decision: { type: 'string', enum: ['approved', 'denied'] },
            kind: { type: 'string', enum: [...APPROVAL_KINDS] },
          },
        },
      },
    },
    async (request, reply) => {
      const { tenantId, id } = request.params as { tenantId: string; id: string };
      const { decision, kind } = request.body as {
        decision: 'approved' | 'denied';
        kind: string;
      };
      if (!isApprovalKind(kind)) {
        return reply.status(400).send({ error: 'APPROVAL_KIND_INVALID' });
      }
      if (kind === 'platform') {
        const principal = await requirePlatformRole(request, reply, repository);
        if (!principal) {
          return;
        }
        return decideTypedApprovalHttp(request, reply, {
          persist,
          repository,
          tenantId,
          id,
          decision,
          kind,
          principal,
        });
      }
      const allowedRoles = shopRolesForApprovalKind(kind);
      if (!allowedRoles) {
        return reply.status(400).send({ error: 'APPROVAL_KIND_INVALID' });
      }
      const principal = await requireShopMember(request, reply, repository, tenantId, allowedRoles);
      if (!principal) {
        return;
      }
      return decideTypedApprovalHttp(request, reply, {
        persist,
        repository,
        tenantId,
        id,
        decision,
        kind,
        principal,
      });
    },
  );

  app.get('/v1/control', { preValidation: requireBuyerPreValidation }, async (request, reply) => {
    const principal = await requirePlatformRole(request, reply, repository);
    if (!principal) {
      return;
    }
    return {
      kill: await repository.killSnapshot(principal.userId),
      flags: {
        paymentsConfigured: Boolean(config.RAZORPAY_KEY_ID && config.RAZORPAY_KEY_SECRET),
        webhookConfigured: Boolean(config.RAZORPAY_WEBHOOK_SECRET),
        fireworksConfigured: Boolean(config.FIREWORKS_API_KEY),
        langfuseConfigured: Boolean(config.LANGFUSE_PUBLIC_KEY && config.LANGFUSE_SECRET_KEY),
        vapiConfigured: Boolean(config.VAPI_PUBLIC_KEY),
        voicePublicUrl: Boolean(config.CHARTER_PUBLIC_URL),
        agentmailConfigured: Boolean(config.AGENTMAIL_API_KEY && config.AGENTMAIL_INBOX),
        persistence: Boolean(persist),
      },
      inbox: persist ? await persist.listInbox(principal.userId) : [],
    };
  });

  app.post(
    '/v1/control/kill',
    {
      preValidation: requireBuyerPreValidation,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['scope', 'on'],
          properties: {
            scope: { type: 'string', enum: ['global', 'tenant'] },
            tenantId: TENANT_ID_SCHEMA,
            on: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const principal = await requirePlatformRole(request, reply, repository, ['admin']);
      if (!principal) {
        return;
      }
      const body = request.body as {
        scope: 'global' | 'tenant';
        tenantId?: string;
        on: boolean;
      };
      if (body.scope === 'global') {
        return {
          kill: await repository.setKillSwitch({
            scope: 'global',
            on: body.on,
            changedBy: principal.userId,
          }),
        };
      }
      if (body.scope === 'tenant') {
        try {
          if (!body.tenantId) {
            return reply.status(400).send({ error: 'TENANT_ID_REQUIRED' });
          }
          return {
            kill: await repository.setKillSwitch({
              scope: 'tenant',
              tenantId: body.tenantId,
              on: body.on,
              changedBy: principal.userId,
            }),
          };
        } catch (error) {
          const code = safeErrorCode(error, ['TENANT_ID_REQUIRED'], 'KILL_ERROR');
          return reply.status(400).send({ error: code });
        }
      }
      return reply.status(400).send({ error: 'KILL_SCOPE_REQUIRED' });
    },
  );
}
