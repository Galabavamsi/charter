// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import {
  bindUnboundChatToShop,
  consumePendingTurn,
  deleteThread,
  getThread,
  listAllUserThreads,
  listThreads,
  openingThreadMessages,
  threadStorageKey,
  UNBOUND_SHOP_ID,
  upsertThread,
  type ChatThread,
  type ThreadScope,
} from './threads';

const northstar: ThreadScope = {
  userId: 'user-1',
  shopId: 'northstar-demo-in',
};
const indigo: ThreadScope = {
  userId: 'user-1',
  shopId: 'indigo-desk-in',
};

function thread(id: string, title: string): ChatThread {
  return {
    id,
    conversationId: null,
    title,
    updatedAt: '2026-08-23T00:00:00.000Z',
    messages: [],
    quote: null,
  };
}

describe('tenant-scoped chat threads', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('isolates the same authenticated user across shops', () => {
    upsertThread(northstar, thread('shared-id', 'Northstar chat'));
    upsertThread(indigo, thread('shared-id', 'Indigo chat'));

    expect(listThreads(northstar).map((item) => item.title)).toEqual(['Northstar chat']);
    expect(listThreads(indigo).map((item) => item.title)).toEqual(['Indigo chat']);
    expect(threadStorageKey(northstar)).not.toBe(threadStorageKey(indigo));
  });

  it('isolates two authenticated users in the same shop', () => {
    const otherUser = { ...northstar, userId: 'user-2' };
    upsertThread(northstar, thread('thread-a', 'First buyer'));
    upsertThread(otherUser, thread('thread-b', 'Second buyer'));

    expect(getThread(northstar, 'thread-b')).toBeNull();
    expect(listThreads(otherUser)).toHaveLength(1);
  });

  it('safely ignores email-keyed legacy chat storage', () => {
    localStorage.setItem(
      'charter.threads.buyer@example.com',
      JSON.stringify([thread('old', 'Old')]),
    );

    expect(listThreads(northstar)).toEqual([]);
  });

  it('deletes only inside the requested user and shop scope', () => {
    upsertThread(northstar, thread('same', 'Northstar'));
    upsertThread(indigo, thread('same', 'Indigo'));

    deleteThread(northstar, 'same');

    expect(listThreads(northstar)).toEqual([]);
    expect(getThread(indigo, 'same')?.title).toBe('Indigo');
  });

  it('deduplicates the same title in one shop and lists chats across shops', () => {
    upsertThread(northstar, thread('thread-a', 'surprise gift'));
    upsertThread(northstar, {
      ...thread('thread-b', 'surprise gift'),
      updatedAt: '2026-08-22T00:00:00.000Z',
    });
    upsertThread(indigo, thread('thread-c', 'desk lamp'));

    expect(listThreads(northstar)).toHaveLength(1);
    expect(listAllUserThreads('user-1').map((item) => item.title)).toEqual([
      'surprise gift',
      'desk lamp',
    ]);
    expect(listAllUserThreads('user-1').map((item) => item.shopId)).toEqual([
      'northstar-demo-in',
      'indigo-desk-in',
    ]);
  });

  it('moves an unbound chat onto a shop and queues the same-thread continue turn', () => {
    upsertThread(
      { userId: 'user-1', shopId: UNBOUND_SHOP_ID },
      {
        ...thread('open-chat', 'a gift for my gf'),
        messages: [{ role: 'you', text: 'a gift for my gf' }],
        shopSlug: UNBOUND_SHOP_ID,
        shopName: 'Concierge',
      },
    );

    const id = bindUnboundChatToShop({
      userId: 'user-1',
      unboundId: 'open-chat',
      shop: { tenantId: 'sable-atelier-in', slug: 'sable-atelier', name: 'Sable Atelier' },
      messages: [{ role: 'you', text: 'a gift for my gf' }],
    });

    expect(listThreads({ userId: 'user-1', shopId: UNBOUND_SHOP_ID })).toEqual([]);
    expect(getThread({ userId: 'user-1', shopId: 'sable-atelier-in' }, id)).toMatchObject({
      messages: [{ role: 'you', text: 'a gift for my gf' }],
      pendingTurn: 'a gift for my gf',
      shopSlug: 'sable-atelier',
    });
    expect(consumePendingTurn({ userId: 'user-1', shopId: 'sable-atelier-in' }, id)).toBe(
      'a gift for my gf',
    );
    expect(getThread({ userId: 'user-1', shopId: 'sable-atelier-in' }, id)?.pendingTurn).toBeNull();
    expect(
      openingThreadMessages('user-1', 'sable-atelier-in', id, [{ role: 'you', text: 'seeded' }]),
    ).toEqual([{ role: 'you', text: 'seeded' }]);
  });
});
