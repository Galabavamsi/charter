import cors from '@fastify/cors';
import Fastify from 'fastify';
import { resetKernel } from '@charter/commerce';
import { resetConversations } from '@charter/orchestrator';
import { resetCheckouts } from '@charter/payments';
import { RazorpayClient } from '@charter/razorpay';
import { buildServer } from '../server.js';
import { testAuthVerifier, testTenantRepository } from '../testing/security.js';
import { createHarnessMoneyPersist } from './harness-persist.js';

const RAZORPAY_KEY_ID = 'rzp_test_e2e_harness';
const RAZORPAY_KEY_SECRET = 'rzp_test_e2e_harness_secret';
const API_PORT = Number(process.env.CHARTER_E2E_API_PORT ?? 3000);
const PROVIDER_PORT = Number(process.env.CHARTER_E2E_RAZORPAY_PORT ?? 3101);

type StoredOrder = {
  id: string;
  amount: number;
  currency: string;
  receipt: string;
  status: string;
};

type StoredPayment = {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: string;
};

async function startProviderStub() {
  const orders: StoredOrder[] = [];
  const payments: StoredPayment[] = [];
  let created = 0;
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });

  app.post('/v1/orders', async (request) => {
    const body = request.body as { amount: number; currency: string; receipt: string };
    const existing = orders.find((row) => row.receipt === body.receipt);
    if (existing) {
      return existing;
    }
    created += 1;
    const order: StoredOrder = {
      id: `order_e2e_${created}`,
      amount: body.amount,
      currency: body.currency,
      receipt: body.receipt,
      status: 'created',
    };
    orders.push(order);
    return order;
  });

  app.get('/v1/orders', async (request) => {
    const receipt = (request.query as { receipt?: string }).receipt;
    return {
      items: receipt ? orders.filter((row) => row.receipt === receipt) : orders,
    };
  });

  app.get('/v1/orders/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const order = orders.find((row) => row.id === id);
    if (!order) {
      return reply.status(404).send({ error: 'ORDER_NOT_FOUND' });
    }
    return order;
  });

  app.get('/v1/orders/:id/payments', async (request) => {
    const { id } = request.params as { id: string };
    return { items: payments.filter((row) => row.order_id === id) };
  });

  app.get('/v1/payments/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const payment = payments.find((row) => row.id === id);
    if (!payment) {
      return reply.status(404).send({ error: 'PAYMENT_NOT_FOUND' });
    }
    return payment;
  });

  app.post('/v1/test/payments', async (request, reply) => {
    const body = request.body as { order_id?: string; status?: string; id?: string };
    const order = orders.find((row) => row.id === body.order_id);
    if (!order || !body.status) {
      return reply.status(400).send({ error: 'PAYMENT_FIXTURE_INVALID' });
    }
    const payment: StoredPayment = {
      id: body.id ?? `pay_e2e_${payments.length + 1}`,
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      status: body.status,
    };
    payments.push(payment);
    order.status = body.status === 'captured' ? 'paid' : 'attempted';
    return payment;
  });

  app.get('/v1/test/stats', async () => ({
    ordersCreated: created,
    orderIds: orders.map((row) => row.id),
    payments: payments.map((row) => ({ id: row.id, order_id: row.order_id, status: row.status })),
  }));

  await app.listen({ host: '127.0.0.1', port: PROVIDER_PORT });
  return app;
}

process.env.CHARTER_E2E_HARNESS = '1';
resetKernel();
resetCheckouts();
resetConversations();

const provider = await startProviderStub();
const repository = testTenantRepository();
const { app } = await buildServer(
  {
    CHARTER_ENV: 'test',
    RAZORPAY_MODE: 'test',
    RAZORPAY_KEY_ID,
    RAZORPAY_KEY_SECRET,
    DATABASE_URL: 'postgres://unused',
    PORT: String(API_PORT),
  },
  {
    authVerifier: testAuthVerifier(),
    tenantRepository: repository,
    persist: createHarnessMoneyPersist(repository),
    razorpay: new RazorpayClient(
      { keyId: RAZORPAY_KEY_ID, keySecret: RAZORPAY_KEY_SECRET },
      fetch,
      `http://127.0.0.1:${PROVIDER_PORT}/v1`,
    ),
  },
);

await app.listen({ host: '127.0.0.1', port: API_PORT });

const shutdown = async () => {
  await app.close();
  await provider.close();
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
