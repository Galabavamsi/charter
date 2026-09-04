import { formatInr, lexicalOverlapScore, money } from '@charter/domain-shared';
import type {
  PublicCatalogFacets,
  PublicCatalogItem,
  PublicCategory,
  PublicDirectoryResult,
  PublicShop,
  PublicShopCatalogResult,
  ShopRecord,
} from './repository.js';
import type { PublicCatalogCursorPosition, PublicCatalogQuery } from './public-catalog-query.js';

export type PublicCatalogSourceItem = {
  id: string;
  productId: string;
  productTitle: string;
  sku: string;
  title: string;
  priceMinor: string;
  availableStock: number;
  category: PublicCategory | null;
  material: PublicCatalogItem['material'];
  aliases: readonly string[];
  publishedAt: string;
};

export type PublicCatalogSourceShop = ShopRecord & {
  publishedAt: string;
  items: PublicCatalogSourceItem[];
  summary?: {
    itemCount: number;
    inStockCount: number;
    unitsInStock: number;
    categories: PublicCategory[];
    startingPriceMinor: string | null;
  };
};

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-IN');
}

function textScore(value: string, query: string, weight: number): number {
  return lexicalOverlapScore(value, query, weight);
}

function itemSearchScore(item: PublicCatalogSourceItem, q: string): number {
  if (!q) {
    return 0;
  }
  return Math.max(
    textScore(item.productTitle, q, 28),
    textScore(item.title, q, 30),
    textScore(item.sku, q, 12),
    textScore(item.material, q, 10),
    ...(item.category
      ? [textScore(item.category.title, q, 20), textScore(item.category.slug, q, 12)]
      : [0]),
    ...item.aliases.map((alias) => textScore(alias, q, 26)),
  );
}

function shopSearchScore(shop: PublicCatalogSourceShop, q: string): number {
  if (!q) {
    return 0;
  }
  return Math.max(
    textScore(shop.name, q, 40),
    textScore(shop.blurb, q, 18),
    textScore(shop.refundPolicy ?? '', q, 14),
  );
}

function itemMatchesFilters(item: PublicCatalogSourceItem, query: PublicCatalogQuery): boolean {
  if (query.category && item.category?.slug !== query.category) {
    return false;
  }
  if (query.inStock && item.availableStock <= 0) {
    return false;
  }
  const price = BigInt(item.priceMinor);
  if (query.minPriceMinor !== null && price < BigInt(query.minPriceMinor)) {
    return false;
  }
  if (query.maxPriceMinor !== null && price > BigInt(query.maxPriceMinor)) {
    return false;
  }
  return true;
}

function categoryList(items: readonly PublicCatalogSourceItem[]): PublicCategory[] {
  const categories = new Map<string, PublicCategory>();
  for (const item of items) {
    if (item.category) {
      categories.set(item.category.slug, item.category);
    }
  }
  return [...categories.values()].sort(
    (left, right) => left.title.localeCompare(right.title) || left.slug.localeCompare(right.slug),
  );
}

function catalogFacets(
  items: readonly PublicCatalogSourceItem[],
  countByShop = false,
): PublicCatalogFacets {
  const categoryCounts = new Map<string, PublicCategory & { count: number }>();
  const seenCategories = new Set<string>();
  for (const item of items) {
    if (!item.category) {
      continue;
    }
    if (countByShop && seenCategories.has(item.category.slug)) {
      continue;
    }
    seenCategories.add(item.category.slug);
    const current = categoryCounts.get(item.category.slug);
    categoryCounts.set(item.category.slug, {
      ...item.category,
      count: (current?.count ?? 0) + 1,
    });
  }
  const prices = items.map((item) => BigInt(item.priceMinor));
  return {
    categories: [...categoryCounts.values()].sort(
      (left, right) => left.title.localeCompare(right.title) || left.slug.localeCompare(right.slug),
    ),
    inStockCount: items.filter((item) => item.availableStock > 0).length,
    minPriceMinor:
      prices.length > 0
        ? prices.reduce((minimum, price) => (price < minimum ? price : minimum)).toString()
        : null,
    maxPriceMinor:
      prices.length > 0
        ? prices.reduce((maximum, price) => (price > maximum ? price : maximum)).toString()
        : null,
  };
}

function asPublicShop(shop: PublicCatalogSourceShop, query?: PublicCatalogQuery): PublicShop {
  const prices = shop.items.map((item) => BigInt(item.priceMinor));
  const startingPrice =
    shop.summary?.startingPriceMinor !== undefined
      ? shop.summary.startingPriceMinor === null
        ? null
        : BigInt(shop.summary.startingPriceMinor)
      : prices.length > 0
        ? prices.reduce((minimum, price) => (price < minimum ? price : minimum))
        : null;
  const categories = shop.summary?.categories ?? categoryList(shop.items);
  const ratingMilli = shop.ratingMilli ?? 0;
  const reviewCount = shop.reviewCount ?? 0;
  return {
    tenantId: shop.tenantId,
    slug: shop.slug,
    name: shop.name,
    blurb: shop.blurb,
    currency: shop.currency,
    synthetic: shop.synthetic,
    publishedAt: shop.publishedAt,
    href: `/shops/${shop.slug}`,
    catalogPath: `/api/v1/merchants/${shop.tenantId}/catalog`,
    itemCount: shop.summary?.itemCount ?? shop.items.length,
    inStockCount:
      shop.summary?.inStockCount ?? shop.items.filter((item) => item.availableStock > 0).length,
    unitsInStock:
      shop.summary?.unitsInStock ?? shop.items.reduce((sum, item) => sum + item.availableStock, 0),
    categories,
    startingPriceMinor: startingPrice?.toString() ?? null,
    startingPriceDisplay: startingPrice === null ? null : formatInr(money(startingPrice)),
    rating: publicRating(ratingMilli),
    reviewCount,
    refundPolicy: shop.refundPolicy ?? '',
    matchedOn: query
      ? shopMatchReasons({ name: shop.name, blurb: shop.blurb, categories }, query)
      : [],
  };
}

export function publicRating(milli: number): number {
  return Math.round(milli) / 1000;
}

export function shopMatchReasons(
  shop: { name: string; blurb: string; categories: PublicCategory[] },
  query: PublicCatalogQuery,
): string[] {
  const reasons: string[] = [];
  if (query.category) {
    reasons.push(`category:${query.category}`);
  }
  if (!query.q) {
    return reasons;
  }
  if (textScore(shop.name, query.q, 1) > 0) {
    reasons.push('name');
  }
  if (textScore(shop.blurb, query.q, 1) > 0) {
    reasons.push('blurb');
  }
  if (
    shop.categories.some(
      (category) =>
        textScore(category.title, query.q, 1) > 0 || textScore(category.slug, query.q, 1) > 0,
    )
  ) {
    reasons.push('category');
  }
  if (!reasons.some((reason) => reason === 'name' || reason === 'blurb' || reason === 'category')) {
    reasons.push('catalog');
  }
  return reasons;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparePosition(
  left: PublicCatalogCursorPosition,
  right: PublicCatalogCursorPosition,
  query: PublicCatalogQuery,
): number {
  if (query.sort === 'name') {
    return compareText(left.name, right.name) || compareText(left.id, right.id);
  }
  if (query.sort === 'rating') {
    return (
      right.ratingMilli - left.ratingMilli ||
      right.reviewCount - left.reviewCount ||
      compareText(left.name, right.name) ||
      compareText(left.id, right.id)
    );
  }
  if (query.sort === 'relevance' && query.q && left.relevance !== right.relevance) {
    return right.relevance - left.relevance;
  }
  return (
    compareText(right.publishedAt, left.publishedAt) ||
    compareText(left.name, right.name) ||
    compareText(left.id, right.id)
  );
}

function pageMatches<T extends { position: PublicCatalogCursorPosition }>(
  matches: T[],
  query: PublicCatalogQuery,
): { rows: T[]; cursor: PublicCatalogCursorPosition | null } {
  matches.sort((left, right) => comparePosition(left.position, right.position, query));
  const after = query.after
    ? matches.filter((match) => comparePosition(match.position, query.after!, query) > 0)
    : matches;
  const page = after.slice(0, query.limit + 1);
  const hasMore = page.length > query.limit;
  const rows = page.slice(0, query.limit);
  return {
    rows,
    cursor: hasMore ? (rows.at(-1)?.position ?? null) : null,
  };
}

export function searchPublicShopSources(
  sources: readonly PublicCatalogSourceShop[],
  query: PublicCatalogQuery,
): PublicDirectoryResult {
  const requiresProduct =
    Boolean(query.category) ||
    query.inStock ||
    query.minPriceMinor !== null ||
    query.maxPriceMinor !== null;
  const matches = sources.flatMap((shop) => {
    if (shop.status !== 'published') {
      return [];
    }
    const shopScore = shopSearchScore(shop, query.q);
    const filteredItems = shop.items.filter((item) => itemMatchesFilters(item, query));
    const searchedItems = filteredItems.filter(
      (item) => !query.q || shopScore > 0 || itemSearchScore(item, query.q) > 0,
    );
    const included =
      (!requiresProduct && !query.q) ||
      (!requiresProduct && shopScore > 0) ||
      searchedItems.length > 0;
    if (!included) {
      return [];
    }
    const score = Math.max(
      shopScore,
      ...searchedItems.map((item) => itemSearchScore(item, query.q)),
    );
    return [
      {
        shop,
        score,
        position: {
          relevance: score,
          publishedAt: shop.publishedAt,
          name: normalized(shop.name),
          id: shop.tenantId,
          ratingMilli: shop.ratingMilli ?? 0,
          reviewCount: shop.reviewCount ?? 0,
        },
      },
    ];
  });
  const page = pageMatches(matches, query);

  const allMatchedItems = matches.flatMap(({ shop }) => shop.items);
  const categoryCounts = new Map<string, PublicCategory & { count: number }>();
  for (const { shop } of matches) {
    for (const category of categoryList(shop.items)) {
      const current = categoryCounts.get(category.slug);
      categoryCounts.set(category.slug, {
        ...category,
        count: (current?.count ?? 0) + 1,
      });
    }
  }
  const baseFacets = catalogFacets(allMatchedItems, true);
  const total = matches.length;
  return {
    items: page.rows.map(({ shop }) => asPublicShop(shop, query)),
    total,
    facets: {
      ...baseFacets,
      categories: [...categoryCounts.values()].sort(
        (left, right) =>
          left.title.localeCompare(right.title) || left.slug.localeCompare(right.slug),
      ),
      inStockCount: matches.filter(({ shop }) => shop.items.some((item) => item.availableStock > 0))
        .length,
    },
    cursor: page.cursor,
  };
}

function asPublicCatalogItem(item: PublicCatalogSourceItem): PublicCatalogItem {
  return {
    id: item.id,
    productId: item.productId,
    sku: item.sku,
    title: item.title,
    priceMinor: item.priceMinor,
    priceDisplay: formatInr(money(BigInt(item.priceMinor))),
    availableStock: item.availableStock,
    category: item.category,
    material: item.material,
    publishedAt: item.publishedAt,
    provenance: 'merchant',
  };
}

export function searchPublicCatalogSource(
  shop: PublicCatalogSourceShop | undefined,
  query: PublicCatalogQuery,
  candidateItemIds?: ReadonlySet<string>,
): PublicShopCatalogResult | undefined {
  if (!shop || shop.status !== 'published') {
    return undefined;
  }
  const matches = shop.items
    .filter((item) => !candidateItemIds || candidateItemIds.has(item.id))
    .filter((item) => (!query.sku || item.sku === query.sku) && itemMatchesFilters(item, query))
    .flatMap((item) => {
      const score = itemSearchScore(item, query.q);
      return !query.q || score > 0
        ? [
            {
              item,
              score,
              position: {
                relevance: score,
                publishedAt: item.publishedAt,
                name: normalized(item.title),
                id: item.id,
                ratingMilli: 0,
                reviewCount: 0,
              },
            },
          ]
        : [];
    });
  const page = pageMatches(matches, query);
  const items = matches.map(({ item }) => item);
  return {
    shop: asPublicShop(shop, query),
    items: page.rows.map(({ item }) => asPublicCatalogItem(item)),
    total: items.length,
    facets: catalogFacets(items),
    cursor: page.cursor,
  };
}
