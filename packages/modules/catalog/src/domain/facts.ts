import { createHash } from 'node:crypto';

export type FactPin = {
  catalogVersion: number;
  policyVersion: number;
  factHash: string;
};

export type FactPinSource = {
  catalogVersion?: number;
  policyVersion?: number;
  variants: Array<{
    sku: string;
    priceMinor: bigint;
    stock: number;
    material: string;
    published?: boolean;
  }>;
  authority: {
    hardCapMinor: bigint;
    autonomousCapMinor: bigint;
    forbiddenMaterials: readonly string[];
  };
  offers: Array<{
    id: string;
    discountMinor: bigint;
    groups: string[][];
    stackable?: boolean;
    marginFloorMinor?: bigint;
    budgetRemainingMinor?: bigint;
    maxRedemptions?: number;
    redemptions?: number;
    expiresAt?: string;
  }>;
};

export type StoredOffer = FactPinSource['offers'][number];

function readSkuGroups(value: unknown): string[][] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value
    .filter(
      (group): group is string[] =>
        Array.isArray(group) && group.every((sku) => typeof sku === 'string'),
    )
    .map((group) => [...group]);
}

function readBigint(value: unknown): bigint | undefined {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }
  try {
    return BigInt(String(value));
  } catch {
    return undefined;
  }
}

function readInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function parseStoredOffer(value: unknown): StoredOffer | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const offer = value as Record<string, unknown>;
  if (typeof offer.id !== 'string') {
    return undefined;
  }
  const groups = readSkuGroups(
    offer.required_sku_groups ?? offer.requiredSkuGroups ?? offer.groups,
  );
  if (!groups) {
    return undefined;
  }
  try {
    const parsed: StoredOffer = {
      id: offer.id,
      discountMinor: BigInt(String(offer.discount_minor ?? offer.discountMinor ?? 0)),
      groups,
    };
    if (typeof offer.stackable === 'boolean') {
      parsed.stackable = offer.stackable;
    }
    const marginFloorMinor = readBigint(offer.margin_floor_minor ?? offer.marginFloorMinor);
    if (marginFloorMinor !== undefined) {
      parsed.marginFloorMinor = marginFloorMinor;
    }
    const budgetRemainingMinor = readBigint(
      offer.budget_remaining_minor ?? offer.budgetRemainingMinor,
    );
    if (budgetRemainingMinor !== undefined) {
      parsed.budgetRemainingMinor = budgetRemainingMinor;
    }
    const maxRedemptions = readInt(offer.max_redemptions ?? offer.maxRedemptions);
    if (maxRedemptions !== undefined) {
      parsed.maxRedemptions = maxRedemptions;
    }
    const redemptions = readInt(offer.redemptions);
    if (redemptions !== undefined) {
      parsed.redemptions = redemptions;
    }
    const expiresAt = offer.expires_at ?? offer.expiresAt;
    if (typeof expiresAt === 'string' && expiresAt.length > 0) {
      parsed.expiresAt = expiresAt;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function parseStoredOffers(value: unknown): StoredOffer[] {
  if (!value || typeof value !== 'object' || !('offers' in value)) {
    return [];
  }
  const offers = (value as { offers?: unknown }).offers;
  if (!Array.isArray(offers)) {
    return [];
  }
  return offers.flatMap((offer) => {
    const parsed = parseStoredOffer(offer);
    return parsed ? [parsed] : [];
  });
}

export function merchantFactPin(source: FactPinSource): FactPin {
  const variants = source.variants
    .filter((row) => row.published !== false)
    .map((row) => ({
      sku: row.sku,
      priceMinor: row.priceMinor.toString(),
      stock: row.stock,
      material: row.material,
    }))
    .sort((left, right) => left.sku.localeCompare(right.sku));
  const offers = source.offers
    .map((offer) => ({
      id: offer.id,
      discountMinor: offer.discountMinor.toString(),
      groups: offer.groups,
      stackable: offer.stackable !== false,
      marginFloorMinor: offer.marginFloorMinor?.toString() ?? null,
      budgetRemainingMinor: offer.budgetRemainingMinor?.toString() ?? null,
      maxRedemptions: offer.maxRedemptions ?? null,
      redemptions: offer.redemptions ?? 0,
      expiresAt: offer.expiresAt ?? null,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const payload = JSON.stringify({
    variants,
    authority: {
      hardCapMinor: source.authority.hardCapMinor.toString(),
      autonomousCapMinor: source.authority.autonomousCapMinor.toString(),
      forbiddenMaterials: [...source.authority.forbiddenMaterials].sort(),
    },
    offers,
  });
  return {
    catalogVersion: source.catalogVersion ?? 1,
    policyVersion: source.policyVersion ?? 1,
    factHash: createHash('sha256').update(payload).digest('hex'),
  };
}

export function rewindOfferRedemptions<
  T extends {
    id: string;
    discountMinor: bigint;
    budgetRemainingMinor?: bigint;
    redemptions?: number;
  },
>(offers: T[], redemptions: ReadonlyArray<{ offerId: string; discountMinor: bigint }>): T[] {
  const copies = offers.map((offer) => ({ ...offer }));
  for (const redemption of redemptions) {
    const offer = copies.find((candidate) => candidate.id === redemption.offerId);
    if (!offer) {
      continue;
    }
    if (offer.budgetRemainingMinor !== undefined) {
      offer.budgetRemainingMinor += redemption.discountMinor;
    }
    if ((offer.redemptions ?? 0) > 0) {
      offer.redemptions = (offer.redemptions ?? 0) - 1;
    }
  }
  return copies;
}

export function isFactHash(value: string | undefined | null): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function assertFactPinMatch(expected: FactPin, actual: FactPin): void {
  if (
    expected.catalogVersion !== actual.catalogVersion ||
    expected.policyVersion !== actual.policyVersion ||
    expected.factHash !== actual.factHash
  ) {
    throw new Error('FACTS_STALE');
  }
}
