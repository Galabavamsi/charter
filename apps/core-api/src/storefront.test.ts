import { createHmac } from 'node:crypto';
import { describe, expect, it, beforeEach } from 'vitest';
import { resetCreatedMerchants } from '@charter/catalog';
import { buildServer } from './server.js';
import { authHeaders, testAuthVerifier, testTenantRepository } from './testing/security.js';

describe('shop directory', () => {
  beforeEach(() => {
    resetCreatedMerchants();
  });

  it('lists seeded shops and lets a merchant add stock', async () => {
    const { app } = await buildServer(
      {
        DATABASE_URL: 'postgres://charter:charter@127.0.0.1:5432/charter',
        CHARTER_ENV: 'test',
        RAZORPAY_MODE: 'test',
      },
      { authVerifier: testAuthVerifier(), tenantRepository: testTenantRepository() },
    );
    const directory = await app.inject({ method: 'GET', url: '/api/v1/shops' });
    expect(directory.statusCode).toBe(200);
    expect(directory.json().items.length).toBeGreaterThanOrEqual(3);
    expect(
      directory.json().items.find((shop: { slug: string }) => shop.slug === 'northstar')
        .catalogPath,
    ).toBe('/api/v1/merchants/northstar-demo-in/catalog');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/shops',
      headers: { ...authHeaders('buyer'), 'idempotency-key': 'storefront-shop-create-001' },
      payload: { name: 'Evaluator Tea', blurb: 'Leaf and cups.' },
    });
    expect(created.statusCode).toBe(201);
    const tenantId = 'northstar-demo-in';
    const item = await app.inject({
      method: 'POST',
      url: `/api/v1/merchant/shops/${tenantId}/catalog/products`,
      headers: {
        ...authHeaders('northstar-owner'),
        'idempotency-key': 'storefront-catalog-create-001',
      },
      payload: {
        title: 'Assam leaf, 250 g',
        description: 'Canonical Assam leaf record.',
        category: 'Tea',
        sku: 'tea.assam-leaf-250',
        material: 'paper',
        price: '249.00',
        stock: 16,
        status: 'published',
      },
    });
    expect(item.statusCode).toBe(201);
    expect(item.json().item.inventory.onHand).toBe(16);
    const found = await app.inject({ method: 'GET', url: '/api/v1/shops/northstar' });
    expect(
      found.json().items.find((entry: { title: string }) => entry.title === 'Assam leaf, 250 g'),
    ).toBeDefined();
    const discover = await app.inject({ method: 'GET', url: '/api/.well-known/agent-commerce' });
    expect(discover.json().shops).toBe('/api/v1/shops');
    expect(discover.body).not.toMatch(/Gemini plugin/i);
    const merchant = await app.inject({
      method: 'GET',
      url: '/api/v1/merchants/northstar-demo-in',
    });
    expect(merchant.json().href).toBe('/shops/northstar');
    await app.close();
  });
});

describe('canonical kit HTTP', () => {
  it('returns a frozen ₹2,347 quote and glass deny', async () => {
    const { app } = await buildServer({
      DATABASE_URL: 'postgres://charter:charter@127.0.0.1:5432/charter',
      CHARTER_ENV: 'test',
      RAZORPAY_MODE: 'test',
    });
    const response = await app.inject({ method: 'POST', url: '/api/v1/demo/canonical-kit' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.quote.totalDisplay).toBe('₹2,347.00');
    expect(body.glass.reason).toBe('PRODUCT_MATERIAL_FORBIDDEN');
    expect(body.kettle.reason).toBe('OUT_OF_STOCK');
    await app.close();
  });

  it('does not acknowledge a raw signed webhook without persistence', async () => {
    const secret = 'whsec_test';
    const raw =
      '{"event":"payment.failed","payload":{"payment":{"entity":{"id":"pay_1","order_id":"order_missing","status":"failed"}}}}';
    const signature = createHmac('sha256', secret).update(raw).digest('hex');
    const { app } = await buildServer({
      DATABASE_URL: 'postgres://charter:charter@127.0.0.1:5432/charter',
      CHARTER_ENV: 'test',
      RAZORPAY_MODE: 'test',
      RAZORPAY_WEBHOOK_SECRET: secret,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/razorpay',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': signature,
        'x-razorpay-event-id': 'evt_1',
      },
      payload: raw,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe('WEBHOOK_PERSISTENCE_UNAVAILABLE');
    await app.close();
  });

  it('refuses recovery mail without an explicit payment_recovery grant', async () => {
    const { app } = await buildServer(
      {
        DATABASE_URL: 'postgres://charter:charter@127.0.0.1:5432/charter',
        CHARTER_ENV: 'test',
        RAZORPAY_MODE: 'test',
        AGENTMAIL_API_KEY: 'am_test',
        AGENTMAIL_INBOX: 'demo@agentmail.to',
      },
      { authVerifier: testAuthVerifier(), tenantRepository: testTenantRepository() },
    );
    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/recovery/consent',
      headers: authHeaders('buyer'),
      payload: { shopSlug: 'northstar' },
    });
    expect(denied.statusCode).toBe(400);
    expect(denied.json().error).toBe('CONSENT_PURPOSE_REQUIRED');
    await app.close();
  });

  it('preserves recovery consent domain errors for invalid purpose and channel values', async () => {
    const { app } = await buildServer(
      {
        DATABASE_URL: 'postgres://charter:charter@127.0.0.1:5432/charter',
        CHARTER_ENV: 'test',
        RAZORPAY_MODE: 'test',
        AGENTMAIL_API_KEY: 'am_test',
        AGENTMAIL_INBOX: 'demo@agentmail.to',
      },
      { authVerifier: testAuthVerifier(), tenantRepository: testTenantRepository() },
    );
    const wrongPurpose = await app.inject({
      method: 'POST',
      url: '/api/v1/recovery/consent',
      headers: authHeaders('buyer'),
      payload: { shopSlug: 'northstar', purpose: 'marketing', channel: 'email' },
    });
    const missingChannel = await app.inject({
      method: 'POST',
      url: '/api/v1/recovery/consent',
      headers: authHeaders('buyer'),
      payload: { shopSlug: 'northstar', purpose: 'payment_recovery' },
    });

    expect(wrongPurpose.statusCode).toBe(400);
    expect(wrongPurpose.json().error).toBe('CONSENT_PURPOSE_REQUIRED');
    expect(missingChannel.statusCode).toBe(400);
    expect(missingChannel.json().error).toBe('CONSENT_CHANNEL_REQUIRED');
    await app.close();
  });
});
