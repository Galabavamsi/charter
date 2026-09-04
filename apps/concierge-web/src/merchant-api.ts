import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from './account';
import { ApiError } from './api';

export type MerchantResourceState<T> = {
  data: T | null;
  loading: boolean;
  error: Error | null;
  reload(): Promise<void>;
};

export function useMerchantResource<T>(path: string | null): MerchantResourceState<T> {
  const api = useApi();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [error, setError] = useState<Error | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const currentGeneration = ++generation.current;
    if (!path) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const next = await api<T>(path, {});
      if (generation.current === currentGeneration) {
        setData(next);
      }
    } catch (cause) {
      if (generation.current === currentGeneration) {
        setError(cause instanceof Error ? cause : new Error('MERCHANT_REQUEST_FAILED'));
      }
    } finally {
      if (generation.current === currentGeneration) {
        setLoading(false);
      }
    }
  }, [api, path]);

  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);

  return { data, loading, error, reload: load };
}

export type MerchantPagedState<T> = {
  items: T[];
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: Error | null;
  loadMoreError: Error | null;
  reload(): Promise<void>;
  loadMore(): Promise<void>;
};

type MerchantCursorPage<T> = {
  items: T[];
  nextCursor: string | null;
};

function withCursor(path: string, cursor: string | null): string {
  if (!cursor) {
    return path;
  }
  const join = path.includes('?') ? '&' : '?';
  return `${path}${join}cursor=${encodeURIComponent(cursor)}`;
}

function mergeUnique<T>(current: T[], incoming: T[], identity: (item: T) => string): T[] {
  const seen = new Set(current.map(identity));
  const next = [...current];
  for (const item of incoming) {
    const id = identity(item);
    if (!seen.has(id)) {
      seen.add(id);
      next.push(item);
    }
  }
  return next;
}

export function useMerchantPagedResource<T>(
  path: string,
  identity: (item: T) => string,
): MerchantPagedState<T> {
  const api = useApi();
  const [items, setItems] = useState<T[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<Error | null>(null);
  const generation = useRef(0);
  const cursorRef = useRef<string | null>(null);
  const identityRef = useRef(identity);
  identityRef.current = identity;

  const load = useCallback(async () => {
    const currentGeneration = ++generation.current;
    setLoading(true);
    setError(null);
    setLoadMoreError(null);
    setItems([]);
    setNextCursor(null);
    cursorRef.current = null;
    try {
      const page = await api<MerchantCursorPage<T>>(path, {});
      if (generation.current === currentGeneration) {
        setItems(page.items);
        setNextCursor(page.nextCursor);
        cursorRef.current = page.nextCursor;
      }
    } catch (cause) {
      if (generation.current === currentGeneration) {
        setError(cause instanceof Error ? cause : new Error('MERCHANT_REQUEST_FAILED'));
      }
    } finally {
      if (generation.current === currentGeneration) {
        setLoading(false);
      }
    }
  }, [api, path]);

  const loadMore = useCallback(async () => {
    const cursor = cursorRef.current;
    if (!cursor || loadingMore) {
      return;
    }
    const currentGeneration = generation.current;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const page = await api<MerchantCursorPage<T>>(withCursor(path, cursor), {});
      if (generation.current === currentGeneration && cursorRef.current === cursor) {
        setItems((current) => mergeUnique(current, page.items, identityRef.current));
        setNextCursor(page.nextCursor);
        cursorRef.current = page.nextCursor;
      }
    } catch (cause) {
      if (generation.current === currentGeneration) {
        setLoadMoreError(cause instanceof Error ? cause : new Error('MERCHANT_REQUEST_FAILED'));
      }
    } finally {
      if (generation.current === currentGeneration) {
        setLoadingMore(false);
      }
    }
  }, [api, loadingMore, path]);

  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);

  return {
    items,
    nextCursor,
    loading,
    loadingMore,
    error,
    loadMoreError,
    reload: load,
    loadMore,
  };
}

export function merchantCommandKey(scope: string): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${scope}:${random}`;
}

const SAFE_ERROR_COPY: Record<string, string> = {
  CATALOG_VERSION_CONFLICT: 'This product changed in another session. Reload and try again.',
  INVENTORY_VERSION_CONFLICT: 'Stock changed in another session. Your edit was rolled back.',
  RULES_VERSION_CONFLICT: 'Rules changed in another session. Reload before publishing.',
  SETTINGS_VERSION_CONFLICT: 'Shop settings changed in another session. Reload before saving.',
  CATALOG_PUBLISH_INVALID:
    'Published products need a title, description, category, SKU, positive price, and available stock.',
  INVENTORY_INSUFFICIENT: 'This adjustment would reduce stock below reserved inventory.',
  RECOVERY_SEND_FAILED: 'The recovery email was not sent. Try again after checking status.',
  FULFILLMENT_NOT_READY: 'Fulfillment stays blocked until payment is captured.',
  FULFILLMENT_STATUS_INVALID: 'Sandbox fulfillment can only move one step at a time.',
  ORDER_NOT_FOUND: 'That order was not found for this shop.',
  DATE_RANGE_INVALID:
    'Use a real calendar date range of at most 366 days. Reversed ranges are not accepted.',
  CURSOR_INVALID: 'This list page is no longer valid. Reload the first page and try again.',
};

export function merchantErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return SAFE_ERROR_COPY[error.code] ?? `Request failed: ${error.code}`;
  }
  if (error instanceof Error) {
    return SAFE_ERROR_COPY[error.message] ?? error.message;
  }
  return 'The merchant request failed.';
}

export type MerchantCatalogItem = {
  productId: string;
  productVersion: number;
  title: string;
  description: string;
  status: 'draft' | 'published' | 'archived';
  category: { id: string; slug: string; title: string } | null;
  variantId: string;
  variantVersion: number;
  sku: string;
  material: 'steel' | 'glass' | 'paper' | 'other';
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

export type MerchantCatalogPage = {
  items: MerchantCatalogItem[];
  nextCursor: string | null;
};

export type MerchantOverview = {
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
  fulfillmentStatus?: string;
};

export type MerchantOrderPage = {
  items: MerchantOrderSummary[];
  nextCursor: string | null;
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
      unitMinor?: string;
      lineMinor?: string;
    }>;
  };
  provider: {
    razorpayOrderId: string;
    paymentId: string | null;
    status: string | null;
  };
  shippingAddress?: {
    recipientName: string;
    street: string;
    city: string;
    state: string;
    pincode: string;
    phone: string;
    source?: string;
  };
  nextFulfillmentStatus?: 'packed' | 'dispatched' | 'delivered' | null;
  timeline: Array<{
    id: string;
    at: string;
    status: string;
    label: string;
    detail: string;
  }>;
};

export type MerchantRecoveryRecord = {
  checkoutId: string;
  quoteId: string;
  razorpayOrderId: string;
  amountMinor: string;
  amountDisplay: string;
  checkoutStatus: string;
  reconciliationStatus: string;
  consentStatus: string;
  sendStatus: string;
  stopStatus: string;
  canSend: boolean;
  blockedReason: string | null;
  updatedAt: string;
};

export type MerchantRecoveryPage = {
  items: MerchantRecoveryRecord[];
  nextCursor: string | null;
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

export type MerchantRules = {
  version: number;
  hardCapMinor: string;
  hardCapDisplay: string;
  autonomousCapMinor: string;
  autonomousCapDisplay: string;
  forbiddenMaterials: string[];
  offers: MerchantOffer[];
  updatedAt?: string;
};

export type MerchantRulesPreview = {
  version: number;
  items: Array<{
    sku: string;
    outcome: 'allow' | 'deny';
    reason: string;
  }>;
};

export type MerchantSettings = {
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
