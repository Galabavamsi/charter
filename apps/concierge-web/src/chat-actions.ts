import { resolveCatalogItem, type CatalogVisualItem } from './catalog-visuals';
import type { StoredCart, StoredQuote } from './threads';

export type CartPick = { sku: string; title: string; quantity: number };

export function messageShowsCart(text: string): boolean {
  return /added to your cart|cart total|subtotal|quantity updated|removed from your cart|your cart:/i.test(
    text,
  );
}

export function shouldOfferLockTotal(
  conciergeText: string,
  hasQuote: boolean,
  hasCartLines = false,
): boolean {
  if (hasQuote) {
    return false;
  }
  return hasCartLines || messageShowsCart(conciergeText);
}

export const BUY_NOW_LABEL = 'Buy now';
export const BUY_NOW_PROMPT = 'Buy now';
export const VIEW_CART_LABEL = 'View cart';
export const BROWSE_SHOP_LABEL = 'Browse shop';
export const BUY_NOW_HINT =
  'Browse the shop or open your cart. Buy now pins today’s prices, then you pay.';
export const VIEW_CART_HINT =
  'Use + and − on any card. Open your cart to review, or Buy now when the mix looks right.';

export function quantityForSku(cart: StoredCart | null | undefined, sku: string): number {
  return cart?.lines.find((line) => line.sku === sku)?.quantity ?? 0;
}

export function quantityForItem(
  cart: StoredCart | null | undefined,
  item: { sku: string; title: string },
  catalog: CatalogVisualItem[] = [],
): number {
  const resolved = resolveCatalogItem(item, catalog);
  return quantityForSku(cart, resolved.sku) || quantityForSku(cart, item.sku);
}

export function displayQuantity(
  picks: Record<string, CartPick>,
  cart: StoredCart | null | undefined,
  item: { sku: string; title: string },
  catalog: CatalogVisualItem[] = [],
): number {
  const resolved = resolveCatalogItem(item, catalog);
  return (
    picks[resolved.sku]?.quantity ??
    picks[item.sku]?.quantity ??
    quantityForItem(cart, item, catalog)
  );
}

export function picksFromCart(
  cart: StoredCart | null | undefined,
  catalog: CatalogVisualItem[] = [],
): Record<string, CartPick> {
  const next: Record<string, CartPick> = {};
  for (const line of cart?.lines ?? []) {
    const item = catalog.find((row) => row.sku === line.sku);
    next[line.sku] = {
      sku: line.sku,
      title: item?.title ?? line.sku,
      quantity: line.quantity,
    };
  }
  return next;
}

export function pickCount(picks: Record<string, CartPick>): number {
  return Object.values(picks).reduce((sum, row) => sum + Math.max(0, row.quantity), 0);
}

export function picksDifferFromCart(
  picks: Record<string, CartPick>,
  cart: StoredCart | null | undefined,
): boolean {
  const lines = new Map((cart?.lines ?? []).map((line) => [line.sku, line.quantity]));
  const skus = new Set([...Object.keys(picks), ...lines.keys()]);
  for (const sku of skus) {
    const picked = picks[sku]?.quantity ?? 0;
    const stored = lines.get(sku) ?? 0;
    if (picked !== stored) {
      return true;
    }
  }
  return false;
}

export function confirmCartPrompt(picks: Record<string, CartPick>, lock = false): string | null {
  const lines = Object.values(picks)
    .filter((row) => row.quantity > 0)
    .map((row) => `${row.title} × ${row.quantity}`);
  if (lines.length === 0) {
    return null;
  }
  return lock
    ? `Put these in my cart, exactly: ${lines.join('; ')}. Then lock this total. Buy now.`
    : `Put these in my cart, exactly: ${lines.join('; ')}. Do not lock this total.`;
}

export function buyNowPrompt(picks: Record<string, CartPick>, dirty: boolean): string | null {
  if (dirty) {
    return confirmCartPrompt(picks, true);
  }
  return BUY_NOW_PROMPT;
}

export function matchingShopItems<T extends { sku: string; title: string }>(
  items: T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return items;
  }
  return items.filter((item) => `${item.title} ${item.sku}`.toLowerCase().includes(needle));
}

export function cartShelfItems(
  catalog: CatalogVisualItem[],
  picks: Record<string, CartPick>,
): CatalogVisualItem[] {
  const fromShop = catalog.filter((item) => (picks[item.sku]?.quantity ?? 0) > 0);
  const seen = new Set(fromShop.map((item) => item.sku));
  const extras = Object.values(picks)
    .filter((pick) => pick.quantity > 0 && !seen.has(pick.sku))
    .map((pick) => ({ sku: pick.sku, title: pick.title }));
  return [...fromShop, ...extras];
}

export function cartFromQuote(quote: StoredQuote | null | undefined): StoredCart | null {
  if (!quote?.lines.length) {
    return null;
  }
  return {
    lines: quote.lines.map((line) => ({ sku: line.sku, quantity: line.quantity })),
  };
}

export function normalizeStoredCart(cart: StoredCart | null | undefined): StoredCart | null {
  if (!cart || cart.lines.length === 0) {
    return null;
  }
  return cart;
}

export function cartSnapshotFromTurn(input: {
  cart?: StoredCart | null;
  quote?: StoredQuote | null;
  traces?: Array<{ result?: unknown }>;
}): StoredCart | null {
  if (input.cart !== undefined) {
    return normalizeStoredCart(input.cart);
  }
  for (const row of [...(input.traces ?? [])].reverse()) {
    const result = row.result as { cart?: StoredCart | null } | undefined;
    if (result && 'cart' in result) {
      return normalizeStoredCart(result.cart ?? null);
    }
  }
  return cartFromQuote(input.quote);
}

export function setQuantityPrompt(title: string, quantity: number): string {
  if (quantity <= 0) {
    return `Remove ${title} from cart`;
  }
  return `Set ${title} quantity to ${quantity}`;
}
