import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { loadConfig } from '@charter/config';
import { createDb, pingDb, type Database, type Kysely } from '@charter/db';
import { buildCharterCommerceDiscovery } from '@charter/domain-shared';
import { RazorpayClient } from '@charter/razorpay';
import { bootPersistence, type MoneyPersist } from './persist.js';
import { registerConversationRoutes } from './conversations.js';
import { registerVoiceRoutes } from './voice.js';
import { registerStorefrontRoutes } from './storefront.js';
import { registerRazorpayWebhook } from './webhooks.js';
import { createRecoveryRuntime } from './recovery.js';
import { registerOperatorRoutes } from './operator.js';
import { registerAccountRoutes } from './account.js';
import { registerMerchantRoutes } from './merchant.js';
import { registerAuthContext } from './auth/context.js';
import { AuthTokenError, createSupabaseAuthVerifier, type AuthVerifier } from './auth/verifier.js';
import type { TenantRepository } from './tenant/repository.js';
import { createMemoryTenantRepository } from './testing/memory-tenant-repository.js';
import { createPostgresTenantRepository } from './tenant/postgres-repository.js';
import {
  renderAgentsIndexHtml,
  renderDirectoryIndexHtml,
  renderShopIndexHtml,
  robotsText,
  safePublicOrigin,
  sitemapXml,
} from './seo.js';
import { parsePublicCatalogQuery } from './tenant/public-catalog-query.js';
import { registerMcpAdapter } from './mcp.js';

function builtSpaRoot(): string | undefined {
  const serverDirectory = dirname(fileURLToPath(import.meta.url));
  return basename(serverDirectory) === 'dist' ? join(serverDirectory, 'public') : undefined;
}

function isSpaNavigation(method: string, url: string): boolean {
  const pathname = new URL(url, 'http://localhost').pathname;
  const reserved =
    pathname === '/api' ||
    pathname.startsWith('/api/') ||
    pathname === '/health' ||
    pathname.startsWith('/health/') ||
    pathname === '/webhooks' ||
    pathname.startsWith('/webhooks/') ||
    pathname === '/.well-known' ||
    pathname.startsWith('/.well-known/') ||
    pathname === '/mcp' ||
    pathname.startsWith('/mcp/');
  return method === 'GET' && !reserved && extname(pathname) === '';
}

export async function buildServer(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    fetch?: typeof fetch;
    spaRoot?: string;
    authVerifier?: AuthVerifier;
    tenantRepository?: TenantRepository;
    db?: Kysely<Database>;
    razorpay?: Pick<RazorpayClient, 'getOrder' | 'listOrderPayments'> | null;
    persist?: MoneyPersist;
  } = {},
) {
  const config = loadConfig(env);
  const trustProxyHops = config.TRUST_PROXY_HOPS ?? (config.RENDER === 'true' ? 1 : 0);
  const app = Fastify({
    logger: config.LOG_LEVEL === 'debug',
    bodyLimit: 64 * 1024,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    trustProxy:
      trustProxyHops === 0 ? false : (_address: string, hop: number) => hop < trustProxyHops,
    ajv: {
      customOptions: {
        coerceTypes: false,
        removeAdditional: false,
      },
    },
  });
  await app.register(cors, {
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }
      const allowed =
        config.CHARTER_ENV === 'production' || config.CHARTER_ENV === 'staging'
          ? sameOrigin(origin, config.CHARTER_PUBLIC_URL)
          : isLocalDevelopmentOrigin(origin);
      callback(null, allowed);
    },
  });
  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: (request, context) => ({
      statusCode: context.statusCode,
      error: 'RATE_LIMITED',
      requestId: request.id,
    }),
  });
  const razorpay = (
    options.razorpay !== undefined
      ? options.razorpay
      : config.RAZORPAY_KEY_ID && config.RAZORPAY_KEY_SECRET
        ? new RazorpayClient({
            keyId: config.RAZORPAY_KEY_ID,
            keySecret: config.RAZORPAY_KEY_SECRET,
          })
        : null
  ) as RazorpayClient | null;

  let persist: MoneyPersist | undefined = options.persist;
  let dbReady = false;
  let db: Kysely<Database> | undefined = options.db;
  let ownsDb = false;
  if (config.CHARTER_ENV !== 'test') {
    db ??= createDb(config.DATABASE_URL);
    ownsDb = options.db === undefined;
    await pingDb(db);
    persist ??= await bootPersistence(db);
    dbReady = true;
    if (ownsDb) {
      app.addHook('onClose', async () => {
        await db?.destroy();
      });
    }
  }
  const tenantRepository =
    options.tenantRepository ??
    (db ? createPostgresTenantRepository(db) : createMemoryTenantRepository());
  const recovery = createRecoveryRuntime(
    config,
    options.fetch,
    tenantRepository,
    razorpay,
    persist,
  );
  const authVerifier = options.authVerifier ?? verifierFromConfig(config);
  await registerAuthContext(app, authVerifier, tenantRepository);
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id);
    return payload;
  });
  app.setErrorHandler((error, request, reply) => {
    if (
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      error.statusCode === 429
    ) {
      return reply.status(429).send({ error: 'RATE_LIMITED', requestId: request.id });
    }
    if (typeof error === 'object' && error !== null && 'validation' in error && error.validation) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', requestId: request.id });
    }
    request.log.error({ err: error }, 'request failed');
    return reply.status(500).send({ error: 'INTERNAL_ERROR', requestId: request.id });
  });

  await app.register(
    async (api) => {
      await registerAccountRoutes(api, tenantRepository, config);
      await registerStorefrontRoutes(api, config, razorpay, tenantRepository, persist, recovery);
      await registerOperatorRoutes(api, config, tenantRepository, persist);
      await registerMerchantRoutes(api, config, tenantRepository, recovery, persist);
      await registerConversationRoutes(api, config, razorpay, tenantRepository, persist);
      await registerVoiceRoutes(api, config, razorpay, tenantRepository, persist);
    },
    { prefix: '/api' },
  );
  await registerRazorpayWebhook(app, config, persist, recovery);
  await registerMcpAdapter(app, config);

  app.get('/health', async () => ({
    ok: true,
    service: 'core-api',
    env: config.CHARTER_ENV,
    razorpayMode: config.RAZORPAY_MODE,
    paymentsConfigured: Boolean(config.RAZORPAY_KEY_ID && config.RAZORPAY_KEY_SECRET),
    webhookConfigured: Boolean(config.RAZORPAY_WEBHOOK_SECRET),
    fireworksConfigured: Boolean(config.FIREWORKS_API_KEY),
    langfuseConfigured: Boolean(config.LANGFUSE_PUBLIC_KEY && config.LANGFUSE_SECRET_KEY),
    vapiConfigured: Boolean(config.VAPI_PUBLIC_KEY),
    voicePublicUrl: Boolean(config.CHARTER_PUBLIC_URL),
    agentmailConfigured: recovery.enabled,
    db: dbReady,
    persistence: Boolean(persist),
    ...(process.env.CHARTER_E2E_HARNESS === '1' ? { e2eHarness: true } : {}),
  }));

  const spaRoot = options.spaRoot ?? builtSpaRoot();
  const requestPublicOrigin = (protocol: string, host: string | undefined) =>
    safePublicOrigin(config.CHARTER_PUBLIC_URL, `${protocol}://${host ?? 'localhost'}`);

  app.get('/.well-known/charter-commerce.json', async (request, reply) => {
    const publicOrigin = requestPublicOrigin(request.protocol, request.headers.host);
    return reply.header('cache-control', 'public, max-age=300').send(
      buildCharterCommerceDiscovery({
        origin: publicOrigin,
        razorpayMode: config.RAZORPAY_MODE,
        jwtAudience: config.SUPABASE_JWT_AUDIENCE,
      }),
    );
  });

  app.get('/robots.txt', async (request, reply) => {
    const publicOrigin = requestPublicOrigin(request.protocol, request.headers.host);
    return reply
      .header('cache-control', 'public, max-age=300')
      .type('text/plain; charset=utf-8')
      .send(robotsText(publicOrigin));
  });

  app.get('/sitemap.xml', async (request, reply) => {
    const publicOrigin = requestPublicOrigin(request.protocol, request.headers.host);
    const shops = await tenantRepository.listPublicShops();
    return reply
      .header('cache-control', 'public, max-age=300')
      .type('application/xml; charset=utf-8')
      .send(sitemapXml(publicOrigin, shops));
  });

  if (spaRoot) {
    const spaIndex = await readFile(join(spaRoot, 'index.html'), 'utf8');
    await app.register(fastifyStatic, {
      root: spaRoot,
      wildcard: false,
      maxAge: '30d',
      immutable: true,
      setHeaders(reply, filePath) {
        if (basename(filePath) === 'index.html') {
          reply.header('cache-control', 'no-cache');
        }
      },
    });
    app.get('/agents', async (request, reply) => {
      const publicOrigin = requestPublicOrigin(request.protocol, request.headers.host);
      return reply
        .header('cache-control', 'public, max-age=60')
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'strict-origin-when-cross-origin')
        .type('text/html; charset=utf-8')
        .send(renderAgentsIndexHtml(spaIndex, publicOrigin));
    });
    app.get('/shops', async (request, reply) => {
      const publicOrigin = requestPublicOrigin(request.protocol, request.headers.host);
      return reply
        .header('cache-control', 'public, max-age=60')
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'strict-origin-when-cross-origin')
        .type('text/html; charset=utf-8')
        .send(renderDirectoryIndexHtml(spaIndex, publicOrigin));
    });
    app.get<{
      Params: { slug: string };
    }>(
      '/shops/:slug',
      {
        schema: {
          params: {
            type: 'object',
            additionalProperties: false,
            required: ['slug'],
            properties: {
              slug: {
                type: 'string',
                minLength: 1,
                maxLength: 64,
                pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
              },
            },
          },
        },
      },
      async (request, reply) => {
        const query = parsePublicCatalogQuery(
          { limit: '48' },
          `shop:${request.params.slug}`,
          config.CHARTER_CURSOR_SECRET,
        );
        const shop = await tenantRepository.searchPublicCatalog(request.params.slug, query);
        if (!shop) {
          return reply.status(404).type('text/html; charset=utf-8').send(spaIndex);
        }
        const publicOrigin = requestPublicOrigin(request.protocol, request.headers.host);
        return reply
          .header('cache-control', 'public, max-age=60')
          .header('x-content-type-options', 'nosniff')
          .header('referrer-policy', 'strict-origin-when-cross-origin')
          .type('text/html; charset=utf-8')
          .send(renderShopIndexHtml(spaIndex, publicOrigin, shop));
      },
    );
  }
  app.setNotFoundHandler((request, reply) => {
    if (spaRoot && isSpaNavigation(request.method, request.url)) {
      return reply
        .type('text/html; charset=utf-8')
        .sendFile('index.html', { maxAge: 0, immutable: false });
    }
    return reply
      .status(404)
      .type('application/json')
      .send({ error: 'NOT_FOUND', requestId: request.id });
  });

  return { app, config, tenantRepository };
}

function sameOrigin(origin: string, publicUrl: string): boolean {
  if (!publicUrl) {
    return false;
  }
  try {
    return new URL(origin).origin === new URL(publicUrl).origin;
  } catch {
    return false;
  }
}

function isLocalDevelopmentOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1')
    );
  } catch {
    return false;
  }
}

function verifierFromConfig(config: ReturnType<typeof loadConfig>): AuthVerifier {
  const issuer =
    config.SUPABASE_JWT_ISSUER ||
    (config.SUPABASE_URL ? `${config.SUPABASE_URL.replace(/\/$/, '')}/auth/v1` : '');
  const jwksUrl = config.SUPABASE_JWT_JWKS_URL || (issuer ? `${issuer}/.well-known/jwks.json` : '');
  if (!issuer || !jwksUrl) {
    return {
      async verify() {
        throw new AuthTokenError('AUTH_INVALID_TOKEN');
      },
    };
  }
  return createSupabaseAuthVerifier({
    issuer,
    jwksUrl,
    audience: config.SUPABASE_JWT_AUDIENCE,
  });
}

const isMain = process.argv[1]?.includes('server');
if (isMain) {
  const { app, config } = await buildServer();
  await app.listen({ host: '0.0.0.0', port: config.PORT });
}
