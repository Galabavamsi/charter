// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const supabaseAuth = vi.hoisted(() => ({
  getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
  signUp: vi.fn(async () => ({ data: { session: null }, error: null })),
  signInWithPassword: vi.fn(async () => ({ data: { session: null }, error: null })),
  signOut: vi.fn(async () => ({ error: null })),
  onAuthStateChange: vi.fn(() => ({
    data: { subscription: { unsubscribe: vi.fn() } },
  })),
}));

const createClient = vi.hoisted(() =>
  vi.fn(() => ({
    auth: supabaseAuth,
  })),
);

vi.mock('@supabase/supabase-js', () => ({
  createClient,
}));

import {
  createBrowserAuthClient,
  emailRedirectTo,
  publicAppOrigin,
  type AuthSession,
} from './auth';

declare global {
  interface Window {
    __CHARTER_PLAYWRIGHT_SESSION__?: AuthSession;
  }
}

const env = {
  VITE_SUPABASE_URL: 'https://example.supabase.co',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
};

describe('auth email redirects', () => {
  beforeEach(() => {
    createClient.mockClear();
    supabaseAuth.signUp.mockClear();
    delete window.__CHARTER_PLAYWRIGHT_SESSION__;
  });

  it('uses the current origin for confirmation email redirects', () => {
    const origin = window.location.origin;
    expect(origin).toMatch(/^https?:\/\//);
    expect(publicAppOrigin(env)).toBe(origin);
    expect(emailRedirectTo(origin)).toBe(`${origin}/`);
  });

  it('prefers the current origin over VITE_PUBLIC_URL so local sign-up stays local', () => {
    expect(
      publicAppOrigin({
        VITE_PUBLIC_URL: 'https://core-api-production-087b.up.railway.app/',
      }),
    ).toBe(window.location.origin);
    expect(emailRedirectTo('https://core-api-production-087b.up.railway.app')).toBe(
      'https://core-api-production-087b.up.railway.app/',
    );
  });

  it('uses an injected Playwright merchant session without opening Supabase', async () => {
    window.__CHARTER_PLAYWRIGHT_SESSION__ = {
      accessToken: 'playwright-merchant-token',
      user: {
        id: 'user-merchant',
        email: 'merchant@example.invalid',
        name: 'Merchant Operator',
      },
    };
    const client = createBrowserAuthClient({});
    expect(client.configured).toBe(true);
    await expect(client.getSession()).resolves.toEqual({
      accessToken: 'playwright-merchant-token',
      user: {
        id: 'user-merchant',
        email: 'merchant@example.invalid',
        name: 'Merchant Operator',
      },
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  it('creates the Supabase client so hash tokens are consumed on load', () => {
    createBrowserAuthClient(env);
    expect(createClient).toHaveBeenCalledWith(
      env.VITE_SUPABASE_URL,
      env.VITE_SUPABASE_PUBLISHABLE_KEY,
      {
        auth: {
          detectSessionInUrl: true,
          persistSession: true,
          autoRefreshToken: true,
        },
      },
    );
  });

  it('sends emailRedirectTo on sign-up so confirmation does not default to Site URL localhost', async () => {
    const client = createBrowserAuthClient(env);
    await client.signUp({
      email: 'ada@example.com',
      password: 'long-enough-password',
      options: { data: { name: 'Ada' } },
    });
    expect(supabaseAuth.signUp).toHaveBeenCalledWith({
      email: 'ada@example.com',
      password: 'long-enough-password',
      options: {
        data: { name: 'Ada' },
        emailRedirectTo: `${window.location.origin}/`,
      },
    });
  });
});
