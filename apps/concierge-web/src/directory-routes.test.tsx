// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, createAppMemoryRouter } from './App';
import type { ApiClient } from './api';
import type { AuthClient, AuthSession } from './auth';

const shop = {
  tenantId: 'indigo-desk-in',
  slug: 'indigo-desk',
  name: 'Indigo Desk',
  blurb: 'Notebooks, pens, and a lamp for a small office.',
  currency: 'INR',
  synthetic: true,
  publishedAt: '2026-01-01T00:00:00.000Z',
  href: '/shops/indigo-desk',
  catalogPath: '/api/v1/shops/indigo-desk',
  itemCount: 4,
  inStockCount: 3,
  unitsInStock: 64,
  categories: [{ slug: 'desk-essentials', title: 'Desk essentials' }],
  startingPriceMinor: '8900',
  startingPriceDisplay: '₹89.00',
  rating: 4.6,
  reviewCount: 54,
  matchedOn: [],
};

const northstar = {
  ...shop,
  tenantId: 'northstar-demo-in',
  slug: 'northstar',
  name: 'Northstar Travel Coffee',
  blurb: 'Travel coffee kit. Steel press, grinders, filters. No glass.',
  href: '/shops/northstar',
  catalogPath: '/api/v1/shops/northstar',
  itemCount: 6,
  inStockCount: 5,
  unitsInStock: 64,
  categories: [{ slug: 'travel-coffee', title: 'Travel coffee' }],
  startingPriceMinor: '24900',
  startingPriceDisplay: '₹249.00',
  rating: 4.8,
  reviewCount: 128,
};

const facets = {
  categories: [
    { slug: 'desk-essentials', title: 'Desk essentials', count: 1 },
    { slug: 'travel-coffee', title: 'Travel coffee', count: 1 },
  ],
  inStockCount: 2,
  minPriceMinor: '8900',
  maxPriceMinor: '149900',
};

function authClient(initialSession: AuthSession | null = null): AuthClient {
  let session = initialSession;
  const listeners = new Set<(next: AuthSession | null) => void>();
  return {
    configured: true,
    getSession: vi.fn(async () => session),
    signInWithPassword: vi.fn(async () => {
      session = {
        accessToken: 'token',
        user: { id: 'buyer', email: 'buyer@example.com', name: 'Buyer' },
      };
      listeners.forEach((listener) => listener(session));
      return session;
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

function renderAt(path: string, api: ApiClient) {
  const router = createAppMemoryRouter([path]);
  const rendered = render(<App authClient={authClient()} apiClient={api} router={router} />);
  return { ...rendered, api, router, user: userEvent.setup() };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.head
    .querySelectorAll('[data-charter-head], [data-charter-seo]')
    .forEach((node) => node.remove());
  document.title = '';
});

describe('shop directory route', () => {
  it('hydrates filters from the URL, converts INR safely, and restores them with Back', async () => {
    const api = vi.fn(async (path: string) => {
      if (path.startsWith('/v1/shops')) {
        return { items: [shop], total: 1, nextCursor: null, facets };
      }
      return {};
    }) as ApiClient;
    const result = renderAt(
      '/shops?q=desk&category=desk-essentials&inStock=1&min=199&max=349&sort=name',
      api,
    );

    expect(await screen.findByRole('heading', { name: 'Shop directory' })).toBeVisible();
    expect(screen.getByLabelText('Search shops and products')).toHaveValue('desk');
    expect(screen.getByLabelText('Minimum price in INR')).toHaveValue(199);
    expect(screen.getByLabelText('Maximum price in INR')).toHaveValue(349);
    expect(screen.getByLabelText('In stock only')).toBeChecked();
    expect(screen.getByLabelText('Sort shops')).toHaveValue('name');
    expect(await screen.findByText('1 shop')).toBeVisible();
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        expect.stringContaining(
          'q=desk&category=desk-essentials&inStock=true&minPriceMinor=19900&maxPriceMinor=34900&sort=name',
        ),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );

    const search = screen.getByLabelText('Search shops and products');
    await result.user.clear(search);
    await result.user.type(search, 'coffee');
    await result.user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() =>
      expect(new URLSearchParams(result.router.state.location.search).get('q')).toBe('coffee'),
    );

    await result.router.navigate(-1);
    await waitFor(() =>
      expect(screen.getByLabelText('Search shops and products')).toHaveValue('desk'),
    );
    expect(new URLSearchParams(result.router.state.location.search).get('category')).toBe(
      'desk-essentials',
    );
  });

  it('shows a loading skeleton, reports an error, and retries in place', async () => {
    let attempts = 0;
    let releaseFirst!: () => void;
    const firstRequest = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const api = vi.fn(async (path: string) => {
      if (!path.startsWith('/v1/shops')) {
        return {};
      }
      attempts += 1;
      if (attempts === 1) {
        await firstRequest;
        throw new Error('offline');
      }
      return { items: [northstar], total: 1, nextCursor: null, facets };
    }) as ApiClient;
    const result = renderAt('/shops', api);

    expect(await screen.findByLabelText('Loading shops')).toBeVisible();
    releaseFirst();
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn’t load the directory/i);

    await result.user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('link', { name: /Northstar Travel Coffee/i })).toBeVisible();
    expect(attempts).toBe(2);
  });

  it('offers a one-action reset when no shops match', async () => {
    const api = vi.fn(async (path: string) => {
      if (path === '/v1/shops?q=missing') {
        return { items: [], total: 0, nextCursor: null, facets: { ...facets, categories: [] } };
      }
      if (path.startsWith('/v1/shops')) {
        return { items: [shop], total: 1, nextCursor: null, facets };
      }
      return {};
    }) as ApiClient;
    const result = renderAt('/shops?q=missing', api);

    expect(await screen.findByRole('heading', { name: 'No matching shops' })).toBeVisible();
    await result.user.click(screen.getByRole('button', { name: 'Reset filters' }));

    await waitFor(() => expect(result.router.state.location.search).toBe(''));
    expect(await screen.findByRole('link', { name: /Indigo Desk/i })).toBeVisible();
  });

  it('appends cursor pages without replacing prior shop cards', async () => {
    const api = vi.fn(async (path: string) => {
      if (path.includes('cursor=next-page')) {
        return { items: [northstar], total: 2, nextCursor: null, facets };
      }
      if (path.startsWith('/v1/shops')) {
        return { items: [shop], total: 2, nextCursor: 'next-page', facets };
      }
      return {};
    }) as ApiClient;
    const result = renderAt('/shops?sort=name', api);

    expect(await screen.findByRole('link', { name: /Indigo Desk/i })).toBeVisible();
    await result.user.click(screen.getByRole('button', { name: 'Load more shops' }));

    expect(await screen.findByRole('link', { name: /Northstar Travel Coffee/i })).toBeVisible();
    expect(screen.getByRole('link', { name: /Indigo Desk/i })).toBeVisible();
    expect(api).toHaveBeenCalledWith(
      expect.stringContaining('cursor=next-page'),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('announces a failed load-more request and retries the same cursor', async () => {
    let pageAttempts = 0;
    const api = vi.fn(async (path: string) => {
      if (path.includes('cursor=next-page')) {
        pageAttempts += 1;
        if (pageAttempts === 1) {
          throw new Error('page offline');
        }
        return { items: [northstar], total: 2, nextCursor: null, facets };
      }
      return { items: [shop], total: 2, nextCursor: 'next-page', facets };
    }) as ApiClient;
    const result = renderAt('/shops', api);

    await result.user.click(await screen.findByRole('button', { name: 'Load more shops' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be loaded/i);
    await result.user.click(screen.getByRole('button', { name: 'Retry loading more shops' }));

    expect(await screen.findByRole('link', { name: /Northstar Travel Coffee/i })).toBeVisible();
    expect(pageAttempts).toBe(2);
  });

  it('ignores stale filter and load-more responses and exposes retry', async () => {
    const pending = new Map<
      string,
      {
        resolve: (value: unknown) => void;
        reject: (reason?: unknown) => void;
        signal?: AbortSignal;
      }
    >();
    const api = vi.fn(
      (path: string, init?: RequestInit) =>
        new Promise((resolve, reject) => {
          pending.set(path, { resolve, reject, signal: init?.signal ?? undefined });
        }),
    ) as ApiClient;
    const result = renderAt('/shops?q=desk', api);
    await waitFor(() => expect(pending.has('/v1/shops?q=desk')).toBe(true));

    await result.router.navigate('/shops?q=coffee');
    await waitFor(() => expect(pending.has('/v1/shops?q=coffee')).toBe(true));
    expect(pending.get('/v1/shops?q=desk')?.signal?.aborted).toBe(true);
    pending
      .get('/v1/shops?q=coffee')
      ?.resolve({ items: [northstar], total: 1, nextCursor: null, facets });
    pending.get('/v1/shops?q=desk')?.resolve({ items: [shop], total: 1, nextCursor: null, facets });

    expect(await screen.findByRole('link', { name: /Northstar Travel Coffee/i })).toBeVisible();
    expect(screen.queryByRole('link', { name: /Indigo Desk/i })).not.toBeInTheDocument();
  });

  it('keeps one complete managed head set across directory navigation', async () => {
    const api = vi.fn(async (path: string) => {
      if (path === '/v1/shops/northstar') {
        return {
          shop: northstar,
          merchant: northstar,
          items: [
            {
              id: 'variant/1',
              productId: 'product-1',
              sku: 'grinder.pocket-lite',
              title: 'Hand grinder',
              priceMinor: '10950',
              priceDisplay: '₹109.50',
              availableStock: 2,
              category: { slug: 'travel-coffee', title: 'Travel coffee' },
              material: 'steel',
              publishedAt: '2026-01-01T00:00:00.000Z',
              provenance: 'merchant',
            },
          ],
          total: 1,
          nextCursor: null,
          facets,
        };
      }
      return { items: [northstar], total: 1, nextCursor: null, facets };
    }) as ApiClient;
    const result = renderAt('/shops/northstar', api);
    await screen.findByRole('heading', { name: northstar.name });
    expect(document.head.querySelectorAll('[data-charter-head="canonical"]')).toHaveLength(1);
    expect(document.head.querySelectorAll('[data-charter-head="jsonld"]')).toHaveLength(1);
    expect(document.head.querySelectorAll('[data-charter-head="title"]')).toHaveLength(1);
    expect(document.title).toBe('Northstar Travel Coffee — Charter');
    const storefrontJsonLd = JSON.parse(
      document.head.querySelector('[data-charter-head="jsonld"]')?.textContent ?? '{}',
    );
    expect(storefrontJsonLd.hasOfferCatalog.itemListElement[0].item).toMatchObject({
      '@type': 'Product',
      offers: {
        '@type': 'Offer',
        price: '109.50',
        availability: 'https://schema.org/InStock',
      },
    });
    expect(document.head.querySelector('meta[property="og:type"]')).toHaveAttribute(
      'content',
      'website',
    );

    await result.router.navigate('/shops');
    await screen.findByRole('heading', { name: 'Shop directory' });
    expect(document.head.querySelectorAll('[data-charter-head="canonical"]')).toHaveLength(1);
    expect(document.head.querySelectorAll('[data-charter-head="description"]')).toHaveLength(1);
    expect(document.head.querySelectorAll('[data-charter-head="jsonld"]')).toHaveLength(0);
    expect(document.head.querySelectorAll('[data-charter-head="title"]')).toHaveLength(1);
    expect(document.title).toBe('Shop directory — Charter');
    expect(document.head.querySelector('link[rel="canonical"]')).toHaveAttribute(
      'href',
      `${window.location.origin}/shops`,
    );

    await result.router.navigate('/auth/sign-in');
    expect(await screen.findByRole('heading', { name: 'Sign in to Charter' })).toBeVisible();
    await waitFor(() => expect(document.title).toBe('Charter'));
    await waitFor(() =>
      expect(document.head.querySelectorAll('[data-charter-head]')).toHaveLength(0),
    );
    expect(document.head.querySelectorAll('meta[property^="og:"]')).toHaveLength(0);
  });

  it('uses one rectangular card link with visible facts and no nested controls', async () => {
    const api = vi.fn(async (path: string) => {
      if (path.startsWith('/v1/shops')) {
        return { items: [shop], total: 1, nextCursor: null, facets };
      }
      return {};
    }) as ApiClient;
    renderAt('/shops', api);

    const card = await screen.findByRole('link', { name: /Indigo Desk/i });
    expect(card).toHaveAttribute('href', '/shops/indigo-desk');
    expect(within(card).getByText('Desk essentials')).toBeVisible();
    expect(within(card).getByText(/From ₹89.00/)).toBeVisible();
    expect(within(card).getByText('View shop')).toBeVisible();
    expect(within(card).queryByRole('button')).not.toBeInTheDocument();
    expect(card).not.toHaveTextContent('/s/');
    expect(card).not.toHaveTextContent(/Gemini plugin/i);
  });

  it('keeps the responsive filter disclosure keyboard operable with labelled controls', async () => {
    const api = vi.fn(async (path: string) => {
      if (path.startsWith('/v1/shops')) {
        return { items: [shop], total: 1, nextCursor: null, facets };
      }
      return {};
    }) as ApiClient;
    const result = renderAt('/shops', api);

    await screen.findByText('1 shop');
    const summary = screen.getByText('Filters');
    const disclosure = summary.closest('details');
    expect(disclosure).toHaveAttribute('open');
    expect(screen.getByLabelText('In stock only')).toBeVisible();
    expect(screen.getByLabelText('Minimum price in INR')).toBeVisible();
    expect(screen.getByLabelText('Maximum price in INR')).toBeVisible();
    expect(screen.getByLabelText('Sort shops')).toBeVisible();

    summary.focus();
    await result.user.keyboard('{Enter}');
    await waitFor(() => expect(disclosure).not.toHaveAttribute('open'));
    expect(summary).toHaveFocus();
    await result.user.keyboard('{Enter}');
    await waitFor(() => expect(disclosure).toHaveAttribute('open'));
  });
});

describe('public shop storefront route', () => {
  it('renders merchant facts and preserves safe product intent through auth', async () => {
    const api = vi.fn(async (path: string) => {
      if (path.startsWith('/v1/shops/northstar')) {
        return {
          shop: northstar,
          merchant: northstar,
          total: 2,
          nextCursor: null,
          facets,
          items: [
            {
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
            },
            {
              id: 'variant-2',
              productId: 'product-2',
              sku: 'kettle.road-mini',
              title: 'Mini travel kettle',
              priceMinor: '129900',
              priceDisplay: '₹1299.00',
              availableStock: 0,
              category: { slug: 'travel-coffee', title: 'Travel coffee' },
              material: 'other',
              publishedAt: '2026-01-01T00:00:00.000Z',
              provenance: 'merchant',
            },
          ],
        };
      }
      return {};
    }) as ApiClient;
    const result = renderAt('/shops/northstar', api);

    expect(await screen.findByRole('heading', { name: 'Northstar Travel Coffee' })).toBeVisible();
    expect(screen.queryByText(/synthetic test shop/i)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to shops' })).toHaveAttribute('href', '/shops');
    expect(screen.getByRole('link', { name: 'Open Concierge' })).toHaveAttribute(
      'href',
      '/buyer/northstar',
    );
    const grinder = screen.getByRole('article', { name: 'Hand grinder' });
    expect(within(grinder).getByText('₹999.00')).toBeVisible();
    expect(within(grinder).getByText('8 available')).toBeVisible();
    expect(within(grinder).getByText(/Travel coffee/)).toBeVisible();
    expect(within(grinder).getByText(/Steel/)).toBeVisible();
    expect(within(grinder).queryByRole('link', { name: 'Ask this shop' })).not.toBeInTheDocument();
    const buy = within(grinder).getByRole('link', { name: 'Buy' });
    expect(buy).toHaveAttribute('href', '/buyer/northstar?intent=buy&product=grinder.pocket-lite');

    const kettle = screen.getByRole('article', { name: 'Mini travel kettle' });
    expect(within(kettle).getByText('Out of stock')).toBeVisible();
    expect(within(kettle).getByRole('button', { name: 'Buy' })).toBeDisabled();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/v1/conversations') && !url.includes('/turns')) {
          return new Response(JSON.stringify({ id: 'conv-buy' }), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/turns')) {
          return new Response(
            JSON.stringify({
              reply: 'Added **Hand grinder**.',
              quote: {
                id: 'q-buy',
                totalDisplay: '₹999.00',
                deliveryBy: 'tomorrow',
                merchant: 'Northstar Travel Coffee',
                discountMinor: '0',
                lines: [{ sku: 'grinder.pocket-lite', title: 'Hand grinder', quantity: 1 }],
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ items: [], voiceEnabled: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    await result.user.click(buy);
    await waitFor(() => expect(result.router.state.location.pathname).toBe('/auth/sign-in'));
    expect(new URLSearchParams(result.router.state.location.search).get('next')).toBe(
      '/buyer/northstar?intent=buy&product=grinder.pocket-lite',
    );

    await result.user.type(await screen.findByLabelText('Email'), 'buyer@example.com');
    await result.user.type(screen.getByLabelText('Password'), 'long-enough-password');
    await result.user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Concierge' })).toBeVisible();
    expect(api).toHaveBeenCalledWith(
      '/v1/shops/northstar?sku=grinder.pocket-lite',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(
      await screen.findByText(
        (_, node) =>
          node?.className === 'bubble-plain' &&
          node.textContent === "I'd like to buy Hand grinder.",
      ),
    ).toBeVisible();
    await waitFor(() => expect(screen.getByLabelText('Message to Concierge')).toHaveValue(''));
    expect(await screen.findByRole('heading', { name: 'Locked total' })).toBeVisible();
  });

  it('renders a shop without a test-shop banner', async () => {
    const renamed = { ...northstar, name: 'Northstar Field Coffee', synthetic: true as const };
    const api = vi.fn(async (path: string) => {
      if (path.startsWith('/v1/shops/northstar')) {
        return {
          shop: renamed,
          merchant: renamed,
          total: 0,
          nextCursor: null,
          facets,
          items: [],
        };
      }
      return { items: [renamed], total: 1, nextCursor: null, facets };
    }) as ApiClient;
    renderAt('/shops', api);
    expect(await screen.findByRole('link', { name: /Northstar Field Coffee/i })).toBeVisible();
    expect(screen.queryByText('Test shop')).not.toBeInTheDocument();
    cleanup();
    renderAt('/shops/northstar', api);
    expect(await screen.findByRole('heading', { name: 'Northstar Field Coffee' })).toBeVisible();
    expect(screen.queryByText(/synthetic test shop/i)).not.toBeInTheDocument();
  });
});
