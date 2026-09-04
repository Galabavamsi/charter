import { POLICY_REASON, type PolicyOutcome } from '@charter/domain-shared';

export type ProductFact = {
  sku: string;
  title: string;
  priceMinor: bigint;
  stock: number;
  material: string;
  published: boolean;
};

export type BuyerAuthority = {
  hardCapMinor: bigint;
  autonomousCapMinor: bigint;
  forbiddenMaterials: readonly string[];
};

export const NORTHSTAR_AUTHORITY: BuyerAuthority = {
  hardCapMinor: 300000n,
  autonomousCapMinor: 250000n,
  forbiddenMaterials: ['glass'],
};

export type PolicyDecision = {
  outcome: PolicyOutcome;
  reason: string;
  message: string;
};

export const POLICY_ALLOW: PolicyDecision = {
  outcome: 'allow',
  reason: 'ALLOW',
  message: 'Within Charter.',
};

export function evaluateVariant(
  variant: ProductFact | undefined,
  authority: BuyerAuthority = NORTHSTAR_AUTHORITY,
): PolicyDecision {
  if (!variant || !variant.published) {
    return {
      outcome: 'deny',
      reason: 'SKU_UNKNOWN',
      message: 'That item is not in the published catalog.',
    };
  }
  if (authority.forbiddenMaterials.includes(variant.material)) {
    return {
      outcome: 'deny',
      reason: POLICY_REASON.PRODUCT_MATERIAL_FORBIDDEN,
      message: `${variant.title} is excluded: ${variant.material} is not allowed.`,
    };
  }
  if (variant.stock <= 0) {
    return {
      outcome: 'deny',
      reason: POLICY_REASON.OUT_OF_STOCK,
      message: `${variant.title} is out of stock.`,
    };
  }
  return POLICY_ALLOW;
}

export function evaluateProposedTotal(
  proposedMinor: bigint,
  authority: BuyerAuthority = NORTHSTAR_AUTHORITY,
  approvedThroughMinor: bigint = 0n,
): PolicyDecision {
  if (proposedMinor > authority.hardCapMinor) {
    const rupees = authority.hardCapMinor / 100n;
    return {
      outcome: 'deny',
      reason: POLICY_REASON.HARD_CAP_EXCEEDED,
      message: `That total exceeds the ₹${rupees.toLocaleString('en-IN')} inclusive cap.`,
    };
  }
  if (proposedMinor > authority.autonomousCapMinor && proposedMinor > approvedThroughMinor) {
    return {
      outcome: 'require_approval',
      reason: POLICY_REASON.AUTHORITY_APPROVAL_REQUIRED,
      message: 'Approval required',
    };
  }
  return POLICY_ALLOW;
}
