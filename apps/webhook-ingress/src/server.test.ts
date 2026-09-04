import { describe, expect, it } from 'vitest';
import { buildWebhookServer } from './server.js';

describe('razorpay webhook ingress', () => {
  it('never acknowledges a webhook even when its signature is valid', async () => {
    const raw = '{"event":"payment.failed"}';
    const { app } = await buildWebhookServer({
      DATABASE_URL: 'postgres://charter:charter@127.0.0.1:5432/charter',
      RAZORPAY_WEBHOOK_SECRET: 'whsec_test',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/razorpay',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': 'unused-while-disabled',
        'x-razorpay-event-id': 'evt_test',
      },
      payload: raw,
    });
    expect(response.statusCode).toBe(410);
    expect(response.json()).toEqual({
      error: 'WEBHOOK_INGRESS_DISABLED',
      requestId: expect.any(String),
    });
    expect(response.headers['x-request-id']).toBe(response.json().requestId);
    await app.close();
  });

  it('returns the same disabled response without a webhook secret', async () => {
    const { app } = await buildWebhookServer({
      DATABASE_URL: 'postgres://charter:charter@127.0.0.1:5432/charter',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/razorpay',
      headers: {
        'content-type': 'application/json',
      },
      payload: '{"event":"payment.captured"}',
    });
    expect(response.statusCode).toBe(410);
    expect(response.json().error).toBe('WEBHOOK_INGRESS_DISABLED');
    await app.close();
  });
});
