import { buildSystemPrompt, type Conversation, type OrchestratorHooks } from '../domain/index.js';
import type { FireworksClient } from '../infrastructure/fireworks.js';
import { executeTool, parseToolArguments, type ToolTrace } from './execute.js';
import { getQuote } from '@charter/commerce';

const MAX_ROUNDS = 12;

export function isPayIntent(text: string): boolean {
  const trimmed = text
    .trim()
    .toLowerCase()
    .replace(/[.!?…]+$/u, '')
    .trim();
  if (/^(yes|y|ok|okay|sure)(\s+please)?$/u.test(trimmed)) {
    return true;
  }
  return (
    /^(proceed|pay|checkout)\b/u.test(trimmed) ||
    /\b(pay now|proceed to payment|razorpay)\b/u.test(trimmed)
  );
}

export type TurnResult = {
  reply: string;
  traces: ToolTrace[];
  cartId: string | null;
  quoteId: string | null;
  checkout: unknown;
};

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
  conversation.messages.push({ role: 'user', content: text });
  const traces: ToolTrace[] = [];
  let checkout: unknown = null;

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const message = await client.complete(conversation.messages);
    conversation.messages.push(message);
    const calls = message.role === 'assistant' ? (message.tool_calls ?? []) : [];
    if (calls.length === 0) {
      checkout =
        (await maybePrepareCheckout(conversation, text, hooks, traces, checkout)) ?? checkout;
      return {
        reply: message.content?.trim() || 'Ready when you are.',
        traces,
        cartId: conversation.cartId,
        quoteId: conversation.quoteId,
        checkout,
      };
    }
    for (const call of calls) {
      const result = await executeTool(
        conversation,
        call.function.name,
        parseToolArguments(call.function.arguments),
        hooks,
      );
      traces.push({ name: call.function.name, result });
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

  checkout = (await maybePrepareCheckout(conversation, text, hooks, traces, checkout)) ?? checkout;
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
  hooks: OrchestratorHooks,
  traces: ToolTrace[],
  checkout: unknown,
): Promise<unknown> {
  if (checkout || !conversation.quoteId || !hooks.startCheckout || !isPayIntent(text)) {
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
