import { describe, expect, it } from 'vitest';
import {
  buildStoreStructuredData,
  minorToDecimal,
  publicShopCanonical,
} from './public-commerce.js';

describe('public commerce metadata', () => {
  it('formats minor units as exact two-decimal major units', () => {
    expect(minorToDecimal('10950')).toBe('109.50');
    expect(minorToDecimal('0')).toBe('0.00');
    expect(minorToDecimal('9')).toBe('0.09');
  });

  it('builds browser-safe Product objects with nested stock-derived Offers', () => {
    const canonical = publicShopCanonical('https://charter.example/base', 'northstar');
    const data = buildStoreStructuredData({
      canonical,
      shop: {
        name: 'Northstar',
        description: 'Travel coffee.',
        currency: 'INR',
      },
      items: [
        {
          id: 'variant/1',
          sku: 'grinder.pocket-lite',
          title: 'Hand grinder',
          priceMinor: '10950',
          availableStock: 2,
          category: 'Travel coffee',
          material: 'steel',
        },
        {
          id: 'variant-2',
          sku: 'kettle.road-mini',
          title: 'Mini kettle',
          priceMinor: '129900',
          availableStock: 0,
          category: null,
          material: 'other',
        },
      ],
    });

    expect(canonical).toBe('https://charter.example/shops/northstar');
    expect(data.hasOfferCatalog.itemListElement[0]?.item).toMatchObject({
      '@type': 'Product',
      '@id': 'https://charter.example/shops/northstar#product-variant%2F1',
      sku: 'grinder.pocket-lite',
      offers: {
        '@type': 'Offer',
        price: '109.50',
        availability: 'https://schema.org/InStock',
      },
    });
    expect(data.hasOfferCatalog.itemListElement[1]?.item.offers.availability).toBe(
      'https://schema.org/OutOfStock',
    );
  });

  it('rejects non-http canonical origins', () => {
    expect(() => publicShopCanonical('javascript:alert(1)', 'northstar')).toThrow(
      'PUBLIC_ORIGIN_INVALID',
    );
  });
});
