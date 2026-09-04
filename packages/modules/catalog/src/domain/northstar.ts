export const NORTHSTAR_TENANT = 'northstar-demo-in';
export const NORTHSTAR_NAME = 'Northstar Travel Coffee';
export const NORTHSTAR_LABEL = 'Northstar Travel Coffee';

export type Material = 'steel' | 'glass' | 'paper' | 'other';

export type CatalogVariant = {
  sku: string;
  title: string;
  priceMinor: bigint;
  stock: number;
  material: Material;
  published: boolean;
  aliases?: readonly string[];
};

export const NORTHSTAR_VARIANTS: readonly CatalogVariant[] = [
  {
    sku: 'brewer.trailpress-steel-750',
    title: 'Steel travel press, 750 ml',
    priceMinor: 119900n,
    stock: 12,
    material: 'steel',
    published: true,
    aliases: ['trailpress', 'steel brewer', 'press', 'brewer'],
  },
  {
    sku: 'grinder.pocket-lite',
    title: 'Hand grinder',
    priceMinor: 99900n,
    stock: 8,
    material: 'steel',
    published: true,
    aliases: ['pocketgrind lite', 'lite', 'manual grinder'],
  },
  {
    sku: 'filters.travel-30',
    title: 'Paper filters, 30 pack',
    priceMinor: 24900n,
    stock: 30,
    material: 'paper',
    published: true,
    aliases: ['travel filters', 'filter paper'],
  },
  {
    sku: 'grinder.pocket-pro',
    title: 'Pro hand grinder',
    priceMinor: 149900n,
    stock: 4,
    material: 'steel',
    published: true,
    aliases: ['pocketgrind pro', 'pro grinder'],
  },
  {
    sku: 'brewer.clear-glass-500',
    title: 'Glass pour-over, 500 ml',
    priceMinor: 89900n,
    stock: 10,
    material: 'glass',
    published: true,
    aliases: ['cleargo glass brewer', 'glass brewer', 'pour over'],
  },
  {
    sku: 'kettle.road-mini',
    title: 'Mini travel kettle',
    priceMinor: 129900n,
    stock: 0,
    material: 'other',
    published: true,
    aliases: ['road mini kettle', 'kettle'],
  },
  {
    sku: 'mug.steel-travel',
    title: 'Steel travel mug',
    priceMinor: 79900n,
    stock: 16,
    material: 'steel',
    published: true,
    aliases: ['mug', 'flask', 'cup', 'travel mug'],
  },
  {
    sku: 'beans.house-250',
    title: 'House beans, 250 g',
    priceMinor: 44900n,
    stock: 22,
    material: 'other',
    published: true,
    aliases: ['coffee', 'beans', 'grounds'],
  },
];

export function getVariant(sku: string): CatalogVariant | undefined {
  return NORTHSTAR_VARIANTS.find((row) => row.sku === sku);
}

export const FILTERS_OFFER_DISCOUNT_MINOR = 10000n;
export const CANONICAL_QUOTE_MINOR = 234700n;
export const PRO_MUTATION_TOTAL_MINOR = 284700n;
