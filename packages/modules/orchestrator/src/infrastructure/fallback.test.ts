import { beforeEach, describe, expect, it } from 'vitest';
import { getCart, resetKernel } from '@charter/commerce';
import { createConversation, resetConversations } from '../domain/index.js';
import { executeTool } from '../application/execute.js';
import { runTurn } from '../application/turn.js';
import { createStructuredFallbackClient, usesStructuredCheckout } from './fallback.js';

describe('structured model fallback', () => {
  beforeEach(() => {
    resetKernel();
    resetConversations();
  });

  it('searches the catalog when the model is unavailable', async () => {
    const conversation = createConversation();
    const turn = await runTurn(
      conversation,
      'what products are available',
      createStructuredFallbackClient(),
    );
    expect(turn.traces.some((row) => row.name === 'catalog.search')).toBe(true);
    expect(turn.reply).toMatch(/PocketGrind|Trail|press|filter/i);
    expect(turn.quoteId).toBeNull();
  });

  it('adds an item and freezes a quote from a buy request', async () => {
    const conversation = createConversation();
    const turn = await runTurn(
      conversation,
      "I'd like to buy PocketGrind Lite",
      createStructuredFallbackClient(),
    );
    expect(turn.traces.map((row) => row.name)).toEqual(
      expect.arrayContaining(['catalog.search', 'cart.add_line', 'checkout.quote']),
    );
    expect(turn.quoteId).toBeTruthy();
    expect(turn.reply).toMatch(/Locked total/i);
  });

  it('sets quantity from a card prompt without locking the total', async () => {
    const conversation = createConversation();
    await runTurn(
      conversation,
      "I'd like to buy PocketGrind Lite",
      createStructuredFallbackClient(),
    );
    conversation.quoteId = null;
    const turn = await runTurn(
      conversation,
      'Set PocketGrind Lite quantity to 2',
      createStructuredFallbackClient(),
    );
    expect(turn.traces.some((row) => row.name === 'cart.set_quantity')).toBe(true);
    expect(turn.quoteId).toBeNull();
    expect(turn.reply).toMatch(/quantity updated|cart total/i);
  });

  it('puts a Sable gift mix in the cart and locks it from Buy now', async () => {
    const conversation = createConversation('sable-atelier-in');
    const turn = await runTurn(
      conversation,
      'Put these in my cart, exactly: Cotton crew tee × 1; Canvas day tote × 1; Sand silk scarf × 2. Then lock this total. Buy now.',
      createStructuredFallbackClient(),
      {
        startCheckout: async () => {
          throw new Error('checkout.prepare should wait for Pay');
        },
      },
    );
    expect(turn.traces.map((row) => row.name)).toEqual(['cart.set_quantities', 'checkout.quote']);
    expect(turn.quoteId).toBeTruthy();
    expect(turn.checkout).toBeNull();
    expect(turn.reply).toMatch(/Locked total/i);
    expect(getCart(conversation.cartId!)?.lines).toEqual([
      { sku: 'tee.crew-cotton', quantity: 1 },
      { sku: 'tote.canvas-day', quantity: 1 },
      { sku: 'scarf.silk-sand', quantity: 2 },
    ]);
  });

  it('does not lock the total from a lone amount fragment', async () => {
    const conversation = createConversation();
    const turn = await runTurn(conversation, 'Amount.', createStructuredFallbackClient());
    expect(turn.traces.map((row) => row.name)).toEqual(['catalog.search']);
    expect(turn.quoteId).toBeNull();
  });

  it('locks the cart from Buy now without opening Razorpay', async () => {
    const conversation = createConversation();
    await executeTool(conversation, 'cart.add_line', { sku: 'grinder.pocket-lite' }, {});
    const turn = await runTurn(conversation, 'Buy now', createStructuredFallbackClient(), {
      startCheckout: async () => {
        throw new Error('checkout.prepare should wait for Pay');
      },
    });
    expect(turn.traces.map((row) => row.name)).toEqual(['checkout.quote']);
    expect(turn.quoteId).toBeTruthy();
    expect(turn.checkout).toBeNull();
    expect(turn.reply).toMatch(/Locked total/i);
  });

  it('treats Buy now and confirm-cart as structured checkout turns', () => {
    expect(usesStructuredCheckout('Buy now')).toBe(true);
    expect(
      usesStructuredCheckout(
        'Put these in my cart, exactly: Tea hamper × 1. Then lock this total. Buy now.',
      ),
    ).toBe(true);
    expect(usesStructuredCheckout('what products are available')).toBe(false);
  });
});
