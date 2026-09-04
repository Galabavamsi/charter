export type ChatMessage = {
  role: 'you' | 'concierge';
  text: string;
  source?: 'voice';
  /** Client clock for live voice coalescing. Omitted on persisted threads. */
  at?: number;
};

export type StoredQuote = {
  id: string;
  totalDisplay: string;
  deliveryBy: string;
  merchant: string;
  discountMinor: string;
  lines: Array<{ sku: string; title: string; quantity: number }>;
};

export type StoredCart = {
  lines: Array<{ sku: string; quantity: number }>;
  totalDisplay?: string | null;
};

export type ChatThread = {
  id: string;
  conversationId: string | null;
  title: string;
  updatedAt: string;
  messages: ChatMessage[];
  quote: StoredQuote | null;
  cart?: StoredCart | null;
  shopSlug?: string;
  shopName?: string;
  pendingTurn?: string | null;
};

export type ThreadScope = {
  userId: string;
  shopId: string;
};

export type ThreadShopHint = {
  tenantId: string;
  slug: string;
  name: string;
};

export type ListedThread = ChatThread & {
  shopId: string;
  shopSlug: string;
  shopName: string;
};

export function threadStorageKey(scope: ThreadScope): string {
  return `charter.threads.v2.${encodeURIComponent(scope.userId)}.${encodeURIComponent(scope.shopId)}`;
}

function readAll(scope: ThreadScope): ChatThread[] {
  const raw = localStorage.getItem(threadStorageKey(scope));
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as ChatThread[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function newer<T extends ChatThread>(left: T, right: T): T {
  return right.updatedAt >= left.updatedAt ? right : left;
}

export function dedupeThreads<T extends ChatThread>(threads: T[]): T[] {
  const byId = new Map<string, T>();
  for (const thread of threads) {
    const existing = byId.get(thread.id);
    byId.set(thread.id, existing ? newer(existing, thread) : thread);
  }
  const byTitle = new Map<string, T>();
  for (const thread of byId.values()) {
    const existing = byTitle.get(thread.title);
    byTitle.set(thread.title, existing ? newer(existing, thread) : thread);
  }
  return [...byTitle.values()];
}

function writeAll(scope: ThreadScope, threads: ChatThread[]): void {
  localStorage.setItem(threadStorageKey(scope), JSON.stringify(dedupeThreads(threads)));
}

export function listThreads(scope: ThreadScope): ChatThread[] {
  return dedupeThreads(readAll(scope)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getThread(scope: ThreadScope, id: string): ChatThread | null {
  return (
    readAll(scope).find((row) => row.id === id) ??
    listAllUserThreads(scope.userId).find((row) => row.id === id) ??
    null
  );
}

export function openingThreadMessages(
  userId: string,
  shopId: string,
  threadId: string | null,
  seeded: ChatMessage[] = [],
): ChatMessage[] {
  if (seeded.length > 0) {
    return seeded;
  }
  if (!threadId) {
    return [];
  }
  return getThread({ userId, shopId }, threadId)?.messages ?? [];
}

export function upsertThread(scope: ThreadScope, thread: ChatThread): ChatThread {
  const next = [thread, ...readAll(scope).filter((row) => row.id !== thread.id)];
  writeAll(scope, next);
  return thread;
}

export function deleteThread(scope: ThreadScope, id: string): void {
  writeAll(
    scope,
    readAll(scope).filter((row) => row.id !== id),
  );
}

export function deleteUserThread(
  userId: string,
  thread: Pick<ListedThread, 'id' | 'shopId' | 'shopSlug'>,
): void {
  const shopIds = new Set([thread.shopId, thread.shopSlug]);
  for (const shopId of shopIds) {
    if (shopId) {
      deleteThread({ userId, shopId }, thread.id);
    }
  }
}

function resolveShop(
  storedShopId: string,
  thread: ChatThread,
  shops: readonly ThreadShopHint[],
): ThreadShopHint | undefined {
  return shops.find(
    (shop) =>
      shop.tenantId === storedShopId ||
      shop.slug === storedShopId ||
      shop.slug === thread.shopSlug ||
      shop.tenantId === thread.shopSlug,
  );
}

export function listAllUserThreads(
  userId: string,
  shops: readonly ThreadShopHint[] = [],
): ListedThread[] {
  if (!userId) {
    return [];
  }
  const prefix = `charter.threads.v2.${encodeURIComponent(userId)}.`;
  const rows: ListedThread[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(prefix)) {
      continue;
    }
    const storedShopId = decodeURIComponent(key.slice(prefix.length));
    for (const thread of readAll({ userId, shopId: storedShopId })) {
      const shop = resolveShop(storedShopId, thread, shops);
      rows.push({
        ...thread,
        shopId: shop?.tenantId ?? storedShopId,
        shopSlug: thread.shopSlug ?? shop?.slug ?? storedShopId,
        shopName: thread.shopName ?? shop?.name ?? shop?.slug ?? storedShopId,
      });
    }
  }
  const byShopId = new Map<string, ListedThread>();
  for (const row of rows) {
    const key = `${row.shopId}:${row.id}`;
    const existing = byShopId.get(key);
    byShopId.set(key, existing ? newer(existing, row) : row);
  }
  const byShopTitle = new Map<string, ListedThread>();
  for (const row of byShopId.values()) {
    const key = `${row.shopId}:${row.title}`;
    const existing = byShopTitle.get(key);
    byShopTitle.set(key, existing ? newer(existing, row) : row);
  }
  return [...byShopTitle.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function titleFrom(text: string): string {
  const clipped = text.replace(/\s+/g, ' ').trim();
  return clipped.length > 42 ? `${clipped.slice(0, 41)}…` : clipped || 'New chat';
}

export const UNBOUND_SHOP_ID = 'unbound';

export function isUnboundThread(thread: Pick<ListedThread, 'shopId' | 'shopSlug'>): boolean {
  return thread.shopId === UNBOUND_SHOP_ID || thread.shopSlug === UNBOUND_SHOP_ID;
}

export function consumePendingTurn(scope: ThreadScope, id: string): string | null {
  const thread = getThread(scope, id);
  const pending = thread?.pendingTurn?.trim() ?? '';
  if (!thread || !pending) {
    return null;
  }
  upsertThread(scope, { ...thread, pendingTurn: null });
  return pending;
}

export function clearUnboundThreads(userId: string): void {
  for (const thread of listThreads({ userId, shopId: UNBOUND_SHOP_ID })) {
    deleteThread({ userId, shopId: UNBOUND_SHOP_ID }, thread.id);
  }
}

export function bindUnboundChatToShop(input: {
  userId: string;
  unboundId: string | null;
  shop: { tenantId: string; slug: string; name: string };
  messages: ChatMessage[];
}): string {
  const id = crypto.randomUUID();
  const lastUser = [...input.messages].reverse().find((row) => row.role === 'you');
  upsertThread(
    { userId: input.userId, shopId: input.shop.tenantId },
    {
      id,
      conversationId: null,
      title: titleFrom(lastUser?.text ?? input.shop.name),
      updatedAt: new Date().toISOString(),
      messages: input.messages,
      quote: null,
      shopSlug: input.shop.slug,
      shopName: input.shop.name,
      pendingTurn: lastUser?.text ?? null,
    },
  );
  if (input.unboundId) {
    deleteThread({ userId: input.userId, shopId: UNBOUND_SHOP_ID }, input.unboundId);
  }
  return id;
}
