import { describe, expect, it, beforeEach } from 'vitest';
import {
  addVariant,
  assertOfferSafety,
  consumeAppliedOffers,
  getMerchant,
  getMerchantBySlug,
  hydrateMerchantCache,
  listPublicShops,
  merchantDisplayName,
  offerDiscount,
  resetCreatedMerchants,
  setVariantStock,
  type OfferRule,
} from './merchants.js';
import { liftStaleSeededShopCaps } from './shops.js';

describe('shops', () => {
  beforeEach(() => {
    resetCreatedMerchants();
  });

  it('labels synthetic shop names and leaves live names unmarked', () => {
    expect(merchantDisplayName({ name: 'Northstar Travel Coffee', synthetic: true })).toBe(
      'Northstar Travel Coffee (synthetic)',
    );
    expect(
      merchantDisplayName({ name: 'Northstar Travel Coffee (synthetic)', synthetic: true }),
    ).toBe('Northstar Travel Coffee (synthetic)');
    expect(merchantDisplayName({ name: 'Harbor Spice' })).toBe('Harbor Spice');
  });

  it('lists seeded shops with stock', () => {
    const shops = listPublicShops();
    expect(shops.some((row) => row.slug === 'northstar')).toBe(true);
    expect(shops.some((row) => row.slug === 'indigo-desk')).toBe(true);
    expect(shops.some((row) => row.slug === 'sable-atelier')).toBe(true);
    expect(shops.some((row) => row.slug === 'lotus-gifting')).toBe(true);
    expect(shops.some((row) => row.slug === 'marigold-home')).toBe(true);
    const northstar = shops.find((row) => row.slug === 'northstar');
    expect(northstar?.itemCount).toBe(8);
    const indigo = shops.find((row) => row.slug === 'indigo-desk');
    expect(indigo?.itemCount).toBe(7);
    expect(indigo?.unitsInStock).toBeGreaterThan(0);
    const harbor = shops.find((row) => row.slug === 'harbor-spice');
    expect(harbor?.itemCount).toBe(7);
    const sable = shops.find((row) => row.slug === 'sable-atelier');
    expect(sable?.itemCount).toBe(6);
    const lotus = shops.find((row) => row.slug === 'lotus-gifting');
    expect(lotus?.itemCount).toBe(6);
    const marigold = shops.find((row) => row.slug === 'marigold-home');
    expect(marigold?.itemCount).toBe(6);
  });

  it('lets a Sable gift mix sit under the shop cap', () => {
    const sable = getMerchant('sable-atelier-in');
    expect(sable?.authority.hardCapMinor).toBe(1500000n);
    expect(sable?.authority.autonomousCapMinor).toBe(1500000n);
    expect(
      liftStaleSeededShopCaps('sable-atelier-in', {
        hardCapMinor: 500000n,
        autonomousCapMinor: 250000n,
      }),
    ).toEqual({
      hardCapMinor: 1500000n,
      autonomousCapMinor: 1500000n,
    });
    expect(
      liftStaleSeededShopCaps('northstar-demo-in', {
        hardCapMinor: 300000n,
        autonomousCapMinor: 250000n,
      }),
    ).toEqual({
      hardCapMinor: 300000n,
      autonomousCapMinor: 250000n,
    });
  });

  it('never lets stacked or exclusive offers exceed a nonnegative discount', () => {
    hydrateMerchantCache({
      tenantId: 'offer-safety-in',
      slug: 'offer-safety',
      name: 'Offer Safety',
      label: 'Offer Safety',
      blurb: '',
      synthetic: true,
      currency: 'INR',
      variants: [
        {
          sku: 'sku.a',
          title: 'A',
          priceMinor: 10000n,
          stock: 1,
          material: 'steel',
          published: true,
        },
        {
          sku: 'sku.b',
          title: 'B',
          priceMinor: 5000n,
          stock: 1,
          material: 'steel',
          published: true,
        },
      ],
      authority: {
        hardCapMinor: 500000n,
        autonomousCapMinor: 250000n,
        forbiddenMaterials: [],
      },
      offers: [
        {
          id: 'stack-a',
          discountMinor: 8000n,
          groups: [['sku.a']],
        },
        {
          id: 'stack-b',
          discountMinor: 8000n,
          groups: [['sku.b']],
        },
        {
          id: 'exclusive',
          discountMinor: 4000n,
          stackable: false,
          groups: [['sku.a']],
        },
      ],
    });

    expect(offerDiscount('offer-safety-in', ['sku.a'])).toBe(8000n);
    expect(offerDiscount('offer-safety-in', ['sku.a', 'sku.b'])).toBe(16000n);
  });

  it('skips expired, exhausted, and over-redeemed offers and fails closed on a margin floor', () => {
    hydrateMerchantCache({
      tenantId: 'offer-bounds-in',
      slug: 'offer-bounds',
      name: 'Offer Bounds',
      label: 'Offer Bounds',
      blurb: '',
      synthetic: true,
      currency: 'INR',
      variants: [
        {
          sku: 'sku.a',
          title: 'A',
          priceMinor: 20000n,
          stock: 1,
          material: 'steel',
          published: true,
        },
      ],
      authority: {
        hardCapMinor: 500000n,
        autonomousCapMinor: 250000n,
        forbiddenMaterials: [],
      },
      offers: [
        {
          id: 'expired',
          discountMinor: 5000n,
          groups: [['sku.a']],
          expiresAt: '2020-01-01T00:00:00.000Z',
        },
        {
          id: 'budget',
          discountMinor: 4000n,
          groups: [['sku.a']],
          budgetRemainingMinor: 1000n,
        },
        {
          id: 'frequency',
          discountMinor: 3000n,
          groups: [['sku.a']],
          maxRedemptions: 1,
          redemptions: 1,
        },
        {
          id: 'margin',
          discountMinor: 15000n,
          groups: [['sku.a']],
          marginFloorMinor: 10000n,
        },
      ],
    });

    expect(offerDiscount('offer-bounds-in', ['sku.a'], new Date('2026-08-24T00:00:00.000Z'))).toBe(
      15000n,
    );
    expect(() =>
      assertOfferSafety(
        'offer-bounds-in',
        ['sku.a'],
        20000n,
        15000n,
        new Date('2026-08-24T00:00:00.000Z'),
      ),
    ).toThrow('OFFER_MARGIN_FLOOR');
  });

  it('enforces the strictest stacked margin floor, not the weakest', () => {
    hydrateMerchantCache({
      tenantId: 'offer-stack-floor-in',
      slug: 'offer-stack-floor',
      name: 'Offer Stack Floor',
      label: 'Offer Stack Floor',
      blurb: '',
      synthetic: true,
      currency: 'INR',
      variants: [
        {
          sku: 'sku.a',
          title: 'A',
          priceMinor: 20000n,
          stock: 1,
          material: 'steel',
          published: true,
        },
        {
          sku: 'sku.b',
          title: 'B',
          priceMinor: 15000n,
          stock: 1,
          material: 'steel',
          published: true,
        },
      ],
      authority: {
        hardCapMinor: 500000n,
        autonomousCapMinor: 250000n,
        forbiddenMaterials: [],
      },
      offers: [
        {
          id: 'floor-high',
          discountMinor: 4000n,
          stackable: true,
          groups: [['sku.a']],
          marginFloorMinor: 180000n,
        },
        {
          id: 'floor-low',
          discountMinor: 3000n,
          stackable: true,
          groups: [['sku.b']],
          marginFloorMinor: 5000n,
        },
      ],
    });

    expect(offerDiscount('offer-stack-floor-in', ['sku.a', 'sku.b'])).toBe(7000n);
    expect(() =>
      assertOfferSafety('offer-stack-floor-in', ['sku.a', 'sku.b'], 35000n, 7000n),
    ).toThrow('OFFER_MARGIN_FLOOR');
  });

  it('hydrates a repository shop cache and adds stocked items', () => {
    const shop = hydrateMerchantCache({
      tenantId: 'priya-tea-in',
      slug: 'priya-tea',
      name: 'Priya Tea',
      label: 'Priya Tea',
      blurb: 'Chai.',
      synthetic: false,
      currency: 'INR',
      variants: [],
      authority: {
        hardCapMinor: 500000n,
        autonomousCapMinor: 250000n,
        forbiddenMaterials: [],
      },
      offers: [],
    });
    expect(shop.slug).toBe('priya-tea');
    expect(getMerchantBySlug('priya-tea')?.tenantId).toBe('priya-tea-in');
    const item = addVariant(shop.tenantId, {
      title: 'Assam leaf, 250 g',
      priceRupees: 249,
      stock: 16,
    });
    expect(item.sku).toBe('item.assam-leaf-250-g');
    expect(item.priceMinor).toBe(24900n);
    expect(setVariantStock(shop.tenantId, item.sku, 9).stock).toBe(9);
    expect(listPublicShops().find((row) => row.slug === 'priya-tea')?.unitsInStock).toBe(9);
  });

  it('counts JSON redemptions for a budget-only offer with no maxRedemptions', () => {
    const offer: OfferRule = {
      id: 'budget-only',
      discountMinor: 10000n,
      groups: [['sku.a']],
      budgetRemainingMinor: 20000n,
    };
    consumeAppliedOffers([offer]);
    expect(offer.budgetRemainingMinor).toBe(10000n);
    expect(offer.redemptions).toBe(1);
    consumeAppliedOffers([offer]);
    expect(offer.budgetRemainingMinor).toBe(0n);
    expect(offer.redemptions).toBe(2);
    expect(() => consumeAppliedOffers([offer])).toThrow('OFFER_BUDGET_EXHAUSTED');
  });
});
