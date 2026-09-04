import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { hydrateCart, hydrateQuote } from '@charter/commerce';
import { applyRazorpayWebhook, hydrateCheckout } from '@charter/payments';
import { verifyRazorpayWebhookSignature } from '@charter/razorpay';
import type { AppConfig } from '@charter/config';
import type { MoneyPersist } from './persist.js';
import type { RecoveryRuntime } from './recovery.js';

export async function registerRazorpayWebhook(
  app: FastifyInstance,
  config: AppConfig,
  persist?: MoneyPersist,
  recovery?: RecoveryRuntime,
): Promise<void> {
  await app.register(async (scope) => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_request, body, done) => {
        done(null, body);
      },
    );

    scope.post('/webhooks/razorpay', async (request, reply) => {
      if (!config.RAZORPAY_WEBHOOK_SECRET) {
        return reply.status(503).send({ error: 'WEBHOOK_SECRET_MISSING' });
      }
      const rawBody = Buffer.isBuffer(request.body)
        ? request.body
        : Buffer.from(String(request.body ?? ''), 'utf8');
      const signature = request.headers['x-razorpay-signature'];
      const ok = verifyRazorpayWebhookSignature({
        rawBody,
        signatureHeader: Array.isArray(signature) ? signature[0] : signature,
        secret: config.RAZORPAY_WEBHOOK_SECRET,
      });
      if (!ok) {
        return reply.status(400).send({ error: 'INVALID_SIGNATURE' });
      }
      let parsed: unknown = {};
      try {
        parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
      } catch {
        return reply.status(400).send({ error: 'INVALID_JSON' });
      }
      const headerId = request.headers['x-razorpay-event-id'];
      const eventId =
        (Array.isArray(headerId) ? headerId[0] : headerId) ??
        createHash('sha256').update(rawBody).digest('hex');
      const eventType =
        parsed &&
        typeof parsed === 'object' &&
        'event' in parsed &&
        typeof parsed.event === 'string'
          ? parsed.event
          : 'unknown';
      if (!persist) {
        return reply.status(503).send({
          error: 'WEBHOOK_PERSISTENCE_UNAVAILABLE',
          requestId: request.id,
        });
      }
      try {
        await persist.recordWebhookIntake({ eventId, eventType, payload: parsed });
      } catch {
        request.log.error(
          { eventId, requestId: request.id },
          'webhook intake persistence unavailable',
        );
        return reply.status(503).send({
          error: 'WEBHOOK_DURABILITY_UNAVAILABLE',
          requestId: request.id,
        });
      }
      const payment =
        parsed && typeof parsed === 'object' && 'payload' in parsed
          ? (parsed as { payload?: { payment?: { entity?: { order_id?: string } } } }).payload
              ?.payment?.entity
          : undefined;
      try {
        const resolved = payment?.order_id
          ? await persist.resolveCheckoutByOrderId(payment.order_id)
          : undefined;
        if (resolved) {
          hydrateCart(resolved.cart);
          hydrateQuote(resolved.quote);
          hydrateCheckout(resolved.session);
        }
        const session = applyRazorpayWebhook(parsed as { event?: string });
        if (payment?.order_id) {
          const tenantId = session?.tenantId ?? resolved?.tenantId;
          if (session && resolved && session.tenantId !== resolved.tenantId) {
            await persist.quarantineWebhook({
              eventId,
              orderId: payment.order_id,
              reason: 'checkout_tenant_conflict',
            });
            return reply.status(200).send({
              received: true,
              eventId,
              checkoutStatus: null,
              recovery: null,
              requestId: request.id,
            });
          }
          if (tenantId) {
            await persist.attributeWebhook({
              eventId,
              tenantId,
              orderId: payment.order_id,
            });
          } else {
            await persist.quarantineWebhook({
              eventId,
              orderId: payment.order_id,
              reason: 'checkout_order_unknown',
            });
          }
        } else {
          await persist.quarantineWebhook({
            eventId,
            reason: 'checkout_order_missing',
          });
        }
        const persistedSession = session
          ? await persist.persistWebhookTransition(session)
          : undefined;
        const recoveryAttempt =
          persistedSession?.status === 'FAILED_PROVISIONAL'
            ? await recovery?.afterFailedPay(persistedSession)
            : undefined;
        return reply.status(200).send({
          received: true,
          eventId,
          checkoutStatus: persistedSession?.status ?? null,
          recovery: recoveryAttempt ?? null,
          requestId: request.id,
        });
      } catch {
        request.log.error(
          { eventId, requestId: request.id },
          'webhook transition persistence unavailable',
        );
        return reply.status(503).send({
          error: 'WEBHOOK_DURABILITY_UNAVAILABLE',
          requestId: request.id,
        });
      }
    });
  });
}
