import { describe, expect, it, beforeEach } from 'vitest';
import { POLICY_REASON } from '@charter/domain-shared';
import { resetKernel } from '@charter/commerce';
import { CANONICAL_QUOTE_MINOR } from '@charter/catalog';
import { createConversation, resetConversations, type ChatMessage } from '../domain/index.js';
import { executeTool } from '../application/execute.js';
import { runTurn, isPayIntent } from '../application/turn.js';
import type { FireworksClient } from '../infrastructure/fireworks.js';

describe('orchestrator tools', () => {
  beforeEach(() => {
    resetKernel();
    resetConversations();
  });

  it('denies glass in Policy, not by trusting the model', async () => {
    const conversation = createConversation();
    const result = (await executeTool(
      conversation,
      'cart.add_line',
      { sku: 'ClearGo Glass Brewer' },
      {},
    )) as { decision: { outcome: string; reason: string }; cartUnchanged: boolean };
    expect(result.decision.outcome).toBe('deny');
    expect(result.decision.reason).toBe(POLICY_REASON.PRODUCT_MATERIAL_FORBIDDEN);
    expect(result.cartUnchanged).toBe(true);
  });

  it('keeps PocketGrind Pro as require_approval without changing the cart', async () => {
    const conversation = createConversation();
    const persistedApprovals: string[] = [];
    await executeTool(conversation, 'cart.add_line', { sku: 'brewer.trailpress-steel-750' }, {});
    await executeTool(conversation, 'cart.add_line', { sku: 'grinder.pocket-lite' }, {});
    await executeTool(conversation, 'cart.add_line', { sku: 'filters.travel-30' }, {});
    const preview = (await executeTool(
      conversation,
      'cart.preview_replace',
      { fromSku: 'grinder.pocket-lite', toSku: 'PocketGrind Pro' },
      {
        persistApproval: async (approvalId: string) => {
          persistedApprovals.push(approvalId);
        },
      },
    )) as {
      decision: { outcome: string; reason: string };
      cartUnchanged: boolean;
      approval: { id: string };
    };
    expect(preview.decision.outcome).toBe('require_approval');
    expect(preview.decision.reason).toBe(POLICY_REASON.AUTHORITY_APPROVAL_REQUIRED);
    expect(preview.cartUnchanged).toBe(true);
    expect(persistedApprovals).toEqual([preview.approval.id]);
    const cart = (await executeTool(conversation, 'cart.get', {}, {})) as {
      cart: { totals: { totalDisplay: string; discountMinor: string } };
      next: string;
    };
    expect(cart.cart.totals.totalDisplay).toBe('₹2,347.00');
    expect(cart.cart.totals.discountMinor).toBe('10000');
    expect(cart.next).toBe('checkout.quote now');
    const quote = (await executeTool(conversation, 'checkout.quote', {}, {})) as {
      quote: { totalMinor: string };
    };
    expect(quote.quote.totalMinor).toBe(CANONICAL_QUOTE_MINOR.toString());
  });

  it('sets an exact cart quantity and refuses after the total is locked', async () => {
    const conversation = createConversation();
    await executeTool(conversation, 'cart.add_line', { sku: 'brewer.trailpress-steel-750' }, {});
    const two = (await executeTool(
      conversation,
      'cart.set_quantity',
      { sku: 'TrailPress', quantity: 2 },
      {},
    )) as {
      decision: { outcome: string };
      cart: { lines: Array<{ sku: string; quantity: number }> };
    };
    expect(two.decision.outcome).toBe('allow');
    expect(two.cart.lines).toEqual([{ sku: 'brewer.trailpress-steel-750', quantity: 2 }]);
    await executeTool(conversation, 'checkout.quote', {}, {});
    const locked = (await executeTool(
      conversation,
      'cart.set_quantity',
      { sku: 'brewer.trailpress-steel-750', quantity: 1 },
      {},
    )) as { error: string };
    expect(locked.error).toBe('QUOTE_LOCKED');
  });

  it('sets several line quantities in one tool call', async () => {
    const conversation = createConversation();
    await executeTool(conversation, 'cart.add_line', { sku: 'brewer.trailpress-steel-750' }, {});
    await executeTool(conversation, 'cart.add_line', { sku: 'filters.travel-30' }, {});
    const result = (await executeTool(
      conversation,
      'cart.set_quantities',
      {
        lines: [
          { sku: 'brewer.trailpress-steel-750', quantity: 1 },
          { sku: 'filters.travel-30', quantity: 2 },
        ],
      },
      {},
    )) as {
      decision: { outcome: string };
      cart: { lines: Array<{ sku: string; quantity: number }> };
    };
    expect(result.decision.outcome).toBe('allow');
    expect(result.cart.lines).toEqual([
      { sku: 'brewer.trailpress-steel-750', quantity: 1 },
      { sku: 'filters.travel-30', quantity: 2 },
    ]);
  });

  it('can search the catalog more than once', async () => {
    const conversation = createConversation();
    const first = (await executeTool(conversation, 'catalog.search', {}, {})) as {
      items: unknown[];
    };
    const browse = (await executeTool(
      conversation,
      'catalog.search',
      { query: 'what products are available' },
      {},
    )) as {
      items: unknown[];
    };
    const second = (await executeTool(conversation, 'catalog.search', { query: 'steel' }, {})) as {
      items: Array<{ sku: string }>;
    };
    expect(first.items.length).toBeGreaterThan(0);
    expect(browse.items.length).toBe(first.items.length);
    expect(
      second.items.some((row) => row.sku.includes('steel') || row.sku.includes('trailpress')),
    ).toBe(true);
  });

  it('records catalog search impressions when a hook is provided', async () => {
    const conversation = createConversation();
    const queries: string[] = [];
    await executeTool(
      conversation,
      'catalog.search',
      { query: 'grinder' },
      {
        recordCatalogSearch: async ({ query, items }) => {
          queries.push(query);
          expect(items.length).toBeGreaterThan(0);
        },
      },
    );
    expect(queries).toEqual(['grinder']);
  });

  it('runs a Fireworks turn loop and still applies server Policy', async () => {
    const conversation = createConversation();
    const script: ChatMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'cart.add_line',
              arguments: JSON.stringify({ sku: 'brewer.clear-glass-500' }),
            },
          },
        ],
      },
      {
        role: 'assistant',
        content: 'ClearGo Glass is deny / PRODUCT_MATERIAL_FORBIDDEN. Glass is not allowed.',
      },
    ];
    const client: FireworksClient = {
      async complete() {
        const next = script.shift();
        if (!next) {
          throw new Error('script exhausted');
        }
        return next;
      },
    };
    const turn = await runTurn(conversation, 'no glass please', client);
    expect(turn.traces[0]?.name).toBe('cart.add_line');
    const decision = (turn.traces[0]?.result as { decision: { reason: string } }).decision;
    expect(decision.reason).toBe(POLICY_REASON.PRODUCT_MATERIAL_FORBIDDEN);
    expect(turn.reply).toContain('PRODUCT_MATERIAL_FORBIDDEN');
  });

  it('starts Razorpay when the shopper says yes after a frozen quote', async () => {
    const conversation = createConversation();
    await executeTool(conversation, 'cart.add_line', { sku: 'brewer.trailpress-steel-750' }, {});
    await executeTool(conversation, 'cart.add_line', { sku: 'grinder.pocket-lite' }, {});
    await executeTool(conversation, 'cart.add_line', { sku: 'filters.travel-30' }, {});
    await executeTool(conversation, 'checkout.quote', {}, {});
    const script: ChatMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_get', type: 'function', function: { name: 'cart.get', arguments: '{}' } },
        ],
      },
      { role: 'assistant', content: 'The quote is ready. Want to pay?' },
    ];
    const client: FireworksClient = {
      async complete() {
        const next = script.shift();
        if (!next) {
          throw new Error('script exhausted');
        }
        return next;
      },
    };
    const turn = await runTurn(conversation, 'yes', client, {
      startCheckout: async () => ({
        checkoutId: 'chk_1',
        keyId: 'rzp_test_x',
        orderId: 'order_1',
        amount: 234700,
        currency: 'INR',
        name: 'Northstar Travel Coffee',
        description: 'Frozen quote — Charter test',
        receipt: 'cht_test',
        copy: 'pay',
      }),
    });
    expect(turn.traces.some((row) => row.name === 'checkout.prepare')).toBe(true);
    expect(turn.checkout).toMatchObject({ orderId: 'order_1', amount: 234700 });
  });

  it('does not treat “okay, let’s pick…” as a pay confirmation', () => {
    expect(isPayIntent('yes')).toBe(true);
    expect(isPayIntent('Checkout.')).toBe(true);
    expect(isPayIntent('okay')).toBe(true);
    expect(isPayIntent("Okay, let's pick the.")).toBe(false);
    expect(isPayIntent('Amount.')).toBe(false);
    expect(isPayIntent("Let's log the total.")).toBe(false);
    expect(isPayIntent('Buy now')).toBe(false);
    expect(isPayIntent("I'd like to buy PocketGrind Lite")).toBe(false);
  });
});
