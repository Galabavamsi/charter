import {
  FILTERS_OFFER_DISCOUNT_MINOR,
  NORTHSTAR_LABEL,
  NORTHSTAR_NAME,
  NORTHSTAR_TENANT,
  NORTHSTAR_VARIANTS,
  type CatalogVariant,
  type Material,
} from './northstar.js';
import { merchantFactPin, rewindOfferRedemptions, type FactPin } from './facts.js';
import {
  DEMO_SHOP_PROFILES,
  SEEDED_SHOP_AUTONOMOUS_CAP_MINOR,
  SEEDED_SHOP_HARD_CAP_MINOR,
  SEEDED_SHOPS,
} from './shops.js';

export type MerchantAuthority = {
  hardCapMinor: bigint;
  autonomousCapMinor: bigint;
  forbiddenMaterials: readonly string[];
};

export type OfferRule = {
  id: string;
  discountMinor: bigint;
  groups: string[][];
  stackable?: boolean;
  marginFloorMinor?: bigint;
  budgetRemainingMinor?: bigint;
  maxRedemptions?: number;
  redemptions?: number;
  expiresAt?: string;
};

export type Merchant = {
  tenantId: string;
  slug: string;
  name: string;
  label: string;
  blurb: string;
  synthetic: boolean;
  currency: 'INR';
  catalogVersion: number;
  policyVersion: number;
  refundPolicy: string;
  variants: CatalogVariant[];
  authority: MerchantAuthority;
  offers: OfferRule[];
};

export type PublicShop = {
  tenantId: string;
  slug: string;
  name: string;
  blurb: string;
  currency: 'INR';
  href: string;
  catalogPath: string;
  itemCount: number;
  inStockCount: number;
  unitsInStock: number;
};

export const DEFAULT_TENANT = NORTHSTAR_TENANT;

const merchants = new Map<string, Merchant>();
const seedIds = new Set<string>([NORTHSTAR_TENANT, ...SEEDED_SHOPS.map((row) => row.tenantId)]);

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'shop';
}

function skuFromTitle(tenantId: string, title: string): string {
  const root = `item.${slugify(title)}`;
  if (!getTenantVariant(tenantId, root)) {
    return root;
  }
  let n = 2;
  while (getTenantVariant(tenantId, `${root}-${n}`)) {
    n += 1;
  }
  return `${root}-${n}`;
}

function toPublic(row: Merchant): PublicShop {
  const published = row.variants.filter((item) => item.published);
  return {
    tenantId: row.tenantId,
    slug: row.slug,
    name: row.name,
    blurb: row.blurb,
    currency: row.currency,
    href: `/shops/${row.slug}`,
    catalogPath: `/api/v1/merchants/${row.tenantId}/catalog`,
    itemCount: published.length,
    inStockCount: published.filter((item) => item.stock > 0).length,
    unitsInStock: published.reduce((sum, item) => sum + item.stock, 0),
  };
}

function seedNorthstar(): Merchant {
  return {
    tenantId: NORTHSTAR_TENANT,
    slug: 'northstar',
    name: NORTHSTAR_NAME,
    label: NORTHSTAR_LABEL,
    blurb: 'Travel coffee kit. Steel press, grinders, filters. No glass.',
    synthetic: true,
    currency: 'INR',
    catalogVersion: 1,
    policyVersion: 1,
    refundPolicy:
      DEMO_SHOP_PROFILES[NORTHSTAR_TENANT]?.refundPolicy ??
      'Unused kit in original packaging within 7 days of capture. Return shipping is on the shopper.',
    variants: NORTHSTAR_VARIANTS.map((row) => ({ ...row })),
    authority: {
      hardCapMinor: 300000n,
      autonomousCapMinor: 250000n,
      forbiddenMaterials: ['glass'],
    },
    offers: [
      {
        id: 'filters_bundle',
        discountMinor: FILTERS_OFFER_DISCOUNT_MINOR,
        groups: [
          ['brewer.trailpress-steel-750'],
          ['filters.travel-30'],
          ['grinder.pocket-lite', 'grinder.pocket-pro'],
        ],
      },
    ],
  };
}

function seedShop(seed: (typeof SEEDED_SHOPS)[number]): Merchant {
  return {
    tenantId: seed.tenantId,
    slug: seed.slug,
    name: seed.name,
    label: seed.name,
    blurb: seed.blurb,
    synthetic: true,
    currency: 'INR',
    catalogVersion: 1,
    policyVersion: 1,
    refundPolicy: DEMO_SHOP_PROFILES[seed.tenantId]?.refundPolicy ?? '',
    variants: seed.variants.map((row) => ({ ...row })),
    authority: {
      hardCapMinor: SEEDED_SHOP_HARD_CAP_MINOR,
      autonomousCapMinor: SEEDED_SHOP_AUTONOMOUS_CAP_MINOR,
      forbiddenMaterials: [...seed.forbiddenMaterials],
    },
    offers: [],
  };
}

function bootSeeds(): void {
  merchants.clear();
  merchants.set(NORTHSTAR_TENANT, seedNorthstar());
  for (const seed of SEEDED_SHOPS) {
    merchants.set(seed.tenantId, seedShop(seed));
  }
}

bootSeeds();

export function resetCreatedMerchants(): void {
  for (const id of [...merchants.keys()]) {
    if (!seedIds.has(id)) {
      merchants.delete(id);
    }
  }
  for (const id of seedIds) {
    if (!merchants.has(id)) {
      bootSeeds();
      return;
    }
  }
}

export function resetMerchantSeeds(): void {
  bootSeeds();
}

export function listMerchants(): Merchant[] {
  return [...merchants.values()];
}

export function getMerchant(tenantId: string = DEFAULT_TENANT): Merchant | undefined {
  return merchants.get(tenantId);
}

export function getMerchantBySlug(slug: string): Merchant | undefined {
  return listMerchants().find((row) => row.slug === slug);
}

export function requireMerchant(tenantId: string = DEFAULT_TENANT): Merchant {
  const merchant = getMerchant(tenantId);
  if (!merchant) {
    throw new Error('TENANT_UNKNOWN');
  }
  return merchant;
}

export function listVariants(tenantId: string = DEFAULT_TENANT): readonly CatalogVariant[] {
  return requireMerchant(tenantId).variants;
}

export function getTenantVariant(tenantId: string, sku: string): CatalogVariant | undefined {
  return listVariants(tenantId).find((row) => row.sku === sku);
}

function offerEligible(offer: OfferRule, now: Date): boolean {
  if (offer.expiresAt && Date.parse(offer.expiresAt) <= now.getTime()) {
    return false;
  }
  if (offer.maxRedemptions !== undefined && (offer.redemptions ?? 0) >= offer.maxRedemptions) {
    return false;
  }
  if (
    offer.budgetRemainingMinor !== undefined &&
    offer.budgetRemainingMinor < offer.discountMinor
  ) {
    return false;
  }
  return true;
}

export function matchingOffersFrom(
  offers: OfferRule[],
  skus: Iterable<string>,
  now: Date = new Date(),
): OfferRule[] {
  const have = new Set(skus);
  return offers.filter(
    (offer) =>
      offerEligible(offer, now) &&
      offer.groups.every((group) => group.some((sku) => have.has(sku))),
  );
}

export function matchingOffers(
  tenantId: string,
  skus: Iterable<string>,
  now: Date = new Date(),
): OfferRule[] {
  return matchingOffersFrom(requireMerchant(tenantId).offers, skus, now);
}

export function offerDiscount(
  tenantId: string,
  skus: Iterable<string>,
  now: Date = new Date(),
): bigint {
  const matching = matchingOffers(tenantId, skus, now);
  const stackableSum = matching
    .filter((offer) => offer.stackable !== false)
    .reduce((total, offer) => total + offer.discountMinor, 0n);
  const exclusiveWinner = matching
    .filter((offer) => offer.stackable === false)
    .sort(
      (left, right) =>
        Number(right.discountMinor - left.discountMinor) || left.id.localeCompare(right.id),
    )[0];
  const exclusiveAmount = exclusiveWinner?.discountMinor ?? 0n;
  const discount = exclusiveAmount > stackableSum ? exclusiveAmount : stackableSum;
  return discount < 0n ? 0n : discount;
}

export function appliedOffersFrom(matching: OfferRule[]): OfferRule[] {
  const stackable = matching.filter((offer) => offer.stackable !== false);
  const exclusiveWinner = matching
    .filter((offer) => offer.stackable === false)
    .sort(
      (left, right) =>
        Number(right.discountMinor - left.discountMinor) || left.id.localeCompare(right.id),
    )[0];
  const stackableSum = stackable.reduce((total, offer) => total + offer.discountMinor, 0n);
  if ((exclusiveWinner?.discountMinor ?? 0n) > stackableSum) {
    return exclusiveWinner ? [exclusiveWinner] : [];
  }
  return stackable;
}

export function appliedOffers(
  tenantId: string,
  skus: Iterable<string>,
  now: Date = new Date(),
): OfferRule[] {
  return appliedOffersFrom(matchingOffers(tenantId, skus, now));
}

export function consumeAppliedOffers(offers: OfferRule[]): void {
  for (const offer of offers) {
    if (offer.budgetRemainingMinor !== undefined) {
      if (offer.budgetRemainingMinor < offer.discountMinor) {
        throw new Error('OFFER_BUDGET_EXHAUSTED');
      }
      offer.budgetRemainingMinor -= offer.discountMinor;
    }
    const next = (offer.redemptions ?? 0) + 1;
    if (offer.maxRedemptions !== undefined && next > offer.maxRedemptions) {
      throw new Error('OFFER_FREQUENCY_EXHAUSTED');
    }
    // Persist and factHash only count redemptions when budget or frequency is constrained.
    // Stamping them on unconstrained offers changes the pin after freeze and false-stales quotes.
    if (offer.budgetRemainingMinor !== undefined || offer.maxRedemptions !== undefined) {
      offer.redemptions = next;
    }
  }
}

export function merchantDisplayName(merchant: { name: string; synthetic?: boolean }): string {
  if (!merchant.synthetic) {
    return merchant.name;
  }
  return merchant.name.endsWith('(synthetic)') ? merchant.name : `${merchant.name} (synthetic)`;
}

export function assertOfferSafety(
  tenantId: string,
  skus: Iterable<string>,
  subtotal: bigint,
  discount: bigint,
  now: Date = new Date(),
): void {
  const floors = matchingOffers(tenantId, skus, now)
    .map((offer) => offer.marginFloorMinor)
    .filter((floor): floor is bigint => floor !== undefined);
  if (floors.length === 0) {
    return;
  }
  const floor = floors.reduce((highest, value) => (value > highest ? value : highest));
  if (subtotal - discount < floor) {
    throw new Error('OFFER_MARGIN_FLOOR');
  }
}

export function liveMerchantFactPin(
  tenantId: string,
  redemptions: ReadonlyArray<{ offerId: string; discountMinor: bigint }> = [],
): FactPin {
  const merchant = requireMerchant(tenantId);
  if (redemptions.length === 0) {
    return merchantFactPin(merchant);
  }
  return merchantFactPin({
    ...merchant,
    offers: rewindOfferRedemptions(merchant.offers, redemptions),
  });
}

export function copyOfferRule(offer: OfferRule): OfferRule {
  const copy: OfferRule = {
    id: offer.id,
    discountMinor: offer.discountMinor,
    groups: offer.groups.map((group) => [...group]),
  };
  if (offer.stackable !== undefined) {
    copy.stackable = offer.stackable;
  }
  if (offer.marginFloorMinor !== undefined) {
    copy.marginFloorMinor = offer.marginFloorMinor;
  }
  if (offer.budgetRemainingMinor !== undefined) {
    copy.budgetRemainingMinor = offer.budgetRemainingMinor;
  }
  if (offer.maxRedemptions !== undefined) {
    copy.maxRedemptions = offer.maxRedemptions;
  }
  if (offer.redemptions !== undefined) {
    copy.redemptions = offer.redemptions;
  }
  if (offer.expiresAt !== undefined) {
    copy.expiresAt = offer.expiresAt;
  }
  return copy;
}

export function listPublicShops(): PublicShop[] {
  return listMerchants().map(toPublic);
}

export function publicShop(tenantId: string): PublicShop | undefined {
  const merchant = getMerchant(tenantId);
  return merchant ? toPublic(merchant) : undefined;
}

export function hydrateMerchantCache(
  input: Omit<Merchant, 'catalogVersion' | 'policyVersion' | 'refundPolicy'> & {
    catalogVersion?: number;
    policyVersion?: number;
    refundPolicy?: string;
  },
): Merchant {
  const previous = merchants.get(input.tenantId);
  const merchant: Merchant = {
    ...input,
    refundPolicy: input.refundPolicy ?? previous?.refundPolicy ?? '',
    catalogVersion: input.catalogVersion ?? previous?.catalogVersion ?? 1,
    policyVersion: input.policyVersion ?? previous?.policyVersion ?? 1,
    variants: input.variants.map((variant) => ({
      ...variant,
      aliases: [...(variant.aliases ?? [])],
    })),
    authority: {
      ...input.authority,
      forbiddenMaterials: [...input.authority.forbiddenMaterials],
    },
    offers: input.offers.map((offer) => ({
      ...offer,
      groups: offer.groups.map((group) => [...group]),
    })),
  };
  merchants.set(merchant.tenantId, merchant);
  return merchant;
}

export function addVariant(
  tenantId: string,
  input: { title: string; priceRupees: number; stock: number; material?: Material },
): CatalogVariant {
  const merchant = requireMerchant(tenantId);
  const title = input.title.trim();
  if (title.length < 2) {
    throw new Error('ITEM_TITLE_REQUIRED');
  }
  if (!Number.isFinite(input.priceRupees) || input.priceRupees <= 0) {
    throw new Error('ITEM_PRICE_REQUIRED');
  }
  const stock = Math.max(0, Math.floor(input.stock));
  const material = input.material ?? 'other';
  const item: CatalogVariant = {
    sku: skuFromTitle(tenantId, title),
    title,
    priceMinor: BigInt(Math.round(input.priceRupees * 100)),
    stock,
    material,
    published: true,
    aliases: [title.toLowerCase()],
  };
  merchant.variants.push(item);
  merchant.catalogVersion += 1;
  return item;
}

export function setVariantStock(tenantId: string, sku: string, stock: number): CatalogVariant {
  const merchant = requireMerchant(tenantId);
  const item = merchant.variants.find((row) => row.sku === sku);
  if (!item) {
    throw new Error('SKU_UNKNOWN');
  }
  item.stock = Math.max(0, Math.floor(stock));
  merchant.catalogVersion += 1;
  return item;
}
