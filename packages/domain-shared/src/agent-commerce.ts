export const CHARTER_COMMERCE_PROTOCOL = 'charter-commerce';
export const CHARTER_COMMERCE_PROTOCOL_VERSION = '2026-09-04';
export const CHARTER_COMMERCE_CONTRACT_VERSION = '1.0.0';
export const CHARTER_COMMERCE_NOT_CERTIFIED = ['UCP', 'ACP', 'AP2', 'Gemini', 'Alexa'] as const;

const SHOP_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKU = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const PRICE_MINOR = /^[0-9]{1,13}$/;
const LIMIT = /^[0-9]{1,2}$/;
const SORTS = new Set(['relevance', 'newest', 'name', 'rating']);

export type CharterCommerceToolName =
  | 'agent.capabilities'
  | 'catalog.search'
  | 'catalog.detail'
  | 'cart.create'
  | 'cart.get'
  | 'cart.update'
  | 'quote.create'
  | 'checkout.complete'
  | 'checkout.resume'
  | 'order.status';

export type CharterCommerceTool = {
  name: CharterCommerceToolName;
  method: 'GET' | 'POST';
  path: string;
  mutation: boolean;
  auth: 'none' | 'bearer';
  local?: boolean;
  description: string;
};

export const CHARTER_COMMERCE_TOOL_ALIASES = {
  'cart.add_line': 'cart.update',
  'quote.freeze': 'quote.create',
  'checkout.start': 'checkout.complete',
  'checkout.prepare': 'checkout.complete',
} as const;

export const CHARTER_COMMERCE_TOOLS: readonly CharterCommerceTool[] = [
  {
    name: 'agent.capabilities',
    method: 'GET',
    path: '/.well-known/charter-commerce.json',
    mutation: false,
    auth: 'none',
    local: true,
    description:
      'Returns the honest evaluator capability manifest. Not a UCP/ACP/AP2 certification.',
  },
  {
    name: 'catalog.search',
    method: 'GET',
    path: '/api/v1/shops/{slug}',
    mutation: false,
    auth: 'none',
    description: 'Search one published shop catalog. Same facts as Concierge catalog.search.',
  },
  {
    name: 'catalog.detail',
    method: 'GET',
    path: '/api/v1/shops/{slug}',
    mutation: false,
    auth: 'none',
    description: 'Published shop plus optional exact SKU filter. Same catalog projection as HTTP.',
  },
  {
    name: 'cart.create',
    method: 'POST',
    path: '/api/v1/carts',
    mutation: true,
    auth: 'bearer',
    description: 'Create a buyer-owned cart bound to one shop. One tenant only.',
  },
  {
    name: 'cart.get',
    method: 'GET',
    path: '/api/v1/carts/{id}',
    mutation: false,
    auth: 'bearer',
    description: 'Read a buyer-owned cart in the bound shop.',
  },
  {
    name: 'cart.update',
    method: 'POST',
    path: '/api/v1/carts/{id}/lines',
    mutation: true,
    auth: 'bearer',
    description:
      'Add one catalog SKU to a buyer-owned cart. Does not invent prices. Swap/preview is a separate HTTP route.',
  },
  {
    name: 'quote.create',
    method: 'POST',
    path: '/api/v1/carts/{id}/quotes',
    mutation: true,
    auth: 'bearer',
    description: 'Freeze an immutable quote from the current cart. Payment must equal this total.',
  },
  {
    name: 'checkout.complete',
    method: 'POST',
    path: '/api/v1/quotes/{id}/checkout',
    mutation: true,
    auth: 'bearer',
    description:
      'Start or resume hosted Razorpay Checkout for a frozen quote. Reuses the same Order after a safe reconcile. Charter never receives PAN, CVV, or UPI PIN.',
  },
  {
    name: 'checkout.resume',
    method: 'GET',
    path: '/api/v1/checkouts/{id}',
    mutation: false,
    auth: 'bearer',
    description: 'Read authoritative checkout state without replaying completion.',
  },
  {
    name: 'order.status',
    method: 'GET',
    path: '/api/v1/checkouts/{id}',
    mutation: false,
    auth: 'bearer',
    description: 'Read checkout/order status. Capture alone fulfills; authorized does not.',
  },
] as const;

export class McpToolError extends Error {
  readonly code: 'MCP_TOOL_UNKNOWN' | 'MCP_ARGS_INVALID';

  constructor(code: 'MCP_TOOL_UNKNOWN' | 'MCP_ARGS_INVALID') {
    super(code);
    this.name = 'McpToolError';
    this.code = code;
  }
}

export type ResolvedMcpCall =
  | {
      name: CharterCommerceToolName;
      local: true;
      mutation: false;
      auth: 'none';
    }
  | {
      name: CharterCommerceToolName;
      local: false;
      method: 'GET' | 'POST';
      path: string;
      mutation: boolean;
      auth: 'none' | 'bearer';
      body?: Record<string, string>;
    };

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new McpToolError('MCP_ARGS_INVALID');
  }
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new McpToolError('MCP_ARGS_INVALID');
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function canonicalToolName(name: string | undefined): CharterCommerceToolName {
  if (!name) {
    throw new McpToolError('MCP_TOOL_UNKNOWN');
  }
  const aliased =
    name in CHARTER_COMMERCE_TOOL_ALIASES
      ? CHARTER_COMMERCE_TOOL_ALIASES[name as keyof typeof CHARTER_COMMERCE_TOOL_ALIASES]
      : name;
  const tool = CHARTER_COMMERCE_TOOLS.find((entry) => entry.name === aliased);
  if (!tool) {
    throw new McpToolError('MCP_TOOL_UNKNOWN');
  }
  return tool.name;
}

function shopSlug(args: Record<string, unknown>): string {
  const value = optionalString(args, 'shopSlug') ?? optionalString(args, 'slug');
  if (!value || !SHOP_SLUG.test(value)) {
    throw new McpToolError('MCP_ARGS_INVALID');
  }
  return value;
}

function resourceId(args: Record<string, unknown>): string {
  const value = requiredString(args, 'id');
  if (!UUID.test(value)) {
    throw new McpToolError('MCP_ARGS_INVALID');
  }
  return value;
}

function skuArg(args: Record<string, unknown>, required: boolean): string | undefined {
  const value = required ? requiredString(args, 'sku') : optionalString(args, 'sku');
  if (value && !SKU.test(value)) {
    throw new McpToolError('MCP_ARGS_INVALID');
  }
  return value;
}

function withQuery(path: string, query: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(key, value);
    }
  }
  const encoded = params.toString();
  return encoded ? `${path}?${encoded}` : path;
}

function catalogQuery(
  args: Record<string, unknown>,
  sku?: string,
): Record<string, string | undefined> {
  const q = optionalString(args, 'q');
  if (q && q.length > 120) {
    throw new McpToolError('MCP_ARGS_INVALID');
  }
  const category = optionalString(args, 'category');
  if (category && !SHOP_SLUG.test(category)) {
    throw new McpToolError('MCP_ARGS_INVALID');
  }
  const inStock = optionalString(args, 'inStock');
  if (inStock && inStock !== 'true' && inStock !== 'false') {
    throw new McpToolError('MCP_ARGS_INVALID');
  }
  const minPriceMinor = optionalString(args, 'minPriceMinor');
  const maxPriceMinor = optionalString(args, 'maxPriceMinor');
  if (minPriceMinor && !PRICE_MINOR.test(minPriceMinor)) {
    throw new McpToolError('MCP_ARGS_INVALID');
  }
  if (maxPriceMinor && !PRICE_MINOR.test(maxPriceMinor)) {
    throw new McpToolError('MCP_ARGS_INVALID');
  }
  const sort = optionalString(args, 'sort');
  if (sort && !SORTS.has(sort)) {
    throw new McpToolError('MCP_ARGS_INVALID');
  }
  const limit = optionalString(args, 'limit');
  if (limit && !LIMIT.test(limit)) {
    throw new McpToolError('MCP_ARGS_INVALID');
  }
  const cursor = optionalString(args, 'cursor');
  if (cursor && (cursor.length < 8 || cursor.length > 512)) {
    throw new McpToolError('MCP_ARGS_INVALID');
  }
  return { q, sku, category, inStock, minPriceMinor, maxPriceMinor, sort, limit, cursor };
}

export function resolveMcpToolCall(
  name: string | undefined,
  args: Record<string, unknown> = {},
): ResolvedMcpCall {
  const canonical = canonicalToolName(name);
  const tool = CHARTER_COMMERCE_TOOLS.find((entry) => entry.name === canonical)!;
  if (tool.local) {
    return { name: tool.name, local: true, mutation: false, auth: 'none' };
  }
  if (canonical === 'catalog.search' || canonical === 'catalog.detail') {
    const slug = shopSlug(args);
    const sku = skuArg(args, false);
    return {
      name: canonical,
      local: false,
      method: 'GET',
      path: withQuery(`/api/v1/shops/${encodeURIComponent(slug)}`, catalogQuery(args, sku)),
      mutation: false,
      auth: 'none',
    };
  }
  if (canonical === 'cart.create') {
    const boundShop = shopSlug(args);
    return {
      name: canonical,
      local: false,
      method: 'POST',
      path: '/api/v1/carts',
      mutation: true,
      auth: 'bearer',
      body: { shopSlug: boundShop },
    };
  }
  const id = resourceId(args);
  const boundShop = shopSlug(args);
  if (canonical === 'cart.get') {
    return {
      name: canonical,
      local: false,
      method: 'GET',
      path: withQuery(`/api/v1/carts/${encodeURIComponent(id)}`, { shopSlug: boundShop }),
      mutation: false,
      auth: 'bearer',
    };
  }
  if (canonical === 'cart.update') {
    const sku = skuArg(args, true)!;
    return {
      name: canonical,
      local: false,
      method: 'POST',
      path: `/api/v1/carts/${encodeURIComponent(id)}/lines`,
      mutation: true,
      auth: 'bearer',
      body: { shopSlug: boundShop, sku },
    };
  }
  if (canonical === 'quote.create') {
    return {
      name: canonical,
      local: false,
      method: 'POST',
      path: `/api/v1/carts/${encodeURIComponent(id)}/quotes`,
      mutation: true,
      auth: 'bearer',
      body: { shopSlug: boundShop },
    };
  }
  if (canonical === 'checkout.complete') {
    return {
      name: canonical,
      local: false,
      method: 'POST',
      path: `/api/v1/quotes/${encodeURIComponent(id)}/checkout`,
      mutation: true,
      auth: 'bearer',
      body: { shopSlug: boundShop },
    };
  }
  return {
    name: canonical,
    local: false,
    method: 'GET',
    path: withQuery(`/api/v1/checkouts/${encodeURIComponent(id)}`, { shopSlug: boundShop }),
    mutation: false,
    auth: 'bearer',
  };
}

export function buildCharterCommerceDiscovery(input: {
  origin: string;
  razorpayMode: string;
  jwtAudience?: string;
}) {
  return {
    name: 'Charter',
    version: CHARTER_COMMERCE_CONTRACT_VERSION,
    protocol: CHARTER_COMMERCE_PROTOCOL,
    protocolVersion: CHARTER_COMMERCE_PROTOCOL_VERSION,
    protocolStatus: 'evaluator-http-contract',
    environment: {
      mode: input.razorpayMode,
      synthetic: true,
      liveSettlement: false,
      testLabeled: true,
    },
    notCertified: [...CHARTER_COMMERCE_NOT_CERTIFIED],
    origin: input.origin,
    apiPrefix: '/api',
    auth: {
      type: 'bearer-jwt',
      audience: input.jwtAudience || 'authenticated',
      note: 'Same verified buyer JWT as Concierge. Tokens expire and are revoked by signing out or revoking the Auth session. Mutations are tenant- and object-scoped to the caller-owned cart, quote, or checkout. No separate agent secret store in this evaluator.',
      scopes: ['catalog.read', 'cart.write', 'quote.freeze', 'checkout.start', 'order.read'],
      paymentCredentials: 'hosted-razorpay-checkout-only',
    },
    mcp: {
      tools: '/mcp/tools',
      call: '/mcp/call',
      protocolStatus: 'evaluator-http-adapter',
      note: 'Thin adapter over /api. No database or Razorpay credentials in the adapter. Caller JWT is forwarded; the adapter cannot bypass first-party authorization.',
    },
    resources: {
      health: '/health',
      discovery: '/.well-known/charter-commerce.json',
      directory: '/api/v1/shops',
      shop: '/api/v1/shops/{slug}',
      conversations: '/api/v1/conversations',
      carts: '/api/v1/carts',
      quotes: '/api/v1/quotes/{id}',
      checkout: '/api/v1/quotes/{id}/checkout',
      checkoutStatus: '/api/v1/checkouts/{id}',
      webhook: '/webhooks/razorpay',
    },
    contracts: {
      version: CHARTER_COMMERCE_CONTRACT_VERSION,
      catalog: {
        directory: { method: 'GET', path: '/api/v1/shops' },
        search: { method: 'GET', path: '/api/v1/shops/{slug}' },
        detail: { method: 'GET', path: '/api/v1/shops/{slug}', query: ['sku'] },
      },
      cart: {
        create: { method: 'POST', path: '/api/v1/carts', auth: true, body: ['shopSlug'] },
        get: { method: 'GET', path: '/api/v1/carts/{id}', auth: true, query: ['shopSlug'] },
        update: {
          method: 'POST',
          path: '/api/v1/carts/{id}/lines',
          auth: true,
          body: ['shopSlug', 'sku'],
        },
      },
      quote: {
        create: {
          method: 'POST',
          path: '/api/v1/carts/{id}/quotes',
          auth: true,
          body: ['shopSlug'],
        },
        get: { method: 'GET', path: '/api/v1/quotes/{id}', auth: true, query: ['shopSlug'] },
      },
      checkout: {
        complete: {
          method: 'POST',
          path: '/api/v1/quotes/{id}/checkout',
          auth: true,
          body: ['shopSlug'],
          note: 'Hosted Razorpay Checkout. Same Order retry after reconcile. No PAN/CVV/UPI PIN in Charter.',
        },
        resume: { method: 'GET', path: '/api/v1/checkouts/{id}', auth: true, query: ['shopSlug'] },
      },
      order: {
        status: { method: 'GET', path: '/api/v1/checkouts/{id}', auth: true, query: ['shopSlug'] },
      },
    },
    directoryQuery: {
      path: '/api/v1/shops',
      params: {
        q: 'Optional tokens over shop name, blurb, category, SKU, aliases',
        category: 'Optional category slug; overlapping shops all return',
        sort: 'rating (directory default) | name | newest | relevance',
        inStock: 'true filters to shops with matching in-stock items',
        minPriceMinor: 'Inclusive catalog price floor',
        maxPriceMinor: 'Inclusive catalog price ceiling',
        limit: '1–48, default 12',
        cursor: 'Opaque keyset from nextCursor',
      },
      ranking: 'sort=rating orders published matches by rating desc, reviewCount desc, then name.',
    },
    tools: CHARTER_COMMERCE_TOOLS.map((tool) => ({
      name: tool.name,
      method: tool.method,
      path: tool.path,
      mutation: tool.mutation,
      auth: tool.auth,
      description: tool.description,
    })),
    payment: {
      provider: 'razorpay',
      mode: input.razorpayMode,
      liveSettlement: false,
      hostedCheckout: true,
    },
  };
}
