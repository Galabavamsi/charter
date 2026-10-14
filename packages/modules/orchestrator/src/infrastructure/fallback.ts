import type { ChatMessage } from '../domain/index.js';
import { isPayIntent } from '../application/turn.js';
import { normalizeToolName } from '../application/execute.js';
import { summarizeToolResult, toolResultFailed } from '../application/summary.js';
import type { FireworksClient, ModelTurnContext } from './fireworks.js';

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
export function usesStructuredCheckout(text: string, hasQuote = false): boolean {
  const trimmed = text.trim();
  return CONFIRM_CART.test(trimmed) || BUY_NOW.test(trimmed) || isPayIntent(trimmed, hasQuote);
}

function lastUserIndex(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      return index;
    }
  }
  return -1;
}

function lastUserText(messages: ChatMessage[]): string {
  const message = messages[lastUserIndex(messages)];
  return message?.role === 'user' ? message.content : '';
}

/** This turn only: what happened after the shopper's latest message. */
function currentTurn(messages: ChatMessage[]): ChatMessage[] {
  return messages.slice(lastUserIndex(messages) + 1);
}

function completedTools(messages: ChatMessage[]): string[] {
  return messages.flatMap((message) =>
    message.role === 'assistant'
      ? (message.tool_calls ?? []).map((call) => normalizeToolName(call.function.name))
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
  return name ? { name: normalizeToolName(name), content: tool.content } : undefined;
}

function parseResult(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
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

/** Most recent cart line in any earlier tool result ("remove it from the cart"). */
function lastCartSku(messages: ChatMessage[]): string {
  for (const message of [...messages].reverse()) {
    if (message.role !== 'tool') {
      continue;
    }
    const result = parseResult(message.content) as
      { cart?: { lines?: Array<{ sku?: string }> } | null } | undefined;
    const line = result?.cart?.lines?.at(-1);
    if (line?.sku) {
      return line.sku;
    }
  }
  return '';
}

function productQuery(text: string, messages: ChatMessage[]): string {
  const tool = lastTool(messages);
  if (tool?.name === 'catalog.search') {
    const result = parseResult(tool.content) as
      { items?: Array<{ sku?: string; title?: string }> } | undefined;
    const lower = text.toLowerCase();
    const hit = (result?.items ?? []).find(
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
  }
  const stripped = text
    .replace(
      /\b(i'd like to|i would like to|please|can i|buy|add|order|get|want|need|set|change|remove|from(?: the)? cart|quantity|to)\b/gi,
      ' ',
    )
    // Articles and pronouns: "I want a grinder" should search "grinder", not "I a grinder".
    .replace(/\b(i|a|an|the|some|me|my|one|it)\b/gi, ' ')
    .replace(/[.!?,]+/g, ' ')
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
  messages: ChatMessage[],
  context: ModelTurnContext,
): { name: string; args: Record<string, unknown> } | null {
  const turn = currentTurn(messages);
  const names = completedTools(turn);
  const latest = lastTool(turn);
  // A denied add, an unknown sku, or a locked cart ends the turn here: never
  // lock (or pay for) a cart that does not hold what the shopper asked for.
  if (latest && toolResultFailed(parseResult(latest.content))) {
    return null;
  }
  const pay = isPayIntent(text, context.hadQuote);
  // Paying on a total that was already locked goes straight to checkout.
  const payOnLockedTotal = pay && context.hadQuote;
  if (CONFIRM_CART.test(text)) {
    if (!names.includes('cart.set_quantities')) {
      return { name: 'cart.set_quantities', args: { lines: parseConfirmLines(text) } };
    }
    if (/\bthen lock this total\b|\bbuy now\b/i.test(text) && !names.includes('checkout.quote')) {
      return { name: 'checkout.quote', args: {} };
    }
    if (pay && !names.includes('checkout.prepare')) {
      return { name: 'checkout.prepare', args: {} };
    }
    return null;
  }
  if (BROWSE_MORE.test(text) && latest?.name !== 'catalog.search') {
    return { name: 'catalog.search', args: { query: '' } };
  }
  const quantity = quantityIntent(text);
  const buy = BUY_INTENT.test(text) && !quantity && !BROWSE_MORE.test(text) && !BUY_NOW.test(text);
  // Plain add/want/need only adds; the total locks on Buy now or an explicit ask.
  const quote = (QUOTE_INTENT.test(text) || BUY_NOW.test(text)) && !payOnLockedTotal;
  if (quantity && !names.includes('cart.set_quantity')) {
    return {
      name: 'cart.set_quantity',
      args: { sku: productQuery(text, messages), quantity: quantity.quantity },
    };
  }
  if (quantity) {
    return null;
  }
  if (
    !names.includes('catalog.search') &&
    !pay &&
    !BUY_NOW.test(text) &&
    !QUOTE_INTENT.test(text)
  ) {
    return { name: 'catalog.search', args: { query: text } };
  }
  if (buy && !names.includes('cart.add_line')) {
    return { name: 'cart.add_line', args: { sku: productQuery(text, messages) } };
  }
  if ((quote || (pay && !payOnLockedTotal)) && !names.includes('checkout.quote')) {
    return { name: 'checkout.quote', args: {} };
  }
  if (pay && !names.includes('checkout.prepare')) {
    return { name: 'checkout.prepare', args: {} };
  }
  return null;
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
    async complete(messages, context = { hadQuote: false }) {
      const text = lastUserText(messages);
      const next = inferNextTool(text, messages, context);
      if (next) {
        return toolCall(next.name, next.args);
      }
      const tool = lastTool(currentTurn(messages));
      if (tool) {
        return {
          role: 'assistant',
          content: summarizeToolResult(tool.name, parseResult(tool.content)),
        };
      }
      return {
        role: 'assistant',
        content:
          'I can search the catalog, add an allowed item, lock this total, or prepare checkout. What do you need?',
      };
    },
  };
}

function logModelFallback(error: unknown): void {
  console.warn(
    JSON.stringify({
      level: 'warn',
      msg: 'llm_fallback',
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

export function createResilientModelClient(
  live: FireworksClient | null,
  onFallback: (error: unknown) => void = logModelFallback,
): FireworksClient {
  const fallback = createStructuredFallbackClient();
  if (!live) {
    return fallback;
  }
  return {
    async complete(messages, context) {
      try {
        return await live.complete(messages, context);
      } catch (error) {
        // The scripted client keeps checkout working, but a silent switch hides a
        // retired model or a bad key, so always leave a trace.
        onFallback(error);
        return fallback.complete(messages, context);
      }
    },
  };
}
