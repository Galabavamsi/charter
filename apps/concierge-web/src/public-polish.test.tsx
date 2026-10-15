// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, createAppMemoryRouter } from './App';
import { ApiError, type ApiClient } from './api';
import type { AuthClient, AuthSession } from './auth';
import { isChunkLoadError, RouteErrorPage } from './RouteError';

const buyer: AuthSession = {
  accessToken: 'buyer-access-token',
  user: { id: 'buyer', email: 'buyer@example.com', name: 'Buyer' },
};

const northstar = {
  tenantId: 'northstar-demo-in',
  slug: 'northstar',
  name: 'Northstar Travel Coffee',
  blurb: 'Travel coffee kit. Steel press, grinders, filters. No glass.',
  currency: 'INR',
  synthetic: true,
  publishedAt: '2026-01-01T00:00:00.000Z',
  href: '/shops/northstar',
  catalogPath: '/api/v1/shops/northstar',
  itemCount: 1,
  inStockCount: 1,
  unitsInStock: 8,
  categories: [{ slug: 'travel-coffee', title: 'Travel coffee' }],
  startingPriceMinor: '99900',
  startingPriceDisplay: '₹999.00',
  rating: 4.8,
  reviewCount: 128,
  matchedOn: [],
};

const facets = {
  categories: [{ slug: 'travel-coffee', title: 'Travel coffee', count: 1 }],
  inStockCount: 1,
  minPriceMinor: '99900',
  maxPriceMinor: '99900',
};

const grinder = {
  id: 'variant-1',
  productId: 'product-1',
  sku: 'grinder.pocket-lite',
  title: 'Hand grinder',
  priceMinor: '99900',
  priceDisplay: '₹999.00',
  availableStock: 8,
  category: { slug: 'travel-coffee', title: 'Travel coffee' },
  material: 'steel',
  publishedAt: '2026-01-01T00:00:00.000Z',
  provenance: 'merchant',
};

function storefront(items: unknown[] = [grinder]) {
  return {
    shop: northstar,
    merchant: northstar,
    items,
    total: items.length,
    nextCursor: null,
    facets,
  };
}

function authClient(initialSession: AuthSession | null = null): AuthClient {
  let session = initialSession;
  const listeners = new Set<(next: AuthSession | null) => void>();
  return {
    configured: true,
    getSession: vi.fn(async () => session),
    signInWithPassword: vi.fn(async () => {
      throw new Error('Invalid login credentials');
    }),
    signUp: vi.fn(async () => null),
    signOut: vi.fn(async () => {
      session = null;
      listeners.forEach((listener) => listener(session));
    }),
    onAuthStateChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function renderAt(path: string, api: ApiClient, client: AuthClient = authClient()) {
  const user = userEvent.setup();
  const router = createAppMemoryRouter([path]);
  const rendered = render(<App authClient={client} apiClient={api} router={router} />);
  return { ...rendered, api, client, router, user };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  document.head.querySelectorAll('[data-charter-head]').forEach((node) => node.remove());
  document.title = '';
});

describe('public storefront polish', () => {
  it('keeps the storefront mounted while a filter refetches and retries a failed refetch inline', async () => {
    let filteredAttempts = 0;
    let rejectFiltered!: (reason: unknown) => void;
    const api = vi.fn((path: string) => {
      if (path === '/v1/shops/northstar') {
        return Promise.resolve(storefront());
      }
      if (path.startsWith('/v1/shops/northstar?category=travel-coffee')) {
        filteredAttempts += 1;
        if (filteredAttempts === 1) {
          return new Promise((_resolve, reject) => {
            rejectFiltered = reject;
          });
        }
        return Promise.resolve(storefront());
      }
      return Promise.resolve({});
    }) as ApiClient;
    const result = renderAt('/shops/northstar', api);

    expect(await screen.findByRole('heading', { name: northstar.name })).toBeVisible();
    await result.user.click(screen.getByRole('button', { name: 'Travel coffee' }));

    await waitFor(() => expect(filteredAttempts).toBe(1));
    expect(screen.getByRole('heading', { name: northstar.name })).toBeVisible();
    expect(screen.getByLabelText('Search this shop')).toBeVisible();
    expect(document.querySelector('.product-grid')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('article', { name: 'Hand grinder' })).toBeVisible();

    rejectFiltered(new Error('offline'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be applied/i);
    await result.user.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(filteredAttempts).toBe(2);
    expect(document.querySelector('.product-grid')).toHaveAttribute('aria-busy', 'false');
  });

  it('shows product thumbnails and plain-language copy on catalog cards', async () => {
    const api = vi.fn(async () => ({
      ...storefront(),
      shop: { ...northstar, refundPolicy: 'Returns within 7 days.' },
    })) as ApiClient;
    renderAt('/shops/northstar', api);

    const card = await screen.findByRole('article', { name: 'Hand grinder' });
    expect(card.querySelector('.catalog-card-thumb img')).toHaveAttribute('src');
    expect(screen.getByText('Refund policy')).toBeVisible();
    expect(
      screen.getByText('Browse below, or tap Buy to continue in Concierge with that item.'),
    ).toBeVisible();
  });

  it('tells buyers when a shop has not listed products yet instead of offering a reset', async () => {
    const api = vi.fn(async () => storefront([])) as ApiClient;
    renderAt('/shops/northstar', api);

    expect(
      await screen.findByRole('heading', { name: 'This shop hasn’t listed products yet.' }),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Reset filters' })).not.toBeInTheDocument();
  });

  it('gives a missing shop and an unknown route a way back to the directory', async () => {
    const api = vi.fn(async () => {
      throw new ApiError({ status: 404, code: 'SHOP_UNKNOWN' });
    }) as ApiClient;
    renderAt('/shops/missing-shop', api);
    expect(await screen.findByRole('heading', { name: 'Shop not found' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Browse shops' })).toHaveAttribute('href', '/shops');
    cleanup();

    renderAt('/no-such-page', vi.fn(async () => ({})) as ApiClient);
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeVisible();
    const main = screen.getByRole('main');
    expect(within(main).getByRole('link', { name: 'Browse shops' })).toHaveAttribute(
      'href',
      '/shops',
    );
    await waitFor(() => expect(document.title).toBe('Page not found — Charter'));
  });
});

describe('agents page', () => {
  it('documents the MCP server and points the token CTA at the account page', async () => {
    renderAt('/agents', vi.fn(async () => ({})) as ApiClient);
    expect(await screen.findByRole('heading', { name: /Same catalog/i })).toBeVisible();
    expect(screen.getByText('POST /mcp')).toBeVisible();
    expect(screen.getByText(/MCP Streamable HTTP \(JSON-RPC 2\.0\), \d+ tools/)).toBeVisible();
    expect(screen.getAllByText(`${window.location.origin}/mcp`).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'GET /mcp/tools' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Get a buyer token for agents' })).toHaveAttribute(
      'href',
      '/auth/sign-in?next=/account',
    );
  });
});

describe('app frame polish', () => {
  it('marks the current section in the header and states the demo is test mode', async () => {
    const api = vi.fn(async () => ({
      items: [],
      total: 0,
      nextCursor: null,
      facets,
    })) as ApiClient;
    renderAt('/shops', api);
    expect(await screen.findByRole('heading', { name: 'Shop directory' })).toBeVisible();
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).getByRole('link', { name: 'Shops' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Agents' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('contentinfo')).toHaveTextContent(
      /Portfolio demo on Razorpay test mode/,
    );
    expect(screen.getByRole('link', { name: 'Source on GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/Galabavamsi/charter',
    );
  });

  it('skips the background video for reduced-motion visitors', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    renderAt('/', vi.fn(async () => ({})) as ApiClient);
    expect(await screen.findByRole('heading', { name: 'Shop by talking.' })).toBeVisible();
    expect(document.querySelector('.home-hero-media')).toBeInTheDocument();
    expect(document.querySelector('.home-hero-media video')).not.toBeInTheDocument();
  });

  it('offers a sign-in-again action that drops the rejected session first', async () => {
    const client = authClient(buyer);
    const api = vi.fn(async (path: string) => {
      if (path === '/v1/me') {
        throw new ApiError({ status: 401, code: 'AUTH_INVALID_TOKEN' });
      }
      return {};
    }) as ApiClient;
    const result = renderAt('/account', api, client);

    expect(await screen.findByRole('heading', { name: 'Authentication required' })).toBeVisible();
    await result.user.click(screen.getByRole('button', { name: 'Sign in again' }));

    expect(client.signOut).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.router.state.location.pathname).toBe('/auth/sign-in'));
    expect(new URLSearchParams(result.router.state.location.search).get('next')).toBe('/account');
  });

  it('copies the buyer access token for agents from the account page', async () => {
    const api = vi.fn(async (path: string) => {
      if (path === '/v1/me') {
        return {
          profile: { userId: 'buyer', email: 'buyer@example.com' },
          shops: [],
          platformRoles: [],
        };
      }
      return {};
    }) as ApiClient;
    const result = renderAt('/account', api, authClient(buyer));

    await result.user.click(
      await screen.findByRole('button', { name: 'Copy access token for agents (expires in 1 h)' }),
    );

    expect(await screen.findByText(/Token copied/)).toBeVisible();
    expect(await navigator.clipboard.readText()).toBe('buyer-access-token');
    expect(document.title).toBe('Account — Charter');
  });
});

describe('auth page polish', () => {
  it('shows sign-up confirmation as a neutral notice and locks the form', async () => {
    const result = renderAt('/auth/sign-up', vi.fn(async () => ({})) as ApiClient);

    await result.user.type(await screen.findByLabelText('Name'), 'Avery Buyer');
    await result.user.type(screen.getByLabelText('Email'), 'new@example.com');
    const password = screen.getByLabelText('Password');
    expect(password).toHaveAttribute('minlength', '8');
    expect(password).toHaveAccessibleDescription('At least 8 characters.');
    await result.user.type(password, 'long-enough-password');
    await result.user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('status')).toHaveTextContent(/Check your email/);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(password).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Create account' })).toBeDisabled();
    expect(within(screen.getByRole('status')).getByRole('link', { name: 'sign in' })).toBeVisible();
    expect(document.title).toBe('Create account — Charter');
  });

  it('keeps a sign-in error on the sign-in form only', async () => {
    const result = renderAt('/auth/sign-in', vi.fn(async () => ({})) as ApiClient);

    const password = await screen.findByLabelText('Password');
    expect(password).not.toHaveAttribute('minlength');
    await result.user.type(screen.getByLabelText('Email'), 'buyer@example.com');
    await result.user.type(password, 'short');
    await result.user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid login credentials');

    await result.user.click(screen.getByRole('link', { name: 'Create one' }));
    expect(
      await screen.findByRole('heading', { name: 'Create your Charter account' }),
    ).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('route error boundary', () => {
  function renderBoom(error: Error) {
    function Boom(): never {
      throw error;
    }
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const router = createMemoryRouter([
      { path: '/', Component: Boom, ErrorBoundary: RouteErrorPage },
    ]);
    return render(<RouterProvider router={router} />);
  }

  it('recognises chunk and CSS preload failures from Chrome, Firefox and Safari', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: x'))).toBe(
      true,
    );
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/buyer-abc.css'))).toBe(
      true,
    );
    expect(isChunkLoadError(new Error('boom'))).toBe(false);
  });

  it('shows a friendly screen with reload and home actions for a crash', async () => {
    renderBoom(new Error('boom'));
    expect(await screen.findByRole('heading', { name: 'Something went wrong' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/');
  });

  it('reloads once after a chunk-load failure, then stops at the friendly screen', async () => {
    const chunkError = new TypeError(
      'Failed to fetch dynamically imported module: https://charter.example/assets/public-abc.js',
    );
    renderBoom(chunkError);
    expect(await screen.findByRole('heading', { name: 'Updating Charter' })).toBeVisible();
    expect(sessionStorage.getItem('charter.chunk-reload-at')).not.toBeNull();
    cleanup();

    renderBoom(chunkError);
    expect(await screen.findByRole('heading', { name: 'Charter was updated' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeVisible();
  });
});
