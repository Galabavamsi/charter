import Fastify from 'fastify';
import { loadConfig } from '@charter/config';
import {
  CHARTER_COMMERCE_NOT_CERTIFIED,
  CHARTER_COMMERCE_PROTOCOL,
  CHARTER_COMMERCE_TOOLS,
  McpToolError,
  resolveMcpToolCall,
} from '@charter/domain-shared';

type McpCallBody = {
  name?: string;
  arguments?: Record<string, unknown>;
  args?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  authorization?: string;
  idempotencyKey?: string;
  path?: string;
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

export function buildMcpGateway(env: NodeJS.ProcessEnv = process.env) {
  const config = loadConfig(env);
  const app = Fastify({ logger: false });
  const coreOrigin = (
    env.CHARTER_CORE_API_URL ||
    config.CHARTER_PUBLIC_URL ||
    'http://127.0.0.1:3000'
  ).replace(/\/$/, '');
  const listenPort = config.RENDER === 'true' ? config.PORT : config.MCP_PORT;

  app.get('/health', async () => ({
    ok: true,
    service: 'mcp-gateway',
    note: 'No database or Razorpay credentials in this process',
    coreOrigin,
    certified: false,
    notCertified: [...CHARTER_COMMERCE_NOT_CERTIFIED],
  }));

  app.get('/mcp/tools', async () => ({
    protocol: CHARTER_COMMERCE_PROTOCOL,
    protocolStatus: 'evaluator-http-adapter',
    tools: CHARTER_COMMERCE_TOOLS,
  }));

  app.post('/mcp/call', async (request, reply) => {
    const body = (request.body ?? {}) as McpCallBody;
    let resolved;
    try {
      resolved = resolveMcpToolCall(body.name, callArguments(body));
    } catch (error) {
      const code = error instanceof McpToolError ? error.code : 'MCP_ARGS_INVALID';
      return reply.status(code === 'MCP_TOOL_UNKNOWN' ? 404 : 400).send({ error: code });
    }
    if (resolved.local) {
      const discovery = await fetch(`${coreOrigin}/.well-known/charter-commerce.json`);
      const text = await discovery.text();
      return reply.status(discovery.status).type('application/json').send(text);
    }
    const authorization =
      (typeof body.authorization === 'string' && body.authorization) ||
      (typeof request.headers.authorization === 'string'
        ? request.headers.authorization
        : undefined);
    if (resolved.auth === 'bearer' && !authorization) {
      return reply.status(401).send({ error: 'AUTH_REQUIRED' });
    }
    const targetPath = resolved.path;
    if (!targetPath.startsWith('/api/')) {
      return reply.status(400).send({ error: 'MCP_PATH_NOT_API' });
    }
    const response = await fetch(`${coreOrigin}${targetPath}`, {
      method: resolved.method,
      headers: {
        'content-type': 'application/json',
        'x-charter-agent': 'mcp',
        ...(authorization ? { authorization } : {}),
        ...(typeof body.idempotencyKey === 'string'
          ? { 'idempotency-key': body.idempotencyKey }
          : {}),
      },
      ...(resolved.method === 'GET' ? {} : { body: JSON.stringify(resolved.body ?? {}) }),
    });
    const text = await response.text();
    return reply.status(response.status).type('application/json').send(text);
  });

  return { app, config, listenPort };
}

const isMain = process.argv[1]?.includes('server');
if (isMain) {
  const { app, config, listenPort } = buildMcpGateway();
  await app.listen({ host: config.HOST, port: listenPort });
}
