// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, createAppMemoryRouter } from './App';
import type { AccountProfile } from './account';
import type { ApiClient } from './api';
import type { AuthClient, AuthSession } from './auth';

const buyerSession: AuthSession = {
  accessToken: 'access-token',
  user: {
    id: 'user-buyer',
    email: 'buyer@example.com',
    name: 'Avery Buyer',
  },
};

const buyerProfile: AccountProfile = {
  profile: { userId: 'user-buyer', email: 'buyer@example.com' },
  shops: [],
  platformRoles: [],
};

const merchantShop = {
  tenantId: 'northstar-demo-in',
  slug: 'northstar',
  name: 'Northstar Travel Coffee',
  label: 'Northstar',
  blurb: 'Coffee gear for the road.',
  currency: 'INR' as const,
  status: 'published' as const,
  synthetic: true,
  role: 'owner' as const,
};

function authClient(
  initialSession: AuthSession | null,
  options: { configured?: boolean } = {},
): AuthClient {
  let session = initialSession;
  const listeners = new Set<(next: AuthSession | null) => void>();
  const emit = () => listeners.forEach((listener) => listener(session));

  return {
    configured: options.configured ?? true,
    getSession: vi.fn(async () => session),
    signInWithPassword: vi.fn(async ({ email }) => {
      session = {
        ...buyerSession,
        user: { ...buyerSession.user, email },
      };
      emit();
      return session;
    }),
    signUp: vi.fn(async ({ email, options: signUpOptions }) => {
      session = {
        ...buyerSession,
        user: {
          ...buyerSession.user,
          email,
          name:
            typeof signUpOptions?.data?.name === 'string'
              ? signUpOptions.data.name
              : buyerSession.user.name,
        },
      };
      emit();
      return session;
    }),
    signOut: vi.fn(async () => {
      session = null;
      emit();
    }),
    onAuthStateChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function apiClient(profile: AccountProfile = buyerProfile): ApiClient {
  return vi.fn(async (path: string) => {
    if (path === '/v1/me') {
      return profile;
    }
    if (path === '/v1/shops') {
      return {
        items: [
          {
            tenantId: merchantShop.tenantId,
            slug: merchantShop.slug,
            name: merchantShop.name,
            blurb: merchantShop.blurb,
            currency: 'INR',
            href: '/shops/northstar',
            catalogPath: '/api/v1/merchants/northstar-demo-in/catalog',
            itemCount: 2,
            inStockCount: 2,
            unitsInStock: 8,
          },
        ],
      };
    }
    if (path === '/v1/shops/northstar') {
      return {
        shop: {
          tenantId: merchantShop.tenantId,
          slug: merchantShop.slug,
          name: merchantShop.name,
          blurb: merchantShop.blurb,
          currency: 'INR',
          href: '/shops/northstar',
          catalogPath: '/api/v1/merchants/northstar-demo-in/catalog',
          itemCount: 2,
          inStockCount: 2,
          unitsInStock: 8,
        },
        merchant: merchantShop,
        items: [],
      };
    }
    if (path === '/v1/merchants/northstar-demo-in') {
      return merchantShop;
    }
    if (path === '/v1/merchants/northstar-demo-in/catalog') {
      return { items: [] };
    }
    if (path === '/v1/concierge/config') {
      return { voiceEnabled: false, recoveryEnabled: false };
    }
    if (path.startsWith('/v1/merchant/shops/northstar-demo-in/overview')) {
      return {
        range: { from: '2026-07-25', to: '2026-08-23' },
        capturedGmvMinor: '234700',
        capturedGmvDisplay: '₹2,347.00',
        capturedOrders: 1,
        validFrozenQuotes: 2,
        conversion: { numerator: 1, denominator: 2, rate: 0.5 },
        failedUnresolvedPays: 0,
        recoveredAmountMinor: '0',
        recoveredAmountDisplay: '₹0.00',
        inventoryUnits: 8,
        lowStockVariants: 0,
        synthetic: true,
        attributionNote: 'Observed records; no incremental lift claim.',
        searches: 0,
        recommendationsBySku: [],
        recommendationsBySource: [],
      };
    }
    if (path.startsWith('/v1/merchant/shops/northstar-demo-in/catalog')) {
      return {
        items: [
          {
            productId: '94000000-0000-4000-8000-000000000001',
            productVersion: 1,
            title: 'Coffee kit',
            description: 'Canonical coffee kit.',
            status: 'published',
            category: {
              id: '95000000-0000-4000-8000-000000000001',
              slug: 'travel-coffee',
              title: 'Travel coffee',
            },
            variantId: '96000000-0000-4000-8000-000000000001',
            variantVersion: 1,
            sku: 'coffee-kit',
            material: 'steel',
            priceMinor: '120000',
            priceDisplay: '₹1200.00',
            inventory: { onHand: 8, reserved: 0, available: 8, version: 1 },
            updatedAt: '2026-08-23T10:00:00.000Z',
          },
        ],
        nextCursor: null,
      };
    }
    if (path === '/v1/orders' || path.startsWith('/v1/orders?')) {
      return { items: [], nextCursor: null };
    }
    if (path.startsWith('/v1/orders/')) {
      throw Object.assign(new Error('ORDER_NOT_FOUND'), { status: 404, code: 'ORDER_NOT_FOUND' });
    }
    if (path.startsWith('/v1/merchant/shops/northstar-demo-in/orders')) {
      return { items: [], nextCursor: null };
    }
    if (path.startsWith('/v1/merchant/shops/northstar-demo-in/recovery')) {
      return { items: [], nextCursor: null };
    }
    if (path.endsWith('/rules/preview')) {
      return { version: 1, items: [] };
    }
    if (path.endsWith('/rules')) {
      return {
        version: 1,
        hardCapMinor: '500000',
        hardCapDisplay: '₹5000.00',
        autonomousCapMinor: '250000',
        autonomousCapDisplay: '₹2500.00',
        forbiddenMaterials: [],
        offers: [],
      };
    }
    if (path.endsWith('/settings')) {
      return {
        version: 1,
        name: merchantShop.name,
        blurb: merchantShop.blurb,
        slug: merchantShop.slug,
        publicPath: '/shops/northstar',
        synthetic: true,
        testMode: true,
        paymentAccountDisclosure: 'Razorpay test mode. No live money.',
        members: [{ userId: 'user-buyer', role: 'owner', status: 'active', label: 'Owner' }],
      };
    }
    if (path === '/v1/register/northstar-demo-in') {
      return {
        merchant: merchantShop,
        authority: {
          hardCapDisplay: '₹5000.00',
          autonomousCapDisplay: '₹2500.00',
          forbiddenMaterials: [],
        },
        catalog: [
          {
            sku: 'coffee-kit',
            title: 'Coffee kit',
            priceDisplay: '₹1200.00',
            stock: 8,
            material: 'steel',
          },
        ],
        quotes: [],
        checkouts: [],
        captures: [],
        approvals: [
          {
            id: 'approval-1',
            cartId: 'cart-1',
            fromTitle: 'Coffee kit',
            toTitle: 'Travel coffee kit',
            proposedDisplay: '₹1200.00',
            reason: 'Buyer requested a substitute.',
            status: 'pending',
          },
        ],
        refunds: { available: false, note: 'Not enabled.' },
      };
    }
    if (path === '/v1/control') {
      return {
        kill: { global: false, tenants: {} },
        flags: {},
        inbox: [],
      };
    }
    return {};
  }) as ApiClient;
}

function renderAt(
  path: string,
  options: {
    session?: AuthSession | null;
    profile?: AccountProfile;
    client?: AuthClient;
    api?: ApiClient;
  } = {},
) {
  const client = options.client ?? authClient(options.session ?? null);
  const api = options.api ?? apiClient(options.profile);
  const router = createAppMemoryRouter([path]);
  const rendered = render(<App authClient={client} apiClient={api} router={router} />);
  return { ...rendered, api, client, router, user: userEvent.setup() };
}

function expectPresent(element: HTMLElement | null, present: boolean) {
  if (present) {
    expect(element).toBeVisible();
  } else {
    expect(element).not.toBeInTheDocument();
  }
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('Charter app shell authentication', () => {
  it('signs in with email/password and safely returns to next', async () => {
    const result = renderAt('/auth/sign-in?next=%2Fshops');

    await result.user.type(await screen.findByLabelText('Email'), 'buyer@example.com');
    await result.user.type(screen.getByLabelText('Password'), 'correct horse battery staple');
    await result.user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(result.client.signInWithPassword).toHaveBeenCalledWith({
      email: 'buyer@example.com',
      password: 'correct horse battery staple',
    });
    await waitFor(() => expect(result.router.state.location.pathname).toBe('/shops'));
  });

  it('signs up with email/password and profile name', async () => {
    const result = renderAt('/auth/sign-up?next=%2Fmerchant');

    await result.user.type(await screen.findByLabelText('Name'), 'Avery Buyer');
    await result.user.type(screen.getByLabelText('Email'), 'new@example.com');
    await result.user.type(screen.getByLabelText('Password'), 'long-enough-password');
    await result.user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(result.client.signUp).toHaveBeenCalledWith({
      email: 'new@example.com',
      password: 'long-enough-password',
      options: { data: { name: 'Avery Buyer' } },
    });
    await waitFor(() => expect(result.router.state.location.pathname).toBe('/merchant'));
  });

  it('rejects a malicious next target after sign-in', async () => {
    const result = renderAt(
      '/auth/sign-in?next=https%3A%2F%2Fattacker.example%2Fcollect%3Ftoken%3D1',
    );

    await result.user.type(await screen.findByLabelText('Email'), 'buyer@example.com');
    await result.user.type(screen.getByLabelText('Password'), 'correct horse battery staple');
    await result.user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(result.router.state.location.pathname).toBe('/chats'));
  });

  it('returns a direct shared chat link to the same shop after sign-in', async () => {
    const result = renderAt('/buyer/northstar/chat/thread-9');

    expect(await screen.findByRole('heading', { name: 'Sign in to Charter' })).toBeVisible();
    expect(result.router.state.location.pathname).toBe('/auth/sign-in');
    expect(new URLSearchParams(result.router.state.location.search).get('next')).toBe(
      '/buyer/northstar/chat/thread-9',
    );

    await result.user.type(screen.getByLabelText('Email'), 'buyer@example.com');
    await result.user.type(screen.getByLabelText('Password'), 'correct horse battery staple');
    await result.user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() =>
      expect(result.router.state.location.pathname).toBe('/buyer/northstar/chat/thread-9'),
    );
    expect(await screen.findByRole('heading', { name: 'Concierge' })).toBeVisible();
  });

  it('redirects an already signed-in account away from auth', async () => {
    const result = renderAt('/auth/sign-in?next=%2Fbuyer%2Fnorthstar', {
      session: buyerSession,
    });

    await waitFor(() => expect(result.router.state.location.pathname).toBe('/buyer/northstar'));
    expect(await screen.findByRole('heading', { name: 'Concierge' })).toBeVisible();
  });

  it('sends a signed-in buyer to Concierge instead of the public catalog', async () => {
    const result = renderAt('/', { session: buyerSession });

    await waitFor(() => expect(result.router.state.location.pathname).toBe('/chats'));
    expect(await screen.findByRole('heading', { name: 'What are you looking for?' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Continue Northstar' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Concierge' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Shop directory' })).not.toBeInTheDocument();
  });

  it('explains when Supabase auth is not configured locally', async () => {
    renderAt('/auth/sign-in', {
      client: authClient(null, { configured: false }),
    });

    expect(
      await screen.findByText(/authentication is not configured for this local build/i),
    ).toBeVisible();
    expect(screen.getByText(/VITE_SUPABASE_URL/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
  });

  it('shows the actual authentication error from the rejected request', async () => {
    const client = authClient(null);
    client.signInWithPassword = vi.fn(async () => {
      throw new Error('Invalid login credentials');
    });
    const result = renderAt('/auth/sign-in', { client });

    await result.user.type(await screen.findByLabelText('Email'), 'buyer@example.com');
    await result.user.type(screen.getByLabelText('Password'), 'incorrect-password');
    await result.user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid login credentials');
  });
});

describe('Charter app shell authorization and navigation', () => {
  it.each([
    {
      name: 'buyer',
      path: '/buyer/northstar',
      profile: buyerProfile,
    },
    {
      name: 'merchant',
      path: '/merchant/shops/northstar-demo-in/overview',
      profile: { ...buyerProfile, shops: [merchantShop] },
    },
    {
      name: 'control',
      path: '/control',
      profile: { ...buyerProfile, platformRoles: ['admin' as const] },
    },
  ])('keeps sign out accessible from the $name shell', async ({ path, profile }) => {
    const result = renderAt(path, { session: buyerSession, profile });

    await result.user.click(await screen.findByRole('button', { name: /account menu/i }));
    await result.user.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(result.client.signOut).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.router.state.location.pathname).toBe('/'));
  });

  it('exposes buyer and merchant destinations for one account', async () => {
    const result = renderAt('/buyer/northstar', {
      session: buyerSession,
      profile: { ...buyerProfile, shops: [merchantShop] },
    });

    await result.user.click(await screen.findByRole('button', { name: /account menu/i }));
    const menu = screen.getByRole('navigation', { name: 'Account links' });
    expect(within(menu).getByRole('link', { name: 'Concierge' })).toBeVisible();
    expect(within(menu).getByRole('link', { name: 'Shops' })).toBeVisible();
    expect(within(menu).getByRole('link', { name: 'Buyer orders' })).toBeVisible();
    expect(within(menu).getByRole('link', { name: 'My shops' })).toBeVisible();
    expect(within(menu).queryByRole('link', { name: 'Control' })).not.toBeInTheDocument();
    expect(within(menu).getByText('buyer@example.com')).toBeVisible();
  });

  it('denies Control from repository profile data without a platform role', async () => {
    renderAt('/control', { session: buyerSession, profile: buyerProfile });

    const denial = await screen.findByRole('alert');
    expect(denial).toHaveTextContent('403');
    expect(denial).toHaveTextContent(/operator or administrator/i);
  });

  it('denies an auditor because the Control read API allows only operators and admins', async () => {
    const result = renderAt('/control', {
      session: buyerSession,
      profile: { ...buyerProfile, platformRoles: ['auditor'] },
    });

    const denial = await screen.findByRole('alert');
    expect(denial).toHaveTextContent('403');
    await result.user.click(screen.getByRole('button', { name: /account menu/i }));
    expect(
      within(screen.getByRole('navigation', { name: 'Account links' })).queryByRole('link', {
        name: 'Control',
      }),
    ).not.toBeInTheDocument();
  });

  it.each([
    ['operator', false],
    ['admin', true],
  ] as const)('gates Control kill actions for %s', async (role, canKill) => {
    renderAt('/control', {
      session: buyerSession,
      profile: { ...buyerProfile, platformRoles: [role] },
    });

    expect(await screen.findByRole('heading', { name: 'Control' })).toBeVisible();
    const switches = screen.queryByRole('link', { name: 'Switches' });
    if (canKill) {
      expect(switches).toBeVisible();
    } else {
      expect(switches).not.toBeInTheDocument();
    }
    expect(
      await screen.findByText('Persisted control state. Changes survive process restarts.'),
    ).toBeVisible();
    const tenantKill = screen.queryByRole('button', { name: /this shop’s checkout/i });
    if (canKill) {
      expect(tenantKill).toBeVisible();
    } else {
      expect(tenantKill).not.toBeInTheDocument();
    }
  });

  it.each([
    ['viewer', false, false],
    ['support', false, true],
    ['finance', false, false],
    ['catalog', true, false],
    ['owner', true, true],
    ['admin', true, true],
  ] as const)(
    'shows only permitted merchant actions for %s',
    async (role, catalogWrite, recoveryOperate) => {
      const shop = { ...merchantShop, role };
      renderAt('/merchant/shops/northstar-demo-in/catalog', {
        session: buyerSession,
        profile: { ...buyerProfile, shops: [shop] },
      });

      expect(await screen.findByRole('heading', { name: 'Catalog' })).toBeVisible();
      const merchantNav = screen.getByRole('navigation', { name: 'Merchant sections' });
      expect(within(merchantNav).getByRole('link', { name: 'Catalog' })).toBeVisible();
      expect(within(merchantNav).getByRole('link', { name: 'Orders' })).toBeVisible();
      expectPresent(within(merchantNav).queryByRole('link', { name: 'Recovery' }), recoveryOperate);
      expectPresent(screen.queryByRole('button', { name: 'Add product' }), catalogWrite);
      if (catalogWrite) {
        expect(
          await screen.findByRole('button', { name: /adjust stock for coffee kit/i }),
        ).toBeVisible();
      } else {
        expect(await screen.findByText(/read-only access/i)).toBeVisible();
      }
    },
  );

  it.each([['finance', '/merchant/shops/northstar-demo-in/recovery', 'Overview']] as const)(
    'redirects %s off unavailable merchant sections',
    async (role, path, title) => {
      renderAt(path, {
        session: buyerSession,
        profile: { ...buyerProfile, shops: [{ ...merchantShop, role }] },
      });

      expect(await screen.findByRole('heading', { name: title })).toBeVisible();
    },
  );

  it('denies a merchant shop that is absent from repository memberships', async () => {
    renderAt('/merchant/shops/northstar-demo-in', {
      session: buyerSession,
      profile: buyerProfile,
    });

    const denial = await screen.findByRole('alert');
    expect(denial).toHaveTextContent('403');
    expect(denial).toHaveTextContent(/shop membership/i);
  });

  it('preserves ordinary browser Back navigation', async () => {
    const result = renderAt('/shops');

    await result.user.click(await screen.findByRole('link', { name: /Northstar Travel Coffee/i }));
    await waitFor(() => expect(result.router.state.location.pathname).toBe('/shops/northstar'));

    await result.router.navigate(-1);

    await waitFor(() => expect(result.router.state.location.pathname).toBe('/shops'));
  });

  it('canonically redirects legacy shop, login, and app routes without loops', async () => {
    const shop = renderAt('/s/northstar');
    await waitFor(() => expect(shop.router.state.location.pathname).toBe('/shops/northstar'));
    shop.unmount();

    const merchantLogin = renderAt('/login/merchant');
    await waitFor(() => expect(merchantLogin.router.state.location.pathname).toBe('/auth/sign-in'));
    expect(new URLSearchParams(merchantLogin.router.state.location.search).get('next')).toBe(
      '/merchant',
    );
    merchantLogin.unmount();

    const oldControl = renderAt('/app/control');
    await waitFor(() => expect(oldControl.router.state.location.pathname).toBe('/auth/sign-in'));
    expect(new URLSearchParams(oldControl.router.state.location.search).get('next')).toBe(
      '/control',
    );
  });

  it('renders an explicit Not Found route', async () => {
    renderAt('/this-route-does-not-exist');

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeVisible();
    expect(screen.getByText('404')).toBeVisible();
  });

  it('supports keyboard opening, focus entry, Escape, and route heading focus', async () => {
    const result = renderAt('/buyer/northstar', {
      session: buyerSession,
      profile: { ...buyerProfile, shops: [merchantShop] },
    });
    const trigger = await screen.findByRole('button', { name: /account menu/i });
    trigger.focus();

    await result.user.keyboard('{Enter}');

    const menu = await screen.findByRole('navigation', { name: 'Account links' });
    const concierge = within(menu).getByRole('link', { name: 'Concierge' });
    await waitFor(() => expect(concierge).toHaveFocus());

    await result.user.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole('navigation', { name: 'Account links' })).not.toBeInTheDocument();

    await result.user.keyboard('{Enter}');
    const reopenedMenu = await screen.findByRole('navigation', { name: 'Account links' });
    await result.user.click(
      within(reopenedMenu).getByRole('link', {
        name: 'Shops',
      }),
    );
    await waitFor(() => expect(result.router.state.location.pathname).toBe('/shops'));
    expect(await screen.findByRole('heading', { name: 'Shop directory' })).toHaveFocus();
  });

  it('closes the account disclosure when focus moves to an outside click target', async () => {
    const result = renderAt('/buyer/northstar', {
      session: buyerSession,
      profile: { ...buyerProfile, shops: [merchantShop] },
    });
    const trigger = await screen.findByRole('button', { name: /account menu/i });

    await result.user.click(trigger);
    expect(screen.getByRole('navigation', { name: 'Account links' })).toBeVisible();

    await result.user.click(screen.getByRole('main'));

    expect(screen.queryByRole('navigation', { name: 'Account links' })).not.toBeInTheDocument();
  });
});
