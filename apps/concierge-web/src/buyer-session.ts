import { getThread } from './threads';

export type LastShopSession = {
  slug: string;
  tenantId: string;
  threadId: string | null;
};

export const DEFAULT_SIGNED_IN_PATH = '/chats';
export const NORTHSTAR_SLUG = 'northstar';

export function lastShopStorageKey(userId: string): string {
  return `charter.lastShop.v1.${encodeURIComponent(userId)}`;
}

export function getLastShop(userId: string): LastShopSession | null {
  if (!userId) {
    return null;
  }
  const raw = localStorage.getItem(lastShopStorageKey(userId));
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as LastShopSession;
    if (typeof parsed?.slug !== 'string' || typeof parsed?.tenantId !== 'string') {
      return null;
    }
    if (!parsed.slug || !parsed.tenantId) {
      return null;
    }
    return {
      slug: parsed.slug,
      tenantId: parsed.tenantId,
      threadId: typeof parsed.threadId === 'string' && parsed.threadId ? parsed.threadId : null,
    };
  } catch {
    return null;
  }
}

export function rememberLastShop(userId: string, session: LastShopSession): void {
  if (!userId) {
    return;
  }
  localStorage.setItem(lastShopStorageKey(userId), JSON.stringify(session));
}

export function lastShopResumePath(
  userId: string,
  last: LastShopSession,
  publishedSlugs: ReadonlySet<string>,
): string | null {
  if (!publishedSlugs.has(last.slug)) {
    return null;
  }
  if (last.threadId && getThread({ userId, shopId: last.tenantId }, last.threadId)) {
    return `/buyer/${encodeURIComponent(last.slug)}/chat/${encodeURIComponent(last.threadId)}`;
  }
  return `/buyer/${encodeURIComponent(last.slug)}`;
}

export function buyerBuyDraft(title: string): string {
  return `I'd like to buy ${title}.`;
}

export function buyerAskDraft(title: string): string {
  return `I have a question about ${title}.`;
}

export function groundedConciergeCopy(): string {
  return '';
}

const BUYER_ERROR_COPY: Record<string, string> = {
  CHECKOUT_KILLED: 'Payments are paused for this shop. Try again later.',
  FACTS_STALE: 'The quote changed. Ask Concierge to freeze a new quote before paying.',
  RECONCILIATION_REQUIRED:
    'The last payment is still being confirmed. Wait a moment, then retry the same order.',
  QUOTE_NOT_FOUND: 'There is no frozen quote yet. Ask Concierge to freeze one first.',
  CART_NOT_FOUND: 'The cart is missing. Ask Concierge to add an item again.',
  SKU_UNKNOWN: 'That product is not in this shop’s catalog.',
  OUT_OF_STOCK: 'That item is out of stock in this shop.',
  HARD_CAP_EXCEEDED: 'This cart is over the shop’s payment cap. Remove a line and try again.',
  PRODUCT_MATERIAL_FORBIDDEN: 'This shop’s policy blocks that material.',
  AUTHORITY_APPROVAL_REQUIRED: 'This shop needs approval before that change.',
  OFFER_MARGIN_FLOOR: 'A catalog offer cannot apply to this mix. The quote stayed as priced.',
  CONVERSATION_VERSION_CONFLICT: 'This chat was updated elsewhere. Refresh and send again.',
  CHECKOUT_ERROR: 'Checkout could not start. Check the quote and try again.',
  CHECKOUT_SCRIPT_FAILED:
    'Razorpay Checkout could not open. Allow checkout.razorpay.com and try Pay again.',
  CHECKOUT_TIMEOUT: 'Razorpay Checkout did not open in time. Try Pay again.',
  TURN_TIMEOUT: 'Buy now took too long. Try Buy now again.',
  CONVERSATION_ERROR: 'Concierge could not complete that turn. Send the message again.',
};

export function buyerFacingError(code: string): string {
  const known = BUYER_ERROR_COPY[code];
  if (known) {
    return known;
  }
  return `That step did not complete (${code}). Try again, or continue in this chat.`;
}

export function conciergeWorkCopy(text: string): string {
  const trimmed = text.trim();
  if (/^put these in my cart/i.test(trimmed) && /\b(lock this total|buy now)\b/i.test(trimmed)) {
    return 'Putting your picks in the cart, then locking today’s prices…';
  }
  if (/^put these in my cart/i.test(trimmed)) {
    return 'Writing these quantities into the cart…';
  }
  if (/^buy now$/i.test(trimmed)) {
    return 'Locking the cart total against this shop’s catalog…';
  }
  if (/^set\b[\s\S]+quantity to/i.test(trimmed) || /^remove\b[\s\S]+from cart/i.test(trimmed)) {
    return 'Updating cart quantities…';
  }
  if (/\b(what|show|browse|available|products|catalog|which)\b/i.test(trimmed)) {
    return 'Searching this shop’s published catalog…';
  }
  if (/\b(add|buy|want|need|order|gift)\b/i.test(trimmed)) {
    return 'Matching that against this shop’s catalog…';
  }
  return 'Running Concierge tools on this shop…';
}

export function razorpayWorkCopy(
  stage: 'create-order' | 'open-checkout' | 'pay-window' | 'check-status',
): string {
  if (stage === 'create-order') {
    return 'Creating the Razorpay order for this locked total…';
  }
  if (stage === 'open-checkout') {
    return 'Opening Razorpay Checkout…';
  }
  if (stage === 'pay-window') {
    return 'Pay in the Razorpay window.';
  }
  return 'Checking this payment with Razorpay…';
}

export function orderConfirmedCopy(
  quote: {
    totalDisplay: string;
    deliveryBy: string;
    lines: Array<{ title: string; quantity: number }>;
  } | null,
  session: { status: string; copy: string },
): string {
  if (session.status !== 'SETTLED') {
    return session.copy;
  }
  if (!quote?.lines.length) {
    return session.copy;
  }
  const lines = quote.lines.map((line) => `${line.title} × ${line.quantity}`).join('\n');
  return [
    `Payment captured. Order confirmed for ${quote.totalDisplay}.`,
    lines,
    `Shop fulfillment window ${quote.deliveryBy} (next Sunday — not a carrier ETA).`,
  ].join('\n\n');
}
