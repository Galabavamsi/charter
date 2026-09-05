// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, createAppMemoryRouter } from './App';
import type { AccountProfile } from './account';
import type { ApiClient } from './api';
import type { AuthClient, AuthSession } from './auth';
import { upsertThread } from './threads';
import { lexicalOverlapScore, lexicalSearchTokens } from '@charter/domain-shared';

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

const directoryShops = [
  {
    tenantId: 'northstar-demo-in',
    slug: 'northstar',
    name: 'Northstar Travel Coffee',
    blurb: 'Coffee gear for the road.',
    synthetic: true,
    rating: 4.8,
    reviewCount: 128,
    categories: [{ slug: 'travel-coffee', title: 'Travel coffee' }],
    matchedOn: [],
  },
  {
    tenantId: 'indigo-desk-in',
    slug: 'indigo-desk',
    name: 'Indigo Desk',
    blurb: 'Stationery, notebooks and a lamp.',
    synthetic: true,
    rating: 4.6,
    reviewCount: 54,
    categories: [{ slug: 'desk-essentials', title: 'Desk essentials' }],
    matchedOn: [],
  },
  {
    tenantId: 'harbor-spice-in',
    slug: 'harbor-spice',
    name: 'Harbor Spice',
    blurb: 'Masala and a mill.',
    synthetic: true,
    rating: 4.2,
    reviewCount: 36,
    categories: [{ slug: 'travel-coffee', title: 'Travel coffee' }],
    matchedOn: [],
  },
  {
    tenantId: 'sable-atelier-in',
    slug: 'sable-atelier',
    name: 'Sable Atelier',
    blurb: 'Quiet cotton tees and a tote.',
    synthetic: true,
    rating: 4.7,
    reviewCount: 89,
    categories: [{ slug: 'apparel', title: 'Apparel' }],
    matchedOn: [],
  },
  {
    tenantId: 'lotus-gifting-in',
    slug: 'lotus-gifting',
    name: 'Lotus Gifting',
    blurb: 'Wrapped gifts and chocolates.',
    synthetic: true,
    rating: 4.5,
    reviewCount: 112,
    categories: [{ slug: 'gifts', title: 'Gifts' }],
    matchedOn: [],
  },
];

function authClient(session: AuthSession): AuthClient {
  return {
    configured: true,
    getSession: vi.fn(async () => session),
    signInWithPassword: vi.fn(async () => session),
    signUp: vi.fn(async () => session),
    signOut: vi.fn(async () => undefined),
    onAuthStateChange() {
      return () => undefined;
    },
  };
}

function apiClient(): ApiClient {
  return vi.fn(async (path: string) => {
    if (path === '/v1/me') {
      return buyerProfile;
    }
    if (path === '/v1/shops' || path.startsWith('/v1/shops?')) {
      const params = new URL(path, 'https://charter.test').searchParams;
      const tokens = lexicalSearchTokens(params.get('q') ?? '');
      const category = params.get('category');
      let items = directoryShops;
      if (category) {
        items = items.filter((shop) => shop.categories.some((entry) => entry.slug === category));
      }
      if (tokens.length > 0) {
        const raw = params.get('q') ?? '';
        items = items.filter((shop) => {
          const hay = [
            shop.name,
            shop.blurb,
            ...shop.categories.flatMap((entry) => [entry.slug, entry.title]),
          ].join(' ');
          return lexicalOverlapScore(hay, raw, 1) > 0;
        });
      }
      return { items };
    }
    if (path.startsWith('/v1/shops/northstar')) {
      return {
        shop: { tenantId: 'northstar-demo-in', slug: 'northstar', name: 'Northstar Travel Coffee' },
        merchant: {
          tenantId: 'northstar-demo-in',
          slug: 'northstar',
          name: 'Northstar Travel Coffee',
        },
        items: [],
      };
    }
    return {};
  }) as ApiClient;
}

function renderAt(path: string) {
  const router = createAppMemoryRouter([path]);
  return {
    router,
    ...render(
      <App authClient={authClient(buyerSession)} apiClient={apiClient()} router={router} />,
    ),
  };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('authenticated Concierge home', () => {
  it('plays the looping film behind Concierge', async () => {
    renderAt('/chats');
    expect(await screen.findByRole('heading', { name: 'Concierge' })).toBeVisible();
    expect(document.querySelector('.home-hero-media source')).toHaveAttribute(
      'src',
      '/media/landing-loop.mp4',
    );
  });

  it('keeps /chats as one Concierge and lists chats across shops without duplicates', async () => {
    upsertThread(
      { userId: 'user-buyer', shopId: 'northstar-demo-in' },
      {
        id: 'thread-gift',
        conversationId: null,
        title: 'surprise gift',
        updatedAt: '2026-08-25T10:00:00.000Z',
        messages: [{ role: 'you', text: 'something to surprise my gf' }],
        quote: null,
        shopSlug: 'northstar',
        shopName: 'Northstar Travel Coffee',
      },
    );
    upsertThread(
      { userId: 'user-buyer', shopId: 'northstar-demo-in' },
      {
        id: 'thread-gift-dup',
        conversationId: null,
        title: 'surprise gift',
        updatedAt: '2026-08-25T09:00:00.000Z',
        messages: [{ role: 'you', text: 'duplicate title' }],
        quote: null,
        shopSlug: 'northstar',
        shopName: 'Northstar Travel Coffee',
      },
    );
    upsertThread(
      { userId: 'user-buyer', shopId: 'indigo-desk-in' },
      {
        id: 'thread-lamp',
        conversationId: null,
        title: 'desk lamp',
        updatedAt: '2026-08-25T08:00:00.000Z',
        messages: [{ role: 'you', text: 'need a lamp' }],
        quote: null,
        shopSlug: 'indigo-desk',
        shopName: 'Indigo Desk',
      },
    );

    renderAt('/chats');

    const sidebar = await screen.findByRole(
      'complementary',
      { name: 'Your chats' },
      { timeout: 8_000 },
    );
    expect(within(sidebar).getByText('Your chats')).toBeVisible();
    expect(within(sidebar).getAllByText('surprise gift')).toHaveLength(1);
    expect(within(sidebar).getByText('Northstar Travel Coffee')).toBeVisible();
    expect(within(sidebar).getByText('desk lamp')).toBeVisible();
    expect(within(sidebar).getByText('Indigo Desk')).toBeVisible();
    expect(screen.queryByText(/chats in this shop/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Shop directory' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Concierge' })).toBeVisible();
    expect(screen.queryByText(/Catalog facts only/i)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'What are you looking for?' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'A gift for someone' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Continue Northstar' })).not.toBeInTheDocument();
  });

  it('binds a shop from unbound Concierge without leaving the shell', { retry: 2 }, async () => {
    const user = userEvent.setup();
    const { router } = renderAt('/chats');

    await user.click(
      await screen.findByRole('button', { name: 'Coffee gear' }, { timeout: 8_000 }),
    );
    await user.click(
      await screen.findByRole('button', { name: /Northstar Travel Coffee/ }, { timeout: 8_000 }),
    );
    await waitFor(
      () => {
        expect(router.state.location.pathname).toMatch(/^\/buyer\/northstar\/chat\//);
        expect(document.querySelector('.shop-binding')).toHaveTextContent(
          'Northstar Travel Coffee',
        );
        expect(document.querySelector('.transcript')).toHaveTextContent(/Coffee gear for travel/i);
        expect(screen.getByRole('complementary', { name: 'Your chats' })).toBeVisible();
        expect(screen.getByLabelText('Message to Concierge')).toBeVisible();
      },
      { timeout: 8_000 },
    );
    expect(screen.queryByText(/chats in this shop/i)).not.toBeInTheDocument();
  });

  it('lists ranked shops for a subjective catalog ask and greets instead of a false shop miss', async () => {
    const user = userEvent.setup();
    renderAt('/chats');

    const composer = await screen.findByLabelText('Message to Concierge', {}, { timeout: 8_000 });
    await user.type(composer, 'find me a shop to gift coffee');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText(/shops that match|A few shops fit|looks right/i)).toBeVisible();
    const picks = screen.getByRole('button', { name: /Northstar Travel Coffee/ });
    expect(picks).toBeVisible();
    expect(screen.getByRole('button', { name: /Harbor Spice/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: /Indigo Desk/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/No published shop matched/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Continue Northstar/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/demo rating|Synthetic test metrics/i)).not.toBeInTheDocument();

    await user.clear(composer);
    await user.type(composer, 'i want to buy some stationaery');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('button', { name: /Indigo Desk/ })).toBeVisible();
    expect(screen.queryByText(/couldn.t find a shop/i)).not.toBeInTheDocument();

    await user.clear(composer);
    await user.type(composer, 'hi');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText(/What are you looking for/)).toBeVisible();
    expect(screen.queryByText(/No published shop matched/)).not.toBeInTheDocument();
  });

  it('starts a fresh unbound chat from New chat without dumping the directory', async () => {
    const user = userEvent.setup();
    renderAt('/chats');

    const composer = await screen.findByLabelText('Message to Concierge', {}, { timeout: 8_000 });
    await user.type(composer, 'a nice notebook');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('button', { name: /Indigo Desk/ })).toBeVisible();

    await user.click(screen.getByRole('link', { name: 'New chat' }));
    expect(await screen.findByRole('heading', { name: 'What are you looking for?' })).toBeVisible();
    expect(screen.queryByText(/a nice notebook/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Indigo Desk/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Northstar Travel Coffee/ }),
    ).not.toBeInTheDocument();
  });
});
