import type { Material } from '@charter/catalog';
import type { FulfillmentStatus, ShippingAddress } from '@charter/commerce';

export type MerchantCatalogStatus = 'draft' | 'published' | 'archived';

export type MerchantCursorPosition = {
  sortValue: string;
  id: string;
};

export type MerchantPage<T> = {
  items: T[];
  cursor: MerchantCursorPosition | null;
};

export type MerchantCatalogRecord = {
  productId: string;
  productVersion: number;
  title: string;
  description: string;
  status: MerchantCatalogStatus;
  category: { id: string; slug: string; title: string } | null;
  variantId: string;
  variantVersion: number;
  sku: string;
  material: Material;
  priceMinor: string;
  priceDisplay: string;
  inventory: {
    onHand: number;
    reserved: number;
    available: number;
    version: number;
  };
  updatedAt: string;
};

export type MerchantOverviewSnapshot = {
  range: { from: string; to: string };
  capturedGmvMinor: string;
  capturedGmvDisplay: string;
  capturedOrders: number;
  validFrozenQuotes: number;
  conversion: { numerator: number; denominator: number; rate: number | null };
  failedUnresolvedPays: number;
  recoveredAmountMinor: string;
  recoveredAmountDisplay: string;
  inventoryUnits: number;
  lowStockVariants: number;
  synthetic: boolean;
  attributionNote: string;
  searches: number;
  recommendationsBySku: Array<{ sku: string; title: string; count: number }>;
  recommendationsBySource: Array<{ source: string; count: number }>;
};

export type MerchantOrderSummary = {
  id: string;
  receipt: string;
  razorpayOrderId: string;
  status: string;
  paymentState: string;
  totalMinor: string;
  totalDisplay: string;
  createdAt: string;
  updatedAt: string;
  paid: boolean;
  fulfillmentReady: boolean;
  paymentTruth: string;
  trackingId?: string;
  fulfillmentStatus?: FulfillmentStatus;
};

export type MerchantTimelineRecord = {
  id: string;
  at: string;
  status: string;
  label: string;
  detail: string;
};

export type BuyerOrderShop = {
  tenantId: string;
  slug: string;
  name: string;
  synthetic: boolean;
};

export type BuyerOrderSummary = MerchantOrderSummary & {
  shop: BuyerOrderShop;
};

export type BuyerOrderDetail = MerchantOrderDetail & {
  shop: BuyerOrderShop;
};

export type MerchantOrderDetail = MerchantOrderSummary & {
  quote: {
    id: string;
    status: string;
    subtotalMinor: string;
    discountMinor: string;
    totalMinor: string;
    deliveryBy?: string;
    lines: Array<{
      sku: string;
      title: string;
      quantity: number;
      unitMinor: string;
      lineMinor: string;
    }>;
  };
  provider: {
    razorpayOrderId: string;
    paymentId: string | null;
    status: string | null;
  };
  shippingAddress?: ShippingAddress;
  nextFulfillmentStatus?: FulfillmentStatus | null;
  timeline: MerchantTimelineRecord[];
};

export type MerchantRecoveryRecord = {
  checkoutId: string;
  quoteId: string;
  razorpayOrderId: string;
  amountMinor: string;
  amountDisplay: string;
  checkoutStatus: string;
  reconciliationStatus: 'clear' | 'unresolved' | 'reconciling' | 'captured';
  consentStatus: 'granted' | 'missing' | 'revoked';
  sendStatus: 'not_sent' | 'pending' | 'sent' | 'delivered' | 'failed' | 'suppressed';
  stopStatus: 'clear' | 'captured' | 'killed' | 'suppressed';
  canSend: boolean;
  blockedReason: string | null;
  updatedAt: string;
};

export type MerchantOffer = {
  id: string;
  discountMinor: string;
  discountDisplay: string;
  requiredSkuGroups: string[][];
  stackable?: boolean;
  marginFloorMinor?: string | null;
  budgetRemainingMinor?: string | null;
  maxRedemptions?: number | null;
  redemptions?: number | null;
  expiresAt?: string | null;
};

export type MerchantRulesSnapshot = {
  version: number;
  hardCapMinor: string;
  hardCapDisplay: string;
  autonomousCapMinor: string;
  autonomousCapDisplay: string;
  forbiddenMaterials: string[];
  offers: MerchantOffer[];
  updatedAt: string;
};

export type MerchantRulesPreview = {
  version: number;
  items: Array<{
    sku: string;
    outcome: 'allow' | 'deny';
    reason: 'WITHIN_POLICY' | 'PRODUCT_MATERIAL_FORBIDDEN' | 'HARD_CAP_EXCEEDED';
  }>;
};

export type MerchantSettingsSnapshot = {
  version: number;
  name: string;
  blurb: string;
  slug: string;
  publicPath: string;
  synthetic: boolean;
  testMode: boolean;
  paymentAccountDisclosure: string;
  gstin: string;
  addressLine: string;
  refundPolicy: string;
  profileVerified: boolean;
  members: Array<{
    userId: string;
    role: string;
    status: string;
    label: string;
  }>;
};

export type MerchantCommand = {
  idempotencyKey: string;
  requestHash: string;
};

export interface MerchantRepository {
  getMerchantOverview(input: {
    userId: string;
    tenantId: string;
    from: string;
    to: string;
  }): Promise<MerchantOverviewSnapshot>;
  listMerchantCatalog(input: {
    userId: string;
    tenantId: string;
    limit: number;
    after: MerchantCursorPosition | null;
  }): Promise<MerchantPage<MerchantCatalogRecord>>;
  createMerchantProduct(
    input: {
      userId: string;
      tenantId: string;
      title: string;
      description: string;
      category: string;
      sku: string;
      material: Material;
      priceMinor: string;
      stock: number;
      status: MerchantCatalogStatus;
    } & MerchantCommand,
  ): Promise<MerchantCatalogRecord>;
  updateMerchantProduct(
    input: {
      userId: string;
      tenantId: string;
      productId: string;
      expectedVersion: number;
      title: string;
      description: string;
      category: string;
      sku: string;
      material: Material;
      priceMinor: string;
      status: MerchantCatalogStatus;
      reason: string;
    } & MerchantCommand,
  ): Promise<MerchantCatalogRecord>;
  adjustMerchantStock(
    input: {
      userId: string;
      tenantId: string;
      variantId: string;
      expectedVersion: number;
      delta: number;
      reason: string;
    } & MerchantCommand,
  ): Promise<MerchantCatalogRecord['inventory']>;
  listMerchantOrders(input: {
    userId: string;
    tenantId: string;
    query: string;
    status: string;
    from: string | null;
    to: string | null;
    limit: number;
    after: MerchantCursorPosition | null;
  }): Promise<MerchantPage<MerchantOrderSummary>>;
  getMerchantOrder(input: {
    userId: string;
    tenantId: string;
    orderId: string;
  }): Promise<MerchantOrderDetail | undefined>;
  advanceMerchantFulfillment(input: {
    userId: string;
    tenantId: string;
    orderId: string;
    status: FulfillmentStatus;
  }): Promise<MerchantOrderDetail>;
  listMerchantRecovery(input: {
    userId: string;
    tenantId: string;
    status: string;
    limit: number;
    after: MerchantCursorPosition | null;
  }): Promise<MerchantPage<MerchantRecoveryRecord>>;
  getMerchantRecovery(input: {
    userId: string;
    tenantId: string;
    checkoutId: string;
  }): Promise<MerchantRecoveryRecord | undefined>;
  getMerchantRules(input: {
    userId: string;
    tenantId: string;
  }): Promise<MerchantRulesSnapshot | undefined>;
  previewMerchantRules(input: { userId: string; tenantId: string }): Promise<MerchantRulesPreview>;
  updateMerchantRules(
    input: {
      userId: string;
      tenantId: string;
      expectedVersion: number;
      hardCapMinor: string;
      autonomousCapMinor: string;
      forbiddenMaterials: string[];
      offers: Array<{
        id: string;
        discountMinor: string;
        requiredSkuGroups: string[][];
        stackable?: boolean;
        marginFloorMinor?: string | null;
        budgetRemainingMinor?: string | null;
        maxRedemptions?: number | null;
        redemptions?: number | null;
        expiresAt?: string | null;
      }>;
      reason: string;
    } & MerchantCommand,
  ): Promise<MerchantRulesSnapshot>;
  getMerchantSettings(input: {
    userId: string;
    tenantId: string;
    testMode: boolean;
  }): Promise<MerchantSettingsSnapshot | undefined>;
  updateMerchantSettings(
    input: {
      userId: string;
      tenantId: string;
      expectedVersion: number;
      name: string;
      blurb: string;
      gstin?: string;
      addressLine?: string;
      refundPolicy?: string;
      reason: string;
      testMode: boolean;
    } & MerchantCommand,
  ): Promise<MerchantSettingsSnapshot>;
}
