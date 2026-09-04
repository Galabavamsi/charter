export type PublicStructuredDataItem = {
  id: string;
  sku: string;
  title: string;
  priceMinor: string;
  availableStock: number;
  category: string | null;
  material: string;
};

export function minorToDecimal(minor: string): string {
  if (!/^[0-9]+$/.test(minor)) {
    throw new Error('MINOR_UNITS_INVALID');
  }
  const value = BigInt(minor);
  return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
}

export function publicShopCanonical(origin: string, slug: string): string {
  const parsed = new URL(origin);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('PUBLIC_ORIGIN_INVALID');
  }
  return `${parsed.origin}/shops/${encodeURIComponent(slug)}`;
}

export function buildStoreStructuredData(input: {
  canonical: string;
  shop: {
    name: string;
    description: string;
    currency: string;
  };
  items: readonly PublicStructuredDataItem[];
}) {
  return {
    '@context': 'https://schema.org' as const,
    '@type': 'Store' as const,
    '@id': `${input.canonical}#store`,
    name: input.shop.name,
    description: input.shop.description,
    url: input.canonical,
    currenciesAccepted: input.shop.currency,
    hasOfferCatalog: {
      '@type': 'OfferCatalog' as const,
      name: `${input.shop.name} catalog`,
      itemListElement: input.items.map((item, index) => ({
        '@type': 'ListItem' as const,
        position: index + 1,
        item: {
          '@type': 'Product' as const,
          '@id': `${input.canonical}#product-${encodeURIComponent(item.id)}`,
          name: item.title,
          sku: item.sku,
          ...(item.category ? { category: item.category } : {}),
          material: item.material,
          offers: {
            '@type': 'Offer' as const,
            priceCurrency: input.shop.currency,
            price: minorToDecimal(item.priceMinor),
            availability:
              item.availableStock > 0
                ? ('https://schema.org/InStock' as const)
                : ('https://schema.org/OutOfStock' as const),
            inventoryLevel: {
              '@type': 'QuantitativeValue' as const,
              value: item.availableStock,
            },
            url: input.canonical,
          },
        },
      })),
    },
  };
}
