import { describe, expect, it, beforeEach } from 'vitest';
import { POLICY_REASON } from '@charter/domain-shared';
import {
  CANONICAL_QUOTE_MINOR,
  PRO_MUTATION_TOTAL_MINOR,
  copyOfferRule,
  getMerchant,
  hydrateMerchantCache,
  resetMerchantSeeds,
  setVariantStock,
} from '@charter/catalog';
import {
  buildCanonicalKit,
  cartTotals,
  decideApproval,
  decideLoadedApproval,
  freezeQuote,
  getCart,
  hydrateCart,
  hydrateQuote,
  previewReplace,
  proposedReplaceTotal,
  resetKernel,
  addLine,
  setLineQuantity,
  setLineQuantities,
  assertQuoteFactsFresh,
  createCart,
} from './kernel.js';
import { listApprovals } from './approval.js';
import { assertApprovalDecision } from './approval-kind.js';

describe('Northstar canonical kit', () => {
  beforeEach(() => {
    resetKernel();
  });

  it('sets, reduces, and removes a cart line quantity before a quote is locked', () => {
    const cart = createCart();
    expect(addLine(cart.id, 'brewer.trailpress-steel-750').decision.outcome).toBe('allow');
    const two = setLineQuantity(cart.id, 'brewer.trailpress-steel-750', 2);
    expect(two.decision.outcome).toBe('allow');
    expect(two.cart.lines).toEqual([{ sku: 'brewer.trailpress-steel-750', quantity: 2 }]);
    const one = setLineQuantity(cart.id, 'brewer.trailpress-steel-750', 1);
    expect(one.cart.lines).toEqual([{ sku: 'brewer.trailpress-steel-750', quantity: 1 }]);
    const gone = setLineQuantity(cart.id, 'brewer.trailpress-steel-750', 0);
    expect(gone.decision.outcome).toBe('allow');
    expect(gone.cart.lines).toEqual([]);
  });

  it('refuses an invalid cart quantity without changing lines', () => {
    const cart = createCart();
    addLine(cart.id, 'brewer.trailpress-steel-750');
    expect(() => setLineQuantity(cart.id, 'brewer.trailpress-steel-750', 1.5)).toThrow(
      'QUANTITY_INVALID',
    );
    expect(getCart(cart.id)?.lines).toEqual([{ sku: 'brewer.trailpress-steel-750', quantity: 1 }]);
  });

  it('puts a Sable gift mix in the cart in one shot', () => {
    const cart = createCart('sable-atelier-in');
    const result = setLineQuantities(cart.id, [
      { sku: 'tee.crew-cotton', quantity: 1 },
      { sku: 'scarf.silk-sand', quantity: 1 },
      { sku: 'tote.canvas-day', quantity: 2 },
    ]);
    expect(result.decision.outcome).toBe('allow');
    expect(result.cart.lines).toEqual([
      { sku: 'tee.crew-cotton', quantity: 1 },
      { sku: 'scarf.silk-sand', quantity: 1 },
      { sku: 'tote.canvas-day', quantity: 2 },
    ]);
  });

  it('does not keep a partial mix when the proposed total needs approval', () => {
    const cart = createCart();
    expect(addLine(cart.id, 'brewer.trailpress-steel-750').decision.outcome).toBe('allow');
    const blocked = setLineQuantities(cart.id, [
      { sku: 'brewer.trailpress-steel-750', quantity: 1 },
      { sku: 'grinder.pocket-pro', quantity: 1 },
    ]);
    expect(blocked.decision.outcome).toBe('require_approval');
    expect(blocked.cart.lines).toEqual([{ sku: 'brewer.trailpress-steel-750', quantity: 1 }]);
  });

  it('freezes ₹2,347 after TrailPress + Lite + Filters offer', () => {
    const { quote, glass, kettle } = buildCanonicalKit(new Date('2026-08-22T08:00:00+05:30'));
    expect(quote.totalMinor).toBe(CANONICAL_QUOTE_MINOR);
    expect(quote.totalDisplay).toBe('₹2,347.00');
    expect(quote.discountMinor).toBe(10000n);
    expect(quote.merchant).toContain('synthetic');
    expect(quote.deliveryBy).toBe('2026-08-23');
    expect(glass.reason).toBe(POLICY_REASON.PRODUCT_MATERIAL_FORBIDDEN);
    expect(kettle.reason).toBe(POLICY_REASON.OUT_OF_STOCK);
    expect(quote.status).toBe('FROZEN');
    expect(cartTotals(quote.cartId)?.totalMinor).toBe(CANONICAL_QUOTE_MINOR);
  });

  it('does not change the cart when PocketGrind Pro needs approval', () => {
    const { cart, quote } = buildCanonicalKit();
    const preview = previewReplace(cart.id, 'grinder.pocket-lite', 'grinder.pocket-pro');
    expect(preview.decision.outcome).toBe('require_approval');
    expect(preview.decision.reason).toBe(POLICY_REASON.AUTHORITY_APPROVAL_REQUIRED);
    expect(preview.decision.message).toBe('Approval required');
    expect(preview.proposedTotalMinor).toBe(PRO_MUTATION_TOTAL_MINOR);
    expect(preview.cartUnchanged).toBe(true);
    expect(preview.approval?.status).toBe('pending');
    expect(freezeQuote(cart.id).totalMinor).toBe(quote.totalMinor);
  });

  it('applies PocketGrind Pro only after Register approves', () => {
    const { cart } = buildCanonicalKit();
    const preview = previewReplace(cart.id, 'grinder.pocket-lite', 'grinder.pocket-pro');
    expect(listApprovals()).toHaveLength(1);
    const denied = decideApproval(preview.approval!.id, 'denied', {
      decidedBy: '71000000-0000-4000-8000-000000000001',
      shopRole: 'owner',
    });
    expect(denied.approval.status).toBe('denied');
    expect(getCart(cart.id)?.lines.some((line) => line.sku === 'grinder.pocket-pro')).toBe(false);

    const again = previewReplace(cart.id, 'grinder.pocket-lite', 'grinder.pocket-pro');
    const approved = decideApproval(again.approval!.id, 'approved', {
      decidedBy: '71000000-0000-4000-8000-000000000001',
      shopRole: 'owner',
    });
    expect(approved.approval.status).toBe('approved');
    expect(approved.cart.lines.some((line) => line.sku === 'grinder.pocket-pro')).toBe(true);
    expect(freezeQuote(cart.id).totalMinor).toBe(PRO_MUTATION_TOTAL_MINOR);
  });

  it('rejects in-memory approval decisions that skip SoD or typed role bindings', () => {
    const { cart } = buildCanonicalKit();
    const preview = previewReplace(cart.id, 'grinder.pocket-lite', 'grinder.pocket-pro');
    const approval = preview.approval!;
    approval.requestedBy = '71000000-0000-4000-8000-000000000002';

    expect(() =>
      decideApproval(approval.id, 'approved', {
        decidedBy: '71000000-0000-4000-8000-000000000002',
        shopRole: 'owner',
      }),
    ).toThrow('APPROVAL_SELF_DECISION');
    expect(() =>
      decideApproval(approval.id, 'approved', {
        decidedBy: '71000000-0000-4000-8000-000000000001',
        shopRole: 'finance',
      }),
    ).toThrow('APPROVAL_ROLE_DENIED');
  });

  it('refuses decideLoadedApproval unless assertApprovalDecision already passed', () => {
    const { cart } = buildCanonicalKit();
    const preview = previewReplace(cart.id, 'grinder.pocket-lite', 'grinder.pocket-pro');
    const approval = preview.approval!;

    expect(() =>
      decideLoadedApproval(approval, cart, 'approved', {
        checkoutLocked: false,
        asserted: Symbol('bypass') as never,
      }),
    ).toThrow('APPROVAL_DECISION_NOT_ASSERTED');
  });

  it('decides a loaded approval from explicit current cart and quote-lock state', () => {
    const { cart } = buildCanonicalKit();
    const preview = previewReplace(cart.id, 'grinder.pocket-lite', 'grinder.pocket-pro');
    const approval = preview.approval!;
    const liveAmountMinor = proposedReplaceTotal(cart, approval.fromSku, approval.toSku);
    const asserted = assertApprovalDecision({
      kind: approval.kind,
      shopRole: 'owner',
      decidedBy: '71000000-0000-4000-8000-000000000001',
      actionHash: approval.actionHash,
      liveActionHash: approval.actionHash,
      amountMinor: approval.proposedTotalMinor,
      liveAmountMinor,
      currency: 'INR',
      liveCurrency: 'INR',
    });

    expect(() =>
      decideLoadedApproval(approval, cart, 'approved', { checkoutLocked: true, asserted }),
    ).toThrow('APPROVAL_CHECKOUT_LOCKED');
    const approved = decideLoadedApproval(approval, cart, 'approved', {
      checkoutLocked: false,
      asserted,
    });

    expect(approved.approval.status).toBe('approved');
    expect(approved.cart.lines).toContainEqual({ sku: 'grinder.pocket-pro', quantity: 1 });
  });

  it('preserves an explicit zero approval ceiling when hydrating a durable cart', () => {
    const { cart } = buildCanonicalKit();
    const approval = previewReplace(cart.id, 'grinder.pocket-lite', 'grinder.pocket-pro').approval!;
    const approved = decideApproval(approval.id, 'approved', {
      decidedBy: '71000000-0000-4000-8000-000000000001',
      shopRole: 'owner',
    }).cart;
    const durableCart = {
      ...approved,
      lines: approved.lines.map((line) => ({ ...line })),
      approvedThroughMinor: 0n,
    };
    resetKernel();

    const hydrated = hydrateCart(durableCart);

    expect(hydrated.approvedThroughMinor).toBe(0n);
    expect(() => freezeQuote(hydrated.id)).toThrow(POLICY_REASON.AUTHORITY_APPROVAL_REQUIRED);
  });

  it('pins catalog facts on a frozen quote and fails closed after stock changes', () => {
    const { quote } = buildCanonicalKit();
    expect(quote.factHash).toMatch(/^[a-f0-9]{64}$/);
    expect(() => assertQuoteFactsFresh(quote)).not.toThrow();
    setVariantStock(quote.tenantId, 'grinder.pocket-lite', 1);
    expect(() => assertQuoteFactsFresh(quote)).toThrow('FACTS_STALE');
  });

  it('refuses to hydrate a quote with an empty or non-hex fact hash from live cache', () => {
    const { quote } = buildCanonicalKit();
    resetKernel();
    expect(() =>
      hydrateQuote({
        ...quote,
        factHash: '',
      }),
    ).toThrow('FACTS_UNPINNED');
    expect(() =>
      hydrateQuote({
        ...quote,
        factHash: 'not-a-pin',
      }),
    ).toThrow('FACTS_UNPINNED');
  });

  it('never lets stacked discounts drive a quote total below zero', () => {
    const { cart, quote } = buildCanonicalKit();
    expect(quote.totalMinor).toBeGreaterThanOrEqual(0n);
    expect(quote.discountMinor).toBeLessThanOrEqual(quote.subtotalMinor);
    expect(quote.totalMinor).toBe(quote.subtotalMinor - quote.discountMinor);
    expect(freezeQuote(cart.id).totalMinor).toBeGreaterThanOrEqual(0n);
  });

  it('consumes a one-discount budget so a second freeze cannot reuse it', () => {
    hydrateMerchantCache({
      tenantId: 'budget-once-in',
      slug: 'budget-once',
      name: 'Budget Once',
      label: 'Budget Once',
      blurb: '',
      synthetic: true,
      currency: 'INR',
      variants: [
        {
          sku: 'sku.a',
          title: 'A',
          priceMinor: 20000n,
          stock: 4,
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
          id: 'once',
          discountMinor: 4000n,
          groups: [['sku.a']],
          budgetRemainingMinor: 4000n,
        },
      ],
    });
    const firstCart = createCart('budget-once-in');
    addLine(firstCart.id, 'sku.a');
    const first = freezeQuote(firstCart.id);
    expect(first.discountMinor).toBe(4000n);
    const secondCart = createCart('budget-once-in');
    addLine(secondCart.id, 'sku.a');
    const second = freezeQuote(secondCart.id);
    expect(second.discountMinor).toBe(0n);
    expect(second.totalMinor).toBe(20000n);
    resetMerchantSeeds();
  });

  it('keeps a budgeted freeze pin fresh so persist can save the quote', () => {
    const merchant = getMerchant()!;
    hydrateMerchantCache({
      ...merchant,
      offers: merchant.offers.map((offer) => ({
        ...copyOfferRule(offer),
        budgetRemainingMinor: offer.discountMinor,
        maxRedemptions: 8,
        redemptions: 0,
      })),
    });
    const cart = createCart();
    addLine(cart.id, 'brewer.trailpress-steel-750');
    addLine(cart.id, 'grinder.pocket-lite');
    addLine(cart.id, 'filters.travel-30');
    const quote = freezeQuote(cart.id);
    expect(quote.discountMinor).toBeGreaterThan(0n);
    expect(() => assertQuoteFactsFresh(quote)).not.toThrow();
    resetMerchantSeeds();
  });
});
