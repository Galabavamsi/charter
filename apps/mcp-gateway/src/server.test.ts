import { describe, expect, it } from 'vitest';
import { buildMcpGateway } from './server.js';

describe('mcp-gateway', () => {
  it('lists an honest adapter without database credentials or certification claims', async () => {
    const { app } = buildMcpGateway({
      CHARTER_ENV: 'test',
      CHARTER_PUBLIC_URL: 'https://charter.example',
      CHARTER_CORE_API_URL: 'https://charter.example',
    });
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json().note).toMatch(/no database or razorpay credentials/i);
    expect(health.json().certified).toBe(false);
    const tools = await app.inject({ method: 'GET', url: '/mcp/tools' });
    expect(tools.statusCode).toBe(200);
    expect(tools.json().protocolStatus).toBe('evaluator-http-adapter');
    expect(tools.json().tools.map((tool: { name: string }) => tool.name)).toEqual(
      expect.arrayContaining([
        'catalog.search',
        'cart.create',
        'quote.create',
        'checkout.complete',
      ]),
    );
    expect(tools.json().tools.every((tool: { path: string }) => tool.path.startsWith('/'))).toBe(
      true,
    );
    await app.close();
  });

  it('rejects caller-supplied paths and unauthenticated mutations', async () => {
    const { app } = buildMcpGateway({
      CHARTER_ENV: 'test',
      CHARTER_PUBLIC_URL: 'https://charter.example',
    });
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
});
