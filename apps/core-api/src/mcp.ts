import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  CHARTER_COMMERCE_PROTOCOL,
  CHARTER_COMMERCE_TOOLS,
  McpToolError,
  buildCharterCommerceDiscovery,
  resolveMcpToolCall,
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

export async function registerMcpAdapter(app: FastifyInstance, config: AppConfig): Promise<void> {
  const discoveryFor = (request: FastifyRequest) =>
    buildCharterCommerceDiscovery({
      origin: safePublicOrigin(
        config.CHARTER_PUBLIC_URL,
        `${request.protocol}://${request.headers.host ?? 'localhost'}`,
      ),
      razorpayMode: config.RAZORPAY_MODE,
      jwtAudience: config.SUPABASE_JWT_AUDIENCE,
    });

  app.get('/mcp/tools', async (request) => ({
    protocol: CHARTER_COMMERCE_PROTOCOL,
    protocolStatus: 'evaluator-http-adapter',
    certified: false,
    note: 'Thin adapter over /api. No database or Razorpay credentials in the adapter.',
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
      const injected = await app.inject({
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
      reply.status(injected.statusCode);
      const contentType = injected.headers['content-type'];
      if (typeof contentType === 'string') {
        reply.type(contentType);
      }
      return reply.send(injected.body);
    },
  );
}
