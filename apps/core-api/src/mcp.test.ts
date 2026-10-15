import { describe, expect, it } from 'vitest';
import { buildServer } from './server.js';
import { authHeaders, testAuthVerifier, testTenantRepository } from './testing/security.js';

const GRINDER = 'grinder.pocket-lite';

function catalogFacts(body: {
  items?: Array<{ sku: string; title: string; priceMinor: string; material: string }>;
  merchant?: { currency?: string };
}) {
  return (body.items ?? [])
    .filter((item) => item.sku === GRINDER)
    .map((item) => ({
      sku: item.sku,
      title: item.title,
      priceMinor: item.priceMinor,
      material: item.material,
      currency: body.merchant?.currency ?? 'INR',
    }));
}

describe('MCP adapter and HTTP/Concierge parity', () => {
  it('lists tools and refuses caller-supplied non-API paths', async () => {
    const { app } = await buildServer(
      {
        DATABASE_URL: 'postgres://charter:charter@127.0.0.1:5432/charter',
        CHARTER_ENV: 'test',
        RAZORPAY_MODE: 'test',
        CHARTER_PUBLIC_URL: 'https://charter.example',
      },
      { authVerifier: testAuthVerifier(), tenantRepository: testTenantRepository() },
    );
    const tools = await app.inject({ method: 'GET', url: '/mcp/tools' });
    expect(tools.statusCode).toBe(200);
    expect(tools.json().protocolStatus).toBe('evaluator-http-adapter');
    expect(tools.json().tools.map((tool: { name: string }) => tool.name)).toEqual(
      expect.arrayContaining([
        'catalog.search',
        'cart.create',
        'cart.update',
        'quote.create',
        'checkout.complete',
        'order.status',
      ]),
    );
    expect(tools.json().tools.every((tool: { path: string }) => tool.path.startsWith('/'))).toBe(
      true,
    );

    const capabilities = await app.inject({
      method: 'POST',
      url: '/mcp/call',
      payload: { name: 'agent.capabilities' },
    });
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json().notCertified).toEqual(
      expect.arrayContaining(['UCP', 'ACP', 'AP2', 'Gemini', 'Alexa']),
    );

    const denied = await app.inject({
      method: 'POST',
      url: '/mcp/call',
      payload: { name: 'cart.get', path: 'https://evil.example/secret' },
    });
    expect(denied.statusCode).toBe(400);
    expect(denied.json().error).toBe('MCP_ARGS_INVALID');

    const unauthenticated = await app.inject({
      method: 'POST',
      url: '/mcp/call',
      payload: { name: 'cart.create', arguments: { shopSlug: 'northstar' } },
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json().error).toBe('AUTH_REQUIRED');
    await app.close();
  });

  it('returns identical catalog, quote, and Concierge facts for the same SKU', async () => {
    const { app } = await buildServer(
      {
        DATABASE_URL: 'postgres://charter:charter@127.0.0.1:5432/charter',
        CHARTER_ENV: 'test',
        RAZORPAY_MODE: 'test',
      },
      { authVerifier: testAuthVerifier(), tenantRepository: testTenantRepository() },
    );

    const httpCatalog = await app.inject({
      method: 'GET',
      url: `/api/v1/shops/northstar?sku=${GRINDER}`,
    });
    expect(httpCatalog.statusCode).toBe(200);
    const mcpCatalog = await app.inject({
      method: 'POST',
      url: '/mcp/call',
      payload: { name: 'catalog.detail', arguments: { slug: 'northstar', sku: GRINDER } },
    });
    expect(mcpCatalog.statusCode).toBe(200);
    expect(catalogFacts(mcpCatalog.json())).toEqual(catalogFacts(httpCatalog.json()));
    const [grinder] = catalogFacts(httpCatalog.json());
    expect(grinder).toEqual(expect.objectContaining({ sku: GRINDER }));
    if (!grinder) {
      throw new Error('expected Northstar pocket grinder catalog row');
    }

    const httpCart = await app.inject({
      method: 'POST',
      url: '/api/v1/carts',
      headers: authHeaders('buyer'),
      payload: { shopSlug: 'northstar' },
    });
    expect(httpCart.statusCode).toBe(200);
    const httpLine = await app.inject({
      method: 'POST',
      url: `/api/v1/carts/${httpCart.json().id}/lines`,
      headers: authHeaders('buyer'),
      payload: { shopSlug: 'northstar', sku: GRINDER },
    });
    expect(httpLine.statusCode).toBe(200);
    const httpQuote = await app.inject({
      method: 'POST',
      url: `/api/v1/carts/${httpCart.json().id}/quotes`,
      headers: authHeaders('buyer'),
      payload: { shopSlug: 'northstar' },
    });
    expect(httpQuote.statusCode).toBe(200);

    const mcpCart = await app.inject({
      method: 'POST',
      url: '/mcp/call',
      headers: authHeaders('buyer'),
      payload: { name: 'cart.create', arguments: { shopSlug: 'northstar' } },
    });
    expect(mcpCart.statusCode).toBe(200);
    const mcpLine = await app.inject({
      method: 'POST',
      url: '/mcp/call',
      headers: authHeaders('buyer'),
      payload: {
        name: 'cart.update',
        arguments: { id: mcpCart.json().id, shopSlug: 'northstar', sku: GRINDER },
      },
    });
    expect(mcpLine.statusCode).toBe(200);
    const mcpQuote = await app.inject({
      method: 'POST',
      url: '/mcp/call',
      headers: authHeaders('buyer'),
      payload: {
        name: 'quote.create',
        arguments: { id: mcpCart.json().id, shopSlug: 'northstar' },
      },
    });
    expect(mcpQuote.statusCode).toBe(200);
    expect(mcpQuote.json().totalMinor).toBe(httpQuote.json().totalMinor);
    expect(mcpQuote.json().currency).toBe(httpQuote.json().currency);
    expect(mcpQuote.json().lines[0]?.sku).toBe(httpQuote.json().lines[0]?.sku);
    expect(mcpQuote.json().lines[0]?.sku).toBe(GRINDER);
    expect(mcpQuote.json().totalMinor).toBe(grinder.priceMinor);

    const conversation = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: authHeaders('buyer'),
      payload: { shopSlug: 'northstar' },
    });
    expect(conversation.statusCode).toBe(200);
    const turn = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversation.json().id}/turns`,
      headers: authHeaders('buyer'),
      payload: { shopSlug: 'northstar', text: "I'd like to buy PocketGrind Lite" },
    });
    expect(turn.statusCode).toBe(200);
    // A buy request only adds to the cart; the total locks on "Buy now".
    const buyNow = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversation.json().id}/turns`,
      headers: authHeaders('buyer'),
      payload: { shopSlug: 'northstar', text: 'Buy now' },
    });
    expect(buyNow.statusCode).toBe(200);
    expect(buyNow.json().quote?.lines.some((line: { sku: string }) => line.sku === GRINDER)).toBe(
      true,
    );
    expect(buyNow.json().quote?.totalMinor).toBe(httpQuote.json().totalMinor);
    expect(buyNow.json().quote?.currency).toBe(httpQuote.json().currency);
    await app.close();
  });
});

describe('MCP server (Streamable HTTP, JSON-RPC)', () => {
  const rpc = (id: number | undefined, method: string, params?: unknown) => ({
    jsonrpc: '2.0',
    ...(id === undefined ? {} : { id }),
    method,
    ...(params === undefined ? {} : { params }),
  });

  async function server() {
    const { app } = await buildServer(
      {
        DATABASE_URL: 'postgres://charter:charter@127.0.0.1:5432/charter',
        CHARTER_ENV: 'test',
        RAZORPAY_MODE: 'test',
        CHARTER_PUBLIC_URL: 'https://charter.example',
      },
      { authVerifier: testAuthVerifier(), tenantRepository: testTenantRepository() },
    );
    return app;
  }

  it('initializes, lists MCP-safe tool names, and accepts notifications', async () => {
    const app = await server();
    const init = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { accept: 'application/json, text/event-stream' },
      payload: rpc(1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      }),
    });
    expect(init.statusCode).toBe(200);
    expect(init.json().result.protocolVersion).toBe('2025-06-18');
    expect(init.json().result.capabilities.tools).toBeDefined();

    const initialized = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: rpc(undefined, 'notifications/initialized'),
    });
    expect(initialized.statusCode).toBe(202);

    const list = await app.inject({ method: 'POST', url: '/mcp', payload: rpc(2, 'tools/list') });
    const tools = list.json().result.tools as Array<{ name: string; inputSchema: unknown }>;
    expect(tools).toHaveLength(11);
    expect(tools.every((tool) => /^[A-Za-z0-9_-]{1,64}$/.test(tool.name))).toBe(true);
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'shops_search',
        'catalog_search',
        'cart_create',
        'checkout_complete',
      ]),
    );
    expect(tools.every((tool) => typeof tool.inputSchema === 'object')).toBe(true);

    const unknown = await app.inject({ method: 'POST', url: '/mcp', payload: rpc(3, 'nope') });
    expect(unknown.json().error.code).toBe(-32601);

    const get = await app.inject({ method: 'GET', url: '/mcp' });
    expect(get.statusCode).toBe(405);
    await app.close();
  });

  it('calls catalog tools without auth and refuses buyer tools without a bearer', async () => {
    const app = await server();
    const detail = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: rpc(1, 'tools/call', {
        name: 'catalog_detail',
        arguments: { shopSlug: 'northstar', sku: GRINDER },
      }),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().result.isError).toBeUndefined();
    expect(catalogFacts(detail.json().result.structuredContent)).toEqual([
      expect.objectContaining({ sku: GRINDER }),
    ]);

    const cart = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: rpc(2, 'tools/call', { name: 'cart_create', arguments: { shopSlug: 'northstar' } }),
    });
    expect(cart.json().result.isError).toBe(true);
    expect(cart.json().result.content[0].text).toMatch(/AUTH_REQUIRED/);

    const authed = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: authHeaders('buyer'),
      payload: rpc(3, 'tools/call', { name: 'cart_create', arguments: { shopSlug: 'northstar' } }),
    });
    expect(authed.json().result.isError).toBeUndefined();
    expect(authed.json().result.structuredContent.id).toEqual(expect.any(String));

    const foreign = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { origin: 'https://evil.example' },
      payload: rpc(4, 'tools/list'),
    });
    expect(foreign.statusCode).toBe(403);
    await app.close();
  });
});
