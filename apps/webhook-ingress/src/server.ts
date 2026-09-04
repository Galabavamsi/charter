import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { loadConfig } from '@charter/config';

export async function buildWebhookServer(env: NodeJS.ProcessEnv = process.env) {
  const config = loadConfig(env);
  const app = Fastify({
    logger: false,
    bodyLimit: 1_048_576,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
  });

  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id);
    return payload;
  });

  app.get('/health', async () => ({
    ok: true,
    service: 'webhook-ingress',
    webhookIngress: 'disabled',
  }));

  app.post('/webhooks/razorpay', async (request, reply) => {
    return reply.status(410).send({
      error: 'WEBHOOK_INGRESS_DISABLED',
      requestId: request.id,
    });
  });

  return { app, config };
}

const isMain = /server\.(ts|js)$/.test(process.argv[1] ?? '');
if (isMain) {
  const { app, config } = await buildWebhookServer();
  await app.listen({ host: config.HOST, port: config.WEBHOOK_PORT });
}
