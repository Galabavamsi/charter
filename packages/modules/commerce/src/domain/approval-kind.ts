export const APPROVAL_KINDS = [
  'cart_spend',
  'catalog_publish',
  'refund',
  'campaign',
  'platform',
] as const;

export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export const APPROVAL_KIND_ROLES: Record<ApprovalKind, readonly string[]> = {
  cart_spend: ['owner', 'admin'],
  catalog_publish: ['owner', 'admin', 'catalog'],
  refund: ['owner', 'admin', 'finance'],
  campaign: ['owner', 'admin'],
  platform: [],
};

export const APPROVAL_KIND_PLATFORM_ROLES: Record<ApprovalKind, readonly string[]> = {
  cart_spend: [],
  catalog_publish: [],
  refund: [],
  campaign: [],
  platform: ['admin', 'operator'],
};

export function isApprovalKind(value: unknown): value is ApprovalKind {
  return typeof value === 'string' && (APPROVAL_KINDS as readonly string[]).includes(value);
}

export function cartSpendActionHash(input: {
  tenantId: string;
  cartId: string;
  fromSku: string;
  toSku: string;
  amountMinor: bigint;
  currency: string;
}): string {
  return [
    'cart_spend',
    input.tenantId,
    input.cartId,
    input.fromSku,
    input.toSku,
    input.amountMinor.toString(),
    input.currency,
  ].join(':');
}

export function typedActionHash(input: {
  kind: Exclude<ApprovalKind, 'cart_spend'>;
  tenantId: string;
  resourceId: string;
  resourceVersion?: number | null;
  amountMinor: bigint;
  currency: string;
}): string {
  return [
    input.kind,
    input.tenantId,
    input.resourceId,
    (input.resourceVersion ?? 0).toString(),
    input.amountMinor.toString(),
    input.currency,
  ].join(':');
}

export function canDecideApprovalKind(input: {
  kind: ApprovalKind;
  shopRole?: string | undefined;
  platformRoles?: readonly string[] | undefined;
}): boolean {
  if (APPROVAL_KIND_ROLES[input.kind].some((role) => role === input.shopRole)) {
    return true;
  }
  const platformRoles = input.platformRoles ?? [];
  return APPROVAL_KIND_PLATFORM_ROLES[input.kind].some((role) => platformRoles.includes(role));
}

const APPROVAL_DECISION_ASSERTED = Object.freeze({
  brand: 'approval-decision-asserted' as const,
});

export type ApprovalDecisionAsserted = typeof APPROVAL_DECISION_ASSERTED;

export function isApprovalDecisionAsserted(value: unknown): value is ApprovalDecisionAsserted {
  return value === APPROVAL_DECISION_ASSERTED;
}

export function assertApprovalDecision(input: {
  kind: ApprovalKind;
  shopRole?: string | undefined;
  platformRoles?: readonly string[] | undefined;
  requestedBy?: string | undefined;
  decidedBy: string;
  expiresAt?: string | null | undefined;
  actionHash: string;
  liveActionHash: string;
  amountMinor: bigint;
  liveAmountMinor: bigint;
  currency: string;
  liveCurrency: string;
  now?: Date | undefined;
}): ApprovalDecisionAsserted {
  if (!canDecideApprovalKind(input)) {
    throw new Error('APPROVAL_ROLE_DENIED');
  }
  if (input.requestedBy && input.requestedBy.toLowerCase() === input.decidedBy.toLowerCase()) {
    throw new Error('APPROVAL_SELF_DECISION');
  }
  const expiresAt = input.expiresAt ? Date.parse(input.expiresAt) : Number.NaN;
  if (Number.isFinite(expiresAt) && (input.now ?? new Date()).getTime() > expiresAt) {
    throw new Error('APPROVAL_EXPIRED');
  }
  if (input.actionHash !== input.liveActionHash) {
    throw new Error('APPROVAL_STALE');
  }
  if (input.amountMinor !== input.liveAmountMinor || input.currency !== input.liveCurrency) {
    throw new Error('APPROVAL_AMOUNT_CHANGED');
  }
  return APPROVAL_DECISION_ASSERTED;
}
