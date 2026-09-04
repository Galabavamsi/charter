import { createHmac } from 'node:crypto';
import { test, expect, type Page, type Response } from '@playwright/test';
import {
  MONEY_API,
  MONEY_APP,
  MONEY_KEY_SECRET,
  MONEY_PROVIDER,
  startMoneyContractStack,
  stopMoneyContractStack,
} from './money-contract';

/**
 * Contract journey against local core-api. Only the Razorpay HTTP provider and
 * Checkout.js widget are stubbed. Conversation, quote, checkout, dismiss,
 * callback, and buyer/merchant receipts go through real Charter routes.
 * This does not replace a live Railway test-mode run.
 */

const BUYER_TOKEN = 'buyer';
const OWNER_TOKEN = 'northstar-owner';
const BUYER_ID = '71000000-0000-4000-8000-000000000002';
const KEY_SECRET = MONEY_KEY_SECRET;
const PROVIDER = MONEY_PROVIDER;
const API = MONEY_API;

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
    __CHARTER_E2E_CHECKOUT_ORDERS__?: string[];
  }
}

const session = {
  accessToken: BUYER_TOKEN,
  user: {
    id: BUYER_ID,
    email: 'buyer@example.invalid',
    name: 'Avery Buyer',
  },
} as const;

type CheckoutLaunch = {
  checkoutId: string;
  orderId: string;
  amount: number;
  currency: string;
  keyId?: string;
  retryAllowed?: boolean;
  reconciliationOutcome?: string | null;
  status?: string;
  copy?: string;
};

type CheckoutSession = {
  id: string;
  status: string;
  copy: string;
  paymentId: string | null;
  providerStatus: string | null;
};

function checkoutPost(response: Response): boolean {
  return (
    response.request().method() === 'POST' &&
    /\/api\/v1\/quotes\/[^/]+\/checkout$/.test(new URL(response.url()).pathname)
  );
}

async function installBuyerSession(page: Page): Promise<void> {
  await page.addInitScript(
    (next: { session: typeof session; provider: string; secret: string }) => {
      window.__CHARTER_PLAYWRIGHT_SESSION__ = next.session;
      window.__CHARTER_E2E_CHECKOUT_ORDERS__ = [];
      async function sign(orderId: string, paymentId: string): Promise<string> {
        const key = await crypto.subtle.importKey(
          'raw',
          new TextEncoder().encode(next.secret),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign'],
        );
        const bits = await crypto.subtle.sign(
          'HMAC',
          key,
          new TextEncoder().encode(`${orderId}|${paymentId}`),
        );
        return [...new Uint8Array(bits)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      }
      async function recordPayment(orderId: string, status: string, id: string): Promise<void> {
        const response = await fetch(`${next.provider}/v1/test/payments`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ order_id: orderId, status, id }),
        });
        if (!response.ok) {
          throw new Error(`PROVIDER_PAYMENT_FIXTURE_${response.status}`);
        }
      }
      let opens = 0;
      window.Razorpay = class {
        constructor(options: {
          order_id?: string;
          handler?: (response: {
            razorpay_payment_id: string;
            razorpay_order_id: string;
            razorpay_signature: string;
          }) => void;
          modal?: { ondismiss?: () => void };
        }) {
          this.options = options;
        }
        options: {
          order_id?: string;
          handler?: (response: {
            razorpay_payment_id: string;
            razorpay_order_id: string;
            razorpay_signature: string;
          }) => void;
          modal?: { ondismiss?: () => void };
        };
        open() {
          const orderId = this.options.order_id;
          if (!orderId) {
            throw new Error('CHECKOUT_ORDER_ID_REQUIRED');
          }
          window.__CHARTER_E2E_CHECKOUT_ORDERS__?.push(orderId);
          opens += 1;
          const { handler, modal } = this.options;
          void (async () => {
            if (opens === 1) {
              await recordPayment(orderId, 'failed', 'pay_e2e_failed');
              modal?.ondismiss?.();
              return;
            }
            await recordPayment(orderId, 'captured', 'pay_e2e_captured');
            handler?.({
              razorpay_payment_id: 'pay_e2e_captured',
              razorpay_order_id: orderId,
              razorpay_signature: await sign(orderId, 'pay_e2e_captured'),
            });
          })();
        }
      };
    },
    { session, provider: PROVIDER, secret: KEY_SECRET },
  );
}

test.describe('Buyer pay journey', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ baseURL: MONEY_APP });

  test.beforeAll(async () => {
    await startMoneyContractStack();
  });

  test.afterAll(async () => {
    await stopMoneyContractStack();
  });

  test('quote, fail, reconcile, same-Order retry, capture, and receipt parity', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const health = await request.get(`${API}/health`);
    expect(health.ok()).toBeTruthy();
    expect((await health.json()).e2eHarness).toBe(true);

    await installBuyerSession(page);
    const turn = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        /\/api\/v1\/conversations\/[^/]+\/turns$/.test(new URL(response.url()).pathname),
    );
    await page.goto('/buyer/northstar?intent=buy&product=grinder.pocket-lite');

    await expect(page.getByRole('heading', { name: 'Concierge' })).toBeVisible();
    await expect(page.getByText(/I'd like to buy .+\./)).toBeVisible();
    const turnBody = (await (await turn).json()) as {
      quote?: {
        id: string;
        totalDisplay: string;
        totalMinor: string;
        lines: Array<{ sku: string }>;
      };
    };
    expect(turnBody.quote?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(turnBody.quote?.lines.some((line) => line.sku === 'grinder.pocket-lite')).toBe(true);
    const totalDisplay = turnBody.quote!.totalDisplay;

    await expect(page.getByRole('heading', { name: 'Locked total' })).toBeVisible();
    await expect(page.getByText(totalDisplay).first()).toBeVisible();

    const firstCheckout = page.waitForResponse(checkoutPost);
    const dismissed = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        /\/api\/v1\/checkouts\/[^/]+\/dismissed$/.test(new URL(response.url()).pathname),
    );
    await page.getByRole('button', { name: `Pay ${totalDisplay}` }).click();
    const created = (await (await firstCheckout).json()) as CheckoutLaunch;
    const failed = (await (await dismissed).json()) as CheckoutSession;

    expect(created.checkoutId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(created.orderId).toMatch(/^order_e2e_/);
    expect(created.currency).toBe('INR');
    expect(created.amount).toBe(Number(turnBody.quote!.totalMinor));
    expect(created.retryAllowed).toBeFalsy();
    expect(created.reconciliationOutcome).not.toBe('same_order_retry_safe');
    expect(failed.id).toBe(created.checkoutId);
    expect(failed.status).toBe('FAILED_PROVISIONAL');
    expect(failed.copy).toMatch(/Payment not confirmed/);

    await expect(page.getByText('FAILED_PROVISIONAL')).toBeVisible();
    await expect(page.getByRole('button', { name: `Pay ${totalDisplay}` })).toHaveCount(0);

    const reconcileCheckout = page.waitForResponse(checkoutPost);
    await page.getByRole('button', { name: 'Check payment status' }).click();
    const reconciled = (await (await reconcileCheckout).json()) as CheckoutLaunch;
    expect(reconciled.checkoutId).toBe(created.checkoutId);
    expect(reconciled.orderId).toBe(created.orderId);
    expect(reconciled.retryAllowed).toBe(true);
    expect(reconciled.reconciliationOutcome).toBe('same_order_retry_safe');
    await expect(page.getByRole('button', { name: 'Retry same order' })).toBeVisible();

    const retryCheckout = page.waitForResponse(checkoutPost);
    const captured = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        /\/api\/v1\/checkouts\/[^/]+\/callback$/.test(new URL(response.url()).pathname),
    );
    await page.getByRole('button', { name: 'Retry same order' }).click();
    const retried = (await (await retryCheckout).json()) as CheckoutLaunch;
    const settled = (await (await captured).json()) as CheckoutSession;

    expect(retried.checkoutId).toBe(created.checkoutId);
    expect(retried.orderId).toBe(created.orderId);
    expect(settled.id).toBe(created.checkoutId);
    expect(settled.status).toBe('SETTLED');
    expect(settled.providerStatus).toBe('captured');
    expect(settled.paymentId).toBe('pay_e2e_captured');
    expect(settled.copy).toMatch(/Payment captured/);

    const expectedSignature = createHmac('sha256', KEY_SECRET)
      .update(`${created.orderId}|pay_e2e_captured`)
      .digest('hex');
    const callbackRequest = (await captured).request();
    expect(callbackRequest.postDataJSON()).toEqual({
      shopSlug: 'northstar',
      razorpay_order_id: created.orderId,
      razorpay_payment_id: 'pay_e2e_captured',
      razorpay_signature: expectedSignature,
    });

    const widgetOrders = await page.evaluate(() => window.__CHARTER_E2E_CHECKOUT_ORDERS__);
    expect(widgetOrders).toEqual([created.orderId, created.orderId]);

    const stats = await request.get(`${PROVIDER}/v1/test/stats`);
    expect(stats.ok()).toBeTruthy();
    expect(await stats.json()).toMatchObject({
      ordersCreated: 1,
      orderIds: [created.orderId],
      payments: [
        { id: 'pay_e2e_failed', order_id: created.orderId, status: 'failed' },
        { id: 'pay_e2e_captured', order_id: created.orderId, status: 'captured' },
      ],
    });

    await expect(page.getByText('SETTLED')).toBeVisible();
    await expect(page.getByRole('button', { name: `Pay ${totalDisplay}` })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Retry same order' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'View buyer receipt' })).toBeVisible();

    const buyerReceipt = await request.get(`${API}/api/v1/orders/${created.checkoutId}`, {
      headers: { authorization: `Bearer ${BUYER_TOKEN}` },
    });
    const merchantReceipt = await request.get(
      `${API}/api/v1/merchant/shops/northstar-demo-in/orders/${created.checkoutId}`,
      { headers: { authorization: `Bearer ${OWNER_TOKEN}` } },
    );
    expect(buyerReceipt.ok()).toBeTruthy();
    expect(merchantReceipt.ok()).toBeTruthy();
    const buyer = await buyerReceipt.json();
    const merchant = await merchantReceipt.json();
    expect(buyer.razorpayOrderId).toBe(created.orderId);
    expect(buyer.razorpayOrderId).toBe(merchant.razorpayOrderId);
    expect(buyer.paymentTruth).toBe(merchant.paymentTruth);
    expect(buyer.totalMinor).toBe(merchant.totalMinor);
    expect(buyer.quote.lines).toEqual(merchant.quote.lines);
    expect(buyer.timeline.map((event: { label: string }) => event.label)).toEqual(
      merchant.timeline.map((event: { label: string }) => event.label),
    );

    await page.getByRole('link', { name: 'View buyer receipt' }).click();
    await expect(page.getByRole('heading', { name: 'Receipt' })).toBeVisible();
    await expect(page.getByText(created.orderId).first()).toBeVisible();
    const receiptLine = buyer.quote.lines.find(
      (line: { sku: string; title: string; quantity: number }) =>
        line.sku === 'grinder.pocket-lite',
    );
    expect(receiptLine).toMatchObject({ sku: 'grinder.pocket-lite', quantity: 1 });
    await expect(page.getByText(`${receiptLine!.title} × ${receiptLine!.quantity}`)).toBeVisible();
    await expect(page.getByText(buyer.paymentTruth).first()).toBeVisible();
  });
});
