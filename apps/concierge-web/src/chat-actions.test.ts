import { describe, expect, it } from 'vitest';
import {
  cartSnapshotFromTurn,
  confirmCartPrompt,
  displayQuantity,
  matchingShopItems,
  messageShowsCart,
  picksDifferFromCart,
  setQuantityPrompt,
  shouldOfferLockTotal,
  buyNowPrompt,
} from './chat-actions';

describe('chat move buttons', () => {
  it('offers lock-total after an add, and not after a quote already exists', () => {
    expect(
      messageShowsCart('The Dried flower bunch has been added to your cart. Cart total: ₹649.00'),
    ).toBe(true);
    expect(shouldOfferLockTotal('The Dried flower bunch has been added to your cart.', false)).toBe(
      true,
    );
    expect(shouldOfferLockTotal('The Dried flower bunch has been added to your cart.', true)).toBe(
      false,
    );
    expect(shouldOfferLockTotal('Here is the catalog.', false)).toBe(false);
    expect(shouldOfferLockTotal('Quantity updated.', false, true)).toBe(true);
    expect(shouldOfferLockTotal('Quantity updated.', true, true)).toBe(false);
  });

  it('builds quantity prompts for the product-card stepper', () => {
    expect(setQuantityPrompt('Cast iron mill', 2)).toBe('Set Cast iron mill quantity to 2');
    expect(setQuantityPrompt('Cast iron mill', 0)).toBe('Remove Cast iron mill from cart');
  });

  it('prefers the turn cart snapshot, including an emptied cart', () => {
    expect(
      cartSnapshotFromTurn({
        cart: { lines: [{ sku: 'mill.cast-iron', quantity: 2 }], totalDisplay: '₹1,798.00' },
      }),
    ).toEqual({
      lines: [{ sku: 'mill.cast-iron', quantity: 2 }],
      totalDisplay: '₹1,798.00',
    });
    expect(cartSnapshotFromTurn({ cart: { lines: [] } })).toBeNull();
  });

  it('treats card picks as local until confirm, including a × 1 listed title', () => {
    const catalog = [{ sku: 'gift.chocolate-box', title: 'Assorted chocolate box' }];
    const picks = {
      'gift.chocolate-box': {
        sku: 'gift.chocolate-box',
        title: 'Assorted chocolate box',
        quantity: 2,
      },
    };
    expect(
      displayQuantity(
        picks,
        null,
        { sku: 'listed.assorted-chocolate-box-1', title: 'Assorted chocolate box × 1' },
        catalog,
      ),
    ).toBe(2);
    expect(picksDifferFromCart(picks, null)).toBe(true);
    expect(confirmCartPrompt(picks)).toBe(
      'Put these in my cart, exactly: Assorted chocolate box × 2. Do not lock this total.',
    );
    expect(confirmCartPrompt(picks, true)).toBe(
      'Put these in my cart, exactly: Assorted chocolate box × 2. Then lock this total. Buy now.',
    );
    expect(buyNowPrompt(picks, true)).toBe(
      'Put these in my cart, exactly: Assorted chocolate box × 2. Then lock this total. Buy now.',
    );
    expect(buyNowPrompt({}, false)).toBe('Buy now');
    expect(
      matchingShopItems([{ sku: 'tee.crew-cotton', title: 'Cotton crew tee' }], 'scarf'),
    ).toEqual([]);
    expect(
      matchingShopItems([{ sku: 'tee.crew-cotton', title: 'Cotton crew tee' }], 'cotton'),
    ).toEqual([{ sku: 'tee.crew-cotton', title: 'Cotton crew tee' }]);
  });
});
