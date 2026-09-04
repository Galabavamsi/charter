import type { ChatMessage } from '../domain/index.js';
import { isPayIntent } from '../application/turn.js';
import type { FireworksClient } from './fireworks.js';

const BUY_INTENT = /\b(buy|add|order|get|want|need)\b/i;
const BUY_NOW = /\bbuy now\b/i;
const QUOTE_INTENT =
  /\b(lock this total|buy now|log the total|freeze(?: a)? quote|quote|checkout|pay)\b/i;
const SET_QUANTITY = /\b(?:set|change)\b[\s\S]{0,80}?\bquantity\s+to\s+(\d+)\b/i;
const REMOVE_FROM_CART = /\bremove\b[\s\S]{0,80}?\bfrom(?:\s+the)?\s+cart\b/i;
const ONLY_COUNT = /\bonly\s+(\d+)\b/i;
const BROWSE_MORE = /\b(more products|view more|show more|what else|browse)\b/i;
const CONFIRM_CART = /^put these in my cart/i;

/** Machine checkout turns. Do not wait on the live model. */
export function usesStructuredCheckout(text: string): boolean {
  const trimmed = text.trim();
  return CONFIRM_CART.test(trimmed) || BUY_NOW.test(trimmed) || isPayIntent(trimmed);
}

function lastUserText(messages: ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') {
      return message.content;
    }
  }
  return '';
}

function completedTools(messages: ChatMessage[]): string[] {
  return messages.flatMap((message) =>
    message.role === 'assistant'
      ? (message.tool_calls ?? []).map((call) => call.function.name)
      : [],
  );
}

function lastTool(messages: ChatMessage[]): { name: string; content: string } | undefined {
  const tool = [...messages].reverse().find((message) => message.role === 'tool');
  if (!tool || tool.role !== 'tool') {
    return undefined;
  }
  const assistant = [...messages]
    .reverse()
    .find((message) => message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0);
  const name =
    assistant && assistant.role === 'assistant'
      ? assistant.tool_calls?.[assistant.tool_calls.length - 1]?.function.name
      : undefined;
  return name ? { name, content: tool.content } : undefined;
}

function quantityIntent(text: string): { quantity: number } | null {
  if (REMOVE_FROM_CART.test(text)) {
    return { quantity: 0 };
  }
  const set = text.match(SET_QUANTITY);
  if (set) {
    return { quantity: Number(set[1]) };
  }
  const only = text.match(ONLY_COUNT);
  if (only) {
    return { quantity: Number(only[1]) };
  }
  return null;
}

function lastCartSku(messages: ChatMessage[]): string {
  const tool = lastTool(messages);
  if (!tool) {
    return '';
  }
  try {
    const result = JSON.parse(tool.content) as {
      cart?: { lines?: Array<{ sku?: string }> };
    };
    const line = result.cart?.lines?.at(-1);
    if (line?.sku) {
      return line.sku;
    }
  } catch {
    /* use empty */
  }
  return '';
}

function productQuery(text: string, messages: ChatMessage[]): string {
  const tool = lastTool(messages);
  if (tool?.name === 'catalog.search') {
    try {
      const result = JSON.parse(tool.content) as {
        items?: Array<{ sku?: string; title?: string }>;
      };
      const lower = text.toLowerCase();
      const hit = (result.items ?? []).find(
        (item) =>
          (item.title && lower.includes(item.title.toLowerCase())) ||
          (item.sku && lower.includes(item.sku.toLowerCase())),
      );
      if (hit?.sku) {
        return hit.sku;
      }
      if (hit?.title) {
        return hit.title;
      }
    } catch {
      /* use stripped text */
    }
  }
  const stripped = text
    .replace(
      /\b(i'd like to|i would like to|please|can i|buy|add|order|get|want|need|set|change|remove|from(?: the)? cart|quantity|to)\b/gi,
      ' ',
    )
    .replace(/\b\d+\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped || lastCartSku(messages);
}

function parseConfirmLines(text: string): Array<{ sku: string; quantity: number }> {
  const body = text
    .replace(/^put these in my cart, exactly:\s*/i, '')
    .replace(/\.?\s*(do not lock|then lock)[\s\S]*$/i, '')
    .trim();
  return [...body.matchAll(/([^;]+?)\s*[×x]\s*(\d+)/g)].flatMap((match) => {
    const sku = match[1]?.trim();
    const quantity = Number(match[2]);
    return sku && Number.isInteger(quantity) ? [{ sku, quantity }] : [];
  });
}

function inferNextTool(
  text: string,
  names: string[],
  messages: ChatMessage[],
): { name: string; args: Record<string, unknown> } | null {
  if (CONFIRM_CART.test(text)) {
    if (!names.includes('cart.set_quantities')) {
      return { name: 'cart.set_quantities', args: { lines: parseConfirmLines(text) } };
    }
    if (/\bthen lock this total\b|\bbuy now\b/i.test(text) && !names.includes('checkout.quote')) {
      return { name: 'checkout.quote', args: {} };
    }
    if (isPayIntent(text) && !names.includes('checkout.prepare')) {
      return { name: 'checkout.prepare', args: {} };
    }
    return null;
  }
  if (BROWSE_MORE.test(text) && lastTool(messages)?.name !== 'catalog.search') {
    return { name: 'catalog.search', args: { query: '' } };
  }
  const quantity = quantityIntent(text);
  const buy = BUY_INTENT.test(text) && !quantity && !BROWSE_MORE.test(text) && !BUY_NOW.test(text);
  const quote = QUOTE_INTENT.test(text) || buy || BUY_NOW.test(text);
  const pay = isPayIntent(text);
  if (quantity && !names.includes('cart.set_quantity')) {
    return {
      name: 'cart.set_quantity',
      args: { sku: productQuery(text, messages), quantity: quantity.quantity },
    };
  }
  if (quantity) {
    return null;
  }
  if (!names.includes('catalog.search') && !BUY_NOW.test(text) && !QUOTE_INTENT.test(text)) {
    return { name: 'catalog.search', args: { query: text } };
  }
  if (buy && !names.includes('cart.add_line')) {
    return { name: 'cart.add_line', args: { sku: productQuery(text, messages) } };
  }
  if ((quote || pay) && !names.includes('checkout.quote')) {
    return { name: 'checkout.quote', args: {} };
  }
  if (pay && !names.includes('checkout.prepare')) {
    return { name: 'checkout.prepare', args: {} };
  }
  return null;
}

function summarizeTool(name: string, content: string): string {
  try {
    const result = JSON.parse(content) as {
      error?: string;
      items?: Array<{ title?: string }>;
      decision?: { outcome?: string; message?: string };
      quote?: { totalDisplay?: string };
      checkout?: unknown;
    };
    if (result.error) {
      return `I could not complete that. ${result.error}`;
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
      const total =
        result && typeof result === 'object' && 'cart' in result
          ? (result as { cart?: { totals?: { totalDisplay?: string }; lines?: unknown[] } }).cart
          : undefined;
      if (total && Array.isArray(total.lines) && total.lines.length === 0) {
        return 'Removed from your cart.';
      }
      return total?.totals?.totalDisplay
        ? `Quantity updated. Cart total: ${total.totals.totalDisplay}. Change quantity on the card, then Buy now.`
        : 'Quantity updated. Change quantity on the card, then Buy now.';
    }
    if (name === 'checkout.quote' && result.quote?.totalDisplay) {
      return `Locked total ${result.quote.totalDisplay}. Review the amount, then pay.`;
    }
    if (name === 'checkout.prepare' && result.checkout) {
      return 'Checkout is ready on the same frozen quote.';
    }
  } catch {
    return 'Ready when you are.';
  }
  return 'Ready when you are.';
}

function toolCall(name: string, args: Record<string, unknown>): ChatMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: `fallback_${name.replace('.', '_')}_${Date.now().toString(36)}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

export function createStructuredFallbackClient(): FireworksClient {
  return {
    async complete(messages) {
      const text = lastUserText(messages);
      const next = inferNextTool(text, completedTools(messages), messages);
      if (next) {
        return toolCall(next.name, next.args);
      }
      const tool = lastTool(messages);
      if (tool) {
        return { role: 'assistant', content: summarizeTool(tool.name, tool.content) };
      }
      return {
        role: 'assistant',
        content:
          'I can search the catalog, add an allowed item, lock this total, or prepare checkout. What do you need?',
      };
    },
  };
}

export function createResilientModelClient(live: FireworksClient | null): FireworksClient {
  const fallback = createStructuredFallbackClient();
  if (!live) {
    return fallback;
  }
  return {
    async complete(messages) {
      try {
        return await live.complete(messages);
      } catch {
        return fallback.complete(messages);
      }
    },
  };
}
