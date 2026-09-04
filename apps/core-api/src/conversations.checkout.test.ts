import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  NORTHSTAR_TENANT,
  copyOfferRule,
  getMerchant,
  hydrateMerchantCache,
  liveMerchantFactPin,
  resetMerchantSeeds,
  setVariantStock,
} from '@charter/catalog';
import {
  addLine,
  buildCanonicalKit,
  createCart,
  freezeQuote,
  getQuote,
  resetKernel,
} from '@charter/commerce';
import { resetConversations } from '@charter/orchestrator';
import { resetCheckouts } from '@charter/payments';
import { RazorpayClient } from '@charter/razorpay';
import { loadConfig } from '@charter/config';
import { conversationHooks } from './conversations.js';
import type { MoneyPersist } from './persist.js';
import { TEST_USERS, testTenantRepository } from './testing/security.js';

describe('conversation and voice checkout fact pinning', () => {
  beforeEach(() => {
    resetKernel();
    resetCheckouts();
    resetConversations();
    resetMerchantSeeds();
  });

  it('fails closed when durable quote facts drifted even if the in-memory pin still matches', async () => {
    const { quote } = buildCanonicalKit();
    expect(liveMerchantFactPin(NORTHSTAR_TENANT)).toEqual({
      catalogVersion: quote.catalogVersion,
      policyVersion: quote.policyVersion,
      factHash: quote.factHash,
    });

    const createOrder = vi.fn(async () => {
      throw new Error('RAZORPAY_SHOULD_NOT_BE_CALLED');
    });
    const razorpay = new RazorpayClient(
      { keyId: 'rzp_test_key', keySecret: 'rzp_test_secret' },
      createOrder as typeof fetch,
    );
    const saveCheckout = vi.fn(async () => undefined);
    const persist = {
      assertQuoteFacts: async () => {
        throw new Error('FACTS_STALE');
      },
      saveCheckout,
    } as unknown as MoneyPersist;
    const hooks = conversationHooks(
      loadConfig({
        DATABASE_URL: 'postgres://unused',
        CHARTER_ENV: 'test',
        RAZORPAY_MODE: 'test',
        RAZORPAY_KEY_ID: 'rzp_test_key',
        RAZORPAY_KEY_SECRET: 'rzp_test_secret',
      }),
      razorpay,
      testTenantRepository(),
      TEST_USERS.buyer,
      persist,
    );

    await expect(hooks.startCheckout?.(quote.id)).rejects.toThrow('FACTS_STALE');
    expect(createOrder).not.toHaveBeenCalled();
    expect(saveCheckout).not.toHaveBeenCalled();
  });

  it('does not save a quote when freeze facts are stale', async () => {
    const { quote } = buildCanonicalKit();
    const saveQuote = vi.fn(async () => undefined);
    const persist = {
      assertQuoteFacts: vi.fn(async () => undefined),
      saveQuote,
    } as unknown as MoneyPersist;
    const hooks = conversationHooks(
      loadConfig({
        DATABASE_URL: 'postgres://unused',
        CHARTER_ENV: 'test',
        RAZORPAY_MODE: 'test',
        RAZORPAY_KEY_ID: 'rzp_test_key',
        RAZORPAY_KEY_SECRET: 'rzp_test_secret',
      }),
      new RazorpayClient(
        { keyId: 'rzp_test_key', keySecret: 'rzp_test_secret' },
        vi.fn(async () => {
          throw new Error('RAZORPAY_SHOULD_NOT_BE_CALLED');
        }) as typeof fetch,
      ),
      testTenantRepository(),
      TEST_USERS.buyer,
      persist,
    );
    setVariantStock(quote.tenantId, 'grinder.pocket-lite', 1);
    expect(hooks.persistQuote).toEqual(expect.any(Function));
    await expect(hooks.persistQuote?.(quote.id)).rejects.toThrow('FACTS_STALE');
    expect(saveQuote).not.toHaveBeenCalled();
    expect(persist.assertQuoteFacts).not.toHaveBeenCalled();
  });

  it('persists a budgeted freeze without FACTS_STALE', async () => {
    const merchant = getMerchant(NORTHSTAR_TENANT)!;
    hydrateMerchantCache({
      ...merchant,
      offers: merchant.offers.map((offer) => ({
        ...copyOfferRule(offer),
        budgetRemainingMinor: offer.discountMinor,
        maxRedemptions: 8,
        redemptions: 0,
      })),
    });
    const cart = createCart(NORTHSTAR_TENANT);
    addLine(cart.id, 'brewer.trailpress-steel-750');
    addLine(cart.id, 'grinder.pocket-lite');
    addLine(cart.id, 'filters.travel-30');
    const quote = freezeQuote(cart.id);
    expect(quote.discountMinor).toBeGreaterThan(0n);
    const saveQuote = vi.fn(async () => undefined);
    const persist = {
      assertQuoteFacts: vi.fn(async () => undefined),
      saveQuote,
    } as unknown as MoneyPersist;
    const hooks = conversationHooks(
      loadConfig({
        DATABASE_URL: 'postgres://unused',
        CHARTER_ENV: 'test',
        RAZORPAY_MODE: 'test',
        RAZORPAY_KEY_ID: 'rzp_test_key',
        RAZORPAY_KEY_SECRET: 'rzp_test_secret',
      }),
      new RazorpayClient(
        { keyId: 'rzp_test_key', keySecret: 'rzp_test_secret' },
        vi.fn(async () => {
          throw new Error('RAZORPAY_SHOULD_NOT_BE_CALLED');
        }) as typeof fetch,
      ),
      testTenantRepository(),
      TEST_USERS.buyer,
      persist,
    );

    await expect(hooks.persistQuote?.(quote.id)).resolves.toBeUndefined();
    expect(saveQuote).toHaveBeenCalledWith(quote);
    expect(persist.assertQuoteFacts).toHaveBeenCalledWith(quote);
    resetMerchantSeeds();
  });

  it('hydrates a bound checkout before createOrder', async () => {
    const { quote } = buildCanonicalKit();
    const frozen = getQuote(quote.id)!;
    frozen.boundCheckoutId = '92000000-0000-4000-8000-000000000099';
    const loadCheckout = vi.fn(async () => {
      const { hydrateCheckout } = await import('@charter/payments');
      hydrateCheckout({
        id: frozen.boundCheckoutId!,
        tenantId: frozen.tenantId,
        quoteId: frozen.id,
        receipt: 'rcpt_bound',
        razorpayOrderId: 'order_already_bound',
        amountMinor: Number(frozen.totalMinor),
        currency: 'INR',
        status: 'FAILED_PROVISIONAL',
        paymentId: 'pay_bound_fail',
        providerStatus: 'failed',
        copy: 'Bound checkout fixture.',
      });
    });
    const razorpay = new RazorpayClient(
      { keyId: 'rzp_test_key', keySecret: 'rzp_test_secret' },
      (async (url: string | URL, init?: RequestInit) => {
        const href = String(url);
        if (href.includes('/orders') && init?.method === 'POST') {
          throw new Error('RAZORPAY_SHOULD_NOT_BE_CALLED');
        }
        if (href.includes('/payments')) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: 'pay_bound_fail',
                  order_id: 'order_already_bound',
                  amount: Number(frozen.totalMinor),
                  currency: 'INR',
                  status: 'failed',
                },
              ],
            }),
          );
        }
        return new Response(
          JSON.stringify({
            id: 'order_already_bound',
            amount: Number(frozen.totalMinor),
            currency: 'INR',
            receipt: 'rcpt_bound',
            status: 'attempted',
          }),
        );
      }) as typeof fetch,
    );
    const persist = {
      assertQuoteFacts: async () => undefined,
      saveCheckout: vi.fn(async () => undefined),
      loadCheckout,
    } as unknown as MoneyPersist;
    const hooks = conversationHooks(
      loadConfig({
        DATABASE_URL: 'postgres://unused',
        CHARTER_ENV: 'test',
        RAZORPAY_MODE: 'test',
        RAZORPAY_KEY_ID: 'rzp_test_key',
        RAZORPAY_KEY_SECRET: 'rzp_test_secret',
      }),
      razorpay,
      testTenantRepository(),
      TEST_USERS.buyer,
      persist,
    );
    const started = await hooks.startCheckout?.(quote.id);
    expect(loadCheckout).toHaveBeenCalled();
    expect(started?.orderId).toBe('order_already_bound');
  });

  it('persists refund paymentId when Concierge checkout reconciles refunded evidence', async () => {
    const { quote } = buildCanonicalKit();
    const frozen = getQuote(quote.id)!;
    frozen.boundCheckoutId = '92000000-0000-4000-8000-000000000066';
    const saveCheckout = vi.fn(async () => undefined);
    const persistWebhookTransition = vi.fn(async (session) => session);
    const loadCheckout = vi.fn(async () => {
      const { hydrateCheckout } = await import('@charter/payments');
      hydrateCheckout({
        id: frozen.boundCheckoutId!,
        tenantId: frozen.tenantId,
        quoteId: frozen.id,
        receipt: 'rcpt_refund',
        razorpayOrderId: 'order_refund_chat',
        amountMinor: Number(frozen.totalMinor),
        currency: 'INR',
        status: 'FAILED_PROVISIONAL',
        paymentId: null,
        providerStatus: 'failed',
        copy: 'Payment not confirmed.',
      });
    });
    const razorpay = new RazorpayClient(
      { keyId: 'rzp_test_key', keySecret: 'rzp_test_secret' },
      (async (url: string | URL) => {
        const href = String(url);
        if (href.includes('/payments')) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: 'pay_refunded_chat',
                  order_id: 'order_refund_chat',
                  amount: Number(frozen.totalMinor),
                  currency: 'INR',
                  status: 'refunded',
                },
              ],
            }),
          );
        }
        return new Response(
          JSON.stringify({
            id: 'order_refund_chat',
            amount: Number(frozen.totalMinor),
            currency: 'INR',
            receipt: 'rcpt_refund',
            status: 'attempted',
          }),
        );
      }) as typeof fetch,
    );
    const persist = {
      assertQuoteFacts: async () => undefined,
      saveCheckout,
      persistWebhookTransition,
      loadCheckout,
    } as unknown as MoneyPersist;
    const hooks = conversationHooks(
      loadConfig({
        DATABASE_URL: 'postgres://unused',
        CHARTER_ENV: 'test',
        RAZORPAY_MODE: 'test',
        RAZORPAY_KEY_ID: 'rzp_test_key',
        RAZORPAY_KEY_SECRET: 'rzp_test_secret',
      }),
      razorpay,
      testTenantRepository(),
      TEST_USERS.buyer,
      persist,
    );

    await expect(hooks.startCheckout?.(quote.id)).rejects.toThrow('PAYMENT_REFUNDED');
    expect(saveCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: 'pay_refunded_chat',
        status: 'RECONCILING',
        providerStatus: 'refunded',
      }),
    );
    expect(persistWebhookTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: 'pay_refunded_chat',
        providerStatus: 'refunded',
      }),
    );
  });
});
