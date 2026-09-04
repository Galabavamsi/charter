import { randomUUID } from 'node:crypto';
import { DEFAULT_TENANT, requireMerchant } from '@charter/catalog';

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export type ToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

export type Conversation = {
  id: string;
  tenantId: string;
  revision: number;
  cartId: string | null;
  quoteId: string | null;
  catalogLoaded: boolean;
  pendingCheckout: unknown | null;
  messages: ChatMessage[];
};

const conversations = new Map<string, Conversation>();

export function resetConversations(): void {
  conversations.clear();
}

export function createConversation(tenantId: string = DEFAULT_TENANT): Conversation {
  requireMerchant(tenantId);
  const row: Conversation = {
    id: randomUUID(),
    tenantId,
    revision: 0,
    cartId: null,
    quoteId: null,
    catalogLoaded: false,
    pendingCheckout: null,
    messages: [],
  };
  conversations.set(row.id, row);
  return row;
}

export function hydrateConversation(conversation: Conversation): Conversation {
  requireMerchant(conversation.tenantId);
  const copy: Conversation = {
    ...conversation,
    messages: structuredClone(conversation.messages),
  };
  conversations.set(copy.id, copy);
  return copy;
}

export function getConversation(id: string): Conversation | undefined {
  return conversations.get(id);
}

export function evictConversation(id: string): boolean {
  return conversations.delete(id);
}

export function takePendingCheckout(conversation: Conversation): unknown | null {
  const pending = conversation.pendingCheckout;
  conversation.pendingCheckout = null;
  return pending;
}
