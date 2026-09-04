import {
  hydrateConversation,
  type ChatMessage,
  type Conversation,
  type ToolCall,
} from '@charter/orchestrator';
import type { PersistedConversationState } from './repository.js';

const CHECKOUT_HANDOFF_FIELDS = [
  'checkoutId',
  'keyId',
  'orderId',
  'amount',
  'currency',
  'name',
  'description',
  'receipt',
  'copy',
] as const;
const CHECKOUT_FREE_TEXT_FIELDS = new Set<string>(['name', 'description', 'copy']);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toolCall(value: unknown): ToolCall | undefined {
  const candidate = record(value);
  const fn = record(candidate?.function);
  if (
    !candidate ||
    candidate.type !== 'function' ||
    typeof candidate.id !== 'string' ||
    !fn ||
    typeof fn.name !== 'string' ||
    typeof fn.arguments !== 'string'
  ) {
    return undefined;
  }
  return {
    id: candidate.id,
    type: 'function',
    function: {
      name: fn.name,
      arguments: fn.arguments,
    },
  };
}

function chatMessage(value: unknown): ChatMessage | undefined {
  const candidate = record(value);
  if (!candidate) {
    return undefined;
  }
  if (
    (candidate.role === 'system' || candidate.role === 'user') &&
    typeof candidate.content === 'string'
  ) {
    return { role: candidate.role, content: candidate.content };
  }
  if (candidate.role === 'assistant') {
    if (candidate.content !== null && typeof candidate.content !== 'string') {
      return undefined;
    }
    if (candidate.tool_calls === undefined) {
      return { role: 'assistant', content: candidate.content };
    }
    if (!Array.isArray(candidate.tool_calls)) {
      return undefined;
    }
    const toolCalls: ToolCall[] = [];
    for (const rawToolCall of candidate.tool_calls) {
      const validatedToolCall = toolCall(rawToolCall);
      if (!validatedToolCall) {
        return undefined;
      }
      toolCalls.push(validatedToolCall);
    }
    return {
      role: 'assistant',
      content: candidate.content,
      tool_calls: toolCalls,
    };
  }
  if (
    candidate.role === 'tool' &&
    typeof candidate.tool_call_id === 'string' &&
    typeof candidate.content === 'string'
  ) {
    return {
      role: 'tool',
      tool_call_id: candidate.tool_call_id,
      content: candidate.content,
    };
  }
  return undefined;
}

export function validPersistedMessages(messages: readonly unknown[]): ChatMessage[] {
  return messages.flatMap((message) => {
    const validated = chatMessage(message);
    return validated ? [validated] : [];
  });
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, '[REDACTED_PAYMENT_CARD]')
    .replace(
      /\b(cvv|cvc|security\s+code)\s*[:=]?\s*\d{3,4}\b/gi,
      '$1 [REDACTED_PAYMENT_CREDENTIAL]',
    )
    .replace(
      /\b(api[_-]?key|key[_-]?secret|password)(["']?\s*[:=]\s*["']?)[^"',\s}]+/gi,
      '$1$2[REDACTED_SECRET]',
    );
}

function safePendingCheckout(
  value: unknown,
): Record<string, string | number | boolean | null> | null {
  const candidate = record(value);
  if (!candidate) {
    return null;
  }
  const safe: Record<string, string | number | boolean | null> = {};
  for (const field of CHECKOUT_HANDOFF_FIELDS) {
    const fieldValue = candidate[field];
    if (
      typeof fieldValue === 'string' ||
      typeof fieldValue === 'number' ||
      typeof fieldValue === 'boolean' ||
      fieldValue === null
    ) {
      safe[field] =
        typeof fieldValue === 'string' && CHECKOUT_FREE_TEXT_FIELDS.has(field)
          ? redactSensitiveText(fieldValue)
          : fieldValue;
    }
  }
  return Object.keys(safe).length > 0 ? safe : null;
}

export function persistedConversationState(
  conversation: Pick<Conversation, 'cartId' | 'quoteId' | 'catalogLoaded' | 'pendingCheckout'> & {
    messages: readonly unknown[];
  },
): PersistedConversationState {
  const messages = validPersistedMessages(conversation.messages).map((message): ChatMessage => {
    if (message.role === 'assistant') {
      return {
        role: 'assistant',
        content: message.content === null ? null : redactSensitiveText(message.content),
        ...(message.tool_calls === undefined
          ? {}
          : {
              tool_calls: message.tool_calls.map((toolCall) => ({
                ...toolCall,
                function: {
                  ...toolCall.function,
                  arguments: redactSensitiveText(toolCall.function.arguments),
                },
              })),
            }),
      };
    }
    if (message.role === 'tool') {
      return { ...message, content: redactSensitiveText(message.content) };
    }
    return { role: message.role, content: redactSensitiveText(message.content) };
  });
  return {
    cartId: conversation.cartId,
    quoteId: conversation.quoteId,
    catalogLoaded: conversation.catalogLoaded,
    pendingCheckout: safePendingCheckout(conversation.pendingCheckout),
    messages,
  };
}

function equalPersistedValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function reconcileField<T>(base: T, local: T, latest: T): T {
  if (equalPersistedValue(local, base)) {
    return latest;
  }
  if (equalPersistedValue(latest, base) || equalPersistedValue(local, latest)) {
    return local;
  }
  throw new Error('CONVERSATION_VERSION_CONFLICT');
}

function hasMessagePrefix(messages: readonly unknown[], prefix: readonly unknown[]): boolean {
  return (
    messages.length >= prefix.length &&
    prefix.every((message, index) => equalPersistedValue(messages[index], message))
  );
}

export function reconcilePersistedConversationState(
  base: PersistedConversationState,
  local: PersistedConversationState,
  latest: PersistedConversationState,
): PersistedConversationState {
  if (!hasMessagePrefix(local.messages, base.messages)) {
    throw new Error('CONVERSATION_VERSION_CONFLICT');
  }
  if (!hasMessagePrefix(latest.messages, base.messages)) {
    throw new Error('CONVERSATION_VERSION_CONFLICT');
  }
  return {
    cartId: reconcileField(base.cartId, local.cartId, latest.cartId),
    quoteId: reconcileField(base.quoteId, local.quoteId, latest.quoteId),
    catalogLoaded: reconcileField(base.catalogLoaded, local.catalogLoaded, latest.catalogLoaded),
    pendingCheckout: reconcileField(
      base.pendingCheckout,
      local.pendingCheckout,
      latest.pendingCheckout,
    ),
    messages: [
      ...structuredClone(latest.messages),
      ...structuredClone(local.messages.slice(base.messages.length)),
    ],
  };
}

export function hydratePersistedConversation(input: {
  id: string;
  tenantId: string;
  revision: number;
  state: PersistedConversationState;
}): Conversation {
  return hydrateConversation({
    id: input.id,
    tenantId: input.tenantId,
    revision: input.revision,
    ...input.state,
    messages: validPersistedMessages(input.state.messages),
  });
}
