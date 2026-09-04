import { getTenantVariant, listVariants } from '@charter/catalog';
import {
  addLine,
  cartTotals,
  createCart,
  freezeQuote,
  getCart,
  getQuote,
  listCatalog,
  previewReplace,
  setLineQuantity,
  setLineQuantities,
} from '@charter/commerce';
import type { Conversation, OrchestratorHooks } from '../domain/index.js';

export type ToolTrace = {
  name: string;
  result: unknown;
};

const BROWSE_WORDS = new Set([
  'what',
  'which',
  'are',
  'the',
  'products',
  'product',
  'available',
  'aviable',
  'show',
  'list',
  'please',
  'give',
  'catalog',
  'items',
  'item',
  'shop',
  'store',
  'all',
  'any',
  'some',
  'have',
  'you',
  'your',
  'sell',
  'selling',
]);

function haystack(row: {
  sku: string;
  title: string;
  material?: string;
  aliases?: readonly string[];
}): string {
  return [row.sku, row.title, row.material ?? '', ...(row.aliases ?? [])].join(' ').toLowerCase();
}

function resolveSku(tenantId: string, input: string): string | undefined {
  const trimmed = input.trim();
  if (getTenantVariant(tenantId, trimmed)) {
    return trimmed;
  }
  const needle = trimmed.toLowerCase();
  return listVariants(tenantId).find((row) => haystack(row).includes(needle))?.sku;
}

function searchCatalog(tenantId: string, rawQuery: string) {
  const all = listCatalog(tenantId);
  const query = rawQuery.trim().toLowerCase();
  if (!query) {
    return all;
  }
  const tokens = query
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !BROWSE_WORDS.has(token));
  if (tokens.length === 0) {
    return all;
  }
  const variants = listVariants(tenantId);
  const hit = all.filter((item) => {
    const row = variants.find((variant) => variant.sku === item.sku);
    const text = haystack({ ...item, aliases: row?.aliases ?? [], material: item.material });
    return tokens.some((token) => text.includes(token));
  });
  return hit.length > 0 ? hit : all;
}

function serializeTotals(cartId: string | null) {
  if (!cartId) {
    return null;
  }
  const totals = cartTotals(cartId);
  if (!totals) {
    return null;
  }
  return {
    subtotalMinor: totals.subtotalMinor.toString(),
    discountMinor: totals.discountMinor.toString(),
    totalMinor: totals.totalMinor.toString(),
    totalDisplay: totals.totalDisplay,
    offer: totals.discountMinor > 0n ? 'filters_bundle_minus_100' : null,
  };
}

function parseQuantity(raw: unknown): number | null {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value < 0 || value > 99) {
    return null;
  }
  return value;
}

function serializeCart(cartId: string | null) {
  if (!cartId) {
    return null;
  }
  const cart = getCart(cartId);
  if (!cart) {
    return null;
  }
  return {
    ...cart,
    approvedThroughMinor: cart.approvedThroughMinor.toString(),
    totals: serializeTotals(cartId),
  };
}

function nextHint(cartId: string | null, quoteId: string | null): string | null {
  if (quoteId) {
    return 'checkout.prepare if the shopper asked to pay; otherwise stop';
  }
  const cart = cartId ? getCart(cartId) : undefined;
  if (cart && cart.lines.length > 0) {
    return 'checkout.quote now';
  }
  return 'cart.add_line for what the shopper asked for';
}

async function applySetQuantity(
  conversation: Conversation,
  requested: string,
  rawQuantity: unknown,
  hooks: OrchestratorHooks,
) {
  if (conversation.quoteId) {
    return { error: 'QUOTE_LOCKED' as const };
  }
  const sku = resolveSku(conversation.tenantId, requested);
  if (!sku) {
    return { error: 'SKU_UNKNOWN' as const, requested };
  }
  const quantity = parseQuantity(rawQuantity);
  if (quantity === null) {
    return { error: 'QUANTITY_INVALID' as const };
  }
  if (!conversation.cartId) {
    if (quantity === 0) {
      return { cart: null, next: nextHint(null, conversation.quoteId) };
    }
    const cart = createCart(conversation.tenantId);
    conversation.cartId = cart.id;
  }
  try {
    const result = setLineQuantity(conversation.cartId, sku, quantity);
    await hooks.persistCart?.(result.cart.id);
    return {
      decision: result.decision,
      cart: serializeCart(result.cart.id),
      cartUnchanged: result.decision.outcome !== 'allow',
      next: nextHint(result.cart.id, conversation.quoteId),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'CART_ERROR' };
  }
}

function serializeQuote(quoteId: string | null) {
  const quote = quoteId ? getQuote(quoteId) : undefined;
  if (!quote) {
    return null;
  }
  return {
    id: quote.id,
    status: quote.status,
    totalDisplay: quote.totalDisplay,
    totalMinor: quote.totalMinor.toString(),
    discountMinor: quote.discountMinor.toString(),
    deliveryBy: quote.deliveryBy,
    merchant: quote.merchant,
    lines: quote.lines.map((line) => ({
      sku: line.sku,
      title: line.title,
      quantity: line.quantity,
    })),
  };
}

export async function executeTool(
  conversation: Conversation,
  name: string,
  rawArgs: Record<string, unknown>,
  hooks: OrchestratorHooks,
): Promise<unknown> {
  switch (name) {
    case 'catalog.search': {
      conversation.catalogLoaded = true;
      const query = typeof rawArgs.query === 'string' ? rawArgs.query : '';
      const items = searchCatalog(conversation.tenantId, query);
      await hooks.recordCatalogSearch?.({ query, items });
      return { items, next: nextHint(conversation.cartId, conversation.quoteId) };
    }
    case 'cart.create': {
      const cart = createCart(conversation.tenantId);
      conversation.cartId = cart.id;
      await hooks.persistCart?.(cart.id);
      return { cart: serializeCart(cart.id) };
    }
    case 'cart.get': {
      const cart = serializeCart(conversation.cartId);
      if (!cart) {
        return { error: 'CART_NOT_FOUND' };
      }
      return { cart, next: nextHint(conversation.cartId, conversation.quoteId) };
    }
    case 'cart.add_line': {
      const requested = typeof rawArgs.sku === 'string' ? rawArgs.sku : '';
      const sku = resolveSku(conversation.tenantId, requested);
      if (!sku) {
        return { error: 'SKU_UNKNOWN', requested };
      }
      if (!conversation.cartId) {
        const cart = createCart(conversation.tenantId);
        conversation.cartId = cart.id;
      }
      const result = addLine(conversation.cartId, sku);
      await hooks.persistCart?.(result.cart.id);
      return {
        decision: result.decision,
        cart: serializeCart(result.cart.id),
        cartUnchanged: result.decision.outcome !== 'allow',
        next: nextHint(result.cart.id, conversation.quoteId),
      };
    }
    case 'cart.set_quantity': {
      const requested = typeof rawArgs.sku === 'string' ? rawArgs.sku : '';
      try {
        return await applySetQuantity(conversation, requested, rawArgs.quantity, hooks);
      } catch (error) {
        return { error: error instanceof Error ? error.message : 'CART_ERROR' };
      }
    }
    case 'cart.set_quantities': {
      if (conversation.quoteId) {
        return { error: 'QUOTE_LOCKED' };
      }
      const rawLines = Array.isArray(rawArgs.lines) ? rawArgs.lines : [];
      if (rawLines.length === 0) {
        return { error: 'QUANTITY_INVALID' };
      }
      const lines: Array<{ sku: string; quantity: number }> = [];
      for (const row of rawLines) {
        const line =
          row && typeof row === 'object' ? (row as { sku?: unknown; quantity?: unknown }) : {};
        const requested = typeof line.sku === 'string' ? line.sku : '';
        const sku = resolveSku(conversation.tenantId, requested);
        if (!sku) {
          return { error: 'SKU_UNKNOWN', requested };
        }
        const quantity = parseQuantity(line.quantity);
        if (quantity === null) {
          return { error: 'QUANTITY_INVALID' };
        }
        lines.push({ sku, quantity });
      }
      if (!conversation.cartId) {
        const hasAdd = lines.some((line) => line.quantity > 0);
        if (!hasAdd) {
          return { cart: null, next: nextHint(null, conversation.quoteId) };
        }
        const cart = createCart(conversation.tenantId);
        conversation.cartId = cart.id;
      }
      try {
        const result = setLineQuantities(conversation.cartId, lines);
        await hooks.persistCart?.(result.cart.id);
        return {
          decision: result.decision,
          cart: serializeCart(result.cart.id),
          cartUnchanged: result.decision.outcome !== 'allow',
          next: nextHint(result.cart.id, conversation.quoteId),
        };
      } catch (error) {
        return { error: error instanceof Error ? error.message : 'CART_ERROR' };
      }
    }
    case 'cart.preview_replace': {
      if (!conversation.cartId) {
        return { error: 'CART_NOT_FOUND' };
      }
      const fromSku =
        resolveSku(
          conversation.tenantId,
          typeof rawArgs.fromSku === 'string' ? rawArgs.fromSku : '',
        ) ?? '';
      const toSku =
        resolveSku(conversation.tenantId, typeof rawArgs.toSku === 'string' ? rawArgs.toSku : '') ??
        '';
      if (!fromSku || !toSku) {
        return { error: 'SKU_UNKNOWN' };
      }
      const preview = previewReplace(conversation.cartId, fromSku, toSku);
      if (preview.approval) {
        await hooks.persistApproval?.(preview.approval.id);
      }
      return {
        decision: preview.decision,
        proposedDisplay: preview.proposedDisplay,
        proposedTotalMinor: preview.proposedTotalMinor.toString(),
        cartUnchanged: preview.cartUnchanged,
        approval: preview.approval
          ? {
              id: preview.approval.id,
              status: preview.approval.status,
              proposedDisplay: preview.approval.proposedDisplay,
            }
          : null,
        next:
          preview.decision.outcome === 'require_approval'
            ? 'Register must approve before that swap is in the cart; quote the current allowed cart'
            : nextHint(conversation.cartId, conversation.quoteId),
      };
    }
    case 'checkout.quote': {
      if (!conversation.cartId) {
        return { error: 'CART_NOT_FOUND' };
      }
      try {
        const quote = freezeQuote(conversation.cartId);
        conversation.quoteId = quote.id;
        await hooks.persistQuote?.(quote.id);
        return { quote: serializeQuote(quote.id) };
      } catch (error) {
        return { error: error instanceof Error ? error.message : 'QUOTE_ERROR' };
      }
    }
    case 'checkout.prepare': {
      if (!conversation.quoteId) {
        return { error: 'QUOTE_NOT_FOUND' };
      }
      if (!hooks.startCheckout) {
        return { error: 'CONFIG_PAYMENTS_NOT_READY' };
      }
      try {
        const checkout = await hooks.startCheckout(conversation.quoteId);
        await hooks.persistCheckout?.(checkout.checkoutId);
        return { checkout, quote: serializeQuote(conversation.quoteId) };
      } catch (error) {
        return { error: error instanceof Error ? error.message : 'CHECKOUT_ERROR' };
      }
    }
    default:
      return { error: 'TOOL_UNKNOWN', name };
  }
}

export function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
