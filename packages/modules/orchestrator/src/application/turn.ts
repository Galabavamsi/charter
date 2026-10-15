import {
  buildSystemPrompt,
  type ChatMessage,
  type Conversation,
  type OrchestratorHooks,
} from '../domain/index.js';
import type { FireworksClient } from '../infrastructure/fireworks.js';
import { executeTool, normalizeToolName, parseToolArguments, type ToolTrace } from './execute.js';
import { summarizeToolResult } from './summary.js';
import { getQuote } from '@charter/commerce';

const MAX_ROUNDS = 12;
/** Recent messages (after the system prompt) sent to the model each round. */
export const MODEL_HISTORY_WINDOW = 24;

/**
 * Pay intent from the shopper's own words. A bare "yes" / "ok" only means pay
 * when a locked total already exists; otherwise it answers whatever was asked.
 */
export function isPayIntent(text: string, hasQuote = false): boolean {
  const trimmed = text
    .trim()
    .toLowerCase()
    .replace(/[.!?…]+$/u, '')
    .trim();
  if (/^(yes|y|ok|okay|sure)(\s+please)?$/u.test(trimmed)) {
    return hasQuote;
  }
  return (
    /^(proceed|pay|checkout)\b/u.test(trimmed) ||
    /\b(pay now|proceed to payment|razorpay)\b/u.test(trimmed)
  );
}

/**
 * What the model sees: today's system prompt (so prompt fixes and merchant edits
 * reach old threads) plus a recent window. The window always starts at a user
 * message, so an assistant tool_calls message never loses its tool results and
 * the current request is never cut. Stored history is left untouched.
 */
export function modelMessages(
  conversation: Conversation,
  windowSize: number = MODEL_HISTORY_WINDOW,
): ChatMessage[] {
  const history =
    conversation.messages[0]?.role === 'system'
      ? conversation.messages.slice(1)
      : conversation.messages;
  let start = Math.max(0, history.length - windowSize);
  while (start > 0 && history[start]?.role !== 'user') {
    start -= 1;
  }
  return [
    { role: 'system', content: buildSystemPrompt(conversation.tenantId) },
    ...history.slice(start),
  ];
}

export type TurnResult = {
  reply: string;
  traces: ToolTrace[];
  cartId: string | null;
  quoteId: string | null;
  checkout: unknown;
};

function finalReply(content: string | null, traces: ToolTrace[]): string {
  const text = content?.trim();
  if (text) {
    return text;
  }
  // Tools ran but the model said nothing: describe the last action, not a shrug.
  const last = traces.at(-1);
  return last ? summarizeToolResult(last.name, last.result) : 'Ready when you are.';
}

export async function runTurn(
  conversation: Conversation,
  text: string,
  client: FireworksClient,
  hooks: OrchestratorHooks = {},
): Promise<TurnResult> {
  if (conversation.messages.length === 0) {
    conversation.messages.push({
      role: 'system',
      content: buildSystemPrompt(conversation.tenantId),
    });
  }
  const hadQuote = Boolean(conversation.quoteId);
  conversation.messages.push({ role: 'user', content: text });
  const traces: ToolTrace[] = [];
  let checkout: unknown = null;

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const message = await client.complete(modelMessages(conversation), { hadQuote });
    conversation.messages.push(message);
    const calls = message.role === 'assistant' ? (message.tool_calls ?? []) : [];
    if (calls.length === 0) {
      checkout =
        (await maybePrepareCheckout(conversation, text, hadQuote, hooks, traces, checkout)) ??
        checkout;
      return {
        reply: finalReply(message.role === 'assistant' ? message.content : null, traces),
        traces,
        cartId: conversation.cartId,
        quoteId: conversation.quoteId,
        checkout,
      };
    }
    for (const call of calls) {
      const name = normalizeToolName(call.function.name);
      const args = parseToolArguments(call.function.arguments);
      const result = args
        ? await executeTool(conversation, name, args, hooks)
        : { error: 'TOOL_ARGS_INVALID', name };
      traces.push({ name, result });
      if (result && typeof result === 'object' && 'checkout' in result) {
        checkout = (result as { checkout: unknown }).checkout;
      }
      conversation.messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  checkout =
    (await maybePrepareCheckout(conversation, text, hadQuote, hooks, traces, checkout)) ?? checkout;
  return {
    reply:
      'Stopped after too many tool calls. The cart and quote on the server are unchanged from the last successful tool.',
    traces,
    cartId: conversation.cartId,
    quoteId: conversation.quoteId,
    checkout,
  };
}

async function maybePrepareCheckout(
  conversation: Conversation,
  text: string,
  hadQuote: boolean,
  hooks: OrchestratorHooks,
  traces: ToolTrace[],
  checkout: unknown,
): Promise<unknown> {
  if (checkout || !conversation.quoteId || !hooks.startCheckout || !isPayIntent(text, hadQuote)) {
    return checkout;
  }
  if (traces.some((row) => row.name === 'checkout.prepare')) {
    return checkout;
  }
  const result = await executeTool(conversation, 'checkout.prepare', {}, hooks);
  traces.push({ name: 'checkout.prepare', result });
  if (result && typeof result === 'object' && 'checkout' in result) {
    return (result as { checkout: unknown }).checkout;
  }
  return checkout;
}

export function conversationQuote(conversation: Conversation) {
  return conversation.quoteId ? getQuote(conversation.quoteId) : undefined;
}
