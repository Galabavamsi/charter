import { test, expect, type Page, type Route } from '@playwright/test';
import {
  expectReadableHeading,
  expectReducedMotionDuration,
  expectSkipHref,
  expectSkipToMain,
} from './a11y';

const session = {
  accessToken: 'playwright-buyer-token',
  user: {
    id: 'user-buyer',
    email: 'buyer@example.invalid',
    name: 'Avery Buyer',
  },
} as const;

const directoryShop = {
  tenantId: 'northstar-demo-in',
  slug: 'northstar',
  name: 'Northstar Travel Coffee',
  blurb: 'Coffee gear for the road.',
  currency: 'INR',
  synthetic: true,
  publishedAt: '2026-01-01T00:00:00.000Z',
  href: '/shops/northstar',
  catalogPath: '/shops/northstar',
  itemCount: 1,
  inStockCount: 1,
  unitsInStock: 8,
  categories: [{ slug: 'coffee', title: 'Coffee' }],
  startingPriceMinor: '99900',
  startingPriceDisplay: '₹999.00',
  rating: 4.8,
  reviewCount: 12,
  matchedOn: ['name'],
};

const receipt = {
  id: 'checkout-playwright-1',
  receipt: 'chr_rcpt_playwright',
  razorpayOrderId: 'order_playwright',
  status: 'captured',
  paymentState: 'captured',
  totalMinor: '99900',
  totalDisplay: '₹999.00',
  createdAt: '2026-09-04T12:00:00.000Z',
  updatedAt: '2026-09-04T12:05:00.000Z',
  paid: true,
  fulfillmentReady: true,
  paymentTruth: 'Payment captured.',
  trackingId: 'CHR-TRK-PLAYWRIGHT',
  fulfillmentStatus: 'confirmed',
  shop: {
    tenantId: directoryShop.tenantId,
    slug: directoryShop.slug,
    name: directoryShop.name,
    synthetic: true,
  },
};

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function installBuyerSession(page: Page): Promise<void> {
  await page.addInitScript((next) => {
    window.__CHARTER_PLAYWRIGHT_SESSION__ = next;
  }, session);
}

async function stubBuyerApis(page: Page): Promise<void> {
  await page.route('**/api/v1/me', (route) =>
    json(route, {
      profile: { userId: session.user.id, email: session.user.email },
      shops: [],
      platformRoles: [],
    }),
  );
  await page.route('**/api/v1/shops**', (route) => {
    const url = new URL(route.request().url());
    if (
      /\/shops\/northstar(?:\/|$|\?)/.test(url.pathname) ||
      url.pathname.endsWith('/shops/northstar')
    ) {
      return json(route, {
        shop: directoryShop,
        merchant: {
          tenantId: directoryShop.tenantId,
          slug: directoryShop.slug,
          name: directoryShop.name,
          blurb: directoryShop.blurb,
          currency: 'INR',
        },
        items: [
          {
            id: 'variant-grinder',
            productId: 'product-grinder',
            sku: 'grinder.pocket-lite',
            title: 'Pocket Lite Grinder',
            priceMinor: '99900',
            priceDisplay: '₹999.00',
          },
        ],
        total: 1,
        nextCursor: null,
        facets: { categories: [], inStockCount: 1, minPriceMinor: '99900', maxPriceMinor: '99900' },
      });
    }
    return json(route, {
      items: [directoryShop],
      total: 1,
      nextCursor: null,
      facets: { categories: [], inStockCount: 1, minPriceMinor: '99900', maxPriceMinor: '99900' },
    });
  });
  await page.route('**/api/v1/orders**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith(`/orders/${receipt.id}`)) {
      return json(route, {
        ...receipt,
        quote: {
          id: 'quote-playwright',
          status: 'frozen',
          subtotalMinor: '99900',
          discountMinor: '0',
          totalMinor: '99900',
          lines: [{ sku: 'grinder.pocket-lite', title: 'Pocket Lite Grinder', quantity: 1 }],
        },
        provider: {
          razorpayOrderId: receipt.razorpayOrderId,
          paymentId: 'pay_playwright',
          status: 'captured',
        },
        timeline: [],
      });
    }
    return json(route, { items: [receipt], nextCursor: null });
  });
  await page.route('**/api/v1/conversations**', (route) =>
    json(route, { id: 'conversation-playwright', messages: [] }),
  );
}

test.describe('Buyer Concierge and account journeys', () => {
  test('signed-in Concierge, account menu, and buyer receipts stay reachable', async ({ page }) => {
    await installBuyerSession(page);
    await stubBuyerApis(page);
    await page.goto('/chats');
    await expect(page.getByRole('heading', { name: 'Concierge' })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Your chats' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /sign in/i })).toHaveCount(0);

    await page.getByRole('button', { name: /account menu/i }).click();
    const menu = page.getByRole('navigation', { name: 'Account links' });
    await expect(menu.getByRole('link', { name: 'Concierge' })).toBeVisible();
    await expect(menu.getByRole('link', { name: 'Buyer orders' })).toBeVisible();
    await menu.getByRole('link', { name: 'Buyer orders' }).click();
    await expect(page).toHaveURL(/\/orders$/);
    await expect(page.getByRole('heading', { name: 'Buyer orders' })).toBeVisible();
    await expect(page.getByLabel('Buyer receipts')).toBeVisible();
    await expect(page.getByText('CHR-TRK-PLAYWRIGHT')).toBeVisible();
  });

  test('shop-bound Concierge opens from a Buy deep link without a sign-in wall', async ({
    page,
  }) => {
    await installBuyerSession(page);
    await stubBuyerApis(page);
    await page.goto('/buyer/northstar?intent=buy&product=grinder.pocket-lite');
    await expect(page.getByRole('heading', { name: 'Concierge' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /sign in/i })).toHaveCount(0);
    await expect(page.getByRole('complementary', { name: 'Your chats' })).toBeVisible();
  });

  test('injected Concierge and receipts keep skip-link, contrast, and reduced-motion', async ({
    page,
  }) => {
    await installBuyerSession(page);
    await stubBuyerApis(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/chats');
    const concierge = page.getByRole('heading', { name: 'Concierge' });
    await expect(page.getByRole('heading', { name: /sign in/i })).toHaveCount(0);
    await expectReadableHeading(concierge);
    await expectReducedMotionDuration(concierge);
    await expectSkipToMain(page);
    await expectSkipHref(page, /skip to chat/i, /#buyer-composer/, '#buyer-composer');

    await page.goto('/orders');
    const orders = page.getByRole('heading', { name: 'Buyer orders' });
    await expect(page.getByLabel('Buyer receipts')).toBeVisible();
    await expectReadableHeading(orders);
    await expectReducedMotionDuration(orders);
    await expectSkipToMain(page);
  });
});
