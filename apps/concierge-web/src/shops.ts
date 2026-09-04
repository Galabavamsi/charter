import { isLexicalSmallTalk, lexicalPhrase } from '@charter/domain-shared';
import { apiFetch } from './api';

export { API } from './api';

export type PublicCategory = {
  slug: string;
  title: string;
};

export type PublicCategoryFacet = PublicCategory & {
  count: number;
};

export type PublicShop = {
  tenantId: string;
  slug: string;
  name: string;
  blurb: string;
  currency: 'INR';
  synthetic: boolean;
  publishedAt: string;
  href: string;
  catalogPath: string;
  itemCount: number;
  inStockCount: number;
  unitsInStock: number;
  categories: PublicCategory[];
  startingPriceMinor: string | null;
  startingPriceDisplay: string | null;
  rating: number;
  reviewCount: number;
  matchedOn: string[];
  refundPolicy?: string;
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
  material: 'steel' | 'glass' | 'paper' | 'other';
  publishedAt: string;
  provenance: 'merchant';
};

export type PublicFacets = {
  categories: PublicCategoryFacet[];
  inStockCount: number;
  minPriceMinor: string | null;
  maxPriceMinor: string | null;
};

export type PublicDirectoryResponse = {
  items: PublicShop[];
  total: number;
  nextCursor: string | null;
  facets: PublicFacets;
};

export type PublicShopResponse = {
  shop: PublicShop;
  merchant: {
    tenantId: string;
    slug: string;
    name: string;
    blurb: string;
    currency: 'INR';
  };
  items: PublicCatalogItem[];
  total: number;
  nextCursor: string | null;
  facets: PublicFacets;
};

export type ShopFilterParams = {
  q: string;
  category: string;
  inStock: boolean;
  min: string;
  max: string;
  sort: 'relevance' | 'newest' | 'name';
};

export function shopFilters(search: URLSearchParams): ShopFilterParams {
  const sort = search.get('sort');
  return {
    q: search.get('q') ?? '',
    category: search.get('category') ?? '',
    inStock: search.get('inStock') === '1',
    min: search.get('min') ?? '',
    max: search.get('max') ?? '',
    sort: sort === 'newest' || sort === 'name' ? sort : 'relevance',
  };
}

export function inrToMinor(value: string): string | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  const match = /^([0-9]{1,11})(?:\.([0-9]{1,2}))?$/.exec(normalized);
  if (!match?.[1]) {
    throw new Error('PRICE_INVALID');
  }
  const fraction = (match[2] ?? '').padEnd(2, '0');
  return (BigInt(match[1]) * 100n + BigInt(fraction || '0')).toString();
}

export function publicCatalogSearch(filters: ShopFilterParams, cursor?: string): URLSearchParams {
  const query = new URLSearchParams();
  const q = filters.q.trim().replace(/\s+/g, ' ');
  if (q) {
    query.set('q', q);
  }
  if (filters.category) {
    query.set('category', filters.category);
  }
  if (filters.inStock) {
    query.set('inStock', 'true');
  }
  const min = inrToMinor(filters.min);
  const max = inrToMinor(filters.max);
  if (min !== null) {
    query.set('minPriceMinor', min);
  }
  if (max !== null) {
    query.set('maxPriceMinor', max);
  }
  if (filters.sort !== 'relevance') {
    query.set('sort', filters.sort);
  }
  if (cursor) {
    query.set('cursor', cursor);
  }
  return query;
}

export function filterUrlSearch(filters: ShopFilterParams): URLSearchParams {
  const query = new URLSearchParams();
  const q = filters.q.trim().replace(/\s+/g, ' ');
  if (q) {
    query.set('q', q);
  }
  if (filters.category) {
    query.set('category', filters.category);
  }
  if (filters.inStock) {
    query.set('inStock', '1');
  }
  if (filters.min.trim()) {
    query.set('min', filters.min.trim());
  }
  if (filters.max.trim()) {
    query.set('max', filters.max.trim());
  }
  if (filters.sort !== 'relevance') {
    query.set('sort', filters.sort);
  }
  return query;
}

export function buyerIntentPath(slug: string, intent: 'ask' | 'buy', sku: string): string {
  const query = new URLSearchParams({ intent, product: sku });
  return `/buyer/${encodeURIComponent(slug)}?${query.toString()}`;
}

export function shopUrl(href: string): string {
  return `${window.location.origin}${href}`;
}

export function whatsappShare(name: string, href: string): string {
  const text = `Buy from ${name} on Charter. Ask, see the amount, pay.\n${shopUrl(href)}`;
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

export async function fetchShops(): Promise<PublicShop[]> {
  const body = await apiFetch<PublicDirectoryResponse>('/v1/shops');
  return (body.items ?? []).map((shop) => ({ ...shop, href: `/shops/${shop.slug}` }));
}

export async function fetchShop(slug: string): Promise<PublicShopResponse | null> {
  try {
    return await apiFetch<PublicShopResponse>(`/v1/shops/${encodeURIComponent(slug)}`);
  } catch {
    return null;
  }
}

export function conciergeShopQuery(text: string): { q: string } {
  return { q: lexicalPhrase(text) };
}

export function directoryShopSearchPath(text: string, limit = 8): string {
  const parsed = conciergeShopQuery(text);
  const query = new URLSearchParams({ sort: 'rating', limit: String(limit) });
  if (parsed.q) {
    query.set('q', parsed.q);
  }
  return `/v1/shops?${query.toString()}`;
}

export const CONCIERGE_STARTERS = [
  { label: 'A gift for someone', text: 'I want a gift for my girlfriend' },
  { label: 'Coffee gear', text: 'Coffee gear for travel' },
  { label: 'A notebook', text: 'A nice notebook' },
  { label: 'A tee', text: 'I want to buy a tshirt' },
] as const;

export function conciergeDiscoverReply(query: string, shops: PublicShop[]): string {
  if (isLexicalSmallTalk(query)) {
    return 'What are you looking for? A gift, coffee kit, notebook, tee, or spices — I’ll find the shop.';
  }
  if (shops.length === 0) {
    return 'I couldn’t find a shop for that. Try a product — a gift, a tee, coffee gear, a notebook, or spices.';
  }
  if (shops.length === 1) {
    const shop = shops[0]!;
    const category = shop.categories?.[0]?.title;
    return category
      ? `${shop.name} looks right for ${category.toLowerCase()}. Open it to keep shopping here.`
      : `${shop.name} carries that. Open it to keep shopping in this chat.`;
  }
  const names = shops.slice(0, 3).map((shop) => shop.name);
  if (names.length === 2) {
    return `A few shops fit — ${names[0]} and ${names[1]}. Pick one to continue.`;
  }
  return `Here are shops that match. ${names[0]} is a strong start — pick one to keep going.`;
}

export { isLexicalSmallTalk };
