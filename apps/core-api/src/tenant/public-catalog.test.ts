import { describe, expect, it } from 'vitest';
import { searchPublicShopSources, type PublicCatalogSourceShop } from './public-catalog.js';
import type { PublicCatalogQuery } from './public-catalog-query.js';

function query(q: string): PublicCatalogQuery {
  return {
    q,
    sku: '',
    category: '',
    inStock: false,
    minPriceMinor: null,
    maxPriceMinor: null,
    sort: 'rating',
    limit: 8,
    fingerprint: '',
    after: null,
  };
}

function shop(input: {
  tenantId: string;
  slug: string;
  name: string;
  blurb: string;
  ratingMilli: number;
  items: PublicCatalogSourceShop['items'];
}): PublicCatalogSourceShop {
  return {
    tenantId: input.tenantId,
    slug: input.slug,
    name: input.name,
    label: input.name,
    blurb: input.blurb,
    currency: 'INR',
    status: 'published',
    synthetic: true,
    publishedAt: '2026-01-01T00:00:00.000Z',
    ratingMilli: input.ratingMilli,
    reviewCount: 12,
    items: input.items,
  };
}

function item(
  id: string,
  title: string,
  category: { slug: string; title: string } | null,
  extras: Partial<PublicCatalogSourceShop['items'][number]> = {},
): PublicCatalogSourceShop['items'][number] {
  return {
    id,
    productId: `product-${id}`,
    productTitle: title,
    sku: `sku.${id}`,
    title,
    priceMinor: '99900',
    availableStock: 4,
    category,
    material: extras.material ?? 'other',
    aliases: extras.aliases ?? [],
    publishedAt: '2026-01-01T00:00:00.000Z',
    ...extras,
  };
}

describe('public shop directory lexical overlap', () => {
  it('matches catalog text even when leftover intent tokens are absent from any one field', () => {
    const ridge = shop({
      tenantId: 'ridge-outfitters-in',
      slug: 'ridge-outfitters',
      name: 'Ridge Outfitters',
      blurb: 'Trail cookware and brew gear.',
      ratingMilli: 4100,
      items: [item('pour-over', 'Pour-over coffee', { slug: 'camp-kit', title: 'Camp kit' })],
    });
    const notebooks = shop({
      tenantId: 'paper-desk-in',
      slug: 'paper-desk',
      name: 'Paper Desk',
      blurb: 'Stationery, notebooks and pens.',
      ratingMilli: 4700,
      items: [
        item('notebook', 'Ruled notebook', { slug: 'desk-essentials', title: 'Desk essentials' }),
      ],
    });
    notebooks.refundPolicy = 'Unopened stationery within 7 days of capture.';

    const ranked = searchPublicShopSources(
      [ridge, notebooks],
      query('find me a shop to gift coffee'),
    );

    expect(ranked.items.map((entry) => entry.slug)).toEqual(['ridge-outfitters']);
    expect(ranked.items[0]?.categories.some((category) => category.slug === 'camp-kit')).toBe(true);
  });

  it('still matches after the category slug is renamed, because product text is the corpus', () => {
    const renamed = shop({
      tenantId: 'ridge-outfitters-in',
      slug: 'ridge-outfitters',
      name: 'Ridge Outfitters',
      blurb: 'Trail cookware.',
      ratingMilli: 4100,
      items: [item('pour-over', 'Pour-over coffee', { slug: 'field-brew', title: 'Field brew' })],
    });

    const ranked = searchPublicShopSources([renamed], query('gift coffee'));

    expect(ranked.items.map((entry) => entry.slug)).toEqual(['ridge-outfitters']);
  });

  it('matches material and alias fields on published items', () => {
    const steel = shop({
      tenantId: 'steel-works-in',
      slug: 'steel-works',
      name: 'Peak Hardware',
      blurb: 'Camp tools.',
      ratingMilli: 4000,
      items: [
        item(
          'press',
          'Trail press',
          { slug: 'camp-kit', title: 'Camp kit' },
          {
            material: 'steel',
            aliases: ['pocketgrind'],
          },
        ),
      ],
    });

    expect(
      searchPublicShopSources([steel], query('steel')).items.map((entry) => entry.slug),
    ).toEqual(['steel-works']);
    expect(
      searchPublicShopSources([steel], query('POCKETGRIND')).items.map((entry) => entry.slug),
    ).toEqual(['steel-works']);
  });

  it('matches a misspelled stationery ask to desk copy instead of a shop miss', () => {
    const ridge = shop({
      tenantId: 'ridge-outfitters-in',
      slug: 'ridge-outfitters',
      name: 'Ridge Outfitters',
      blurb: 'Trail cookware and brew gear.',
      ratingMilli: 4100,
      items: [item('pour-over', 'Pour-over coffee', { slug: 'camp-kit', title: 'Camp kit' })],
    });
    const notebooks = shop({
      tenantId: 'paper-desk-in',
      slug: 'paper-desk',
      name: 'Paper Desk',
      blurb: 'Notebooks and pens.',
      ratingMilli: 4700,
      items: [
        item('notebook', 'Ruled notebook', { slug: 'desk-essentials', title: 'Desk essentials' }),
      ],
    });
    notebooks.refundPolicy = 'Unopened stationery within 7 days of capture.';

    const ranked = searchPublicShopSources(
      [ridge, notebooks],
      query('i want to buy some stationaery'),
    );

    expect(ranked.items.map((entry) => entry.slug)).toEqual(['paper-desk']);
  });
});
