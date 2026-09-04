// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buyerAskDraft,
  buyerBuyDraft,
  buyerFacingError,
  conciergeWorkCopy,
  getLastShop,
  groundedConciergeCopy,
  lastShopResumePath,
  lastShopStorageKey,
  orderConfirmedCopy,
  razorpayWorkCopy,
  rememberLastShop,
} from './buyer-session';
import { upsertThread } from './threads';

afterEach(() => {
  localStorage.clear();
});

describe('buyer shop resume', () => {
  it('stores and resumes the last shop thread when the shop is still published', () => {
    const userId = 'user-buyer';
    rememberLastShop(userId, {
      slug: 'northstar',
      tenantId: 'northstar-demo-in',
      threadId: 'thread-9',
    });
    expect(getLastShop(userId)).toEqual({
      slug: 'northstar',
      tenantId: 'northstar-demo-in',
      threadId: 'thread-9',
    });
    expect(localStorage.getItem(lastShopStorageKey(userId))).toContain('northstar');

    upsertThread(
      { userId, shopId: 'northstar-demo-in' },
      {
        id: 'thread-9',
        conversationId: null,
        title: 'surprise gift',
        updatedAt: new Date().toISOString(),
        messages: [{ role: 'you', text: 'surprise gift' }],
        quote: null,
      },
    );

    expect(lastShopResumePath(userId, getLastShop(userId)!, new Set(['northstar']))).toBe(
      '/buyer/northstar/chat/thread-9',
    );
  });

  it('falls back to the shop Concierge when the thread is gone, and ignores unpublished slugs', () => {
    const last = { slug: 'northstar', tenantId: 'northstar-demo-in', threadId: 'missing' };
    expect(lastShopResumePath('user-buyer', last, new Set(['northstar']))).toBe('/buyer/northstar');
    expect(lastShopResumePath('user-buyer', last, new Set(['indigo-desk']))).toBeNull();
  });

  it('writes buy drafts the orchestrator already understands', () => {
    expect(buyerBuyDraft('Hand grinder')).toBe("I'd like to buy Hand grinder.");
    expect(buyerAskDraft('Hand grinder')).toBe('I have a question about Hand grinder.');
  });

  it('does not show a demo disclaimer line on Concierge', () => {
    expect(groundedConciergeCopy()).toBe('');
  });

  it('names the Concierge and Razorpay step instead of a generic working line', () => {
    expect(
      conciergeWorkCopy(
        'Put these in my cart, exactly: Tea hamper × 2. Then lock this total. Buy now.',
      ),
    ).toMatch(/putting your picks in the cart/i);
    expect(conciergeWorkCopy('Buy now')).toMatch(/locking the cart total/i);
    expect(conciergeWorkCopy('I want a gift for my girlfriend')).toMatch(/catalog/i);
    expect(razorpayWorkCopy('create-order')).toMatch(/creating the razorpay order/i);
  });

  it('writes order confirmation from the frozen quote after capture', () => {
    expect(
      orderConfirmedCopy(
        {
          totalDisplay: '₹2,096.00',
          deliveryBy: '2026-09-06',
          lines: [
            { title: 'Tea hamper', quantity: 2 },
            { title: 'Oak photo frame', quantity: 1 },
          ],
        },
        {
          status: 'SETTLED',
          copy: 'Payment captured. One Charter order; inventory will commit once.',
        },
      ),
    ).toMatch(
      /order confirmed for ₹2,096\.00[\s\S]*tea hamper × 2[\s\S]*shop fulfillment window 2026-09-06/i,
    );
    expect(
      orderConfirmedCopy(null, {
        status: 'SETTLED',
        copy: 'Payment captured. One Charter order; inventory will commit once.',
      }),
    ).toMatch(/inventory will commit/i);
  });

  it('turns checkout machine codes into a buyer sentence', () => {
    expect(buyerFacingError('CHECKOUT_KILLED')).toMatch(/paused/i);
    expect(buyerFacingError('FACTS_STALE')).toMatch(/quote changed/i);
    expect(buyerFacingError('TURN_TIMEOUT')).toMatch(/too long/i);
    expect(buyerFacingError('CHECKOUT_TIMEOUT')).toMatch(/did not open/i);
    expect(buyerFacingError('UNKNOWN_CODE')).toMatch(/UNKNOWN_CODE/);
  });

  it('lets the grounded-facts line wrap instead of CSS-ellipsis', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'product.css'), 'utf8');
    const block = css.match(/\.workspace-head \.grounded-note \{[\s\S]*?\n\}/)?.[0];
    expect(block).toBeTruthy();
    expect(block).toMatch(/white-space:\s*normal/);
    expect(block).toMatch(/overflow:\s*visible/);
    expect(block).not.toMatch(/white-space:\s*nowrap/);
    expect(block).not.toMatch(/text-overflow:\s*ellipsis/);
    expect(block).not.toMatch(/max-width:\s*min\(36ch/);
  });
});
