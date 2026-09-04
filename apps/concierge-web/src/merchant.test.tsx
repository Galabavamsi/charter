// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App, createAppMemoryRouter } from './App';
import type { AccountProfile, AccountShop, ShopRole } from './account';
import { ApiError, type ApiClient } from './api';
import type { AuthClient, AuthSession } from './auth';

const session: AuthSession = {
  accessToken: 'merchant-access-token',
  user: {
    id: 'user-merchant',
    email: 'merchant@example.invalid',
    name: 'Merchant Operator',
  },
};

const shop: AccountShop = {
  tenantId: 'northstar-demo-in',
  slug: 'northstar',
  name: 'Northstar Travel Coffee',
  label: 'Northstar Travel Coffee',
  blurb: 'Coffee gear for the road.',
  currency: 'INR',
  status: 'published',
  synthetic: true,
  role: 'owner',
};

function authClient(): AuthClient {
  return {
    configured: true,
    getSession: vi.fn(async () => session),
    signInWithPassword: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(async () => undefined),
    onAuthStateChange: () => () => undefined,
  };
}

function profile(role: ShopRole = 'owner', shops: AccountShop[] = [shop]): AccountProfile {
  return {
    profile: {
      userId: session.user.id,
      ...(session.user.email ? { email: session.user.email } : {}),
    },
    shops: shops.map((entry) => ({ ...entry, role })),
    platformRoles: [],
  };
}

const catalogItem = {
  productId: '94000000-0000-4000-8000-000000000001',
  productVersion: 1,
  title: 'PocketGrind Lite',
  description: 'A compact steel hand grinder.',
  status: 'published',
  category: {
    id: '95000000-0000-4000-8000-000000000001',
    slug: 'travel-coffee',
    title: 'Travel coffee',
  },
  variantId: '96000000-0000-4000-8000-000000000001',
  variantVersion: 1,
  sku: 'grinder.pocket-lite',
  material: 'steel',
  priceMinor: '99900',
  priceDisplay: '₹999.00',
  inventory: { onHand: 8, reserved: 0, available: 8, version: 1 },
  updatedAt: '2026-08-23T10:00:00.000Z',
};

function merchantApi(account: AccountProfile = profile()): ApiClient {
  return vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/v1/me') return account;
    if (path.match(/^\/v1\/merchant\/shops\/[^/]+\/overview/)) {
      return {
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
        attributionNote: 'Observed captures after recovery; no incremental lift claim.',
      };
    }
    if (path.startsWith('/v1/merchant/shops/northstar-demo-in/catalog')) {
      if (init?.method === 'POST') {
        return { item: catalogItem };
      }
      return { items: [catalogItem], nextCursor: null };
    }
    if (path.startsWith('/v1/merchant/shops/northstar-demo-in/orders/')) {
      return {
        id: '92000000-0000-4000-8000-000000000001',
        receipt: 'cht_test_order',
        razorpayOrderId: 'order_test_safe',
        status: 'SETTLED',
        paymentState: 'captured',
        totalMinor: '234700',
        totalDisplay: '₹2,347.00',
        createdAt: '2026-08-23T10:00:00.000Z',
        updatedAt: '2026-08-23T10:02:00.000Z',
        paid: true,
        fulfillmentReady: true,
        paymentTruth: 'Captured',
        quote: {
          id: '97000000-0000-4000-8000-000000000001',
          status: 'SETTLED',
          subtotalMinor: '234700',
          discountMinor: '0',
          totalMinor: '234700',
          lines: [{ sku: 'kit', title: 'Travel coffee kit', quantity: 1 }],
        },
        provider: {
          razorpayOrderId: 'order_test_safe',
          paymentId: 'pay_test_safe',
          status: 'captured',
        },
        timeline: [
          {
            id: 'capture',
            at: '2026-08-23T10:02:00.000Z',
            status: 'captured',
            label: 'Payment captured',
            detail: 'Captured ledger evidence. Eligible for fulfillment.',
          },
        ],
      };
    }
    if (path.startsWith('/v1/merchant/shops/northstar-demo-in/orders')) {
      return {
        items: [
          {
            id: '92000000-0000-4000-8000-000000000001',
            receipt: 'cht_test_order',
            razorpayOrderId: 'order_test_safe',
            status: 'SETTLED',
            paymentState: 'captured',
            totalMinor: '234700',
            totalDisplay: '₹2,347.00',
            createdAt: '2026-08-23T10:00:00.000Z',
            updatedAt: '2026-08-23T10:02:00.000Z',
            paid: true,
            fulfillmentReady: true,
            paymentTruth: 'Captured',
          },
          {
            id: '92000000-0000-4000-8000-000000000099',
            receipt: 'cht_unresolved',
            razorpayOrderId: 'order_unresolved',
            status: 'FAILED_PROVISIONAL',
            paymentState: 'failed',
            totalMinor: '99900',
            totalDisplay: '₹999.00',
            createdAt: '2026-08-23T09:00:00.000Z',
            updatedAt: '2026-08-23T09:02:00.000Z',
            paid: false,
            fulfillmentReady: false,
            paymentTruth: 'Payment not confirmed',
          },
        ],
        nextCursor: null,
      };
    }
    if (
      path ===
        '/v1/merchant/shops/northstar-demo-in/recovery/92000000-0000-4000-8000-000000000001/send' &&
      init?.method === 'POST'
    ) {
      return { action: 'sent', messageId: 'msg_recovery_001' };
    }
    if (path.startsWith('/v1/merchant/shops/northstar-demo-in/recovery')) {
      return {
        items: [
          {
            checkoutId: '92000000-0000-4000-8000-000000000001',
            quoteId: '97000000-0000-4000-8000-000000000001',
            razorpayOrderId: 'order_sendable',
            amountMinor: '99900',
            amountDisplay: '₹999.00',
            checkoutStatus: 'FAILED_PROVISIONAL',
            reconciliationStatus: 'unresolved',
            consentStatus: 'granted',
            sendStatus: 'not_sent',
            stopStatus: 'clear',
            canSend: true,
            blockedReason: null,
            updatedAt: '2026-08-23T10:00:00.000Z',
          },
          {
            checkoutId: '92000000-0000-4000-8000-000000000002',
            quoteId: '97000000-0000-4000-8000-000000000002',
            razorpayOrderId: 'order_captured',
            amountMinor: '234700',
            amountDisplay: '₹2,347.00',
            checkoutStatus: 'SETTLED',
            reconciliationStatus: 'captured',
            consentStatus: 'granted',
            sendStatus: 'not_sent',
            stopStatus: 'captured',
            canSend: false,
            blockedReason: 'PAYMENT_CAPTURED',
            updatedAt: '2026-08-23T10:02:00.000Z',
          },
        ],
        nextCursor: null,
      };
    }
    if (path.endsWith('/rules/preview')) {
      return {
        version: 1,
        items: [
          {
            sku: 'grinder.pocket-lite',
            outcome: 'allow',
            reason: 'WITHIN_POLICY',
          },
        ],
      };
    }
    if (path.endsWith('/rules')) {
      if (init?.method === 'PUT') {
        return {
          rules: {
            version: 2,
            hardCapMinor: '300000',
            hardCapDisplay: '₹3000.00',
            autonomousCapMinor: '250000',
            autonomousCapDisplay: '₹2500.00',
            forbiddenMaterials: ['glass'],
            offers: [],
          },
        };
      }
      return {
        version: 1,
        hardCapMinor: '300000',
        hardCapDisplay: '₹3000.00',
        autonomousCapMinor: '250000',
        autonomousCapDisplay: '₹2500.00',
        forbiddenMaterials: ['glass'],
        offers: [],
      };
    }
    if (path.endsWith('/settings')) {
      if (init?.method === 'PATCH') {
        return {
          settings: {
            version: 2,
            name: 'Northstar Travel Coffee',
            blurb: 'Coffee gear for every road.',
            slug: 'northstar',
            publicPath: '/shops/northstar',
            synthetic: true,
            testMode: true,
            paymentAccountDisclosure: 'Razorpay test mode. No live money.',
            members: [{ userId: 'owner-1', role: 'owner', status: 'active', label: 'Owner' }],
          },
        };
      }
      return {
        version: 1,
        name: 'Northstar Travel Coffee',
        blurb: 'Coffee gear for the road.',
        slug: 'northstar',
        publicPath: '/shops/northstar',
        synthetic: true,
        testMode: true,
        paymentAccountDisclosure: 'Razorpay test mode. No live money.',
        members: [{ userId: 'owner-1', role: 'owner', status: 'active', label: 'Owner' }],
      };
    }
    throw new Error(`UNEXPECTED_API:${path}:${init?.method ?? 'GET'}`);
  }) as ApiClient;
}

function renderAt(path: string, account: AccountProfile = profile(), api = merchantApi(account)) {
  const router = createAppMemoryRouter([path]);
  const rendered = render(<App authClient={authClient()} apiClient={api} router={router} />);
  return { ...rendered, api, router, user: userEvent.setup() };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('merchant workspace', () => {
  it('keeps a :focus-visible ring on route headings', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'product.css'), 'utf8');
    expect(css).toMatch(/\[data-route-heading\]:focus\s*\{[\s\S]*?outline:\s*none/);
    expect(css).toMatch(/\[data-route-heading\]:focus-visible\s*\{[\s\S]*?outline:\s*3px solid/);
  });

  it('onboards a first shop with labelled fields and an idempotency key', async () => {
    let created = false;
    const createdShop = {
      ...shop,
      tenantId: 'first-record-shop-a1b2c3d4',
      slug: 'first-record-shop',
      name: 'First Record Shop',
      status: 'draft' as const,
      synthetic: false,
    };
    const api = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/v1/me') {
        return profile('owner', created ? [createdShop] : []);
      }
      if (path === '/v1/shops' && init?.method === 'POST') {
        created = true;
        return { shop: createdShop };
      }
      throw new Error(`UNEXPECTED_API:${path}`);
    }) as ApiClient;
    const result = renderAt('/merchant', profile('owner', []), api);

    expect(await screen.findByRole('heading', { name: 'Create your first shop' })).toBeVisible();
    await result.user.type(screen.getByLabelText('Shop name'), 'First Record Shop');
    await result.user.type(screen.getByLabelText('What do you sell?'), 'Operationally calm goods.');
    await result.user.click(screen.getByRole('button', { name: 'Create shop' }));

    await waitFor(() =>
      expect(result.router.state.location.pathname).toBe(
        '/merchant/shops/first-record-shop-a1b2c3d4/overview',
      ),
    );
    const createCall = vi.mocked(api).mock.calls.find(([path]) => path === '/v1/shops');
    expect(createCall?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ 'idempotency-key': expect.any(String) }),
    });
  });

  it.each([
    ['viewer', false, false],
    ['catalog', true, false],
    ['support', false, true],
    ['finance', false, false],
    ['owner', true, true],
  ] as const)(
    'shows record-level controls for the %s capability',
    async (role, canWriteCatalog, canRecover) => {
      renderAt(`/merchant/shops/${shop.tenantId}/catalog`, profile(role));

      expect(await screen.findByRole('heading', { name: 'Catalog' })).toBeVisible();
      const nav = screen.getByRole('navigation', { name: 'Merchant sections' });
      expect(within(nav).getByRole('link', { name: 'Orders' })).toBeVisible();
      expect(Boolean(within(nav).queryByRole('link', { name: 'Recovery' }))).toBe(canRecover);
      expect(Boolean(screen.queryByRole('button', { name: 'Add product' }))).toBe(canWriteCatalog);
      if (canWriteCatalog) {
        expect(await screen.findByRole('button', { name: /adjust stock/i })).toBeVisible();
      } else {
        expect(await screen.findByText('PocketGrind Lite')).toBeVisible();
        expect(screen.queryByRole('button', { name: /adjust stock/i })).not.toBeInTheDocument();
      }
      if (!canWriteCatalog) {
        expect(screen.getByText(/read-only access/i)).toBeVisible();
      }
    },
  );

  it('keeps catalog money as a decimal string and presents persistent validation', async () => {
    const result = renderAt(`/merchant/shops/${shop.tenantId}/catalog`, profile('catalog'));
    await result.user.click(await screen.findByRole('button', { name: 'Add product' }));
    await result.user.type(screen.getByLabelText('Title'), 'Road press');
    await result.user.type(screen.getByLabelText('Description'), 'Compact steel travel press.');
    await result.user.type(screen.getByLabelText('Category'), 'Travel coffee');
    await result.user.type(screen.getByLabelText('SKU'), 'brewer.road-press');
    await result.user.selectOptions(screen.getByLabelText('Material'), 'steel');
    await result.user.type(screen.getByLabelText('Price in INR'), '23.001');
    await result.user.clear(screen.getByLabelText('Stock'));
    await result.user.type(screen.getByLabelText('Stock'), '3');
    await result.user.selectOptions(screen.getByLabelText('Status'), 'published');
    await result.user.click(screen.getByRole('button', { name: 'Save product' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Use rupees with no more than 2 decimal places.',
    );
    await result.user.clear(screen.getByLabelText('Price in INR'));
    await result.user.type(screen.getByLabelText('Price in INR'), '2347.00');
    await result.user.click(screen.getByRole('button', { name: 'Save product' }));

    await waitFor(() =>
      expect(vi.mocked(result.api)).toHaveBeenCalledWith(
        `/v1/merchant/shops/${shop.tenantId}/catalog/products`,
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"price":"2347.00"'),
        }),
      ),
    );
    expect(screen.getByRole('status')).toHaveTextContent('Product saved');
  });

  it('renders metric hierarchy with an explicit conversion denominator and attribution limit', async () => {
    renderAt(`/merchant/shops/${shop.tenantId}/overview`);

    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeVisible();
    expect(screen.getByRole('heading', { name: shop.name })).toHaveAttribute('tabindex', '-1');
    expect(await screen.findByText('₹2,347.00')).toBeVisible();
    expect(screen.getByText('1 / 2')).toBeVisible();
    expect(screen.getByText(/no incremental lift claim/i)).toBeVisible();
    expect(screen.getByText(/synthetic \/ test data/i)).toBeVisible();
    expect(screen.getByText('Failed / unresolved pays')).toBeVisible();
    expect(screen.getByText(/refunded captures are excluded/i)).toBeVisible();
  });

  it('filters orders and opens a capture-truth timeline', async () => {
    const result = renderAt(`/merchant/shops/${shop.tenantId}/orders`, profile('finance'));
    await result.user.type(await screen.findByLabelText('Search orders'), 'cht_test');
    await result.user.selectOptions(screen.getByLabelText('Payment status'), 'SETTLED');
    await result.user.click(screen.getByRole('button', { name: 'Apply filters' }));

    await waitFor(() =>
      expect(vi.mocked(result.api)).toHaveBeenCalledWith(
        expect.stringMatching(/orders\?.*q=cht_test.*status=SETTLED/),
        expect.anything(),
      ),
    );
    await result.user.click(
      await screen.findByRole('button', { name: /open order cht_test_order/i }),
    );
    expect(await screen.findByRole('heading', { name: 'Order timeline' })).toBeVisible();
    expect(screen.getByText('Payment not confirmed')).toBeVisible();
    expect(screen.getByText('Payment captured')).toBeVisible();
    expect(screen.getAllByText(/eligible for fulfillment/i)).not.toHaveLength(0);
  });

  it('shows recovery stop reasons and sends only the individually eligible record', async () => {
    const result = renderAt(`/merchant/shops/${shop.tenantId}/recovery`, profile('support'));

    expect(await screen.findByText('Payment already captured')).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Send recovery email' })).toHaveLength(1);
    await result.user.click(screen.getByRole('button', { name: 'Send recovery email' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Recovery email sent');
    expect(vi.mocked(result.api)).toHaveBeenCalledWith(
      expect.stringContaining('/recovery/92000000-0000-4000-8000-000000000001/send'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('keeps rules manager-only and exposes settings share plus read-only membership records', async () => {
    const viewerRules = renderAt(`/merchant/shops/${shop.tenantId}/rules`, profile('viewer'));
    expect(await screen.findByRole('heading', { name: 'Rules' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Publish rules' })).not.toBeInTheDocument();
    viewerRules.unmount();

    const ownerSettings = renderAt(`/merchant/shops/${shop.tenantId}/settings`, profile('owner'));
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeVisible();
    expect(await screen.findByDisplayValue('northstar')).toBeDisabled();
    expect(screen.getByText('Razorpay test mode. No live money.')).toBeVisible();
    expect(screen.getByText('Owner')).toBeVisible();
    await ownerSettings.user.click(screen.getByRole('button', { name: 'Copy public link' }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('/shops/northstar'));
    expect(screen.getByRole('link', { name: 'Share on WhatsApp' })).toHaveAttribute(
      'href',
      expect.stringContaining('wa.me'),
    );
  });

  it('moves a viewer shop off recovery onto overview and announces the switch', async () => {
    const viewerShop: AccountShop = {
      ...shop,
      tenantId: 'harbor-spice-in',
      slug: 'harbor-spice',
      name: 'Harbor Spice',
      role: 'viewer',
    };
    const mixed: AccountProfile = {
      profile: {
        userId: session.user.id,
        ...(session.user.email ? { email: session.user.email } : {}),
      },
      shops: [{ ...shop, role: 'owner' }, viewerShop],
      platformRoles: [],
    };
    const result = renderAt(`/merchant/shops/${shop.tenantId}/recovery`, mixed);
    expect(await screen.findByRole('heading', { name: shop.name })).toBeVisible();
    await result.user.selectOptions(screen.getByLabelText('Shop'), viewerShop.tenantId);
    expect(
      await screen.findByText(/Opened overview because recovery is unavailable/i),
    ).toBeVisible();
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeVisible();
  });

  it('moves focus from account loading to the overview heading once the merchant shell opens', async () => {
    let releaseAccount!: (value: AccountProfile) => void;
    const pendingAccount = new Promise<AccountProfile>((resolve) => {
      releaseAccount = resolve;
    });
    const api = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/v1/me') {
        return pendingAccount;
      }
      return merchantApi()(path, init);
    }) as ApiClient;
    renderAt(`/merchant/shops/${shop.tenantId}/overview`, profile(), api);
    expect(await screen.findByRole('heading', { name: 'Loading account access' })).toBeVisible();
    releaseAccount(profile());
    const overview = await screen.findByRole('heading', { name: 'Overview' });
    await waitFor(() => expect(overview).toHaveFocus());
    expect(document.getElementById('merchant-records')).toBeTruthy();
  });

  it.each([
    ['overview', 'Overview'],
    ['catalog', 'Catalog'],
    ['orders', 'Orders'],
    ['recovery', 'Recovery'],
    ['rules', 'Rules'],
    ['settings', 'Settings'],
  ] as const)('focuses the %s leaf heading instead of the shop name', async (section, title) => {
    renderAt(`/merchant/shops/${shop.tenantId}/${section}`);
    const leaf = await screen.findByRole('heading', { name: title });
    await waitFor(() => expect(leaf).toHaveFocus());
    expect(screen.getByRole('heading', { name: shop.name })).not.toHaveFocus();
    expect(screen.getByRole('link', { name: 'Skip to merchant records' })).toHaveAttribute(
      'href',
      '#merchant-records',
    );
    expect(document.getElementById('merchant-records')).toHaveAttribute('tabindex', '-1');
  });

  it('moves focus to merchant records when the skip link is activated', async () => {
    const result = renderAt(`/merchant/shops/${shop.tenantId}/overview`);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Overview' })).toHaveFocus());
    await result.user.click(screen.getByRole('link', { name: 'Skip to merchant records' }));
    expect(document.getElementById('merchant-records')).toHaveFocus();
  });

  it('shows quote-created-in-window cohort copy on overview', async () => {
    renderAt(`/merchant/shops/${shop.tenantId}/overview`);
    expect(await screen.findByText(/quotes created in this window/i)).toBeVisible();
    expect(screen.queryByText(/valid frozen quotes/i)).not.toBeInTheDocument();
  });

  it('renders the API INR display string with Indian grouping', async () => {
    const api = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.match(/^\/v1\/merchant\/shops\/[^/]+\/overview/)) {
        return {
          range: { from: '2026-07-25', to: '2026-08-23' },
          capturedGmvMinor: '10000000',
          capturedGmvDisplay: '₹1,00,000.00',
          capturedOrders: 1,
          validFrozenQuotes: 1,
          conversion: { numerator: 1, denominator: 1, rate: 1 },
          failedUnresolvedPays: 0,
          recoveredAmountMinor: '0',
          recoveredAmountDisplay: '₹0.00',
          inventoryUnits: 8,
          lowStockVariants: 0,
          synthetic: true,
          attributionNote:
            'Cohort is quotes created in this window. Captured GMV and conversion count only captures in the same window whose quote is in that cohort.',
        };
      }
      return merchantApi()(path, init);
    }) as ApiClient;
    renderAt(`/merchant/shops/${shop.tenantId}/overview`, profile(), api);
    expect(await screen.findByText('₹1,00,000.00')).toBeVisible();
  });

  it('surfaces the shared date-range contract when orders filters are invalid', async () => {
    const base = merchantApi();
    const api = vi.fn(async (path: string, init?: RequestInit) => {
      if (
        path.startsWith('/v1/merchant/shops/northstar-demo-in/orders?') &&
        path.includes('from=')
      ) {
        throw new ApiError({ status: 400, code: 'DATE_RANGE_INVALID' });
      }
      return base(path, init);
    }) as ApiClient;
    const result = renderAt(`/merchant/shops/${shop.tenantId}/orders`, profile(), api);
    const from = await screen.findByLabelText('From');
    const to = screen.getByLabelText('To');
    await result.user.type(from, '2026-08-31');
    await result.user.type(to, '2026-08-01');
    await result.user.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /real calendar date range of at most 366 days/i,
    );
  });

  it.each([
    ['overview', 'Overview', 'Loading overview metrics'],
    ['catalog', 'Catalog', 'Loading catalog records'],
    ['orders', 'Orders', 'Loading order records'],
    ['recovery', 'Recovery', 'Loading recovery queue'],
    ['rules', 'Rules', 'Loading rules'],
    ['settings', 'Settings', 'Loading shop settings'],
  ] as const)('shows loading and error on the %s leaf', async (section, title, loadingLabel) => {
    const loadingApi = vi.fn(async (path: string) => {
      if (path === '/v1/me') return profile();
      return new Promise(() => undefined);
    }) as ApiClient;
    const loading = renderAt(`/merchant/shops/${shop.tenantId}/${section}`, profile(), loadingApi);
    expect(await screen.findByRole('status', { name: loadingLabel })).toBeVisible();
    await waitFor(() => expect(screen.getByRole('heading', { name: title })).toHaveFocus());
    loading.unmount();

    const failingApi = vi.fn(async (path: string) => {
      if (path === '/v1/me') return profile();
      throw new Error('RECORDS_UNAVAILABLE');
    }) as ApiClient;
    renderAt(`/merchant/shops/${shop.tenantId}/${section}`, profile(), failingApi);
    const alerts = await screen.findAllByRole('alert');
    expect(alerts[0]).toHaveTextContent('Records unavailable');
    await waitFor(() => expect(screen.getByRole('heading', { name: title })).toHaveFocus());
    expect(screen.getAllByRole('button', { name: 'Try again' }).length).toBeGreaterThan(0);
  });

  it('focuses shop access denial instead of a merchant shell heading', async () => {
    renderAt('/merchant/shops/unknown-shop-in/overview');
    const denial = await screen.findByRole('heading', { name: 'Shop access denied' });
    await waitFor(() => expect(denial).toHaveFocus());
    expect(screen.getByText('403')).toBeVisible();
    expect(screen.queryByRole('navigation', { name: 'Merchant sections' })).not.toBeInTheDocument();
  });

  it('moves keyboard focus to the next leaf heading when changing merchant sections', async () => {
    const result = renderAt(`/merchant/shops/${shop.tenantId}/overview`);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Overview' })).toHaveFocus());
    await result.user.click(
      within(screen.getByRole('navigation', { name: 'Merchant sections' })).getByRole('link', {
        name: 'Orders',
      }),
    );
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Orders' })).toHaveFocus());
    expect(screen.getByRole('heading', { name: shop.name })).not.toHaveFocus();
  });

  it('appends catalog pages, resets on shop change, and retries load more without duplicates', async () => {
    const secondShop: AccountShop = {
      ...shop,
      tenantId: 'harbor-spice-in',
      slug: 'harbor-spice',
      name: 'Harbor Spice',
    };
    const account = profile('owner', [shop, secondShop]);
    const pageTwo = {
      ...catalogItem,
      productId: '94000000-0000-4000-8000-000000000002',
      variantId: '96000000-0000-4000-8000-000000000002',
      title: 'TrailPress Steel',
      sku: 'brewer.trailpress-steel-750',
    };
    const harborItem = {
      ...catalogItem,
      productId: '94000000-0000-4000-8000-000000000003',
      variantId: '96000000-0000-4000-8000-000000000003',
      title: 'Harbor mill',
      sku: 'mill.harbor',
    };
    let moreAttempts = 0;
    const base = merchantApi(account);
    const api = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.startsWith('/v1/merchant/shops/harbor-spice-in/catalog')) {
        return { items: [harborItem], nextCursor: null };
      }
      if (path.startsWith('/v1/merchant/shops/northstar-demo-in/catalog')) {
        if (path.includes('after=')) {
          throw new Error('merchant list pagination must use cursor=, not after=');
        }
        if (path.includes('cursor=')) {
          moreAttempts += 1;
          if (moreAttempts === 1) {
            throw new Error('CATALOG_PAGE_UNAVAILABLE');
          }
          return { items: [catalogItem, pageTwo], nextCursor: null };
        }
        return { items: [catalogItem], nextCursor: 'catalog-cursor-2' };
      }
      return base(path, init);
    }) as ApiClient;
    const result = renderAt(`/merchant/shops/${shop.tenantId}/catalog`, account, api);
    expect(await screen.findByText('PocketGrind Lite')).toBeVisible();
    expect(screen.queryByText('TrailPress Steel')).not.toBeInTheDocument();
    await result.user.click(screen.getByRole('button', { name: 'Load more catalog' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Records unavailable');
    await result.user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('TrailPress Steel')).toBeVisible();
    expect(screen.getAllByText('PocketGrind Lite')).toHaveLength(1);
    expect(api).toHaveBeenCalledWith(
      expect.stringContaining('cursor=catalog-cursor-2'),
      expect.anything(),
    );
    expect(vi.mocked(api).mock.calls.some(([path]) => String(path).includes('after='))).toBe(false);
    await result.user.selectOptions(screen.getByLabelText('Shop'), secondShop.tenantId);
    expect(await screen.findByText('Harbor mill')).toBeVisible();
    expect(screen.queryByText('PocketGrind Lite')).not.toBeInTheDocument();
    expect(screen.queryByText('TrailPress Steel')).not.toBeInTheDocument();
  });

  it('appends order and recovery pages and resets those lists when filters change', async () => {
    const secondOrder = {
      id: '92000000-0000-4000-8000-000000000099',
      receipt: 'cht_second',
      razorpayOrderId: 'order_second',
      status: 'FAILED_PROVISIONAL',
      paymentState: 'failed',
      totalMinor: '99900',
      totalDisplay: '₹999.00',
      createdAt: '2026-08-23T09:00:00.000Z',
      updatedAt: '2026-08-23T09:02:00.000Z',
      paid: false,
      fulfillmentReady: false,
      paymentTruth: 'Payment not confirmed',
    };
    const secondRecovery = {
      checkoutId: '92000000-0000-4000-8000-000000000099',
      quoteId: '97000000-0000-4000-8000-000000000099',
      razorpayOrderId: 'order_second',
      amountMinor: '99900',
      amountDisplay: '₹999.00',
      checkoutStatus: 'RECONCILING',
      reconciliationStatus: 'unresolved',
      consentStatus: 'granted',
      sendStatus: 'not_sent',
      stopStatus: 'clear',
      canSend: false,
      blockedReason: 'RECONCILIATION_REQUIRED',
      updatedAt: '2026-08-23T09:00:00.000Z',
    };
    const base = merchantApi();
    const api = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.startsWith('/v1/merchant/shops/northstar-demo-in/orders?')) {
        if (path.includes('status=FAILED_PROVISIONAL')) {
          return { items: [secondOrder], nextCursor: null };
        }
        if (path.includes('after=')) {
          throw new Error('merchant list pagination must use cursor=, not after=');
        }
        if (path.includes('cursor=')) {
          return { items: [secondOrder], nextCursor: null };
        }
        return {
          items: [
            {
              id: '92000000-0000-4000-8000-000000000001',
              receipt: 'cht_test_order',
              razorpayOrderId: 'order_test_safe',
              status: 'SETTLED',
              paymentState: 'captured',
              totalMinor: '234700',
              totalDisplay: '₹2,347.00',
              createdAt: '2026-08-23T10:00:00.000Z',
              updatedAt: '2026-08-23T10:02:00.000Z',
              paid: true,
              fulfillmentReady: true,
              paymentTruth: 'Captured',
            },
          ],
          nextCursor: 'orders-cursor-2',
        };
      }
      if (path.startsWith('/v1/merchant/shops/northstar-demo-in/recovery?')) {
        if (path.includes('status=RECONCILING')) {
          return { items: [secondRecovery], nextCursor: null };
        }
        if (path.includes('after=')) {
          throw new Error('merchant list pagination must use cursor=, not after=');
        }
        if (path.includes('cursor=')) {
          return { items: [secondRecovery], nextCursor: null };
        }
        return {
          items: [
            {
              checkoutId: '92000000-0000-4000-8000-000000000001',
              quoteId: '97000000-0000-4000-8000-000000000001',
              razorpayOrderId: 'order_sendable',
              amountMinor: '99900',
              amountDisplay: '₹999.00',
              checkoutStatus: 'FAILED_PROVISIONAL',
              reconciliationStatus: 'unresolved',
              consentStatus: 'granted',
              sendStatus: 'not_sent',
              stopStatus: 'clear',
              canSend: true,
              blockedReason: null,
              updatedAt: '2026-08-23T10:00:00.000Z',
            },
          ],
          nextCursor: 'recovery-cursor-2',
        };
      }
      return base(path, init);
    }) as ApiClient;

    const orders = renderAt(`/merchant/shops/${shop.tenantId}/orders`, profile(), api);
    expect(await screen.findByText('cht_test_order')).toBeVisible();
    await orders.user.click(screen.getByRole('button', { name: 'Load more orders' }));
    expect(await screen.findByText('cht_second')).toBeVisible();
    expect(screen.getByText('cht_test_order')).toBeVisible();
    expect(api).toHaveBeenCalledWith(
      expect.stringContaining('cursor=orders-cursor-2'),
      expect.anything(),
    );
    expect(vi.mocked(api).mock.calls.some(([path]) => String(path).includes('after='))).toBe(false);
    await orders.user.selectOptions(screen.getByLabelText('Payment status'), 'FAILED_PROVISIONAL');
    await orders.user.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(await screen.findByText('cht_second')).toBeVisible();
    expect(screen.queryByText('cht_test_order')).not.toBeInTheDocument();
    orders.unmount();

    const recovery = renderAt(`/merchant/shops/${shop.tenantId}/recovery`, profile(), api);
    expect(await screen.findByText('order_sendable')).toBeVisible();
    await recovery.user.click(screen.getByRole('button', { name: 'Load more recovery' }));
    expect(await screen.findByText('order_second')).toBeVisible();
    expect(api).toHaveBeenCalledWith(
      expect.stringContaining('cursor=recovery-cursor-2'),
      expect.anything(),
    );
    expect(vi.mocked(api).mock.calls.some(([path]) => String(path).includes('after='))).toBe(false);
    await recovery.user.selectOptions(screen.getByLabelText('Queue status'), 'RECONCILING');
    expect(await screen.findByText('order_second')).toBeVisible();
    expect(screen.queryByText('order_sendable')).not.toBeInTheDocument();
  });
});
