import { describe, expect, it } from 'vitest';
import {
  catalogItemsInText,
  catalogThumbSrc,
  productsFromMessage,
  visualKind,
} from './catalog-visuals';

describe('catalog visuals', () => {
  it('matches products named in Concierge copy', () => {
    const items = [
      { sku: 'tee.crew-cotton', title: 'Cotton crew tee', priceDisplay: '₹1,299.00' },
      { sku: 'scarf.silk-sand', title: 'Sand silk scarf', priceDisplay: '₹2,499.00' },
      { sku: 'lamp.desk-arm', title: 'Desk lamp', priceDisplay: '₹1,299.00' },
    ];
    expect(
      catalogItemsInText(
        'Try the Cotton crew tee, Sand silk scarf, and Canvas day tote.',
        items,
      ).map((row) => row.sku),
    ).toEqual(['tee.crew-cotton', 'scarf.silk-sand']);
  });

  it('parses priced product lines even without a loaded catalog', () => {
    expect(
      productsFromMessage(
        '- **Cotton crew tee** — ₹1,299\n- Sand silk scarf — ₹2,499.00\n- Canvas day tote (₹1,899.00)',
        [],
      ).map((row) => row.title),
    ).toEqual(['Cotton crew tee', 'Sand silk scarf', 'Canvas day tote']);
    expect(visualKind('Cotton crew tee', 'tee.crew-cotton')).toBe('tee');
    expect(visualKind('Sand linen shirt', 'shirt.linen-sand')).toBe('shirt');
    expect(catalogThumbSrc('Cotton crew tee', 'tee.crew-cotton')).toBe('/thumbs/tee.jpg');
    expect(catalogThumbSrc('Sand linen shirt', 'shirt.linen-sand')).toBe('/thumbs/shirt.jpg');
    expect(catalogThumbSrc('Oat wool beanie', 'beanie.wool-oat')).toBe('/thumbs/beanie.jpg');
    expect(catalogThumbSrc('Steel travel mug', 'mug.steel-travel')).toBe('/thumbs/travel-mug.jpg');
    expect(catalogThumbSrc('Sand silk scarf', 'scarf.silk-sand')).toBe('/thumbs/scarf.jpg');
    expect(catalogThumbSrc('Assorted chocolate box', 'gift.chocolate-box')).toBe(
      '/thumbs/chocolate.jpg',
    );
    expect(catalogThumbSrc('Dried flower bunch', 'gift.dried-flowers')).toBe('/thumbs/flowers.jpg');
    expect(catalogThumbSrc('Brass diya set', 'gift.brass-diya')).toBe('/thumbs/diya.jpg');
    expect(catalogThumbSrc('Lotus Gifting', 'lotus-gifting')).toBe(
      '/thumbs/shop-lotus-gifting.jpg',
    );
  });

  it('strips a cart count from a priced line and maps it onto the catalog SKU', () => {
    expect(
      productsFromMessage('• **Assorted chocolate box × 1** — ₹799.00', [
        { sku: 'gift.chocolate-box', title: 'Assorted chocolate box', priceDisplay: '₹799.00' },
      ]).map((row) => row.sku),
    ).toEqual(['gift.chocolate-box']);
  });
});
