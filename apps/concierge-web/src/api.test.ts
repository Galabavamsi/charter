import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  API,
  ApiError,
  apiFetch,
  fetchPendingConversationSnapshot,
  setAccessTokenProvider,
} from './api';

describe('concierge API base', () => {
  afterEach(() => {
    setAccessTokenProvider(async () => null);
  });

  it('uses the same-origin API prefix', () => {
    expect(API).toBe('/api');
  });

  it('attaches the current bearer token and serializes JSON bodies', async () => {
    const httpFetch = vi.fn(async () =>
      Response.json({ ok: true }, { headers: { 'x-request-id': 'request-1' } }),
    );
    setAccessTokenProvider(async () => 'supabase-access-token');

    await apiFetch(
      '/v1/carts',
      { method: 'POST', body: JSON.stringify({ shopSlug: 'northstar' }) },
      { httpFetch },
    );

    expect(httpFetch).toHaveBeenCalledWith('/api/v1/carts', {
      method: 'POST',
      body: '{"shopSlug":"northstar"}',
      headers: {
        accept: 'application/json',
        authorization: 'Bearer supabase-access-token',
        'content-type': 'application/json',
      },
    });
  });

  it('allows public reads when no access token exists', async () => {
    const httpFetch = vi.fn(async () => Response.json({ items: [] }));

    await expect(apiFetch('/v1/shops', {}, { httpFetch })).resolves.toEqual({ items: [] });
    expect(httpFetch).toHaveBeenCalledWith('/api/v1/shops', {
      headers: { accept: 'application/json' },
    });
  });

  it('exposes stable JSON error codes and request IDs', async () => {
    const httpFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: 'PLATFORM_ROLE_REQUIRED', requestId: 'request-json' }),
          {
            status: 403,
            headers: { 'content-type': 'application/json', 'x-request-id': 'request-header' },
          },
        ),
    );

    const error = await apiFetch('/v1/control', {}, { httpFetch }).catch((cause) => cause);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 403,
      code: 'PLATFORM_ROLE_REQUIRED',
      requestId: 'request-json',
    });
  });

  it('rejects absolute and cross-origin API paths', async () => {
    await expect(apiFetch('https://attacker.example/collect')).rejects.toMatchObject({
      code: 'API_PATH_INVALID',
    });
  });

  it('skips the pending checkout poll when no bearer token is available', async () => {
    const httpFetch = vi.fn();

    const snapshot = await fetchPendingConversationSnapshot({
      conversationId: 'conversation-1',
      shopSlug: 'northstar',
      getAccessToken: async () => null,
      httpFetch,
    });

    expect(snapshot).toBeNull();
    expect(httpFetch).not.toHaveBeenCalled();
  });

  it('polls the canonical shop with the provided bearer token', async () => {
    const httpFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ checkout: null, quote: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    await fetchPendingConversationSnapshot({
      conversationId: 'conversation-1',
      shopSlug: 'northstar',
      getAccessToken: async () => 'supabase-access-token',
      httpFetch,
    });

    expect(httpFetch).toHaveBeenCalledWith(
      '/api/v1/conversations/conversation-1?shopSlug=northstar&takeCheckout=1',
      {
        headers: {
          accept: 'application/json',
          authorization: 'Bearer supabase-access-token',
        },
      },
    );
  });

  it('maps an aborted request to TURN_TIMEOUT', async () => {
    const httpFetch = vi.fn(async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    });

    await expect(apiFetch('/v1/conversations/x/turns', {}, { httpFetch })).rejects.toMatchObject({
      name: 'ApiError',
      code: 'TURN_TIMEOUT',
    });
  });
});
