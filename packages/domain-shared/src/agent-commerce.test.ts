import { describe, expect, it } from 'vitest';
import {
  CHARTER_COMMERCE_NOT_CERTIFIED,
  McpToolError,
  buildCharterCommerceDiscovery,
  resolveMcpToolCall,
} from './agent-commerce.js';

describe('charter commerce discovery and MCP path builder', () => {
  it('publishes an honest evaluator contract without certification claims', () => {
    const discovery = buildCharterCommerceDiscovery({
      origin: 'https://charter.example',
      razorpayMode: 'test',
      jwtAudience: 'authenticated',
    });
    expect(discovery.protocol).toBe('charter-commerce');
    expect(discovery.protocolStatus).toBe('evaluator-http-contract');
    expect(discovery.environment.liveSettlement).toBe(false);
    expect(discovery.environment.synthetic).toBe(true);
    expect(discovery.notCertified).toEqual([...CHARTER_COMMERCE_NOT_CERTIFIED]);
    expect(discovery.auth.type).toBe('bearer-jwt');
    expect(discovery.mcp.call).toBe('/mcp/call');
    expect(discovery.contracts.checkout.complete.path).toBe('/api/v1/quotes/{id}/checkout');
    expect(discovery.resources.checkout).toBe('/api/v1/quotes/{id}/checkout');
    expect(JSON.stringify(discovery)).not.toMatch(/certified as|official (UCP|ACP|AP2)/i);
  });

  it('builds only first-party /api paths and ignores caller-supplied path overrides', () => {
    const search = resolveMcpToolCall('catalog.search', { slug: 'northstar', q: 'grinder' });
    expect(search).toMatchObject({
      local: false,
      method: 'GET',
      path: '/api/v1/shops/northstar?q=grinder',
      auth: 'none',
    });
    const update = resolveMcpToolCall('cart.add_line', {
      id: '11111111-1111-4111-8111-111111111111',
      shopSlug: 'northstar',
      sku: 'grinder.pocket-lite',
      path: 'https://evil.example/secret',
    });
    expect(update).toMatchObject({
      name: 'cart.update',
      method: 'POST',
      path: '/api/v1/carts/11111111-1111-4111-8111-111111111111/lines',
      body: { shopSlug: 'northstar', sku: 'grinder.pocket-lite' },
    });
    expect(resolveMcpToolCall('agent.capabilities')).toEqual({
      name: 'agent.capabilities',
      local: true,
      mutation: false,
      auth: 'none',
    });
  });

  it('rejects unknown tools and unsafe arguments', () => {
    expect(() => resolveMcpToolCall('refund.create')).toThrow(McpToolError);
    expect(() => resolveMcpToolCall('catalog.search', { slug: '../admin' })).toThrow(McpToolError);
    expect(() =>
      resolveMcpToolCall('cart.get', { id: 'not-a-uuid', shopSlug: 'northstar' }),
    ).toThrow(McpToolError);
    expect(() => resolveMcpToolCall('cart.create', {})).toThrow(McpToolError);
  });
});
