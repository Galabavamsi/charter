import { createHmac } from 'node:crypto';
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INDIGO_DESK } from '@charter/catalog';
import {
  createCart,
  hydrateQuote,
  resetKernel,
  type Cart,
  type FrozenQuote,
} from '@charter/commerce';
import { loadConfig } from '@charter/config';
import { hydrateCheckout, resetCheckouts, type CheckoutSession } from '@charter/payments';
import type { MoneyPersist } from './persist.js';
import { registerRazorpayWebhook } from './webhooks.js';

const WEBHOOK_FACT_HASH = 'ab'.repeat(32);
const secret = 'whsec_schema_auth';

function webhookBody(
  orderId: string,
  event:
    | 'payment.failed'
    | 'payment.authorized'
    | 'payment.captured'
    | 'payment.refunded' = 'payment.failed',
): string {
  const status = event.slice('payment.'.length);
  return JSON.stringify({
    event,
    payload: {
      payment: {
        entity: { id: `pay_${orderId}`, order_id: orderId, status },
      },
    },
  });
}

async function sendWebhook(
  persist: MoneyPersist,
  input: {
    eventId: string;
    orderId: string;
    event?: 'payment.failed' | 'payment.authorized' | 'payment.captured' | 'payment.refunded';
  },
): Promise<Record<string, unknown>> {
  const app = Fastify();
  const config = loadConfig({
    DATABASE_URL: 'postgres://unused',
    CHARTER_ENV: 'test',
    RAZORPAY_MODE: 'test',
    RAZORPAY_WEBHOOK_SECRET: secret,
  });
  await registerRazorpayWebhook(app, config, persist);
  const raw = webhookBody(input.orderId, input.event);
  const response = await app.inject({
    method: 'POST',
    url: '/webhooks/razorpay',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': createHmac('sha256', secret).update(raw).digest('hex'),
      'x-razorpay-event-id': input.eventId,
    },
    payload: raw,
  });
  expect(response.statusCode).toBe(200);
  await app.close();
  return response.json() as Record<string, unknown>;
}

function checkout(orderId: string): CheckoutSession {
  return {
    id: `checkout-${orderId}`,
    tenantId: INDIGO_DESK.tenantId,
    quoteId: `quote-${orderId}`,
    receipt: `receipt-${orderId}`,
    razorpayOrderId: orderId,
    amountMinor: 50000,
    currency: 'INR',
    status: 'CREATED',
    paymentId: null,
    providerStatus: 'created',
    copy: 'Synthetic webhook test checkout.',
  };
}

function persistedChain(session: CheckoutSession): {
  tenantId: string;
  session: CheckoutSession;
  quote: FrozenQuote;
  cart: Cart;
} {
  const cart: Cart = {
    id: `cart-${session.razorpayOrderId}`,
    tenantId: session.tenantId,
    version: 1,
    lines: [],
    approvedThroughMinor: 0n,
  };
  return {
    tenantId: session.tenantId,
    session: { ...session },
    cart,
    quote: {
      id: session.quoteId,
      tenantId: session.tenantId,
      cartId: cart.id,
      cartVersion: cart.version,
      status: 'BOUND',
      boundCheckoutId: session.id,
      currency: 'INR',
      subtotalMinor: BigInt(session.amountMinor),
      discountMinor: 0n,
      totalMinor: BigInt(session.amountMinor),
      totalDisplay: '₹500.00',
      deliveryBy: '2026-08-30',
      merchant: INDIGO_DESK.name,
      catalogVersion: 1,
      policyVersion: 1,
      factHash: WEBHOOK_FACT_HASH,
      lines: [],
    },
  };
}

describe('webhook inbox attribution', () => {
  beforeEach(() => {
    resetKernel();
    resetCheckouts();
  });

  it('does not acknowledge a signed webhook without durable persistence', async () => {
    const app = Fastify();
    const config = loadConfig({
      DATABASE_URL: 'postgres://unused',
      CHARTER_ENV: 'test',
      RAZORPAY_MODE: 'test',
      RAZORPAY_WEBHOOK_SECRET: secret,
    });
    await registerRazorpayWebhook(app, config);
    const raw = webhookBody('order_without_persistence');
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/razorpay',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': createHmac('sha256', secret).update(raw).digest('hex'),
        'x-razorpay-event-id': 'evt_without_persistence',
      },
      payload: raw,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe('WEBHOOK_PERSISTENCE_UNAVAILABLE');
    await app.close();
  });

  it('attributes a non-Northstar event to its resolved checkout tenant', async () => {
    const session = checkout('order_indigo');
    const chain = persistedChain(session);
    const recordWebhookIntake = vi.fn(async () => 'new' as const);
    const attributeWebhook = vi.fn(async () => undefined);
    const quarantineWebhook = vi.fn(async () => undefined);
    const resolveCheckoutByOrderId = vi.fn(async () => {
      return chain;
    });
    const persist = {
      recordWebhookIntake,
      attributeWebhook,
      quarantineWebhook,
      resolveCheckoutByOrderId,
      saveCheckout: vi.fn(async () => undefined),
      persistWebhookTransition: vi.fn(async (updated: CheckoutSession) => updated),
    } as unknown as MoneyPersist;

    await sendWebhook(persist, { eventId: 'evt_indigo', orderId: 'order_indigo' });

    expect(recordWebhookIntake).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'evt_indigo' }),
    );
    expect(attributeWebhook).toHaveBeenCalledWith({
      eventId: 'evt_indigo',
      tenantId: 'indigo-desk-in',
      orderId: 'order_indigo',
    });
    expect(quarantineWebhook).not.toHaveBeenCalled();
  });

  it('quarantines an unknown order without assigning Northstar', async () => {
    const attributeWebhook = vi.fn(async () => undefined);
    const quarantineWebhook = vi.fn(async () => undefined);
    const persist = {
      recordWebhookIntake: vi.fn(async () => 'new' as const),
      attributeWebhook,
      quarantineWebhook,
      resolveCheckoutByOrderId: vi.fn(async () => undefined),
      saveCheckout: vi.fn(async () => undefined),
      persistWebhookTransition: vi.fn(async (updated: CheckoutSession) => updated),
    } as unknown as MoneyPersist;

    await sendWebhook(persist, { eventId: 'evt_unknown', orderId: 'order_unknown' });

    expect(attributeWebhook).not.toHaveBeenCalled();
    expect(quarantineWebhook).toHaveBeenCalledWith({
      eventId: 'evt_unknown',
      reason: 'checkout_order_unknown',
      orderId: 'order_unknown',
    });
    expect(JSON.stringify(quarantineWebhook.mock.calls)).not.toContain('northstar');
  });

  it('attributes from the in-memory quote tenant when persistence lookup races', async () => {
    const cart = createCart(INDIGO_DESK.tenantId);
    const session = checkout('order_race');
    session.quoteId = 'quote-race';
    hydrateQuote({
      id: session.quoteId,
      tenantId: INDIGO_DESK.tenantId,
      cartId: cart.id,
      cartVersion: cart.version,
      status: 'BOUND',
      boundCheckoutId: session.id,
      currency: 'INR',
      subtotalMinor: 50000n,
      discountMinor: 0n,
      totalMinor: 50000n,
      totalDisplay: '₹500.00',
      deliveryBy: '2026-08-30',
      merchant: INDIGO_DESK.name,
      catalogVersion: 1,
      policyVersion: 1,
      factHash: WEBHOOK_FACT_HASH,
      lines: [],
    });
    hydrateCheckout(session);
    const attributeWebhook = vi.fn(async () => undefined);
    const quarantineWebhook = vi.fn(async () => undefined);
    const persist = {
      recordWebhookIntake: vi.fn(async () => 'new' as const),
      attributeWebhook,
      quarantineWebhook,
      resolveCheckoutByOrderId: vi.fn(async () => undefined),
      saveCheckout: vi.fn(async () => undefined),
      persistWebhookTransition: vi.fn(async (updated: CheckoutSession) => updated),
    } as unknown as MoneyPersist;

    await sendWebhook(persist, { eventId: 'evt_race', orderId: 'order_race' });

    expect(attributeWebhook).toHaveBeenCalledWith({
      eventId: 'evt_race',
      tenantId: INDIGO_DESK.tenantId,
      orderId: 'order_race',
    });
    expect(quarantineWebhook).not.toHaveBeenCalled();
  });

  it('hydrates a persisted checkout chain after each restart and converges duplicate capture', async () => {
    const cart = createCart(INDIGO_DESK.tenantId);
    const session = checkout('order_restart');
    session.quoteId = 'quote-restart';
    const quote: FrozenQuote = {
      id: session.quoteId,
      tenantId: INDIGO_DESK.tenantId,
      cartId: cart.id,
      cartVersion: cart.version,
      status: 'BOUND',
      boundCheckoutId: session.id,
      currency: 'INR',
      subtotalMinor: 50000n,
      discountMinor: 0n,
      totalMinor: 50000n,
      totalDisplay: '₹500.00',
      deliveryBy: '2026-08-30',
      merchant: INDIGO_DESK.name,
      catalogVersion: 1,
      policyVersion: 1,
      factHash: WEBHOOK_FACT_HASH,
      lines: [],
    };
    let persistedSession = { ...session };
    let persistedQuote = { ...quote };
    const captures = new Set<string>();
    const attributeWebhook = vi.fn(
      async (_input: { eventId: string; tenantId: string; orderId: string }) => undefined,
    );
    const rememberCapture = vi.fn(async (updated: CheckoutSession) => {
      persistedSession = { ...updated };
      persistedQuote = { ...persistedQuote, status: 'SETTLED' };
      captures.add(updated.id);
    });
    const persist = {
      recordWebhookIntake: vi.fn(async () => 'new' as const),
      attributeWebhook,
      quarantineWebhook: vi.fn(async () => undefined),
      resolveCheckoutByOrderId: vi.fn(async (orderId: string) =>
        orderId === persistedSession.razorpayOrderId
          ? {
              tenantId: persistedSession.tenantId,
              session: { ...persistedSession },
              quote: { ...persistedQuote, lines: [...persistedQuote.lines] },
              cart: { ...cart, lines: [...cart.lines] },
            }
          : undefined,
      ),
      saveCheckout: vi.fn(async (updated: CheckoutSession) => {
        persistedSession = { ...updated };
      }),
      persistWebhookTransition: vi.fn(async (updated: CheckoutSession) => {
        persistedSession = { ...updated };
        if (updated.status === 'SETTLED') {
          persistedQuote = { ...persistedQuote, status: 'SETTLED' };
          captures.add(updated.id);
        }
        return { ...updated };
      }),
      rememberCapture,
    } as unknown as MoneyPersist;

    resetKernel();
    resetCheckouts();
    const failed = await sendWebhook(persist, {
      eventId: 'evt_restart_failed',
      orderId: session.razorpayOrderId,
      event: 'payment.failed',
    });
    expect(failed.checkoutStatus).toBe('FAILED_PROVISIONAL');
    expect(persistedSession.status).toBe('FAILED_PROVISIONAL');

    resetKernel();
    resetCheckouts();
    const authorized = await sendWebhook(persist, {
      eventId: 'evt_restart_authorized',
      orderId: session.razorpayOrderId,
      event: 'payment.authorized',
    });
    expect(authorized.checkoutStatus).toBe('CAPTURE_PENDING');
    expect(persistedSession.status).toBe('CAPTURE_PENDING');
    expect(rememberCapture).not.toHaveBeenCalled();
    expect(captures.size).toBe(0);

    resetKernel();
    resetCheckouts();
    const captured = await sendWebhook(persist, {
      eventId: 'evt_restart_captured',
      orderId: session.razorpayOrderId,
      event: 'payment.captured',
    });
    expect(captured.checkoutStatus).toBe('SETTLED');
    expect(persistedSession.status).toBe('SETTLED');

    resetKernel();
    resetCheckouts();
    await sendWebhook(persist, {
      eventId: 'evt_restart_captured',
      orderId: session.razorpayOrderId,
      event: 'payment.captured',
    });
    expect(captures.size).toBe(1);
    expect(
      attributeWebhook.mock.calls.every(
        ([input]) => (input as { tenantId: string }).tenantId === INDIGO_DESK.tenantId,
      ),
    ).toBe(true);
  });

  it('persists a refund after capture as refunded evidence and does not fulfill', async () => {
    const session = checkout('order_refund_after_capture');
    const chain = persistedChain(session);
    const transitions: string[] = [];
    let persistedSession = { ...session };
    const persist = {
      recordWebhookIntake: vi.fn(async () => 'new' as const),
      attributeWebhook: vi.fn(async () => undefined),
      quarantineWebhook: vi.fn(async () => undefined),
      resolveCheckoutByOrderId: vi.fn(async (orderId: string) =>
        orderId === persistedSession.razorpayOrderId
          ? {
              ...chain,
              session: { ...persistedSession },
              quote: {
                ...chain.quote,
                status: persistedSession.status === 'SETTLED' ? 'SETTLED' : chain.quote.status,
              },
            }
          : undefined,
      ),
      saveCheckout: vi.fn(async () => undefined),
      persistWebhookTransition: vi.fn(async (updated: CheckoutSession) => {
        persistedSession = { ...updated };
        transitions.push(updated.providerStatus ?? '');
        return { ...updated };
      }),
    } as unknown as MoneyPersist;

    const captured = await sendWebhook(persist, {
      eventId: 'evt_refund_captured',
      orderId: session.razorpayOrderId,
      event: 'payment.captured',
    });
    expect(captured.checkoutStatus).toBe('SETTLED');

    const refunded = await sendWebhook(persist, {
      eventId: 'evt_refund_refunded',
      orderId: session.razorpayOrderId,
      event: 'payment.refunded',
    });
    expect(refunded.checkoutStatus).not.toBe('SETTLED');
    expect(persistedSession.providerStatus).toBe('refunded');
    expect(persistedSession.status).toBe('RECONCILING');
    expect(transitions).toEqual(['captured', 'refunded']);
    expect(persist.persistWebhookTransition).toHaveBeenCalledTimes(2);
  });

  it('acknowledges a refunded webhook instead of returning 503', async () => {
    const session = checkout('order_refund_only');
    hydrateCheckout(session);
    const persist = {
      recordWebhookIntake: vi.fn(async () => 'new' as const),
      attributeWebhook: vi.fn(async () => undefined),
      quarantineWebhook: vi.fn(async () => undefined),
      resolveCheckoutByOrderId: vi.fn(async () => persistedChain(session)),
      saveCheckout: vi.fn(async () => undefined),
      persistWebhookTransition: vi.fn(async (updated: CheckoutSession) => updated),
    } as unknown as MoneyPersist;

    const refunded = await sendWebhook(persist, {
      eventId: 'evt_refund_only',
      orderId: session.razorpayOrderId,
      event: 'payment.refunded',
    });
    expect(refunded.received).toBe(true);
    expect(refunded.checkoutStatus).toBe('RECONCILING');
    expect(persist.persistWebhookTransition).toHaveBeenCalledWith(
      expect.objectContaining({ providerStatus: 'refunded', status: 'RECONCILING' }),
    );
  });
});
