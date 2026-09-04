import { randomUUID } from 'node:crypto';
import { formatInr, money } from '@charter/domain-shared';
import {
  CANONICAL_QUOTE_MINOR,
  DEFAULT_TENANT,
  appliedOffers,
  assertFactPinMatch,
  assertOfferSafety,
  consumeAppliedOffers,
  getTenantVariant,
  isFactHash,
  listVariants,
  liveMerchantFactPin,
  merchantDisplayName,
  offerDiscount,
  requireMerchant,
} from '@charter/catalog';
import {
  evaluateProposedTotal,
  evaluateVariant,
  POLICY_ALLOW,
  type PolicyDecision,
} from '@charter/policy';
import { nextKolkataSundayDate } from './delivery.js';
import { getApproval, openApproval, resetApprovals, type ApprovalRequest } from './approval.js';
import {
  assertApprovalDecision,
  cartSpendActionHash,
  isApprovalDecisionAsserted,
  type ApprovalDecisionAsserted,
} from './approval-kind.js';

export type CartLine = { sku: string; quantity: number };

export type Cart = {
  id: string;
  tenantId: string;
  version: number;
  lines: CartLine[];
  approvedThroughMinor: bigint;
};

export type FrozenQuote = {
  id: string;
  tenantId: string;
  cartId: string;
  cartVersion: number;
  status: 'FROZEN' | 'BOUND' | 'SETTLED';
  boundCheckoutId: string | null;
  currency: 'INR';
  subtotalMinor: bigint;
  discountMinor: bigint;
  totalMinor: bigint;
  totalDisplay: string;
  deliveryBy: string;
  merchant: string;
  catalogVersion: number;
  policyVersion: number;
  factHash: string;
  lines: Array<{
    sku: string;
    title: string;
    quantity: number;
    unitMinor: bigint;
    lineMinor: bigint;
  }>;
};

const carts = new Map<string, Cart>();
const quotes = new Map<string, FrozenQuote>();
const quoteOfferRedemptions = new Map<string, Array<{ offerId: string; discountMinor: bigint }>>();

function lineTotal(
  lines: CartLine[],
  tenantId: string,
): { subtotal: bigint; discount: bigint; total: bigint } {
  let subtotal = 0n;
  for (const line of lines) {
    const variant = getTenantVariant(tenantId, line.sku);
    if (!variant) {
      throw new Error('SKU_UNKNOWN');
    }
    subtotal += variant.priceMinor * BigInt(line.quantity);
  }
  const rawDiscount = offerDiscount(
    tenantId,
    lines.map((line) => line.sku),
  );
  const discount = rawDiscount < 0n ? 0n : rawDiscount > subtotal ? subtotal : rawDiscount;
  assertOfferSafety(
    tenantId,
    lines.map((line) => line.sku),
    subtotal,
    discount,
  );
  return { subtotal, discount, total: subtotal - discount };
}

function authorityFor(tenantId: string) {
  return requireMerchant(tenantId).authority;
}

function inferGrant(lines: CartLine[], tenantId: string, explicit?: bigint): bigint {
  if (explicit !== undefined) {
    return explicit;
  }
  const total = lineTotal(lines, tenantId).total;
  if (total > authorityFor(tenantId).autonomousCapMinor) {
    return total;
  }
  return 0n;
}

export function resetKernel(): void {
  carts.clear();
  quotes.clear();
  quoteOfferRedemptions.clear();
  resetApprovals();
}

export function rememberQuoteOfferRedemptions(
  quoteId: string,
  redemptions: Array<{ offerId: string; discountMinor: bigint }>,
): void {
  quoteOfferRedemptions.set(
    quoteId,
    redemptions.map((row) => ({ offerId: row.offerId, discountMinor: row.discountMinor })),
  );
}

export function hydrateCart(
  cart: Omit<Cart, 'approvedThroughMinor'> & { approvedThroughMinor?: bigint },
): Cart {
  const lines = cart.lines.map((line) => ({ ...line }));
  const copy: Cart = {
    ...cart,
    lines,
    approvedThroughMinor: inferGrant(lines, cart.tenantId, cart.approvedThroughMinor),
  };
  carts.set(copy.id, copy);
  return copy;
}

export function hydrateQuote(
  quote: Omit<FrozenQuote, 'catalogVersion' | 'policyVersion' | 'factHash'> & {
    catalogVersion?: number;
    policyVersion?: number;
    factHash?: string;
  },
): FrozenQuote {
  const storedHash = quote.factHash ?? '';
  if (!isFactHash(storedHash)) {
    throw new Error('FACTS_UNPINNED');
  }
  const copy: FrozenQuote = {
    ...quote,
    catalogVersion: quote.catalogVersion ?? 1,
    policyVersion: quote.policyVersion ?? 1,
    factHash: storedHash,
    lines: quote.lines.map((line) => ({ ...line })),
  };
  quotes.set(copy.id, copy);
  return copy;
}

export function createCart(tenantId: string = DEFAULT_TENANT): Cart {
  requireMerchant(tenantId);
  const cart: Cart = {
    id: randomUUID(),
    tenantId,
    version: 1,
    lines: [],
    approvedThroughMinor: 0n,
  };
  carts.set(cart.id, cart);
  return cart;
}

export function getCart(id: string): Cart | undefined {
  return carts.get(id);
}

export function serializeCart(cart: Cart) {
  return {
    ...cart,
    approvedThroughMinor: cart.approvedThroughMinor.toString(),
  };
}

export function cartTotals(cartId: string):
  | {
      subtotalMinor: bigint;
      discountMinor: bigint;
      totalMinor: bigint;
      totalDisplay: string;
    }
  | undefined {
  const cart = carts.get(cartId);
  if (!cart) {
    return undefined;
  }
  const totals = lineTotal(cart.lines, cart.tenantId);
  return {
    subtotalMinor: totals.subtotal,
    discountMinor: totals.discount,
    totalMinor: totals.total,
    totalDisplay: formatInr(money(totals.total)),
  };
}

export function addLine(cartId: string, sku: string): { cart: Cart; decision: PolicyDecision } {
  const cart = carts.get(cartId);
  if (!cart) {
    throw new Error('CART_NOT_FOUND');
  }
  const variant = getTenantVariant(cart.tenantId, sku);
  const decision = evaluateVariant(variant, authorityFor(cart.tenantId));
  if (decision.outcome !== 'allow') {
    return { cart, decision };
  }
  const existing = cart.lines.find((line) => line.sku === sku);
  const nextLines = existing
    ? cart.lines.map((line) => (line.sku === sku ? { ...line, quantity: line.quantity + 1 } : line))
    : [...cart.lines, { sku, quantity: 1 }];
  const proposed = lineTotal(nextLines, cart.tenantId).total;
  const totalDecision = evaluateProposedTotal(
    proposed,
    authorityFor(cart.tenantId),
    cart.approvedThroughMinor,
  );
  if (totalDecision.outcome !== 'allow') {
    return { cart, decision: totalDecision };
  }
  cart.lines = nextLines;
  cart.version += 1;
  return { cart, decision };
}

export function setLineQuantity(
  cartId: string,
  sku: string,
  quantity: number,
): { cart: Cart; decision: PolicyDecision } {
  const cart = carts.get(cartId);
  if (!cart) {
    throw new Error('CART_NOT_FOUND');
  }
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 99) {
    throw new Error('QUANTITY_INVALID');
  }
  const existing = cart.lines.find((line) => line.sku === sku);
  if (!existing && quantity === 0) {
    return { cart, decision: POLICY_ALLOW };
  }
  if (existing && existing.quantity === quantity) {
    return { cart, decision: POLICY_ALLOW };
  }
  if (quantity > 0) {
    const variant = getTenantVariant(cart.tenantId, sku);
    const decision = evaluateVariant(variant, authorityFor(cart.tenantId));
    if (decision.outcome !== 'allow') {
      return { cart, decision };
    }
  }
  const nextLines =
    quantity === 0
      ? cart.lines.filter((line) => line.sku !== sku)
      : existing
        ? cart.lines.map((line) => (line.sku === sku ? { ...line, quantity } : line))
        : [...cart.lines, { sku, quantity }];
  const proposed = lineTotal(nextLines, cart.tenantId).total;
  const totalDecision = evaluateProposedTotal(
    proposed,
    authorityFor(cart.tenantId),
    cart.approvedThroughMinor,
  );
  if (totalDecision.outcome !== 'allow') {
    return { cart, decision: totalDecision };
  }
  cart.lines = nextLines;
  cart.version += 1;
  return { cart, decision: POLICY_ALLOW };
}

export function setLineQuantities(
  cartId: string,
  lines: Array<{ sku: string; quantity: number }>,
): { cart: Cart; decision: PolicyDecision } {
  const cart = carts.get(cartId);
  if (!cart) {
    throw new Error('CART_NOT_FOUND');
  }
  let nextLines = cart.lines.map((line) => ({ ...line }));
  for (const { sku, quantity } of lines) {
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 99) {
      throw new Error('QUANTITY_INVALID');
    }
    const existing = nextLines.find((line) => line.sku === sku);
    if (!existing && quantity === 0) {
      continue;
    }
    if (existing && existing.quantity === quantity) {
      continue;
    }
    if (quantity > 0) {
      const variant = getTenantVariant(cart.tenantId, sku);
      const decision = evaluateVariant(variant, authorityFor(cart.tenantId));
      if (decision.outcome !== 'allow') {
        return { cart, decision };
      }
    }
    nextLines =
      quantity === 0
        ? nextLines.filter((line) => line.sku !== sku)
        : existing
          ? nextLines.map((line) => (line.sku === sku ? { ...line, quantity } : line))
          : [...nextLines, { sku, quantity }];
  }
  const proposed = lineTotal(nextLines, cart.tenantId).total;
  const totalDecision = evaluateProposedTotal(
    proposed,
    authorityFor(cart.tenantId),
    cart.approvedThroughMinor,
  );
  if (totalDecision.outcome !== 'allow') {
    return { cart, decision: totalDecision };
  }
  cart.lines = nextLines;
  cart.version += 1;
  return { cart, decision: POLICY_ALLOW };
}

export function previewReplace(
  cartId: string,
  fromSku: string,
  toSku: string,
): {
  decision: PolicyDecision;
  proposedTotalMinor: bigint;
  proposedDisplay: string;
  cartUnchanged: true;
  approval: ApprovalRequest | null;
} {
  const cart = carts.get(cartId);
  if (!cart) {
    throw new Error('CART_NOT_FOUND');
  }
  const variant = getTenantVariant(cart.tenantId, toSku);
  const variantDecision = evaluateVariant(variant, authorityFor(cart.tenantId));
  if (variantDecision.outcome !== 'allow') {
    return {
      decision: variantDecision,
      proposedTotalMinor: 0n,
      proposedDisplay: formatInr(money(0)),
      cartUnchanged: true,
      approval: null,
    };
  }
  const nextLines = cart.lines.map((line) =>
    line.sku === fromSku ? { sku: toSku, quantity: line.quantity } : line,
  );
  const proposed = lineTotal(nextLines, cart.tenantId).total;
  const decision = evaluateProposedTotal(
    proposed,
    authorityFor(cart.tenantId),
    cart.approvedThroughMinor,
  );
  const approval =
    decision.outcome === 'require_approval'
      ? openApproval({
          tenantId: cart.tenantId,
          cartId: cart.id,
          fromSku,
          toSku,
          proposedTotalMinor: proposed,
          proposedDisplay: formatInr(money(proposed)),
          decision,
        })
      : null;
  return {
    decision,
    proposedTotalMinor: proposed,
    proposedDisplay: formatInr(money(proposed)),
    cartUnchanged: true,
    approval,
  };
}

export function proposedReplaceTotal(cart: Cart, fromSku: string, toSku: string): bigint {
  return lineTotal(
    cart.lines.map((line) =>
      line.sku === fromSku ? { sku: toSku, quantity: line.quantity } : line,
    ),
    cart.tenantId,
  ).total;
}

export type ApprovalDecisionActor = {
  decidedBy: string;
  shopRole?: string | undefined;
  platformRoles?: readonly string[] | undefined;
  now?: Date | undefined;
};

export function decideApproval(
  approvalId: string,
  decision: 'approved' | 'denied',
  actor: ApprovalDecisionActor,
): { approval: ApprovalRequest; cart: Cart } {
  const approval = getApproval(approvalId);
  if (!approval) {
    throw new Error('APPROVAL_NOT_FOUND');
  }
  if (approval.status !== 'pending') {
    throw new Error('APPROVAL_ALREADY_DECIDED');
  }
  const cart = carts.get(approval.cartId);
  if (!cart) {
    throw new Error('CART_NOT_FOUND');
  }
  const liveAmountMinor = proposedReplaceTotal(cart, approval.fromSku, approval.toSku);
  const asserted = assertApprovalDecision({
    kind: approval.kind,
    shopRole: actor.shopRole,
    platformRoles: actor.platformRoles,
    requestedBy: approval.requestedBy ?? undefined,
    decidedBy: actor.decidedBy,
    expiresAt: approval.expiresAt,
    actionHash: approval.actionHash,
    liveActionHash: cartSpendActionHash({
      tenantId: approval.tenantId,
      cartId: approval.cartId,
      fromSku: approval.fromSku,
      toSku: approval.toSku,
      amountMinor: liveAmountMinor,
      currency: 'INR',
    }),
    amountMinor: approval.proposedTotalMinor,
    liveAmountMinor,
    currency: 'INR',
    liveCurrency: 'INR',
    now: actor.now,
  });
  const checkoutLocked = [...quotes.values()].some(
    (quote) => quote.cartId === cart.id && (quote.status === 'BOUND' || quote.status === 'SETTLED'),
  );
  return decideLoadedApproval(approval, cart, decision, { checkoutLocked, asserted });
}

/**
 * Applies an already-authorized decision onto the current cart.
 * Callers must pass the token from assertApprovalDecision; Register/HTTP
 * paths must use decideApproval or decidePersistedApproval.
 */
export function decideLoadedApproval(
  approval: ApprovalRequest,
  cart: Cart,
  decision: 'approved' | 'denied',
  state: { checkoutLocked: boolean; asserted: ApprovalDecisionAsserted },
): { approval: ApprovalRequest; cart: Cart } {
  if (!isApprovalDecisionAsserted(state.asserted)) {
    throw new Error('APPROVAL_DECISION_NOT_ASSERTED');
  }
  if (approval.tenantId !== cart.tenantId || approval.cartId !== cart.id) {
    throw new Error('APPROVAL_NOT_FOUND');
  }
  if (approval.status !== 'pending') {
    throw new Error('APPROVAL_ALREADY_DECIDED');
  }
  if (decision === 'denied') {
    approval.status = 'denied';
    approval.decidedAt = new Date().toISOString();
    return { approval, cart };
  }
  if (state.checkoutLocked) {
    throw new Error('APPROVAL_CHECKOUT_LOCKED');
  }
  if (!cart.lines.some((line) => line.sku === approval.fromSku)) {
    throw new Error('APPROVAL_STALE');
  }
  const toVariant = getTenantVariant(cart.tenantId, approval.toSku);
  const variantDecision = evaluateVariant(toVariant, authorityFor(cart.tenantId));
  if (variantDecision.outcome !== 'allow') {
    throw new Error(variantDecision.reason);
  }
  const nextLines = cart.lines.map((line) =>
    line.sku === approval.fromSku ? { sku: approval.toSku, quantity: line.quantity } : line,
  );
  const proposed = lineTotal(nextLines, cart.tenantId).total;
  const hard = evaluateProposedTotal(proposed, authorityFor(cart.tenantId), proposed);
  if (hard.outcome === 'deny') {
    throw new Error(hard.reason);
  }
  cart.lines = nextLines;
  cart.version += 1;
  cart.approvedThroughMinor =
    proposed > cart.approvedThroughMinor ? proposed : cart.approvedThroughMinor;
  approval.status = 'approved';
  approval.decidedAt = new Date().toISOString();
  return { approval, cart };
}

export function freezeQuote(cartId: string, now: Date = new Date()): FrozenQuote {
  const cart = carts.get(cartId);
  if (!cart) {
    throw new Error('CART_NOT_FOUND');
  }
  const totals = lineTotal(cart.lines, cart.tenantId);
  const decision = evaluateProposedTotal(
    totals.total,
    authorityFor(cart.tenantId),
    cart.approvedThroughMinor,
  );
  if (decision.outcome !== 'allow') {
    throw new Error(decision.reason);
  }
  const merchant = requireMerchant(cart.tenantId);
  const applied = appliedOffers(
    cart.tenantId,
    cart.lines.map((line) => line.sku),
    now,
  );
  const redemptions = applied.map((offer) => ({
    offerId: offer.id,
    discountMinor: offer.discountMinor,
  }));
  const pin = liveMerchantFactPin(cart.tenantId);
  consumeAppliedOffers(applied);
  const quote: FrozenQuote = {
    id: randomUUID(),
    tenantId: cart.tenantId,
    cartId: cart.id,
    cartVersion: cart.version,
    status: 'FROZEN',
    boundCheckoutId: null,
    currency: 'INR',
    subtotalMinor: totals.subtotal,
    discountMinor: totals.discount,
    totalMinor: totals.total,
    totalDisplay: formatInr(money(totals.total)),
    deliveryBy: nextKolkataSundayDate(now),
    merchant: merchantDisplayName(merchant),
    catalogVersion: pin.catalogVersion,
    policyVersion: pin.policyVersion,
    factHash: pin.factHash,
    lines: cart.lines.map((line) => {
      const variant = getTenantVariant(cart.tenantId, line.sku)!;
      return {
        sku: line.sku,
        title: variant.title,
        quantity: line.quantity,
        unitMinor: variant.priceMinor,
        lineMinor: variant.priceMinor * BigInt(line.quantity),
      };
    }),
  };
  quotes.set(quote.id, quote);
  rememberQuoteOfferRedemptions(quote.id, redemptions);
  return quote;
}

export function assertQuoteFactsFresh(quote: FrozenQuote): void {
  assertFactPinMatch(
    {
      catalogVersion: quote.catalogVersion,
      policyVersion: quote.policyVersion,
      factHash: quote.factHash,
    },
    liveMerchantFactPin(quote.tenantId, quoteOfferRedemptions.get(quote.id) ?? []),
  );
}

export function listCatalog(tenantId: string = DEFAULT_TENANT) {
  return listVariants(tenantId).map((row) => ({
    sku: row.sku,
    title: row.title,
    priceDisplay: formatInr(money(row.priceMinor)),
    priceMinor: row.priceMinor.toString(),
    stock: row.stock,
    material: row.material,
  }));
}

export function listAuthority(tenantId: string = DEFAULT_TENANT) {
  const authority = authorityFor(tenantId);
  return {
    hardCapDisplay: formatInr(money(authority.hardCapMinor)),
    autonomousCapDisplay: formatInr(money(authority.autonomousCapMinor)),
    forbiddenMaterials: [...authority.forbiddenMaterials],
  };
}

export function buildCanonicalKit(now: Date = new Date()): {
  cart: Cart;
  quote: FrozenQuote;
  glass: PolicyDecision;
  kettle: PolicyDecision;
} {
  const cart = createCart();
  const glass = addLine(cart.id, 'brewer.clear-glass-500').decision;
  const kettle = addLine(cart.id, 'kettle.road-mini').decision;
  addLine(cart.id, 'brewer.trailpress-steel-750');
  addLine(cart.id, 'grinder.pocket-lite');
  addLine(cart.id, 'filters.travel-30');
  const quote = freezeQuote(cart.id, now);
  if (quote.totalMinor !== CANONICAL_QUOTE_MINOR) {
    throw new Error('CANONICAL_TOTAL_MISMATCH');
  }
  return { cart, quote, glass, kettle };
}

export function getQuote(id: string): FrozenQuote | undefined {
  return quotes.get(id);
}

export function listQuotes(): FrozenQuote[] {
  return [...quotes.values()].reverse();
}

export function bindQuote(quoteId: string, checkoutId: string): FrozenQuote {
  const quote = quotes.get(quoteId);
  if (!quote) {
    throw new Error('QUOTE_NOT_FOUND');
  }
  if (quote.boundCheckoutId && quote.boundCheckoutId !== checkoutId) {
    throw new Error('QUOTE_ALREADY_BOUND');
  }
  quote.status = 'BOUND';
  quote.boundCheckoutId = checkoutId;
  return quote;
}

export function settleQuote(quoteId: string): FrozenQuote {
  const quote = quotes.get(quoteId);
  if (!quote) {
    throw new Error('QUOTE_NOT_FOUND');
  }
  quote.status = 'SETTLED';
  return quote;
}
