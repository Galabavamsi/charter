import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  CHARTER_COMMERCE_PROTOCOL,
  CHARTER_COMMERCE_TOOLS,
  McpToolError,
  buildCharterCommerceDiscovery,
  resolveMcpToolCall,
  type CharterCommerceToolName,
  type ResolvedMcpCall,
} from '@charter/domain-shared';
import type { AppConfig } from '@charter/config';
import { safePublicOrigin } from './seo.js';

type McpCallBody = {
  name?: string;
  arguments?: Record<string, unknown>;
  args?: Record<string, unknown>;
  authorization?: string;
  idempotencyKey?: string;
  path?: string;
  payload?: Record<string, unknown>;
};

function callArguments(body: McpCallBody): Record<string, unknown> {
  if (body.arguments && typeof body.arguments === 'object') {
    return body.arguments;
  }
  if (body.args && typeof body.args === 'object') {
    return body.args;
  }
  if (body.payload && typeof body.payload === 'object') {
    return body.payload;
  }
  return {};
}

function bearerFrom(request: FastifyRequest, body: McpCallBody): string | undefined {
  if (typeof body.authorization === 'string' && body.authorization.trim()) {
    return body.authorization.trim();
  }
  const header = request.headers.authorization;
  return typeof header === 'string' ? header : undefined;
}

// --- MCP (Streamable HTTP, stateless JSON responses) -------------------------------

const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
const MCP_SERVER_VERSION = '1.1.0';

type JsonSchema = Record<string, unknown>;

const SHOP_SLUG_PROP = {
  type: 'string',
  pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
  description: 'Shop slug from shops_search, for example "northstar".',
};
const UUID_PROP = (what: string) => ({
  type: 'string',
  format: 'uuid',
  description: `${what} id returned by an earlier tool call.`,
});
const SKU_PROP = { type: 'string', description: 'Catalog SKU, for example "grinder.pocket-lite".' };
const CATALOG_FILTER_PROPS = {
  q: { type: 'string', maxLength: 120, description: 'Free-text search.' },
  category: { type: 'string', description: 'Category slug.' },
  inStock: { type: 'boolean', description: 'Only items or shops with stock.' },
  minPriceMinor: { type: 'integer', minimum: 0, description: 'Minimum price in paise.' },
  maxPriceMinor: { type: 'integer', minimum: 0, description: 'Maximum price in paise.' },
  sort: { type: 'string', enum: ['relevance', 'newest', 'name', 'rating'] },
  limit: { type: 'integer', minimum: 1, maximum: 50 },
  cursor: { type: 'string', description: 'nextCursor from a previous page.' },
};

function objectSchema(properties: Record<string, unknown>, required: string[] = []): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

const MCP_INPUT_SCHEMAS: Record<CharterCommerceToolName, JsonSchema> = {
  'agent.capabilities': objectSchema({}),
  'shops.search': objectSchema(CATALOG_FILTER_PROPS),
  'catalog.search': objectSchema({ shopSlug: SHOP_SLUG_PROP, ...CATALOG_FILTER_PROPS }, [
    'shopSlug',
  ]),
  'catalog.detail': objectSchema({ shopSlug: SHOP_SLUG_PROP, sku: SKU_PROP }, ['shopSlug', 'sku']),
  'cart.create': objectSchema({ shopSlug: SHOP_SLUG_PROP }, ['shopSlug']),
  'cart.get': objectSchema({ id: UUID_PROP('Cart'), shopSlug: SHOP_SLUG_PROP }, ['id', 'shopSlug']),
  'cart.update': objectSchema({ id: UUID_PROP('Cart'), shopSlug: SHOP_SLUG_PROP, sku: SKU_PROP }, [
    'id',
    'shopSlug',
    'sku',
  ]),
  'quote.create': objectSchema({ id: UUID_PROP('Cart'), shopSlug: SHOP_SLUG_PROP }, [
    'id',
    'shopSlug',
  ]),
  'checkout.complete': objectSchema({ id: UUID_PROP('Quote'), shopSlug: SHOP_SLUG_PROP }, [
    'id',
    'shopSlug',
  ]),
  'checkout.resume': objectSchema({ id: UUID_PROP('Checkout'), shopSlug: SHOP_SLUG_PROP }, [
    'id',
    'shopSlug',
  ]),
  'order.status': objectSchema({ id: UUID_PROP('Checkout'), shopSlug: SHOP_SLUG_PROP }, [
    'id',
    'shopSlug',
  ]),
};

/** MCP clients (and the Claude API) only accept [A-Za-z0-9_-] tool names. */
function mcpToolName(name: CharterCommerceToolName): string {
  return name.replace(/\./g, '_');
}

function canonicalFromMcpName(name: unknown): string | undefined {
  if (typeof name !== 'string') {
    return undefined;
  }
  const match = CHARTER_COMMERCE_TOOLS.find(
    (tool) => mcpToolName(tool.name) === name || tool.name === name,
  );
  return match?.name ?? name;
}

/** The HTTP resolver takes query-string shaped values; MCP schemas use JSON types. */
function stringifyArguments(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(args as Record<string, unknown>).map(([key, value]) => [
      key,
      typeof value === 'number' || typeof value === 'boolean' ? String(value) : value,
    ]),
  );
}

function mcpTools() {
  return CHARTER_COMMERCE_TOOLS.map((tool) => ({
    name: mcpToolName(tool.name),
    title: tool.name,
    description:
      tool.auth === 'bearer'
        ? `${tool.description} Requires the buyer's Supabase access token as "Authorization: Bearer <token>" on the MCP HTTP request.`
        : tool.description,
    inputSchema: MCP_INPUT_SCHEMAS[tool.name],
    annotations: {
      readOnlyHint: !tool.mutation,
      destructiveHint: false,
      idempotentHint: !tool.mutation,
      openWorldHint: false,
    },
  }));
}

type JsonRpcId = string | number | null;
type JsonRpcRequest = { jsonrpc?: unknown; id?: JsonRpcId; method?: unknown; params?: unknown };

function rpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

export async function registerMcpAdapter(app: FastifyInstance, config: AppConfig): Promise<void> {
  const originFor = (request: FastifyRequest) =>
    safePublicOrigin(
      config.CHARTER_PUBLIC_URL,
      `${request.protocol}://${request.headers.host ?? 'localhost'}`,
    );
  const discoveryFor = (request: FastifyRequest) =>
    buildCharterCommerceDiscovery({
      origin: originFor(request),
      razorpayMode: config.RAZORPAY_MODE,
      jwtAudience: config.SUPABASE_JWT_AUDIENCE,
    });

  async function forward(
    request: FastifyRequest,
    resolved: Extract<ResolvedMcpCall, { local: false }>,
    authorization: string | undefined,
    idempotencyKey: string | undefined,
  ) {
    return app.inject({
      method: resolved.method,
      url: resolved.path,
      headers: {
        'content-type': 'application/json',
        'x-request-id': request.id,
        'x-charter-agent': 'mcp',
        ...(authorization ? { authorization } : {}),
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      ...(resolved.method === 'GET' ? {} : { payload: resolved.body ?? {} }),
    });
  }

  app.get('/mcp/tools', async (request) => ({
    protocol: CHARTER_COMMERCE_PROTOCOL,
    protocolStatus: 'evaluator-http-adapter',
    certified: false,
    note: 'Thin adapter over /api. No database or Razorpay credentials in the adapter. A standard MCP server (Streamable HTTP) is at POST /mcp.',
    tools: CHARTER_COMMERCE_TOOLS,
    discovery: discoveryFor(request).mcp,
  }));

  app.post(
    '/mcp/call',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const body = (request.body ?? {}) as McpCallBody;
      let resolved;
      try {
        resolved = resolveMcpToolCall(body.name, callArguments(body));
      } catch (error) {
        const code = error instanceof McpToolError ? error.code : 'MCP_ARGS_INVALID';
        return reply.status(code === 'MCP_TOOL_UNKNOWN' ? 404 : 400).send({
          error: code,
          requestId: request.id,
        });
      }
      if (resolved.local) {
        return discoveryFor(request);
      }
      const authorization = bearerFrom(request, body);
      if (resolved.auth === 'bearer' && !authorization) {
        return reply.status(401).send({ error: 'AUTH_REQUIRED', requestId: request.id });
      }
      const idempotencyKey =
        (typeof body.idempotencyKey === 'string' && body.idempotencyKey) ||
        (typeof request.headers['idempotency-key'] === 'string'
          ? request.headers['idempotency-key']
          : undefined);
      const injected = await forward(request, resolved, authorization, idempotencyKey);
      reply.status(injected.statusCode);
      const contentType = injected.headers['content-type'];
      if (typeof contentType === 'string') {
        reply.type(contentType);
      }
      return reply.send(injected.body);
    },
  );

  async function callTool(request: FastifyRequest, params: unknown) {
    const { name, arguments: args } = (params ?? {}) as { name?: unknown; arguments?: unknown };
    let resolved: ResolvedMcpCall;
    try {
      resolved = resolveMcpToolCall(canonicalFromMcpName(name), stringifyArguments(args));
    } catch (error) {
      const code = error instanceof McpToolError ? error.code : 'MCP_ARGS_INVALID';
      if (code === 'MCP_TOOL_UNKNOWN') {
        return { unknownTool: true as const };
      }
      return {
        result: {
          content: [
            {
              type: 'text',
              text: 'Invalid arguments. Check the tool inputSchema (shopSlug, id, and sku formats).',
            },
          ],
          isError: true,
        },
      };
    }
    if (resolved.local) {
      const discovery = discoveryFor(request);
      return {
        result: {
          content: [{ type: 'text', text: JSON.stringify(discovery) }],
          structuredContent: discovery,
        },
      };
    }
    const authorization =
      typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined;
    if (resolved.auth === 'bearer' && !authorization) {
      return {
        result: {
          content: [
            {
              type: 'text',
              text: 'AUTH_REQUIRED: this tool acts for a buyer. Send the buyer Supabase access token as "Authorization: Bearer <token>" on the MCP HTTP request.',
            },
          ],
          isError: true,
        },
      };
    }
    const injected = await forward(request, resolved, authorization, undefined);
    let parsed: unknown;
    try {
      parsed = JSON.parse(injected.body);
    } catch {
      parsed = undefined;
    }
    const isObject = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
    return {
      result: {
        content: [{ type: 'text', text: injected.body }],
        ...(isObject ? { structuredContent: parsed } : {}),
        ...(injected.statusCode >= 400 ? { isError: true } : {}),
      },
    };
  }

  async function handleRpc(
    request: FastifyRequest,
    message: JsonRpcRequest,
  ): Promise<Record<string, unknown> | undefined> {
    const id = message.id ?? null;
    if (
      message.jsonrpc !== '2.0' ||
      typeof message.method !== 'string' ||
      (message.id !== undefined &&
        message.id !== null &&
        typeof message.id !== 'string' &&
        typeof message.id !== 'number')
    ) {
      return rpcError(id, -32600, 'Invalid Request');
    }
    const isNotification = message.id === undefined;
    switch (message.method) {
      case 'initialize': {
        const requested = (message.params as { protocolVersion?: unknown } | undefined)
          ?.protocolVersion;
        const protocolVersion = MCP_PROTOCOL_VERSIONS.includes(
          requested as (typeof MCP_PROTOCOL_VERSIONS)[number],
        )
          ? (requested as string)
          : MCP_PROTOCOL_VERSIONS[0];
        return rpcResult(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: 'charter-commerce',
            title: 'Charter commerce (Razorpay test mode)',
            version: MCP_SERVER_VERSION,
          },
          instructions:
            'Charter sells synthetic demo catalogs in INR on Razorpay test mode. Start with shops_search, then catalog_search. Cart, quote and checkout tools need the buyer Supabase access token as a Bearer header. checkout_complete returns a hosted Razorpay Checkout order; a human completes payment in the browser.',
        });
      }
      case 'ping':
        return isNotification ? undefined : rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: mcpTools() });
      case 'tools/call': {
        const outcome = await callTool(request, message.params);
        if ('unknownTool' in outcome) {
          return rpcError(id, -32602, 'Unknown tool');
        }
        return rpcResult(id, outcome.result);
      }
      default:
        if (isNotification) {
          return undefined;
        }
        return rpcError(id, -32601, 'Method not found');
    }
  }

  const sameOriginOrNone = (request: FastifyRequest) => {
    const origin = request.headers.origin;
    if (typeof origin !== 'string' || origin === 'null') {
      return true;
    }
    return origin === originFor(request);
  };

  app.post(
    '/mcp',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply: FastifyReply) => {
      if (!sameOriginOrNone(request)) {
        return reply.status(403).send(rpcError(null, -32000, 'Origin not allowed'));
      }
      const body = request.body as unknown;
      if (body === null || typeof body !== 'object') {
        return reply.status(400).send(rpcError(null, -32700, 'Parse error'));
      }
      const messages = Array.isArray(body) ? (body as JsonRpcRequest[]) : [body as JsonRpcRequest];
      if (messages.length === 0) {
        return reply.status(400).send(rpcError(null, -32600, 'Invalid Request'));
      }
      const responses = (
        await Promise.all(messages.map((message) => handleRpc(request, message)))
      ).filter((response): response is Record<string, unknown> => response !== undefined);
      if (responses.length === 0) {
        return reply.status(202).send();
      }
      reply.type('application/json');
      return reply.send(Array.isArray(body) ? responses : responses[0]);
    },
  );

  // Stateless server: no server-initiated SSE stream and no sessions to delete.
  const methodNotAllowed = async (_request: FastifyRequest, reply: FastifyReply) =>
    reply.status(405).header('allow', 'POST').send({ error: 'METHOD_NOT_ALLOWED' });
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);
}
