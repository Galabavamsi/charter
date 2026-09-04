import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApprovalKind } from '@charter/commerce';
import type { PlatformRole, ShopRole, TenantRepository } from '../tenant/repository.js';
import { requireBuyer, type BuyerPrincipal } from './context.js';

export const CAPABILITIES = {
  catalogWrite: ['owner', 'admin', 'catalog'],
  registerRead: ['owner', 'admin', 'catalog', 'support', 'finance', 'viewer'],
  cartSpendApprove: ['owner', 'admin'],
  catalogPublishApprove: ['owner', 'admin', 'catalog'],
  refundApprove: ['owner', 'admin', 'finance'],
  campaignApprove: ['owner', 'admin'],
  approvalWrite: ['owner', 'admin'],
  recoveryOperate: ['owner', 'admin', 'support'],
} as const satisfies Record<string, readonly ShopRole[]>;

export function shopRolesForApprovalKind(kind: ApprovalKind): readonly ShopRole[] | undefined {
  switch (kind) {
    case 'cart_spend':
      return CAPABILITIES.cartSpendApprove;
    case 'catalog_publish':
      return CAPABILITIES.catalogPublishApprove;
    case 'refund':
      return CAPABILITIES.refundApprove;
    case 'campaign':
      return CAPABILITIES.campaignApprove;
    case 'platform':
      return undefined;
  }
}

function forbidden(request: FastifyRequest, reply: FastifyReply, error: string): FastifyReply {
  return reply.status(403).send({ error, requestId: request.id });
}

export async function requireShopMember(
  request: FastifyRequest,
  reply: FastifyReply,
  repository: TenantRepository,
  tenantId: string,
  allowedRoles: readonly ShopRole[],
): Promise<BuyerPrincipal | undefined> {
  const principal = requireBuyer(request, reply);
  if (!principal) {
    return undefined;
  }
  const role = await repository.membershipRole(principal.userId, tenantId);
  if (!role || !allowedRoles.includes(role)) {
    forbidden(request, reply, 'SHOP_MEMBERSHIP_REQUIRED');
    return undefined;
  }
  return principal;
}

export async function requirePlatformRole(
  request: FastifyRequest,
  reply: FastifyReply,
  repository: TenantRepository,
  allowedRoles: readonly PlatformRole[] = ['operator', 'admin'],
): Promise<BuyerPrincipal | undefined> {
  const principal = requireBuyer(request, reply);
  if (!principal) {
    return undefined;
  }
  const roles = await repository.platformRoles(principal.userId);
  if (!roles.some((role) => allowedRoles.includes(role))) {
    forbidden(request, reply, 'PLATFORM_ROLE_REQUIRED');
    return undefined;
  }
  return principal;
}

export async function requireOwnedResource(
  request: FastifyRequest,
  reply: FastifyReply,
  repository: TenantRepository,
  input: {
    kind: 'cart' | 'quote' | 'checkout' | 'conversation' | 'order';
    tenantId: string;
    resourceId: string;
  },
): Promise<BuyerPrincipal | undefined> {
  const principal = requireBuyer(request, reply);
  if (!principal) {
    return undefined;
  }
  if (
    !(await repository.canAccessResource(
      input.kind,
      input.tenantId,
      input.resourceId,
      principal.userId,
    ))
  ) {
    forbidden(request, reply, 'RESOURCE_FORBIDDEN');
    return undefined;
  }
  return principal;
}
