import { createHash, randomUUID } from 'node:crypto';
import {
  copyOfferRule,
  DEMO_SHOP_METRICS,
  DEMO_SHOP_PROFILES,
  getMerchant,
  listMerchants,
  merchantDisplayName,
} from '@charter/catalog';
import {
  charterTrackingId,
  fulfillmentStatusDetail,
  fulfillmentStatusLabel,
  isFulfillmentStatus,
  mockIndianAddress,
  nextFulfillmentStatus,
  type FulfillmentStatus,
  type ShippingAddress,
} from '@charter/commerce';
import { formatInr, money } from '@charter/domain-shared';
import { paymentTruth } from '@charter/payments';
import type { RecoveryChannel, RecoveryPurpose } from '@charter/recovery';
import type { VerifiedIdentity } from '../auth/verifier.js';
import { persistedConversationState } from '../tenant/conversation-state.js';
import {
  searchPublicCatalogSource,
  searchPublicShopSources,
  type PublicCatalogSourceShop,
} from '../tenant/public-catalog.js';
import type { PublicCatalogQuery } from '../tenant/public-catalog-query.js';
import { normalizeShopProfile } from '../tenant/shop-profile.js';
import {
  type BuyerOrderDetail,
  type BuyerOrderShop,
  type BuyerOrderSummary,
  type MerchantCatalogRecord,
  type MerchantCatalogStatus,
  type MerchantCursorPosition,
  type MerchantOrderDetail,
  type MerchantOrderSummary,
  type MerchantPage,
  type MerchantRecoveryRecord,
  type MerchantRulesSnapshot,
  type MerchantSettingsSnapshot,
} from '../tenant/merchant-repository.js';
import {
  type BuyerResourceKind,
  type CatalogItem,
  type KillSnapshot,
  type PlatformRole,
  type PersistedConversationSnapshot,
  type RecoveryConsentRecord,
  type ShopPolicy,
  type ShopRecord,
  type ShopRole,
  type TenantRepository,
} from '../tenant/repository.js';

type MerchantCatalogMetadata = {
  productVersion: number;
  variantVersion: number;
  inventoryVersion: number;
  reserved: number;
  description: string;
  status: MerchantCatalogStatus;
  updatedAt: string;
};

type MemoryMerchantQuote = {
  id: string;
  status: string;
  createdAt: string;
  subtotalMinor?: string;
  discountMinor?: string;
  totalMinor?: string;
  deliveryBy?: string;
  lines?: Array<{
    sku: string;
    title: string;
    quantity: number;
    unitMinor: string;
    lineMinor: string;
  }>;
};

type MemoryMerchantOrder = {
  id: string;
  quoteId: string;
  receipt: string;
  razorpayOrderId: string;
  amountMinor: string;
  status: string;
  paymentId: string | null;
  providerStatus: string | null;
  copy: string;
  createdAt: string;
  updatedAt: string;
  capturedAt: string | null;
  recovered: boolean;
  reconciliationOutcome?: string;
  reconciliationReconciledAt?: string;
  reconciliationCorrelationId?: string;
  transitions?: Array<{
    id: string;
    at: string;
    status: string;
    label: string;
    detail: string;
  }>;
};

type MemorySandboxFulfillment = {
  trackingId: string;
  status: FulfillmentStatus;
  address: ShippingAddress;
  events: Array<{
    id: string;
    at: string;
    status: FulfillmentStatus;
    note: string;
  }>;
};

type MemoryCommandResult = {
  requestHash: string;
  response: unknown;
};

type MembershipSeed = { userId: string; tenantId: string; role: ShopRole };
type PlatformRoleSeed = { userId: string; role: PlatformRole };

export type MemoryTenantState = {
  identities: Map<string, VerifiedIdentity>;
  shops: Map<string, ShopRecord>;
  catalog: Map<string, CatalogItem[]>;
  policies: Map<string, ShopPolicy>;
  memberships: Map<string, ShopRole>;
  platformRoles: Map<string, Set<PlatformRole>>;
  resources: Map<string, string>;
  conversations: Map<string, PersistedConversationSnapshot>;
  recoveryConsents: Map<string, RecoveryConsentRecord>;
  checkoutConsents: Map<string, string>;
  catalogMetadata: Map<string, MerchantCatalogMetadata>;
  merchantQuotes: Map<string, MemoryMerchantQuote[]>;
  merchantOrders: Map<string, MemoryMerchantOrder[]>;
  sandboxFulfillment: Map<string, MemorySandboxFulfillment>;
  merchantCommands: Map<string, MemoryCommandResult>;
  inventoryAdjustments: Array<{
    tenantId: string;
    variantId: string;
    actorId: string;
    reason: string;
    before: number;
    after: number;
    versionBefore: number;
    versionAfter: number;
    createdAt: string;
  }>;
  catalogAudits: Array<{
    tenantId: string;
    productId: string;
    actorId: string;
    reason: string;
    versionBefore: number;
    versionAfter: number;
    createdAt: string;
  }>;
  policyVersions: Map<string, { version: number; updatedAt: string }>;
  policyAudits: Array<{
    tenantId: string;
    actorId: string;
    reason: string;
    versionBefore: number;
    versionAfter: number;
    createdAt: string;
  }>;
  shopVersions: Map<string, { version: number; updatedAt: string }>;
  shopAudits: Array<{
    tenantId: string;
    actorId: string;
    reason: string;
    versionBefore: number;
    versionAfter: number;
    createdAt: string;
  }>;
  searchEvents: Array<{
    tenantId: string;
    requestId: string;
    query: string;
    surface: string;
    agentSource: string;
    createdAt: string;
  }>;
  impressions: Array<{
    tenantId: string;
    requestId: string;
    shopSlug: string;
    sku: string | null;
    rank: number;
    surface: string;
    agentSource: string;
    query: string;
    createdAt: string;
  }>;
  recoverySuppressions: Set<string>;
  recoveryAttempts: Array<{
    id: string;
    tenantId: string;
    checkoutId: string;
    consentId: string;
    userId: string;
    purpose: RecoveryPurpose;
    channel: RecoveryChannel;
    attemptNumber: number;
    status: 'pending' | 'sent' | 'delivered' | 'failed' | 'suppressed';
    providerMessageId: string | null;
    failureCode: string | null;
    completedAt: string | null;
    reconciliationOutcome?: string;
    reconciledAt?: string;
    reconciliationCorrelationId?: string;
  }>;
  globalKill: boolean;
  tenantKills: Set<string>;
};

export interface MemoryTenantRepository extends TenantRepository {
  readonly state: MemoryTenantState;
}

export type MemoryTenantRepositoryOptions = {
  state?: MemoryTenantState;
  memberships?: MembershipSeed[];
  platformRoles?: PlatformRoleSeed[];
};

function membershipKey(userId: string, tenantId: string): string {
  return `${userId.toLowerCase()}:${tenantId}`;
}

function resourceKey(kind: BuyerResourceKind, tenantId: string, id: string): string {
  return `${kind}:${tenantId}:${id}`;
}

function requireMembership(
  state: MemoryTenantState,
  userId: string,
  tenantId: string,
  allowedRoles?: readonly ShopRole[],
): ShopRole {
  const role = state.memberships.get(membershipKey(userId, tenantId));
  if (!role || (allowedRoles && !allowedRoles.includes(role))) {
    throw new Error('SHOP_MEMBERSHIP_REQUIRED');
  }
  return role;
}

function slugify(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'shop'
  );
}

const SEED_CATEGORIES = {
  'northstar-demo-in': { slug: 'travel-coffee', title: 'Travel coffee' },
  'indigo-desk-in': { slug: 'desk-essentials', title: 'Desk essentials' },
  'harbor-spice-in': { slug: 'spice-pantry', title: 'Spice pantry' },
  'sable-atelier-in': { slug: 'apparel', title: 'Apparel' },
  'lotus-gifting-in': { slug: 'gifts', title: 'Gifts' },
  'marigold-home-in': { slug: 'home', title: 'Home' },
} as const;

const SEED_PUBLISHED_AT = {
  'northstar-demo-in': '2026-01-01T00:00:00.000Z',
  'indigo-desk-in': '2026-01-01T00:00:00.000Z',
  'harbor-spice-in': '2026-01-01T00:00:00.000Z',
  'sable-atelier-in': '2026-02-01T00:00:00.000Z',
  'lotus-gifting-in': '2026-02-08T00:00:00.000Z',
  'marigold-home-in': '2026-02-15T00:00:00.000Z',
} as const;

function stableUuid(scope: string, value: string): string {
  const hex = createHash('sha256').update(`${scope}:${value}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(
    17,
    20,
  )}-${hex.slice(20, 32)}`;
}

function createSeedState(): MemoryTenantState {
  const shops = new Map<string, ShopRecord>();
  const catalog = new Map<string, CatalogItem[]>();
  const policies = new Map<string, ShopPolicy>();
  const catalogMetadata = new Map<string, MerchantCatalogMetadata>();
  const policyVersions = new Map<string, { version: number; updatedAt: string }>();
  const shopVersions = new Map<string, { version: number; updatedAt: string }>();
  for (const merchant of listMerchants()) {
    const metrics = DEMO_SHOP_METRICS[merchant.tenantId];
    shops.set(merchant.tenantId, {
      tenantId: merchant.tenantId,
      slug: merchant.slug,
      name: merchant.name,
      label: merchant.label,
      blurb: merchant.blurb,
      currency: 'INR',
      status: 'published',
      synthetic: merchant.synthetic,
      version: 1,
      publishedAt:
        SEED_PUBLISHED_AT[merchant.tenantId as keyof typeof SEED_PUBLISHED_AT] ??
        '2026-01-01T00:00:00.000Z',
      ratingMilli: metrics?.ratingMilli ?? 0,
      reviewCount: metrics?.reviewCount ?? 0,
      gstin: DEMO_SHOP_PROFILES[merchant.tenantId]?.gstin ?? '',
      addressLine: DEMO_SHOP_PROFILES[merchant.tenantId]?.addressLine ?? '',
      refundPolicy: DEMO_SHOP_PROFILES[merchant.tenantId]?.refundPolicy ?? '',
      profileVerified: false,
    });
    const category = SEED_CATEGORIES[merchant.tenantId as keyof typeof SEED_CATEGORIES] ?? null;
    const shopPublishedAt =
      SEED_PUBLISHED_AT[merchant.tenantId as keyof typeof SEED_PUBLISHED_AT] ??
      '2026-01-01T00:00:00.000Z';
    catalog.set(
      merchant.tenantId,
      merchant.variants.map((variant) => ({
        id: stableUuid('variant', `${merchant.tenantId}:${variant.sku}`),
        productId: stableUuid('product', `${merchant.tenantId}:${variant.sku}`),
        sku: variant.sku,
        title: variant.title,
        priceMinor: variant.priceMinor.toString(),
        priceDisplay: formatInr(money(variant.priceMinor)),
        stock: variant.stock,
        material: variant.material,
        published: variant.published,
        aliases: [...(variant.aliases ?? [])],
        category:
          variant.sku === 'mill.cast-iron'
            ? { slug: 'travel-coffee', title: 'Travel coffee' }
            : category,
        publishedAt: shopPublishedAt,
      })),
    );
    for (const item of catalog.get(merchant.tenantId) ?? []) {
      catalogMetadata.set(`${merchant.tenantId}:${item.id}`, {
        productVersion: 1,
        variantVersion: 1,
        inventoryVersion: 1,
        reserved: 0,
        description: item.title,
        status: item.published ? 'published' : 'draft',
        updatedAt: shopPublishedAt,
      });
    }
    policies.set(merchant.tenantId, {
      hardCapMinor: merchant.authority.hardCapMinor,
      autonomousCapMinor: merchant.authority.autonomousCapMinor,
      forbiddenMaterials: [...merchant.authority.forbiddenMaterials],
      offers: merchant.offers.map(copyOfferRule),
      version: 1,
    });
    policyVersions.set(merchant.tenantId, { version: 1, updatedAt: shopPublishedAt });
    shopVersions.set(merchant.tenantId, { version: 1, updatedAt: shopPublishedAt });
  }
  return {
    identities: new Map(),
    shops,
    catalog,
    policies,
    memberships: new Map(),
    platformRoles: new Map(),
    resources: new Map(),
    conversations: new Map(),
    recoveryConsents: new Map(),
    checkoutConsents: new Map(),
    catalogMetadata,
    merchantQuotes: new Map(),
    merchantOrders: new Map(),
    sandboxFulfillment: new Map(),
    merchantCommands: new Map(),
    inventoryAdjustments: [],
    catalogAudits: [],
    policyVersions,
    policyAudits: [],
    shopVersions,
    shopAudits: [],
    searchEvents: [],
    impressions: [],
    recoverySuppressions: new Set(),
    recoveryAttempts: [],
    globalKill: false,
    tenantKills: new Set(),
  };
}

function publicCatalogSource(state: MemoryTenantState, shop: ShopRecord): PublicCatalogSourceShop {
  const publishedAt = shop.publishedAt ?? '2026-01-01T00:00:00.000Z';
  return {
    ...shop,
    publishedAt,
    items: (state.catalog.get(shop.tenantId) ?? [])
      .filter((item) => item.published)
      .map((item) => ({
        id: item.id,
        productId: item.productId ?? stableUuid('product', `${shop.tenantId}:${item.sku}`),
        productTitle: item.title,
        sku: item.sku,
        title: item.title,
        priceMinor: item.priceMinor,
        availableStock: item.stock,
        category: item.category ?? null,
        material: item.material,
        aliases: [...item.aliases],
        publishedAt: item.publishedAt ?? publishedAt,
      })),
  };
}

function unpagedQuery(): PublicCatalogQuery {
  return {
    q: '',
    sku: '',
    category: '',
    inStock: false,
    minPriceMinor: null,
    maxPriceMinor: null,
    sort: 'name',
    limit: Number.MAX_SAFE_INTEGER,
    fingerprint: '',
    after: null,
  };
}

function formatMinor(value: string): string {
  return formatInr(money(BigInt(value)));
}

function catalogMetadata(
  state: MemoryTenantState,
  tenantId: string,
  item: CatalogItem,
): MerchantCatalogMetadata {
  const key = `${tenantId}:${item.id}`;
  const current = state.catalogMetadata.get(key);
  if (current) {
    return current;
  }
  const fallback: MerchantCatalogMetadata = {
    productVersion: 1,
    variantVersion: 1,
    inventoryVersion: 1,
    reserved: 0,
    description: item.title,
    status: item.published ? 'published' : 'draft',
    updatedAt: item.publishedAt ?? new Date().toISOString(),
  };
  state.catalogMetadata.set(key, fallback);
  return fallback;
}

function merchantCatalogRecord(
  state: MemoryTenantState,
  tenantId: string,
  item: CatalogItem,
): MerchantCatalogRecord {
  const metadata = catalogMetadata(state, tenantId, item);
  const category = item.category
    ? {
        id: stableUuid('category', `${tenantId}:${item.category.slug}`),
        slug: item.category.slug,
        title: item.category.title,
      }
    : null;
  return {
    productId: item.productId ?? stableUuid('product', `${tenantId}:${item.sku}`),
    productVersion: metadata.productVersion,
    title: item.title,
    description: metadata.description,
    status: metadata.status,
    category,
    variantId: item.id,
    variantVersion: metadata.variantVersion,
    sku: item.sku,
    material: item.material,
    priceMinor: item.priceMinor,
    priceDisplay: formatMinor(item.priceMinor),
    inventory: {
      onHand: item.stock,
      reserved: metadata.reserved,
      available: item.stock - metadata.reserved,
      version: metadata.inventoryVersion,
    },
    updatedAt: metadata.updatedAt,
  };
}

function pageByCursor<T>(
  rows: T[],
  limit: number,
  after: MerchantCursorPosition | null,
  position: (row: T) => MerchantCursorPosition,
): MerchantPage<T> {
  const eligible = after
    ? rows.filter((row) => {
        const cursor = position(row);
        return (
          cursor.sortValue < after.sortValue ||
          (cursor.sortValue === after.sortValue && cursor.id < after.id)
        );
      })
    : rows;
  const page = eligible.slice(0, limit);
  return {
    items: page,
    cursor: eligible.length > limit && page.length > 0 ? position(page[page.length - 1]!) : null,
  };
}

function runMerchantCommand<T>(
  state: MemoryTenantState,
  input: {
    userId: string;
    operation: string;
    idempotencyKey: string;
    requestHash: string;
  },
  work: () => T,
): T {
  const key = `${input.userId.toLowerCase()}:${input.operation}:${input.idempotencyKey}`;
  const existing = state.merchantCommands.get(key);
  if (existing) {
    if (existing.requestHash !== input.requestHash) {
      throw new Error('IDEMPOTENCY_CONFLICT');
    }
    return structuredClone(existing.response) as T;
  }
  const response = work();
  state.merchantCommands.set(key, {
    requestHash: input.requestHash,
    response: structuredClone(response),
  });
  return response;
}

function buyerOrderShop(state: MemoryTenantState, tenantId: string): BuyerOrderShop {
  const shop = state.shops.get(tenantId);
  return {
    tenantId,
    slug: shop?.slug ?? tenantId,
    name: shop?.name ?? tenantId,
    synthetic: shop?.synthetic ?? true,
  };
}

function sandboxKey(tenantId: string, checkoutId: string): string {
  return `${tenantId}:${checkoutId}`;
}

function ensureMemorySandbox(
  state: MemoryTenantState,
  tenantId: string,
  order: MemoryMerchantOrder,
): MemorySandboxFulfillment | undefined {
  const paid =
    order.status === 'SETTLED' && order.providerStatus === 'captured' && order.capturedAt !== null;
  const key = sandboxKey(tenantId, order.id);
  const existing = state.sandboxFulfillment.get(key);
  if (!paid) {
    return existing;
  }
  if (existing) {
    return existing;
  }
  const address = mockIndianAddress(order.id);
  const trackingId = charterTrackingId(order.id);
  const created: MemorySandboxFulfillment = {
    trackingId,
    status: 'confirmed',
    address,
    events: [
      {
        id: `fulfillment:${order.id}:confirmed`,
        at: order.capturedAt ?? order.updatedAt,
        status: 'confirmed',
        note: fulfillmentStatusDetail('confirmed'),
      },
    ],
  };
  state.sandboxFulfillment.set(key, created);
  return created;
}

function merchantOrderDetail(
  state: MemoryTenantState,
  tenantId: string,
  order: MemoryMerchantOrder,
): MerchantOrderDetail {
  const quote = state.merchantQuotes
    .get(tenantId)
    ?.find((candidate) => candidate.id === order.quoteId);
  const sandbox = ensureMemorySandbox(state, tenantId, order);
  const summary = withSandboxSummaryFields(state, tenantId, order);
  const timeline: MerchantOrderDetail['timeline'] = [
    {
      id: `quote:${order.quoteId}`,
      at: quote?.createdAt ?? order.createdAt,
      status: 'quote_frozen',
      label: 'Quote frozen',
      detail: 'Line prices and totals were frozen for this checkout.',
    },
    {
      id: `provider-order:${order.id}`,
      at: order.createdAt,
      status: 'provider_order_created',
      label: 'Razorpay Order created',
      detail: `Receipt ${order.receipt}. Payment is not fulfilled at this stage.`,
    },
  ];
  if (order.transitions && order.transitions.length > 0) {
    timeline.push(...order.transitions.map((transition) => ({ ...transition })));
  } else if (order.status === 'SETTLED' && order.capturedAt) {
    timeline.push({
      id: `capture:${order.id}`,
      at: order.capturedAt,
      status: 'captured',
      label: 'Payment captured',
      detail: 'Captured ledger evidence. Eligible for fulfillment.',
    });
  } else if (order.status === 'FAILED_PROVISIONAL') {
    timeline.push({
      id: `failure:${order.id}`,
      at: order.updatedAt,
      status: 'failed_provisional',
      label: 'Payment not confirmed',
      detail: 'Provisional provider failure. Reconciliation remains authoritative.',
    });
  } else if (order.status === 'CAPTURE_PENDING') {
    timeline.push({
      id: `authorization:${order.id}`,
      at: order.updatedAt,
      status: 'authorized',
      label: 'Awaiting capture',
      detail: 'Waiting for automatic capture. Not fulfilled.',
    });
  } else if (order.status === 'RECONCILING') {
    timeline.push({
      id: `reconciling:${order.id}`,
      at: order.updatedAt,
      status: 'reconciling',
      label: 'Reconciling',
      detail: 'Payment not confirmed. Provider state is being fetched.',
    });
  } else {
    timeline.push({
      id: `status:${order.id}`,
      at: order.updatedAt,
      status: order.status.toLowerCase(),
      label: 'Provider status updated',
      detail: order.copy,
    });
  }
  for (const attempt of state.recoveryAttempts.filter(
    (candidate) => candidate.tenantId === tenantId && candidate.checkoutId === order.id,
  )) {
    timeline.push({
      id: `recovery:${attempt.id}`,
      at: attempt.completedAt ?? order.updatedAt,
      status: `recovery_${attempt.status}`,
      label: `Recovery ${attempt.status}`,
      detail:
        attempt.status === 'sent'
          ? 'A consented recovery email was sent.'
          : `Recovery stopped with ${attempt.failureCode ?? attempt.status}.`,
    });
  }
  for (const event of sandbox?.events ?? []) {
    timeline.push({
      id: event.id,
      at: event.at,
      status: event.status,
      label: fulfillmentStatusLabel(event.status),
      detail: event.note,
    });
  }
  timeline.sort(
    (left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id),
  );
  return {
    ...summary,
    quote: {
      id: order.quoteId,
      status: quote?.status ?? 'BOUND',
      subtotalMinor: quote?.subtotalMinor ?? order.amountMinor,
      discountMinor: quote?.discountMinor ?? '0',
      totalMinor: quote?.totalMinor ?? order.amountMinor,
      ...(quote?.deliveryBy ? { deliveryBy: quote.deliveryBy } : {}),
      lines: quote?.lines?.map((line) => ({ ...line })) ?? [],
    },
    provider: {
      razorpayOrderId: order.razorpayOrderId,
      paymentId: order.paymentId,
      status: order.providerStatus,
    },
    ...(sandbox
      ? {
          shippingAddress: sandbox.address,
          nextFulfillmentStatus: nextFulfillmentStatus(sandbox.status),
        }
      : {}),
    timeline,
  };
}

function merchantOrderSummary(order: MemoryMerchantOrder): MerchantOrderSummary {
  const truth = paymentTruth(order.status);
  const paid =
    order.status === 'SETTLED' && order.providerStatus === 'captured' && order.capturedAt !== null;
  return {
    id: order.id,
    receipt: order.receipt,
    razorpayOrderId: order.razorpayOrderId,
    status: order.status,
    paymentState: order.providerStatus ?? 'unknown',
    totalMinor: order.amountMinor,
    totalDisplay: formatMinor(order.amountMinor),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    paid,
    fulfillmentReady: paid,
    paymentTruth: truth.label,
  };
}

function withSandboxSummaryFields(
  state: MemoryTenantState,
  tenantId: string,
  order: MemoryMerchantOrder,
): MerchantOrderSummary {
  const summary = merchantOrderSummary(order);
  const sandbox = ensureMemorySandbox(state, tenantId, order);
  if (!sandbox) {
    return summary;
  }
  return {
    ...summary,
    trackingId: sandbox.trackingId,
    fulfillmentStatus: sandbox.status,
  };
}

function memberRows(
  state: MemoryTenantState,
  tenantId: string,
): MerchantSettingsSnapshot['members'] {
  const suffix = `:${tenantId}`;
  return [...state.memberships.entries()]
    .filter(([key]) => key.endsWith(suffix))
    .map(([key, role]) => {
      const userId = key.slice(0, -suffix.length);
      const identity = state.identities.get(userId);
      return {
        userId,
        role,
        status: 'active',
        label: identity?.email ?? userId,
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

function merchantRulesSnapshot(
  state: MemoryTenantState,
  tenantId: string,
): MerchantRulesSnapshot | undefined {
  const policy = state.policies.get(tenantId);
  if (!policy) {
    return undefined;
  }
  const version = state.policyVersions.get(tenantId) ?? {
    version: 1,
    updatedAt: new Date().toISOString(),
  };
  return {
    version: version.version,
    hardCapMinor: policy.hardCapMinor.toString(),
    hardCapDisplay: formatMinor(policy.hardCapMinor.toString()),
    autonomousCapMinor: policy.autonomousCapMinor.toString(),
    autonomousCapDisplay: formatMinor(policy.autonomousCapMinor.toString()),
    forbiddenMaterials: [...policy.forbiddenMaterials],
    offers: policy.offers.map((offer) => ({
      id: offer.id,
      discountMinor: offer.discountMinor.toString(),
      discountDisplay: formatMinor(offer.discountMinor.toString()),
      requiredSkuGroups: offer.groups.map((group) => [...group]),
      stackable: offer.stackable !== false,
      marginFloorMinor: offer.marginFloorMinor?.toString() ?? null,
      budgetRemainingMinor: offer.budgetRemainingMinor?.toString() ?? null,
      maxRedemptions: offer.maxRedemptions ?? null,
      redemptions: offer.redemptions ?? 0,
      expiresAt: offer.expiresAt ?? null,
    })),
    updatedAt: version.updatedAt,
  };
}

function projectSettingsMembers(
  actorRole: ShopRole,
  members: MerchantSettingsSnapshot['members'],
): MerchantSettingsSnapshot['members'] {
  if (actorRole !== 'owner' && actorRole !== 'admin') {
    return [];
  }
  return members.map((member) => ({
    userId: member.userId,
    role: member.role,
    status: member.status,
    label: member.role,
  }));
}

function recommendationSkuRows(
  state: MemoryTenantState,
  tenantId: string,
  inRange: (value: string | null) => boolean,
): Array<{ sku: string; title: string; count: number }> {
  const counts = new Map<string, number>();
  for (const impression of state.impressions) {
    if (impression.tenantId !== tenantId || !impression.sku || !inRange(impression.createdAt)) {
      continue;
    }
    counts.set(impression.sku, (counts.get(impression.sku) ?? 0) + 1);
  }
  const catalog = state.catalog.get(tenantId) ?? [];
  return [...counts.entries()]
    .map(([sku, count]) => ({
      sku,
      title: catalog.find((item) => item.sku === sku)?.title ?? sku,
      count,
    }))
    .sort((left, right) => right.count - left.count || left.sku.localeCompare(right.sku))
    .slice(0, 8);
}

function recommendationSourceRows(
  state: MemoryTenantState,
  tenantId: string,
  inRange: (value: string | null) => boolean,
): Array<{ source: string; count: number }> {
  const counts = new Map<string, number>();
  for (const impression of state.impressions) {
    if (impression.tenantId !== tenantId || !inRange(impression.createdAt)) {
      continue;
    }
    counts.set(impression.agentSource, (counts.get(impression.agentSource) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((left, right) => right.count - left.count || left.source.localeCompare(right.source));
}

function merchantSettingsSnapshot(
  state: MemoryTenantState,
  tenantId: string,
  testMode: boolean,
  actorRole: ShopRole,
): MerchantSettingsSnapshot | undefined {
  const shop = state.shops.get(tenantId);
  if (!shop || shop.status === 'archived') {
    return undefined;
  }
  const version = state.shopVersions.get(tenantId) ?? {
    version: 1,
    updatedAt: new Date().toISOString(),
  };
  return {
    version: version.version,
    name: shop.name,
    blurb: shop.blurb,
    slug: shop.slug,
    publicPath: `/shops/${shop.slug}`,
    synthetic: shop.synthetic,
    testMode,
    paymentAccountDisclosure: testMode
      ? 'Razorpay test mode. No live money is accepted.'
      : 'Live payment account status is managed by the payment provider.',
    gstin: shop.gstin ?? '',
    addressLine: shop.addressLine ?? '',
    refundPolicy: shop.refundPolicy ?? '',
    profileVerified: shop.profileVerified === true,
    members: projectSettingsMembers(actorRole, memberRows(state, tenantId)),
  };
}

function merchantRecoveryRecord(
  state: MemoryTenantState,
  tenantId: string,
  order: MemoryMerchantOrder,
): MerchantRecoveryRecord {
  const consentId = state.checkoutConsents.get(`${tenantId}:${order.id}`);
  const consent = consentId ? state.recoveryConsents.get(`${tenantId}:${consentId}`) : undefined;
  const attempts = state.recoveryAttempts
    .filter((attempt) => attempt.tenantId === tenantId && attempt.checkoutId === order.id)
    .sort((left, right) => right.attemptNumber - left.attemptNumber);
  const latestAttempt = attempts[0];
  const killed = state.globalKill || state.tenantKills.has(tenantId);
  const suppressed = Boolean(
    consent && state.recoverySuppressions.has(`${tenantId}:${consent.email.toLowerCase()}`),
  );
  const refunded =
    order.providerStatus === 'refunded' || order.reconciliationOutcome === 'refunded';
  const captured = !refunded && (order.status === 'SETTLED' || order.providerStatus === 'captured');
  const alreadySent =
    latestAttempt?.status === 'pending' ||
    latestAttempt?.status === 'sent' ||
    latestAttempt?.status === 'delivered';
  const retryLimitReached =
    attempts.filter((attempt) => attempt.status !== 'suppressed').length >= 2;
  const reconciling =
    !captured &&
    !refunded &&
    order.status === 'FAILED_PROVISIONAL' &&
    order.reconciliationOutcome !== 'same_order_retry_safe';
  const blockedReason = captured
    ? 'PAYMENT_CAPTURED'
    : refunded
      ? 'PAYMENT_REFUNDED'
      : killed
        ? 'CHECKOUT_KILLED'
        : suppressed
          ? 'SUPPRESSED'
          : !consent
            ? 'NO_CONSENT'
            : order.status !== 'FAILED_PROVISIONAL'
              ? 'NOT_FAILED_PROVISIONAL'
              : reconciling
                ? 'RECONCILIATION_REQUIRED'
                : alreadySent
                  ? latestAttempt.status === 'pending'
                    ? 'ALREADY_PENDING'
                    : 'ALREADY_SENT'
                  : retryLimitReached
                    ? 'RETRY_LIMIT_REACHED'
                    : null;
  const sendStatus: MerchantRecoveryRecord['sendStatus'] = latestAttempt?.status ?? 'not_sent';
  return {
    checkoutId: order.id,
    quoteId: order.quoteId,
    razorpayOrderId: order.razorpayOrderId,
    amountMinor: order.amountMinor,
    amountDisplay: formatMinor(order.amountMinor),
    checkoutStatus: order.status,
    reconciliationStatus: captured
      ? 'captured'
      : order.status === 'RECONCILING' || reconciling
        ? 'reconciling'
        : order.status === 'FAILED_PROVISIONAL'
          ? 'unresolved'
          : 'clear',
    consentStatus: consent ? 'granted' : 'missing',
    sendStatus,
    stopStatus: captured ? 'captured' : killed ? 'killed' : suppressed ? 'suppressed' : 'clear',
    canSend: blockedReason === null,
    blockedReason,
    updatedAt: order.updatedAt,
  };
}

export function createMemoryTenantRepository(
  options: MemoryTenantRepositoryOptions = {},
): MemoryTenantRepository {
  const state = options.state ?? createSeedState();
  if (!state.sandboxFulfillment) {
    state.sandboxFulfillment = new Map();
  }
  for (const membership of options.memberships ?? []) {
    state.memberships.set(membershipKey(membership.userId, membership.tenantId), membership.role);
  }
  for (const assignment of options.platformRoles ?? []) {
    const roles = state.platformRoles.get(assignment.userId.toLowerCase()) ?? new Set();
    roles.add(assignment.role);
    state.platformRoles.set(assignment.userId.toLowerCase(), roles);
  }
  let conversationMutationTail = Promise.resolve();

  async function withConversationMutationLock<T>(work: () => T): Promise<T> {
    const predecessor = conversationMutationTail;
    let release!: () => void;
    conversationMutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return work();
    } finally {
      release();
    }
  }

  return {
    state,
    async getMerchantOverview(input) {
      requireMembership(state, input.userId, input.tenantId);
      const inRange = (value: string | null): boolean =>
        Boolean(value && value.slice(0, 10) >= input.from && value.slice(0, 10) <= input.to);
      const quotes = (state.merchantQuotes.get(input.tenantId) ?? []).filter((quote) =>
        inRange(quote.createdAt),
      );
      const quoteIds = new Set(quotes.map((quote) => quote.id));
      const orders = state.merchantOrders.get(input.tenantId) ?? [];
      const captures = orders.filter(
        (order) =>
          order.status === 'SETTLED' &&
          order.providerStatus === 'captured' &&
          quoteIds.has(order.quoteId) &&
          inRange(order.capturedAt),
      );
      const uniqueCaptures = new Map<string, (typeof captures)[number]>();
      for (const order of captures) {
        if (!uniqueCaptures.has(order.quoteId)) {
          uniqueCaptures.set(order.quoteId, order);
        }
      }
      const capturedQuotes = [...uniqueCaptures.values()];
      const failed = orders.filter(
        (order) =>
          (order.status === 'FAILED_PROVISIONAL' || order.status === 'RECONCILING') &&
          order.providerStatus !== 'refunded' &&
          order.reconciliationOutcome !== 'refunded' &&
          inRange(order.updatedAt),
      );
      const capturedMinor = capturedQuotes.reduce((total, order) => {
        const quote = quotes.find((candidate) => candidate.id === order.quoteId);
        return total + BigInt(quote?.totalMinor ?? order.amountMinor);
      }, 0n);
      const recoveredMinor = capturedQuotes
        .filter((order) => order.recovered)
        .reduce((total, order) => {
          const quote = quotes.find((candidate) => candidate.id === order.quoteId);
          return total + BigInt(quote?.totalMinor ?? order.amountMinor);
        }, 0n);
      const catalog = (state.catalog.get(input.tenantId) ?? []).map((item) =>
        merchantCatalogRecord(state, input.tenantId, item),
      );
      const denominator = quotes.length;
      const numerator = capturedQuotes.length;
      return {
        range: { from: input.from, to: input.to },
        capturedGmvMinor: capturedMinor.toString(),
        capturedGmvDisplay: formatMinor(capturedMinor.toString()),
        capturedOrders: numerator,
        validFrozenQuotes: denominator,
        conversion: {
          numerator,
          denominator,
          rate: denominator === 0 ? null : numerator / denominator,
        },
        failedUnresolvedPays: failed.length,
        recoveredAmountMinor: recoveredMinor.toString(),
        recoveredAmountDisplay: formatMinor(recoveredMinor.toString()),
        inventoryUnits: catalog
          .filter((item) => item.status !== 'archived')
          .reduce((sum, item) => sum + item.inventory.onHand, 0),
        lowStockVariants: catalog.filter(
          (item) => item.status !== 'archived' && item.inventory.available <= 5,
        ).length,
        synthetic: state.shops.get(input.tenantId)?.synthetic ?? false,
        attributionNote:
          'Cohort is quotes created in this window. Captured GMV and conversion count only captures in the same window whose quote is in that cohort. Recovered amount is observed capture after a recorded recovery attempt; no incremental lift is claimed without a control.',
        searches: (state.searchEvents ?? []).filter(
          (event) => event.tenantId === input.tenantId && inRange(event.createdAt),
        ).length,
        recommendationsBySku: recommendationSkuRows(state, input.tenantId, inRange),
        recommendationsBySource: recommendationSourceRows(state, input.tenantId, inRange),
      };
    },
    async listMerchantCatalog(input) {
      requireMembership(state, input.userId, input.tenantId);
      const rows = (state.catalog.get(input.tenantId) ?? [])
        .map((item) => merchantCatalogRecord(state, input.tenantId, item))
        .sort(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) ||
            right.productId.localeCompare(left.productId),
        );
      return pageByCursor(rows, input.limit, input.after, (row) => ({
        sortValue: row.updatedAt,
        id: row.productId,
      }));
    },
    async createMerchantProduct(input) {
      requireMembership(state, input.userId, input.tenantId, ['owner', 'admin', 'catalog']);
      return runMerchantCommand(
        state,
        {
          userId: input.userId,
          operation: `catalog:create:${input.tenantId}`,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
        },
        () => {
          const title = input.title.trim();
          const description = input.description.trim();
          const categoryTitle = input.category.trim();
          const sku = input.sku.trim();
          let priceMinor: bigint;
          try {
            priceMinor = BigInt(input.priceMinor);
          } catch {
            throw new Error('MONEY_DECIMAL_INVALID');
          }
          if (priceMinor < 0n || !Number.isSafeInteger(input.stock) || input.stock < 0) {
            throw new Error('CATALOG_PUBLISH_INVALID');
          }
          if (
            input.status === 'published' &&
            (title.length < 2 ||
              !description ||
              !categoryTitle ||
              !sku ||
              priceMinor <= 0n ||
              input.stock <= 0)
          ) {
            throw new Error('CATALOG_PUBLISH_INVALID');
          }
          const items = state.catalog.get(input.tenantId) ?? [];
          if (items.some((item) => item.sku.toLowerCase() === sku.toLowerCase())) {
            throw new Error('CATALOG_SKU_CONFLICT');
          }
          const productId = randomUUID();
          const variantId = randomUUID();
          const now = new Date().toISOString();
          const item: CatalogItem = {
            id: variantId,
            productId,
            sku,
            title,
            priceMinor: priceMinor.toString(),
            priceDisplay: formatMinor(priceMinor.toString()),
            stock: input.stock,
            material: input.material,
            published: input.status === 'published',
            aliases: [title.toLowerCase()],
            category: categoryTitle ? { slug: slugify(categoryTitle), title: categoryTitle } : null,
            publishedAt: input.status === 'published' ? now : null,
          };
          items.push(item);
          state.catalog.set(input.tenantId, items);
          state.catalogMetadata.set(`${input.tenantId}:${variantId}`, {
            productVersion: 1,
            variantVersion: 1,
            inventoryVersion: 1,
            reserved: 0,
            description,
            status: input.status,
            updatedAt: now,
          });
          state.catalogAudits.push({
            tenantId: input.tenantId,
            productId,
            actorId: input.userId,
            reason:
              input.status === 'published'
                ? 'Direct published product creation'
                : 'Initial draft product creation',
            versionBefore: 0,
            versionAfter: 1,
            createdAt: now,
          });
          return merchantCatalogRecord(state, input.tenantId, item);
        },
      );
    },
    async updateMerchantProduct(input) {
      requireMembership(state, input.userId, input.tenantId, ['owner', 'admin', 'catalog']);
      return runMerchantCommand(
        state,
        {
          userId: input.userId,
          operation: `catalog:update:${input.tenantId}:${input.productId}`,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
        },
        () => {
          const items = state.catalog.get(input.tenantId) ?? [];
          const item = items.find(
            (candidate) =>
              (candidate.productId ??
                stableUuid('product', `${input.tenantId}:${candidate.sku}`)) === input.productId,
          );
          if (!item) {
            throw new Error('CATALOG_PRODUCT_NOT_FOUND');
          }
          const metadata = catalogMetadata(state, input.tenantId, item);
          if (metadata.productVersion !== input.expectedVersion) {
            throw new Error('CATALOG_VERSION_CONFLICT');
          }
          const title = input.title.trim();
          const description = input.description.trim();
          const categoryTitle = input.category.trim();
          const sku = input.sku.trim();
          const priceMinor = BigInt(input.priceMinor);
          if (
            input.status === 'published' &&
            (title.length < 2 ||
              !description ||
              !categoryTitle ||
              !sku ||
              priceMinor <= 0n ||
              item.stock - metadata.reserved <= 0)
          ) {
            throw new Error('CATALOG_PUBLISH_INVALID');
          }
          if (
            items.some(
              (candidate) =>
                candidate.id !== item.id && candidate.sku.toLowerCase() === sku.toLowerCase(),
            )
          ) {
            throw new Error('CATALOG_SKU_CONFLICT');
          }
          const versionBefore = metadata.productVersion;
          const now = new Date().toISOString();
          item.title = title;
          item.sku = sku;
          item.priceMinor = priceMinor.toString();
          item.priceDisplay = formatMinor(priceMinor.toString());
          item.material = input.material;
          item.published = input.status === 'published';
          item.category = categoryTitle
            ? { slug: slugify(categoryTitle), title: categoryTitle }
            : null;
          item.aliases = [...new Set([...item.aliases, title.toLowerCase()])];
          item.publishedAt = input.status === 'published' ? (item.publishedAt ?? now) : null;
          metadata.productVersion += 1;
          metadata.variantVersion += 1;
          metadata.description = description;
          metadata.status = input.status;
          metadata.updatedAt = now;
          state.catalogAudits.push({
            tenantId: input.tenantId,
            productId: input.productId,
            actorId: input.userId,
            reason: input.reason.trim(),
            versionBefore,
            versionAfter: metadata.productVersion,
            createdAt: now,
          });
          return merchantCatalogRecord(state, input.tenantId, item);
        },
      );
    },
    async adjustMerchantStock(input) {
      requireMembership(state, input.userId, input.tenantId, ['owner', 'admin', 'catalog']);
      return runMerchantCommand(
        state,
        {
          userId: input.userId,
          operation: `inventory:adjust:${input.tenantId}:${input.variantId}`,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
        },
        () => {
          const item = state.catalog
            .get(input.tenantId)
            ?.find((candidate) => candidate.id === input.variantId);
          if (!item) {
            throw new Error('CATALOG_VARIANT_NOT_FOUND');
          }
          const metadata = catalogMetadata(state, input.tenantId, item);
          if (metadata.inventoryVersion !== input.expectedVersion) {
            throw new Error('INVENTORY_VERSION_CONFLICT');
          }
          if (
            !Number.isSafeInteger(input.delta) ||
            input.delta === 0 ||
            input.reason.trim().length < 3
          ) {
            throw new Error('INVENTORY_ADJUSTMENT_INVALID');
          }
          const next = item.stock + input.delta;
          if (next < metadata.reserved || next < 0) {
            throw new Error('INVENTORY_INSUFFICIENT');
          }
          const before = item.stock;
          const versionBefore = metadata.inventoryVersion;
          const now = new Date().toISOString();
          item.stock = next;
          metadata.inventoryVersion += 1;
          metadata.updatedAt = now;
          state.inventoryAdjustments.push({
            tenantId: input.tenantId,
            variantId: input.variantId,
            actorId: input.userId,
            reason: input.reason.trim(),
            before,
            after: next,
            versionBefore,
            versionAfter: metadata.inventoryVersion,
            createdAt: now,
          });
          return merchantCatalogRecord(state, input.tenantId, item).inventory;
        },
      );
    },
    async listMerchantOrders(input) {
      requireMembership(state, input.userId, input.tenantId, [
        'owner',
        'admin',
        'catalog',
        'support',
        'finance',
        'viewer',
      ]);
      const query = input.query.toLowerCase();
      const rows = (state.merchantOrders.get(input.tenantId) ?? [])
        .filter(
          (order) =>
            (!input.status || order.status === input.status) &&
            (!input.from || order.createdAt.slice(0, 10) >= input.from) &&
            (!input.to || order.createdAt.slice(0, 10) <= input.to) &&
            (!query ||
              order.receipt.toLowerCase().includes(query) ||
              order.razorpayOrderId.toLowerCase().includes(query) ||
              order.paymentId?.toLowerCase().includes(query)),
        )
        .map((order) => withSandboxSummaryFields(state, input.tenantId, order))
        .sort(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id),
        );
      return pageByCursor(rows, input.limit, input.after, (row) => ({
        sortValue: row.updatedAt,
        id: row.id,
      }));
    },
    async getMerchantOrder(input) {
      requireMembership(state, input.userId, input.tenantId, [
        'owner',
        'admin',
        'catalog',
        'support',
        'finance',
        'viewer',
      ]);
      const order = state.merchantOrders
        .get(input.tenantId)
        ?.find((candidate) => candidate.id === input.orderId);
      if (!order) {
        return undefined;
      }
      return merchantOrderDetail(state, input.tenantId, order);
    },
    async advanceMerchantFulfillment(input) {
      requireMembership(state, input.userId, input.tenantId, [
        'owner',
        'admin',
        'catalog',
        'support',
      ]);
      const order = state.merchantOrders
        .get(input.tenantId)
        ?.find((candidate) => candidate.id === input.orderId);
      if (!order) {
        throw new Error('ORDER_NOT_FOUND');
      }
      const summary = merchantOrderSummary(order);
      if (!summary.fulfillmentReady) {
        throw new Error('FULFILLMENT_NOT_READY');
      }
      const sandbox = ensureMemorySandbox(state, input.tenantId, order);
      if (!sandbox) {
        throw new Error('FULFILLMENT_NOT_READY');
      }
      if (sandbox.status === input.status) {
        return merchantOrderDetail(state, input.tenantId, order);
      }
      if (nextFulfillmentStatus(sandbox.status) !== input.status) {
        throw new Error('FULFILLMENT_STATUS_INVALID');
      }
      if (!isFulfillmentStatus(input.status)) {
        throw new Error('FULFILLMENT_STATUS_INVALID');
      }
      sandbox.status = input.status;
      sandbox.events.push({
        id: `fulfillment:${order.id}:${input.status}`,
        at: new Date().toISOString(),
        status: input.status,
        note: fulfillmentStatusDetail(input.status),
      });
      return merchantOrderDetail(state, input.tenantId, order);
    },
    async listMerchantRecovery(input) {
      requireMembership(state, input.userId, input.tenantId, ['owner', 'admin', 'support']);
      const rows = (state.merchantOrders.get(input.tenantId) ?? [])
        .filter(
          (order) =>
            order.status === 'FAILED_PROVISIONAL' ||
            order.status === 'RECONCILING' ||
            state.recoveryAttempts.some(
              (attempt) => attempt.tenantId === input.tenantId && attempt.checkoutId === order.id,
            ),
        )
        .map((order) => merchantRecoveryRecord(state, input.tenantId, order))
        .filter(
          (record) =>
            !input.status ||
            record.checkoutStatus === input.status ||
            record.sendStatus === input.status ||
            record.stopStatus === input.status,
        )
        .sort(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) ||
            right.checkoutId.localeCompare(left.checkoutId),
        );
      return pageByCursor(rows, input.limit, input.after, (row) => ({
        sortValue: row.updatedAt,
        id: row.checkoutId,
      }));
    },
    async getMerchantRecovery(input) {
      requireMembership(state, input.userId, input.tenantId, ['owner', 'admin', 'support']);
      const order = state.merchantOrders
        .get(input.tenantId)
        ?.find((candidate) => candidate.id === input.checkoutId);
      return order ? merchantRecoveryRecord(state, input.tenantId, order) : undefined;
    },
    async getMerchantRules(input) {
      requireMembership(state, input.userId, input.tenantId);
      return merchantRulesSnapshot(state, input.tenantId);
    },
    async previewMerchantRules(input) {
      requireMembership(state, input.userId, input.tenantId);
      const rules = merchantRulesSnapshot(state, input.tenantId);
      if (!rules) {
        throw new Error('SHOP_POLICY_NOT_FOUND');
      }
      return {
        version: rules.version,
        items: (state.catalog.get(input.tenantId) ?? [])
          .map((item) => merchantCatalogRecord(state, input.tenantId, item))
          .filter((item) => item.status !== 'archived')
          .map((item) => {
            if (rules.forbiddenMaterials.includes(item.material)) {
              return {
                sku: item.sku,
                outcome: 'deny' as const,
                reason: 'PRODUCT_MATERIAL_FORBIDDEN' as const,
              };
            }
            if (BigInt(item.priceMinor) > BigInt(rules.hardCapMinor)) {
              return {
                sku: item.sku,
                outcome: 'deny' as const,
                reason: 'HARD_CAP_EXCEEDED' as const,
              };
            }
            return {
              sku: item.sku,
              outcome: 'allow' as const,
              reason: 'WITHIN_POLICY' as const,
            };
          }),
      };
    },
    async updateMerchantRules(input) {
      requireMembership(state, input.userId, input.tenantId, ['owner', 'admin']);
      return runMerchantCommand(
        state,
        {
          userId: input.userId,
          operation: `rules:update:${input.tenantId}`,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
        },
        () => {
          const current = state.policies.get(input.tenantId);
          const version = state.policyVersions.get(input.tenantId);
          if (!current || !version) {
            throw new Error('SHOP_POLICY_NOT_FOUND');
          }
          if (version.version !== input.expectedVersion) {
            throw new Error('RULES_VERSION_CONFLICT');
          }
          const hardCapMinor = BigInt(input.hardCapMinor);
          const autonomousCapMinor = BigInt(input.autonomousCapMinor);
          if (
            hardCapMinor <= 0n ||
            autonomousCapMinor < 0n ||
            autonomousCapMinor > hardCapMinor ||
            input.reason.trim().length < 3 ||
            input.offers.some(
              (offer) =>
                !offer.id ||
                BigInt(offer.discountMinor) <= 0n ||
                BigInt(offer.discountMinor) > hardCapMinor ||
                offer.requiredSkuGroups.length === 0 ||
                offer.requiredSkuGroups.some((group) => group.length === 0),
            )
          ) {
            throw new Error('RULES_INVALID');
          }
          const versionBefore = version.version;
          const now = new Date().toISOString();
          state.policies.set(input.tenantId, {
            hardCapMinor,
            autonomousCapMinor,
            forbiddenMaterials: [...input.forbiddenMaterials],
            offers: input.offers.map((offer) =>
              copyOfferRule({
                id: offer.id,
                discountMinor: BigInt(offer.discountMinor),
                groups: offer.requiredSkuGroups.map((group) => [...group]),
                ...(offer.stackable !== undefined ? { stackable: offer.stackable } : {}),
                ...(offer.marginFloorMinor
                  ? { marginFloorMinor: BigInt(offer.marginFloorMinor) }
                  : {}),
                ...(offer.budgetRemainingMinor
                  ? { budgetRemainingMinor: BigInt(offer.budgetRemainingMinor) }
                  : {}),
                ...(offer.maxRedemptions !== undefined && offer.maxRedemptions !== null
                  ? { maxRedemptions: offer.maxRedemptions }
                  : {}),
                ...(offer.redemptions !== undefined && offer.redemptions !== null
                  ? { redemptions: offer.redemptions }
                  : {}),
                ...(offer.expiresAt ? { expiresAt: offer.expiresAt } : {}),
              }),
            ),
            version: version.version + 1,
          });
          version.version += 1;
          version.updatedAt = now;
          state.policyAudits.push({
            tenantId: input.tenantId,
            actorId: input.userId,
            reason: input.reason.trim(),
            versionBefore,
            versionAfter: version.version,
            createdAt: now,
          });
          return merchantRulesSnapshot(state, input.tenantId)!;
        },
      );
    },
    async getMerchantSettings(input) {
      const role = requireMembership(state, input.userId, input.tenantId);
      return merchantSettingsSnapshot(state, input.tenantId, input.testMode, role);
    },
    async updateMerchantSettings(input) {
      const role = requireMembership(state, input.userId, input.tenantId, ['owner', 'admin']);
      return runMerchantCommand(
        state,
        {
          userId: input.userId,
          operation: `settings:update:${input.tenantId}`,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
        },
        () => {
          const shop = state.shops.get(input.tenantId);
          const version = state.shopVersions.get(input.tenantId);
          if (!shop || !version) {
            throw new Error('TENANT_UNKNOWN');
          }
          if (version.version !== input.expectedVersion) {
            throw new Error('SETTINGS_VERSION_CONFLICT');
          }
          const name = input.name.trim();
          const blurb = input.blurb.trim();
          if (name.length < 2 || input.reason.trim().length < 3) {
            throw new Error('SETTINGS_INVALID');
          }
          const versionBefore = version.version;
          const now = new Date().toISOString();
          shop.name = name;
          shop.label = merchantDisplayName({ name, synthetic: shop.synthetic });
          shop.blurb = blurb;
          const profile = normalizeShopProfile({
            ...(input.gstin === undefined ? {} : { gstin: input.gstin }),
            ...(input.addressLine === undefined ? {} : { addressLine: input.addressLine }),
            ...(input.refundPolicy === undefined ? {} : { refundPolicy: input.refundPolicy }),
            previous: {
              gstin: shop.gstin ?? '',
              addressLine: shop.addressLine ?? '',
              refundPolicy: shop.refundPolicy ?? '',
            },
          });
          shop.gstin = profile.gstin;
          shop.addressLine = profile.addressLine;
          shop.refundPolicy = profile.refundPolicy;
          const cached = getMerchant(input.tenantId);
          if (cached) {
            cached.name = name;
            cached.label = shop.label;
            cached.refundPolicy = profile.refundPolicy;
          }
          version.version += 1;
          version.updatedAt = now;
          state.shopAudits.push({
            tenantId: input.tenantId,
            actorId: input.userId,
            reason: input.reason.trim(),
            versionBefore,
            versionAfter: version.version,
            createdAt: now,
          });
          return merchantSettingsSnapshot(state, input.tenantId, input.testMode, role)!;
        },
      );
    },
    async syncIdentity(identity) {
      state.identities.set(identity.userId.toLowerCase(), {
        userId: identity.userId.toLowerCase(),
        ...(identity.email === undefined ? {} : { email: identity.email.toLowerCase() }),
      });
    },
    async membershipRole(userId, tenantId) {
      return state.memberships.get(membershipKey(userId, tenantId));
    },
    async listMemberShops(userId) {
      return [...state.shops.values()]
        .flatMap((shop) => {
          const role = state.memberships.get(membershipKey(userId, shop.tenantId));
          return role && shop.status !== 'archived' ? [{ ...shop, role }] : [];
        })
        .sort((left, right) => left.slug.localeCompare(right.slug));
    },
    async platformRoles(userId) {
      return [...(state.platformRoles.get(userId.toLowerCase()) ?? [])];
    },
    async listPublicShops() {
      return searchPublicShopSources(
        [...state.shops.values()].map((shop) => publicCatalogSource(state, shop)),
        unpagedQuery(),
      ).items;
    },
    async searchPublicShops(query) {
      return searchPublicShopSources(
        [...state.shops.values()].map((shop) => publicCatalogSource(state, shop)),
        query,
      );
    },
    async searchPublicCatalog(slug, query) {
      const shop = [...state.shops.values()].find(
        (candidate) => candidate.slug === slug && candidate.status === 'published',
      );
      return searchPublicCatalogSource(shop ? publicCatalogSource(state, shop) : undefined, query);
    },
    async findShopBySlug(slug) {
      return [...state.shops.values()].find(
        (shop) => shop.slug === slug && shop.status === 'published',
      );
    },
    async findShopByTenantId(tenantId) {
      const shop = state.shops.get(tenantId);
      return shop?.status === 'published' ? shop : undefined;
    },
    async findShopByTenantIdForMember(userId, tenantId) {
      requireMembership(state, userId, tenantId);
      const shop = state.shops.get(tenantId);
      return shop?.status !== 'archived' ? shop : undefined;
    },
    async provisionShop(identity, input, command) {
      const name = input.name.trim();
      if (name.length < 2) {
        throw new Error('SHOP_NAME_REQUIRED');
      }
      state.identities.set(identity.userId.toLowerCase(), {
        userId: identity.userId.toLowerCase(),
        ...(identity.email === undefined ? {} : { email: identity.email.toLowerCase() }),
      });
      const create = (): ShopRecord => {
        const base = slugify(name);
        let slug = base;
        let suffix = 2;
        while ([...state.shops.values()].some((shop) => shop.slug === slug)) {
          slug = `${base}-${suffix}`;
          suffix += 1;
        }
        const tenantId = `${slug}-${randomUUID().slice(0, 8)}`;
        const shop: ShopRecord = {
          tenantId,
          slug,
          name,
          label: name,
          blurb: input.blurb?.trim() || 'A shop on Charter.',
          currency: 'INR',
          status: 'draft',
          synthetic: false,
          version: 1,
          publishedAt: null,
          gstin: '',
          addressLine: '',
          refundPolicy: '',
          profileVerified: false,
        };
        state.shops.set(tenantId, shop);
        state.catalog.set(tenantId, []);
        state.policies.set(tenantId, {
          hardCapMinor: 500000n,
          autonomousCapMinor: 250000n,
          forbiddenMaterials: [],
          offers: [],
          version: 1,
        });
        const now = new Date().toISOString();
        state.policyVersions.set(tenantId, { version: 1, updatedAt: now });
        state.shopVersions.set(tenantId, { version: 1, updatedAt: now });
        state.memberships.set(membershipKey(identity.userId, tenantId), 'owner');
        return shop;
      };
      return command
        ? runMerchantCommand(
            state,
            {
              userId: identity.userId,
              operation: 'shops:create',
              idempotencyKey: command.idempotencyKey,
              requestHash: command.requestHash,
            },
            create,
          )
        : create();
    },
    async listCatalog(tenantId) {
      const items = state.catalog.get(tenantId) ?? [];
      return items
        .filter((item) => item.published)
        .map((item) => ({ ...item, aliases: [...item.aliases] }));
    },
    async listCatalogForMember(userId, tenantId) {
      requireMembership(state, userId, tenantId);
      return (state.catalog.get(tenantId) ?? []).map((item) => ({
        ...item,
        aliases: [...item.aliases],
      }));
    },
    async addCatalogItem(userId, tenantId, input) {
      requireMembership(state, userId, tenantId, ['owner', 'admin', 'catalog']);
      const shop = state.shops.get(tenantId);
      if (!shop) {
        throw new Error('TENANT_UNKNOWN');
      }
      const title = input.title.trim();
      if (title.length < 2) {
        throw new Error('ITEM_TITLE_REQUIRED');
      }
      if (!Number.isFinite(input.priceRupees) || input.priceRupees <= 0) {
        throw new Error('ITEM_PRICE_REQUIRED');
      }
      const items = state.catalog.get(tenantId) ?? [];
      const baseSku = `item.${slugify(title)}`;
      let sku = baseSku;
      let suffix = 2;
      while (items.some((item) => item.sku === sku)) {
        sku = `${baseSku}-${suffix}`;
        suffix += 1;
      }
      const priceMinor = BigInt(Math.round(input.priceRupees * 100));
      const item: CatalogItem = {
        id: randomUUID(),
        productId: randomUUID(),
        sku,
        title,
        priceMinor: priceMinor.toString(),
        priceDisplay: formatInr(money(priceMinor)),
        stock: Math.max(0, Math.floor(input.stock)),
        material: input.material ?? 'other',
        published: true,
        aliases: [title.toLowerCase()],
        category: null,
        publishedAt: new Date().toISOString(),
      };
      items.push(item);
      state.catalog.set(tenantId, items);
      return { ...item, aliases: [...item.aliases] };
    },
    async setCatalogStock(userId, tenantId, sku, stock) {
      requireMembership(state, userId, tenantId, ['owner', 'admin', 'catalog']);
      const item = state.catalog.get(tenantId)?.find((entry) => entry.sku === sku);
      if (!item) {
        return undefined;
      }
      item.stock = Math.max(0, Math.floor(stock));
      return { ...item, aliases: [...item.aliases] };
    },
    async getPolicy(tenantId) {
      const policy = state.policies.get(tenantId);
      if (!policy) {
        return undefined;
      }
      return {
        ...policy,
        version: state.policyVersions.get(tenantId)?.version ?? 1,
      };
    },
    async claimResource(kind, tenantId, resourceId, userId) {
      state.resources.set(resourceKey(kind, tenantId, resourceId), userId.toLowerCase());
    },
    async canAccessResource(kind, tenantId, resourceId, userId) {
      return state.resources.get(resourceKey(kind, tenantId, resourceId)) === userId.toLowerCase();
    },
    async listBuyerOrders(input) {
      const rows: BuyerOrderSummary[] = [];
      for (const [tenantId, orders] of state.merchantOrders) {
        for (const order of orders) {
          if (
            state.resources.get(resourceKey('checkout', tenantId, order.id)) !==
            input.userId.toLowerCase()
          ) {
            continue;
          }
          rows.push({
            ...withSandboxSummaryFields(state, tenantId, order),
            shop: buyerOrderShop(state, tenantId),
          });
        }
      }
      rows.sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id),
      );
      return pageByCursor(rows, input.limit, input.after, (row) => ({
        sortValue: row.updatedAt,
        id: row.id,
      }));
    },
    async getBuyerOrder(input) {
      for (const [tenantId, orders] of state.merchantOrders) {
        const order = orders.find((candidate) => candidate.id === input.orderId);
        if (!order) {
          continue;
        }
        if (
          state.resources.get(resourceKey('checkout', tenantId, order.id)) !==
          input.userId.toLowerCase()
        ) {
          continue;
        }
        return {
          ...merchantOrderDetail(state, tenantId, order),
          shop: buyerOrderShop(state, tenantId),
        } satisfies BuyerOrderDetail;
      }
      return undefined;
    },
    async saveConversation(input) {
      return withConversationMutationLock(() => {
        const key = resourceKey('conversation', input.tenantId, input.id);
        const normalizedUserId = input.userId.toLowerCase();
        const owner = state.resources.get(key);
        const current = state.conversations.get(key);
        if (
          (owner && owner !== normalizedUserId) ||
          (!current && input.expectedRevision !== 0) ||
          (current && current.revision !== input.expectedRevision)
        ) {
          throw new Error('CONVERSATION_VERSION_CONFLICT');
        }
        const persisted = persistedConversationState(input.state);
        const revision = (current?.revision ?? 0) + 1;
        state.conversations.set(key, {
          revision,
          state: structuredClone(persisted),
        });
        state.resources.set(key, normalizedUserId);
        return revision;
      });
    },
    async loadConversation(input) {
      if (
        state.resources.get(resourceKey('conversation', input.tenantId, input.id)) !==
        input.userId.toLowerCase()
      ) {
        return undefined;
      }
      const conversation = state.conversations.get(
        resourceKey('conversation', input.tenantId, input.id),
      );
      return conversation
        ? ({
            revision: conversation.revision,
            state: structuredClone(conversation.state),
          } satisfies PersistedConversationSnapshot)
        : undefined;
    },
    async consumePendingCheckout(input) {
      return withConversationMutationLock(() => {
        const key = resourceKey('conversation', input.tenantId, input.id);
        if (state.resources.get(key) !== input.userId.toLowerCase()) {
          return undefined;
        }
        const conversation = state.conversations.get(key);
        if (!conversation) {
          return undefined;
        }
        if (!conversation.state.pendingCheckout) {
          return { revision: conversation.revision, checkout: null };
        }
        const checkout = structuredClone(conversation.state.pendingCheckout);
        conversation.state.pendingCheckout = null;
        conversation.revision += 1;
        return { revision: conversation.revision, checkout };
      });
    },
    async saveRecoveryConsent(consent) {
      state.recoveryConsents.set(`${consent.tenantId}:${consent.id}`, { ...consent });
      return { ...consent };
    },
    async bindRecoveryConsent(input) {
      const consent = state.recoveryConsents.get(`${input.tenantId}:${input.consentId}`);
      if (!consent || consent.userId.toLowerCase() !== input.userId.toLowerCase()) {
        throw new Error('CONSENT_NOT_FOUND');
      }
      state.checkoutConsents.set(`${input.tenantId}:${input.checkoutId}`, input.consentId);
    },
    async loadRecoveryConsent(input) {
      const consentId = state.checkoutConsents.get(`${input.tenantId}:${input.checkoutId}`);
      const consent = consentId
        ? state.recoveryConsents.get(`${input.tenantId}:${consentId}`)
        : undefined;
      return consent?.userId.toLowerCase() === input.userId.toLowerCase()
        ? { ...consent }
        : undefined;
    },
    async reserveRecoveryAttempt(input) {
      const { tenantId, checkoutId, purpose, channel, maxAttempts } = input;
      if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
        throw new Error('RECOVERY_MAX_ATTEMPTS_INVALID');
      }
      const consentId = state.checkoutConsents.get(`${tenantId}:${checkoutId}`);
      const consent = consentId
        ? state.recoveryConsents.get(`${tenantId}:${consentId}`)
        : undefined;
      if (!consent || consent.purpose !== purpose || consent.channel !== channel) {
        return { action: 'suppressed', reason: 'NO_CONSENT' };
      }
      const durableOrder = state.merchantOrders
        .get(tenantId)
        ?.find((order) => order.id === checkoutId);
      if (durableOrder && durableOrder.status !== 'FAILED_PROVISIONAL') {
        return { action: 'suppressed', reason: 'NOT_FAILED_PROVISIONAL' };
      }
      if (input.evidence.outcome !== 'same_order_retry_safe' || !input.evidence.reconciledAt) {
        return { action: 'suppressed', reason: 'RECONCILIATION_REQUIRED' };
      }
      if (
        durableOrder?.reconciliationReconciledAt &&
        (durableOrder.reconciliationOutcome !== 'same_order_retry_safe' ||
          durableOrder.reconciliationReconciledAt !== input.evidence.reconciledAt)
      ) {
        return { action: 'suppressed', reason: 'RECONCILIATION_REQUIRED' };
      }
      if (state.recoverySuppressions.has(`${tenantId}:${consent.email.toLowerCase()}`)) {
        return { action: 'suppressed', reason: 'SUPPRESSED' };
      }
      const consentAttempts = state.recoveryAttempts.filter(
        (attempt) => attempt.tenantId === tenantId && attempt.consentId === consent.id,
      );
      const nextAttemptNumber =
        Math.max(0, ...consentAttempts.map((attempt) => attempt.attemptNumber)) + 1;
      if (state.globalKill || state.tenantKills.has(tenantId)) {
        state.recoveryAttempts.push({
          id: randomUUID(),
          tenantId,
          checkoutId,
          consentId: consent.id,
          userId: consent.userId,
          purpose,
          channel,
          attemptNumber: nextAttemptNumber,
          status: 'suppressed',
          providerMessageId: null,
          failureCode: 'RECOVERY_CHECKOUT_KILLED',
          completedAt: new Date().toISOString(),
        });
        return { action: 'suppressed', reason: 'CHECKOUT_KILLED' };
      }
      const active = state.recoveryAttempts.find(
        (attempt) =>
          attempt.tenantId === tenantId &&
          attempt.checkoutId === checkoutId &&
          attempt.consentId === consent.id &&
          attempt.purpose === purpose &&
          attempt.channel === channel &&
          (attempt.status === 'pending' ||
            attempt.status === 'sent' ||
            attempt.status === 'delivered'),
      );
      if (active) {
        return {
          action: 'suppressed',
          reason: active.status === 'pending' ? 'ALREADY_PENDING' : 'ALREADY_SENT',
        };
      }
      const priorAttempts = consentAttempts.filter(
        (attempt) =>
          attempt.checkoutId === checkoutId &&
          attempt.purpose === purpose &&
          attempt.channel === channel &&
          attempt.status !== 'suppressed',
      );
      if (priorAttempts.length >= maxAttempts) {
        return { action: 'suppressed', reason: 'RETRY_LIMIT_REACHED' };
      }
      const attemptId = randomUUID();
      state.recoveryAttempts.push({
        id: attemptId,
        tenantId,
        checkoutId,
        consentId: consent.id,
        userId: consent.userId,
        purpose,
        channel,
        attemptNumber: nextAttemptNumber,
        status: 'pending',
        providerMessageId: null,
        failureCode: null,
        completedAt: null,
        reconciliationOutcome: input.evidence.outcome,
        reconciledAt: input.evidence.reconciledAt,
        ...(durableOrder?.reconciliationCorrelationId
          ? { reconciliationCorrelationId: durableOrder.reconciliationCorrelationId }
          : {}),
      });
      return { action: 'reserved', attemptId, consent: { ...consent } };
    },
    async markRecoveryAttemptSent(input) {
      const attempt = state.recoveryAttempts.find(
        (candidate) =>
          candidate.id === input.attemptId &&
          candidate.tenantId === input.tenantId &&
          candidate.status === 'pending',
      );
      if (!attempt) {
        throw new Error('RECOVERY_ATTEMPT_NOT_PENDING');
      }
      attempt.status = 'sent';
      attempt.providerMessageId = input.providerMessageId;
      attempt.failureCode = null;
      attempt.completedAt = new Date().toISOString();
    },
    async markRecoveryAttemptFailed(input) {
      const attempt = state.recoveryAttempts.find(
        (candidate) =>
          candidate.id === input.attemptId &&
          candidate.tenantId === input.tenantId &&
          candidate.status === 'pending',
      );
      if (!attempt) {
        throw new Error('RECOVERY_ATTEMPT_NOT_PENDING');
      }
      attempt.status = 'failed';
      attempt.providerMessageId = null;
      attempt.failureCode = input.failureCode;
      attempt.completedAt = new Date().toISOString();
    },
    async setKillSwitch(input) {
      if (input.scope === 'global') {
        state.globalKill = input.on;
      } else {
        if (!input.tenantId) {
          throw new Error('TENANT_ID_REQUIRED');
        }
        if (input.on) {
          state.tenantKills.add(input.tenantId);
        } else {
          state.tenantKills.delete(input.tenantId);
        }
      }
      return this.killSnapshot(input.changedBy);
    },
    async killSnapshot(_userId): Promise<KillSnapshot> {
      return {
        global: state.globalKill,
        tenants: Object.fromEntries([...state.tenantKills].map((tenantId) => [tenantId, true])),
      };
    },
    async isCheckoutKilled(tenantId) {
      return state.globalKill || state.tenantKills.has(tenantId);
    },
    async recordDiscovery(input) {
      if (input.hits.length === 0) {
        return;
      }
      const now = new Date().toISOString();
      const requestId = input.requestId.slice(0, 80);
      const query = input.query.slice(0, 400);
      for (const tenantId of new Set(input.hits.map((hit) => hit.tenantId))) {
        state.searchEvents.push({
          tenantId,
          requestId,
          query,
          surface: input.surface,
          agentSource: input.agentSource,
          createdAt: now,
        });
      }
      for (const hit of input.hits) {
        state.impressions.push({
          tenantId: hit.tenantId,
          requestId,
          shopSlug: hit.shopSlug,
          sku: hit.sku ?? null,
          rank: hit.rank,
          surface: input.surface,
          agentSource: input.agentSource,
          query,
          createdAt: now,
        });
      }
    },
  };
}
