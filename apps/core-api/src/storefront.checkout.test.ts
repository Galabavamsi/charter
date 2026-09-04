import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NORTHSTAR_TENANT,
  copyOfferRule,
  getMerchant,
  liveMerchantFactPin,
  resetMerchantSeeds,
} from '@charter/catalog';
import { addLine, buildCanonicalKit, createCart, getQuote, resetKernel } from '@charter/commerce';
import { hydrateCheckout, resetCheckouts } from '@charter/payments';
import { RazorpayClient } from '@charter/razorpay';
import { loadConfig } from '@charter/config';
import { registerAuthContext } from './auth/context.js';
import type { MoneyPersist } from './persist.js';
import { registerStorefrontRoutes } from './storefront.js';
import {
  TEST_USERS,
  authHeaders,
  testAuthVerifier,
  testTenantRepository,
} from './testing/security.js';

describe('HTTP storefront checkout fact pinning', () => {
  beforeEach(() => {
    resetKernel();
    resetCheckouts();
    resetMerchantSeeds();
  });

  it('does not call Razorpay createOrder when durable quote facts are stale', async () => {
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
    const repository = testTenantRepository();
    await repository.claimResource('quote', NORTHSTAR_TENANT, quote.id, TEST_USERS.buyer);

    const app = Fastify();
    await registerAuthContext(app, testAuthVerifier(), repository);
    await registerStorefrontRoutes(
      app,
      loadConfig({
        DATABASE_URL: 'postgres://unused',
        CHARTER_ENV: 'test',
        RAZORPAY_MODE: 'test',
        RAZORPAY_KEY_ID: 'rzp_test_key',
        RAZORPAY_KEY_SECRET: 'rzp_test_secret',
      }),
      razorpay,
      repository,
      persist,
    );

    const response = await app.inject({
      method: 'POST',
      url: `/v1/quotes/${quote.id}/checkout`,
      headers: authHeaders('buyer'),
      payload: { shopSlug: 'northstar' },
    });

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().error).toBe('FACTS_STALE');
    expect(createOrder).not.toHaveBeenCalled();
    expect(saveCheckout).not.toHaveBeenCalled();
    await app.close();
  });

  it('hydrates a bound checkout before Razorpay createOrder', async () => {
    const { quote } = buildCanonicalKit();
    const frozen = getQuote(quote.id)!;
    frozen.boundCheckoutId = '92000000-0000-4000-8000-000000000088';
    const createOrder = vi.fn(async () => {
      throw new Error('RAZORPAY_SHOULD_NOT_BE_CALLED');
    });
    const loadCheckout = vi.fn(async () => {
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
          return createOrder();
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
    const repository = testTenantRepository();
    await repository.claimResource('quote', NORTHSTAR_TENANT, quote.id, TEST_USERS.buyer);

    const app = Fastify();
    await registerAuthContext(app, testAuthVerifier(), repository);
    await registerStorefrontRoutes(
      app,
      loadConfig({
        DATABASE_URL: 'postgres://unused',
        CHARTER_ENV: 'test',
        RAZORPAY_MODE: 'test',
        RAZORPAY_KEY_ID: 'rzp_test_key',
        RAZORPAY_KEY_SECRET: 'rzp_test_secret',
      }),
      razorpay,
      repository,
      persist,
    );

    const response = await app.inject({
      method: 'POST',
      url: `/v1/quotes/${quote.id}/checkout`,
      headers: authHeaders('buyer'),
      payload: { shopSlug: 'northstar' },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().orderId).toBe('order_already_bound');
    expect(loadCheckout).toHaveBeenCalled();
    expect(createOrder).not.toHaveBeenCalled();
    await app.close();
  });

  it('persists refund paymentId when buyer checkout reconciles refunded evidence', async () => {
    const { quote } = buildCanonicalKit();
    const frozen = getQuote(quote.id)!;
    frozen.boundCheckoutId = '92000000-0000-4000-8000-000000000077';
    const saveCheckout = vi.fn(async () => undefined);
    const persistWebhookTransition = vi.fn(async (session) => session);
    const loadCheckout = vi.fn(async () => {
      hydrateCheckout({
        id: frozen.boundCheckoutId!,
        tenantId: frozen.tenantId,
        quoteId: frozen.id,
        receipt: 'rcpt_refund',
        razorpayOrderId: 'order_refund_buyer',
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
                  id: 'pay_refunded_buyer',
                  order_id: 'order_refund_buyer',
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
            id: 'order_refund_buyer',
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
    const repository = testTenantRepository();
    await repository.claimResource('quote', NORTHSTAR_TENANT, quote.id, TEST_USERS.buyer);

    const app = Fastify();
    await registerAuthContext(app, testAuthVerifier(), repository);
    await registerStorefrontRoutes(
      app,
      loadConfig({
        DATABASE_URL: 'postgres://unused',
        CHARTER_ENV: 'test',
        RAZORPAY_MODE: 'test',
        RAZORPAY_KEY_ID: 'rzp_test_key',
        RAZORPAY_KEY_SECRET: 'rzp_test_secret',
      }),
      razorpay,
      repository,
      persist,
    );

    const response = await app.inject({
      method: 'POST',
      url: `/v1/quotes/${quote.id}/checkout`,
      headers: authHeaders('buyer'),
      payload: { shopSlug: 'northstar' },
    });

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().error).toBe('PAYMENT_REFUNDED');
    expect(saveCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: 'pay_refunded_buyer',
        status: 'RECONCILING',
        providerStatus: 'refunded',
      }),
    );
    expect(persistWebhookTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: 'pay_refunded_buyer',
        providerStatus: 'refunded',
      }),
    );
    await app.close();
  });

  it('persists a budgeted freeze without FACTS_STALE', async () => {
    const repository = testTenantRepository();
    const policy = repository.state.policies.get(NORTHSTAR_TENANT);
    if (!policy) {
      throw new Error('NORTHSTAR_POLICY_MISSING');
    }
    policy.offers = policy.offers.map((offer) => ({
      ...offer,
      budgetRemainingMinor: offer.discountMinor,
      maxRedemptions: 8,
      redemptions: 0,
    }));
    const merchant = getMerchant(NORTHSTAR_TENANT)!;
    merchant.offers = merchant.offers.map((offer) => ({
      ...copyOfferRule(offer),
      budgetRemainingMinor: offer.discountMinor,
      maxRedemptions: 8,
      redemptions: 0,
    }));
    const cart = createCart(NORTHSTAR_TENANT);
    addLine(cart.id, 'brewer.trailpress-steel-750');
    addLine(cart.id, 'grinder.pocket-lite');
    addLine(cart.id, 'filters.travel-30');
    await repository.claimResource('cart', NORTHSTAR_TENANT, cart.id, TEST_USERS.buyer);
    const saveQuote = vi.fn(async () => undefined);
    const persist = {
      assertQuoteFacts: vi.fn(async () => undefined),
      saveQuote,
    } as unknown as MoneyPersist;

    const app = Fastify();
    await registerAuthContext(app, testAuthVerifier(), repository);
    await registerStorefrontRoutes(
      app,
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
      repository,
      persist,
    );

    const response = await app.inject({
      method: 'POST',
      url: `/v1/carts/${cart.id}/quotes`,
      headers: authHeaders('buyer'),
      payload: { shopSlug: 'northstar' },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(BigInt(response.json().discountMinor)).toBeGreaterThan(0n);
    expect(saveQuote).toHaveBeenCalled();
    expect(persist.assertQuoteFacts).toHaveBeenCalled();
    await app.close();
  });
});
