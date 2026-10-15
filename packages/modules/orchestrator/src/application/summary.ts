/** Buyer copy for tool error codes. Raw codes read as a broken demo. */
const ERROR_COPY: Record<string, string> = {
  QUOTE_LOCKED: 'This total is already locked. Pay it, or start a new chat to change the cart.',
  CART_NOT_FOUND: 'Your cart is empty. Tell me what to add.',
  CART_EMPTY: 'Your cart is empty, so there is no total to lock yet. Tell me what to add.',
  QUOTE_TOTAL_TOO_LOW: 'That total is too small to pay online. Add another item first.',
  QUOTE_NOT_FOUND: 'There is no locked total yet. Tap Buy now first.',
  SKU_UNKNOWN: "I couldn't find that item in this shop. Try Browse shop or use its name.",
  QUANTITY_INVALID: 'Pick a quantity between 0 and 99.',
  TOOL_ARGS_INVALID: "I didn't catch which item you meant. Could you say it again?",
  OUT_OF_STOCK: 'That item is out of stock right now.',
  HARD_CAP_EXCEEDED: "That total is over this shop's spending cap.",
  AUTHORITY_APPROVAL_REQUIRED: 'That total needs the shop to approve it before it can be locked.',
  PRODUCT_MATERIAL_FORBIDDEN: 'This shop does not allow that item.',
  FACTS_STALE:
    'Prices or stock changed since this total was locked. Say "lock this total" to refresh it.',
  CONFIG_PAYMENTS_NOT_READY: 'Payments are not set up on this deployment yet.',
  CHECKOUT_KILLED: 'Checkout is paused for this shop right now.',
  QUOTE_ALREADY_PAID: 'This order is already paid.',
  PAYMENT_AUTHORIZED: 'Your payment is authorized and waiting for capture. No need to pay again.',
  PAYMENT_REFUNDED: 'That payment was refunded. Start a new chat to order again.',
  RECONCILIATION_REQUIRED: 'The last payment is still being checked. Try Pay again in a moment.',
};

const GENERIC_ERROR = "That step didn't go through. Try again, or tap Buy now.";

type ToolResult = {
  error?: string;
  items?: Array<{ title?: string }>;
  decision?: { outcome?: string; message?: string };
  quote?: { totalDisplay?: string; status?: string } | null;
  checkout?: { status?: string } | null;
  cart?: { totals?: { totalDisplay?: string } | null; lines?: unknown[] } | null;
};

export function toolErrorCopy(code: string): string {
  return ERROR_COPY[code] ?? GENERIC_ERROR;
}

/** True when a tool result is an error or a Policy outcome other than allow. */
export function toolResultFailed(result: unknown): boolean {
  if (!result || typeof result !== 'object') {
    return false;
  }
  const row = result as ToolResult;
  return Boolean(row.error) || Boolean(row.decision && row.decision.outcome !== 'allow');
}

/** One short buyer sentence for what a tool just did. */
export function summarizeToolResult(name: string, raw: unknown): string {
  if (!raw || typeof raw !== 'object') {
    return 'Ready when you are.';
  }
  const result = raw as ToolResult;
  if (result.error) {
    if (result.error === 'QUOTE_LOCKED' && result.quote?.status === 'SETTLED') {
      return 'This order is already paid. Start a new chat for another order.';
    }
    return toolErrorCopy(result.error);
  }
  if (name === 'catalog.search' && Array.isArray(result.items)) {
    const titles = result.items
      .map((item) => item.title)
      .filter((title): title is string => Boolean(title))
      .slice(0, 6);
    return titles.length > 0
      ? `Available items:\n${titles.map((title) => `- ${title}`).join('\n')}`
      : 'The catalog has no matching items.';
  }
  if (name === 'cart.add_line') {
    if (result.decision?.outcome === 'deny' || result.decision?.outcome === 'require_approval') {
      return result.decision.message ?? 'That item is not in the allowed cart.';
    }
    return 'Added to your cart. Change quantity on the card if you need to, then Buy now.';
  }
  if (name === 'cart.set_quantity' || name === 'cart.set_quantities') {
    if (result.decision?.outcome === 'deny' || result.decision?.outcome === 'require_approval') {
      return result.decision.message ?? 'That quantity is not in the allowed cart.';
    }
    const cart = result.cart ?? undefined;
    if (cart && Array.isArray(cart.lines) && cart.lines.length === 0) {
      return 'Removed from your cart.';
    }
    return cart?.totals?.totalDisplay
      ? `Quantity updated. Cart total: ${cart.totals.totalDisplay}. Change quantity on the card, then Buy now.`
      : 'Quantity updated. Change quantity on the card, then Buy now.';
  }
  if (name === 'cart.get' && result.cart?.totals?.totalDisplay) {
    return `Your cart total is ${result.cart.totals.totalDisplay}.`;
  }
  if (name === 'checkout.quote' && result.quote?.totalDisplay) {
    return `Locked total ${result.quote.totalDisplay}. Review the amount, then pay.`;
  }
  if (name === 'checkout.prepare' && result.checkout) {
    return result.checkout.status === 'SETTLED'
      ? 'Payment captured. Your order is confirmed.'
      : 'Checkout is ready on the same frozen quote.';
  }
  return 'Ready when you are.';
}
