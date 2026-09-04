import type { Material } from '@charter/catalog';
import type { RecoveryAttemptRepository, RecoveryDispatchConsent } from '@charter/recovery';
import type { VerifiedIdentity } from '../auth/verifier.js';
import type {
  BuyerOrderDetail,
  BuyerOrderSummary,
  MerchantCommand,
  MerchantCursorPosition,
  MerchantPage,
  MerchantRepository,
} from './merchant-repository.js';
import type { PublicCatalogCursorPosition, PublicCatalogQuery } from './public-catalog-query.js';

export const SHOP_ROLES = ['owner', 'admin', 'catalog', 'support', 'finance', 'viewer'] as const;
export type ShopRole = (typeof SHOP_ROLES)[number];

export const PLATFORM_ROLES = ['admin', 'operator', 'auditor'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export type ShopRecord = {
  tenantId: string;
  slug: string;
  name: string;
  label: string;
  blurb: string;
  currency: 'INR';
  status: 'draft' | 'published' | 'suspended' | 'archived';
  synthetic: boolean;
  version?: number;
  publishedAt?: string | null;
  ratingMilli?: number;
  reviewCount?: number;
  gstin?: string;
  addressLine?: string;
  refundPolicy?: string;
  profileVerified?: boolean;
};

export type PublicCategory = {
  slug: string;
  title: string;
};

export type PublicCategoryFacet = PublicCategory & {
  count: number;
};

export type PublicCatalogFacets = {
  categories: PublicCategoryFacet[];
  inStockCount: number;
  minPriceMinor: string | null;
  maxPriceMinor: string | null;
};

export type PublicShop = Omit<ShopRecord, 'label' | 'status' | 'ratingMilli' | 'reviewCount'> & {
  href: string;
  catalogPath: string;
  itemCount: number;
  inStockCount: number;
  unitsInStock: number;
  categories: PublicCategory[];
  startingPriceMinor: string | null;
  startingPriceDisplay: string | null;
  publishedAt: string;
  rating: number;
  reviewCount: number;
  matchedOn: string[];
  refundPolicy?: string;
};

export type AccountShop = ShopRecord & {
  role: ShopRole;
};

export type CatalogItem = {
  id: string;
  productId?: string;
  sku: string;
  title: string;
  priceMinor: string;
  priceDisplay: string;
  stock: number;
  material: Material;
  published: boolean;
  aliases: string[];
  category?: PublicCategory | null;
  publishedAt?: string | null;
};

export type PublicCatalogItem = {
  id: string;
  productId: string;
  sku: string;
  title: string;
  priceMinor: string;
  priceDisplay: string;
  availableStock: number;
  category: PublicCategory | null;
  material: Material;
  publishedAt: string;
  provenance: 'merchant';
};

export type PublicDirectoryResult = {
  items: PublicShop[];
  total: number;
  facets: PublicCatalogFacets;
  cursor: PublicCatalogCursorPosition | null;
};

export type PublicShopCatalogResult = {
  shop: PublicShop;
  items: PublicCatalogItem[];
  total: number;
  facets: PublicCatalogFacets;
  cursor: PublicCatalogCursorPosition | null;
};

export type ShopPolicy = {
  hardCapMinor: bigint;
  autonomousCapMinor: bigint;
  forbiddenMaterials: readonly string[];
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
  version: number;
};

export type BuyerResourceKind = 'cart' | 'quote' | 'checkout' | 'conversation' | 'order';

export type KillSnapshot = {
  global: boolean;
  tenants: Record<string, boolean>;
};

export type PersistedConversationState = {
  cartId: string | null;
  quoteId: string | null;
  catalogLoaded: boolean;
  pendingCheckout: unknown | null;
  messages: unknown[];
};

export type PersistedConversationSnapshot = {
  revision: number;
  state: PersistedConversationState;
};

export type PendingCheckoutConsumption = {
  revision: number;
  checkout: unknown | null;
};

export type RecoveryConsentRecord = RecoveryDispatchConsent;

export interface TenantRepository extends RecoveryAttemptRepository, MerchantRepository {
  syncIdentity(identity: VerifiedIdentity): Promise<void>;
  membershipRole(userId: string, tenantId: string): Promise<ShopRole | undefined>;
  listMemberShops(userId: string): Promise<AccountShop[]>;
  platformRoles(userId: string): Promise<PlatformRole[]>;
  listPublicShops(): Promise<PublicShop[]>;
  searchPublicShops(query: PublicCatalogQuery): Promise<PublicDirectoryResult>;
  searchPublicCatalog(
    slug: string,
    query: PublicCatalogQuery,
  ): Promise<PublicShopCatalogResult | undefined>;
  findShopBySlug(slug: string): Promise<ShopRecord | undefined>;
  findShopByTenantId(tenantId: string): Promise<ShopRecord | undefined>;
  findShopByTenantIdForMember(userId: string, tenantId: string): Promise<ShopRecord | undefined>;
  provisionShop(
    identity: VerifiedIdentity,
    input: { name: string; blurb?: string },
    command?: MerchantCommand,
  ): Promise<ShopRecord>;
  listCatalog(tenantId: string): Promise<CatalogItem[]>;
  listCatalogForMember(userId: string, tenantId: string): Promise<CatalogItem[]>;
  addCatalogItem(
    userId: string,
    tenantId: string,
    input: { title: string; priceRupees: number; stock: number; material?: Material },
  ): Promise<CatalogItem>;
  setCatalogStock(
    userId: string,
    tenantId: string,
    sku: string,
    stock: number,
  ): Promise<CatalogItem | undefined>;
  getPolicy(tenantId: string): Promise<ShopPolicy | undefined>;
  claimResource(
    kind: BuyerResourceKind,
    tenantId: string,
    resourceId: string,
    userId: string,
  ): Promise<void>;
  canAccessResource(
    kind: BuyerResourceKind,
    tenantId: string,
    resourceId: string,
    userId: string,
  ): Promise<boolean>;
  listBuyerOrders(input: {
    userId: string;
    limit: number;
    after: MerchantCursorPosition | null;
  }): Promise<MerchantPage<BuyerOrderSummary>>;
  getBuyerOrder(input: { userId: string; orderId: string }): Promise<BuyerOrderDetail | undefined>;
  saveConversation(input: {
    id: string;
    tenantId: string;
    userId: string;
    expectedRevision: number;
    state: PersistedConversationState;
  }): Promise<number>;
  loadConversation(input: {
    id: string;
    tenantId: string;
    userId: string;
  }): Promise<PersistedConversationSnapshot | undefined>;
  consumePendingCheckout(input: {
    id: string;
    tenantId: string;
    userId: string;
  }): Promise<PendingCheckoutConsumption | undefined>;
  saveRecoveryConsent(consent: RecoveryConsentRecord): Promise<RecoveryConsentRecord>;
  bindRecoveryConsent(input: {
    tenantId: string;
    checkoutId: string;
    consentId: string;
    userId: string;
  }): Promise<void>;
  loadRecoveryConsent(input: {
    tenantId: string;
    checkoutId: string;
    userId: string;
  }): Promise<RecoveryConsentRecord | undefined>;
  setKillSwitch(input: {
    scope: 'global' | 'tenant';
    tenantId?: string;
    on: boolean;
    changedBy: string;
  }): Promise<KillSnapshot>;
  killSnapshot(userId: string): Promise<KillSnapshot>;
  isCheckoutKilled(tenantId: string): Promise<boolean>;
  recordDiscovery(input: {
    requestId: string;
    query: string;
    surface: 'shops.search' | 'catalog.search';
    agentSource: 'concierge_web' | 'concierge_voice' | 'mcp' | 'directory_http';
    hits: Array<{ tenantId: string; shopSlug: string; sku?: string; rank: number }>;
  }): Promise<void>;
}
