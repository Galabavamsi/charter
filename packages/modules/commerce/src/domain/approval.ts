import { randomUUID } from 'node:crypto';
import { getTenantVariant } from '@charter/catalog';
import { formatInr, money } from '@charter/domain-shared';
import type { PolicyDecision } from '@charter/policy';
import {
  assertApprovalDecision,
  cartSpendActionHash,
  typedActionHash,
  type ApprovalKind,
} from './approval-kind.js';

export type ApprovalStatus = 'pending' | 'approved' | 'denied';

export type ApprovalRequest = {
  id: string;
  tenantId: string;
  cartId: string;
  fromSku: string;
  toSku: string;
  fromTitle: string;
  toTitle: string;
  proposedTotalMinor: bigint;
  proposedDisplay: string;
  reason: string;
  status: ApprovalStatus;
  kind: ApprovalKind;
  actionHash: string;
  resourceId: string | null;
  resourceVersion: number | null;
  requestedBy: string | null;
  expiresAt: string | null;
  createdAt: string;
  decidedAt: string | null;
};

const approvals = new Map<string, ApprovalRequest>();

export function resetApprovals(): void {
  approvals.clear();
}

export function listApprovals(): ApprovalRequest[] {
  return [...approvals.values()].reverse();
}

export function getApproval(id: string): ApprovalRequest | undefined {
  return approvals.get(id);
}

export function hydrateApproval(request: ApprovalRequest): ApprovalRequest {
  const copy = { ...request };
  approvals.set(copy.id, copy);
  return copy;
}

export function openApproval(input: {
  tenantId: string;
  cartId: string;
  fromSku: string;
  toSku: string;
  proposedTotalMinor: bigint;
  proposedDisplay: string;
  decision: PolicyDecision;
  requestedBy?: string | null;
}): ApprovalRequest {
  if (input.decision.outcome !== 'require_approval') {
    throw new Error('APPROVAL_NOT_REQUIRED');
  }
  const existing = [...approvals.values()].find(
    (row) =>
      row.cartId === input.cartId &&
      row.fromSku === input.fromSku &&
      row.toSku === input.toSku &&
      row.status === 'pending',
  );
  if (existing) {
    return existing;
  }
  const request: ApprovalRequest = {
    id: randomUUID(),
    tenantId: input.tenantId,
    cartId: input.cartId,
    fromSku: input.fromSku,
    toSku: input.toSku,
    fromTitle: getTenantVariant(input.tenantId, input.fromSku)?.title ?? input.fromSku,
    toTitle: getTenantVariant(input.tenantId, input.toSku)?.title ?? input.toSku,
    proposedTotalMinor: input.proposedTotalMinor,
    proposedDisplay: input.proposedDisplay,
    reason: input.decision.reason,
    status: 'pending',
    kind: 'cart_spend',
    actionHash: cartSpendActionHash({
      tenantId: input.tenantId,
      cartId: input.cartId,
      fromSku: input.fromSku,
      toSku: input.toSku,
      amountMinor: input.proposedTotalMinor,
      currency: 'INR',
    }),
    resourceId: input.cartId,
    resourceVersion: null,
    requestedBy: input.requestedBy ?? null,
    expiresAt: null,
    createdAt: new Date().toISOString(),
    decidedAt: null,
  };
  approvals.set(request.id, request);
  return request;
}

export function serializeApproval(request: ApprovalRequest) {
  return {
    id: request.id,
    cartId: request.cartId,
    fromSku: request.fromSku,
    toSku: request.toSku,
    fromTitle: request.fromTitle,
    toTitle: request.toTitle,
    proposedDisplay: request.proposedDisplay,
    proposedTotalMinor: request.proposedTotalMinor.toString(),
    reason: request.reason,
    status: request.status,
    kind: request.kind,
    actionHash: request.actionHash,
    resourceId: request.resourceId,
    createdAt: request.createdAt,
    decidedAt: request.decidedAt,
  };
}

export function openTypedApproval(input: {
  kind: Exclude<ApprovalKind, 'cart_spend'>;
  tenantId: string;
  resourceId: string;
  resourceVersion?: number | null;
  amountMinor: bigint;
  reason: string;
  requestedBy: string;
  expiresAt?: string | null;
}): ApprovalRequest {
  const existing = [...approvals.values()].find(
    (row) =>
      row.kind === input.kind &&
      row.tenantId === input.tenantId &&
      row.resourceId === input.resourceId &&
      row.status === 'pending',
  );
  if (existing) {
    return existing;
  }
  const request: ApprovalRequest = {
    id: randomUUID(),
    tenantId: input.tenantId,
    cartId: '',
    fromSku: '',
    toSku: '',
    fromTitle: input.resourceId,
    toTitle: input.resourceId,
    proposedTotalMinor: input.amountMinor,
    proposedDisplay: formatInr(money(input.amountMinor)),
    reason: input.reason,
    status: 'pending',
    kind: input.kind,
    actionHash: typedActionHash({
      kind: input.kind,
      tenantId: input.tenantId,
      resourceId: input.resourceId,
      resourceVersion: input.resourceVersion ?? 0,
      amountMinor: input.amountMinor,
      currency: 'INR',
    }),
    resourceId: input.resourceId,
    resourceVersion: input.resourceVersion ?? 0,
    requestedBy: input.requestedBy,
    expiresAt: input.expiresAt ?? null,
    createdAt: new Date().toISOString(),
    decidedAt: null,
  };
  approvals.set(request.id, request);
  return request;
}

export function liveTypedActionHash(approval: ApprovalRequest): string {
  if (approval.kind === 'cart_spend') {
    return cartSpendActionHash({
      tenantId: approval.tenantId,
      cartId: approval.cartId,
      fromSku: approval.fromSku,
      toSku: approval.toSku,
      amountMinor: approval.proposedTotalMinor,
      currency: 'INR',
    });
  }
  return typedActionHash({
    kind: approval.kind,
    tenantId: approval.tenantId,
    resourceId: approval.resourceId ?? '',
    resourceVersion: approval.resourceVersion,
    amountMinor: boundAmountFromHash(approval),
    currency: 'INR',
  });
}

function boundAmountFromHash(approval: ApprovalRequest): bigint {
  const amount = approval.actionHash.split(':')[4];
  return amount !== undefined && amount !== '' ? BigInt(amount) : approval.proposedTotalMinor;
}

export function decideTypedApproval(
  approvalId: string,
  decision: 'approved' | 'denied',
  actor: {
    decidedBy: string;
    shopRole?: string | undefined;
    platformRoles?: readonly string[] | undefined;
    now?: Date | undefined;
    expectedKind?: ApprovalKind;
  },
): ApprovalRequest {
  const approval = getApproval(approvalId);
  if (!approval) {
    throw new Error('APPROVAL_NOT_FOUND');
  }
  if (approval.status !== 'pending') {
    throw new Error('APPROVAL_ALREADY_DECIDED');
  }
  if (actor.expectedKind && actor.expectedKind !== approval.kind) {
    throw new Error('APPROVAL_KIND_MISMATCH');
  }
  if (approval.kind === 'cart_spend') {
    throw new Error('APPROVAL_KIND_MISMATCH');
  }
  assertApprovalDecision({
    kind: approval.kind,
    shopRole: actor.shopRole,
    platformRoles: actor.platformRoles,
    requestedBy: approval.requestedBy ?? undefined,
    decidedBy: actor.decidedBy,
    expiresAt: approval.expiresAt,
    actionHash: approval.actionHash,
    liveActionHash: liveTypedActionHash(approval),
    amountMinor: boundAmountFromHash(approval),
    liveAmountMinor: approval.proposedTotalMinor,
    currency: 'INR',
    liveCurrency: 'INR',
    now: actor.now,
  });
  approval.status = decision === 'approved' ? 'approved' : 'denied';
  approval.decidedAt = new Date().toISOString();
  return approval;
}
