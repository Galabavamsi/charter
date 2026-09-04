import { test, expect, type Page, type Route } from '@playwright/test';
import {
  expectReadableHeading,
  expectReducedMotionDuration,
  expectSkipToMain,
} from './a11y';

const shop = {
  tenantId: 'northstar-demo-in',
  slug: 'northstar',
  name: 'Northstar Travel Coffee',
  label: 'Northstar Travel Coffee',
  blurb: 'Coffee gear for the road.',
  currency: 'INR',
  status: 'published',
  synthetic: true,
  role: 'owner',
} as const;

const harbor = {
  tenantId: 'harbor-spice-in',
  slug: 'harbor-spice',
  name: 'Harbor Spice',
  label: 'Harbor Spice',
  blurb: 'Spice kits.',
  currency: 'INR',
  status: 'published',
  synthetic: true,
  role: 'viewer',
} as const;

const session = {
  accessToken: 'playwright-merchant-token',
  user: {
    id: 'user-merchant',
    email: 'merchant@example.invalid',
    name: 'Merchant Operator',
  },
} as const;

const leaves = [
  ['overview', 'Overview'],
  ['catalog', 'Catalog'],
  ['orders', 'Orders'],
  ['recovery', 'Recovery'],
  ['rules', 'Rules'],
  ['settings', 'Settings'],
] as const;

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function installMerchantSession(page: Page): Promise<void> {
  await page.addInitScript((next) => {
    window.__CHARTER_PLAYWRIGHT_SESSION__ = next;
  }, session);
}

async function stubMerchantApis(
  page: Page,
  options: {
    hangOverview?: boolean;
    failLeaf?: (typeof leaves)[number][0];
    shops?: readonly (typeof shop | typeof harbor)[];
  } = {},
): Promise<void> {
  const memberShops = options.shops ?? [shop];
  await page.route('**/api/v1/me', (route) =>
    json(route, {
      profile: { userId: session.user.id, email: session.user.email },
      shops: memberShops,
      platformRoles: [],
    }),
  );
  await page.route('**/api/v1/merchant/shops/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const leaf = leaves.find(([name]) =>
      memberShops.some((member) => path.includes(`/merchant/shops/${member.tenantId}/${name}`)),
    );
    if (options.failLeaf && leaf?.[0] === options.failLeaf) {
      await json(route, { error: 'RECORDS_UNAVAILABLE' }, 500);
      return;
    }
    if (options.hangOverview && path.includes('/overview')) {
      return;
    }
    if (path.includes('/overview')) {
      await json(route, {
        range: { from: '2026-07-25', to: '2026-08-23' },
        capturedGmvMinor: '234700',
        capturedGmvDisplay: '₹2,347.00',
        capturedOrders: 1,
        validFrozenQuotes: 2,
        conversion: { numerator: 1, denominator: 2, rate: 0.5 },
        failedUnresolvedPays: 1,
        recoveredAmountMinor: '0',
        recoveredAmountDisplay: '₹0.00',
        inventoryUnits: 8,
        lowStockVariants: 0,
        synthetic: true,
        attributionNote:
          'Cohort is quotes created in this window. Captured GMV and conversion count only captures in the same window whose quote is in that cohort.',
      });
      return;
    }
    if (path.endsWith('/rules/preview')) {
      await json(route, { version: 1, items: [] });
      return;
    }
    if (path.endsWith('/rules')) {
      await json(route, {
        version: 1,
        hardCapMinor: '300000',
        hardCapDisplay: '₹3,000.00',
        autonomousCapMinor: '250000',
        autonomousCapDisplay: '₹2,500.00',
        forbiddenMaterials: ['glass'],
        offers: [],
      });
      return;
    }
    if (path.endsWith('/settings')) {
      await json(route, {
        version: 1,
        name: shop.name,
        blurb: shop.blurb,
        slug: shop.slug,
        publicPath: `/shops/${shop.slug}`,
        synthetic: true,
        testMode: true,
        paymentAccountDisclosure: 'Razorpay test mode. No live money.',
        members: [{ userId: session.user.id, role: 'owner', status: 'active', label: 'Owner' }],
      });
      return;
    }
    await json(route, { items: [], nextCursor: null });
  });
}

test.describe('Merchant keyboard journey', () => {
  test('authenticated overview reaches records, other leaves, and skip-to-records', async ({
    page,
  }) => {
    await installMerchantSession(page);
    await stubMerchantApis(page);
    await page.goto(`/merchant/shops/${shop.tenantId}/overview`);

    const overview = page.getByRole('heading', { name: 'Overview' });
    await expect(overview).toBeVisible();
    await expect(overview).toBeFocused();
    await expect(page.locator('#merchant-records')).toBeVisible();
    await expect(page.getByRole('heading', { name: shop.name })).not.toBeFocused();
    await expect(page.getByRole('heading', { name: /sign in/i })).toHaveCount(0);

    const skip = page.getByRole('link', { name: /skip to merchant records/i });
    await skip.focus();
    await skip.press('Enter');
    await expect(page.locator('#merchant-records')).toBeFocused();

    for (const [path, title] of leaves.slice(1)) {
      await page
        .getByRole('navigation', { name: 'Merchant sections' })
        .getByRole('link', { name: title, exact: true })
        .press('Enter');
      const leafHeading = page.getByRole('heading', { name: title });
      await expect(leafHeading).toBeVisible();
      await expect(leafHeading).toBeFocused();
      await expect(page.locator('#merchant-records')).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/merchant/shops/${shop.tenantId}/${path}`));
    }
  });

  test('loading and error states stay keyboard reachable inside the merchant shell', async ({
    page,
  }) => {
    await installMerchantSession(page);
    await stubMerchantApis(page, { hangOverview: true });
    await page.goto(`/merchant/shops/${shop.tenantId}/overview`);
    const overview = page.getByRole('heading', { name: 'Overview' });
    await expect(overview).toBeVisible();
    await expect(page.getByRole('status', { name: 'Loading overview metrics' })).toBeVisible();
    await expect(overview).toBeFocused();
    await expect(page.locator('#merchant-records')).toBeVisible();

    await installMerchantSession(page);
    await stubMerchantApis(page, { failLeaf: 'catalog' });
    await page.goto(`/merchant/shops/${shop.tenantId}/catalog`);
    const catalog = page.getByRole('heading', { name: 'Catalog' });
    await expect(catalog).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('Records unavailable');
    await expect(catalog).toBeFocused();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(page.locator('#merchant-records')).toBeVisible();
  });

  test('shop switcher moves a second membership onto overview and announces it', async ({
    page,
  }) => {
    await installMerchantSession(page);
    await stubMerchantApis(page, { shops: [shop, harbor] });
    await page.goto(`/merchant/shops/${shop.tenantId}/overview`);
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await page.getByLabel('Shop').selectOption(harbor.tenantId);
    await expect(page).toHaveURL(new RegExp(`/merchant/shops/${harbor.tenantId}/overview`));
    await expect(page.getByRole('heading', { name: harbor.name })).toBeVisible();
    await expect(page.locator('[aria-live="polite"]')).toHaveText(
      /Switched to Harbor Spice as viewer/i,
    );
  });

  test('overview keeps skip-to-main, reduced-motion, and heading contrast', async ({ page }) => {
    await installMerchantSession(page);
    await stubMerchantApis(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`/merchant/shops/${shop.tenantId}/overview`);
    const overview = page.getByRole('heading', { name: 'Overview' });
    await expect(overview).toBeVisible();
    await expect(page.getByRole('heading', { name: /sign in/i })).toHaveCount(0);
    await expectReadableHeading(overview);
    await expectReducedMotionDuration(overview);
    await expectSkipToMain(page);
    const skipRecords = page.getByRole('link', { name: /skip to merchant records/i });
    await skipRecords.focus();
    await skipRecords.press('Enter');
    await expect(page.locator('#merchant-records')).toBeFocused();
  });

  test('shop access denial stays keyboard reachable without a merchant records region', async ({
    page,
  }) => {
    await installMerchantSession(page);
    await stubMerchantApis(page);
    await page.goto('/merchant/shops/unknown-shop-in/overview');
    const denial = page.getByRole('heading', { name: 'Shop access denied' });
    await expect(denial).toBeVisible();
    await expect(denial).toBeFocused();
    await expect(page.locator('#merchant-records')).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Merchant sections' })).toHaveCount(0);
  });
});
