import Fastify from 'fastify';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  buildCanonicalKit,
  decideApproval,
  hydrateApproval,
  hydrateCart,
  openTypedApproval,
  previewReplace,
  resetApprovals,
  resetKernel,
} from '@charter/commerce';
import { resetCheckouts } from '@charter/payments';
import { loadConfig } from '@charter/config';
import { buildServer } from './server.js';
import { registerAuthContext } from './auth/context.js';
import { registerOperatorRoutes } from './operator.js';
import type { MoneyPersist } from './persist.js';
import {
  authHeaders,
  TEST_USERS,
  testAuthVerifier,
  testTenantRepository,
} from './testing/security.js';

describe('register and control', () => {
  beforeEach(() => {
    resetKernel();
    resetCheckouts();
    resetApprovals();
  });

  it('exposes Northstar authority and catalog on Register', async () => {
    const { app } = await buildServer(
      {
        DATABASE_URL: 'postgres://charter:charter@127.0.0.1:5432/charter',
        CHARTER_ENV: 'test',
        RAZORPAY_MODE: 'test',
      },
      { authVerifier: testAuthVerifier(), tenantRepository: testTenantRepository() },
    );
    await app.inject({ method: 'POST', url: '/api/v1/demo/canonical-kit' });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/register/northstar-demo-in',
      headers: authHeaders('northstar-owner'),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.authority.hardCapDisplay).toBe('₹3,000.00');
    expect(body.authority.forbiddenMaterials).toContain('glass');
    expect(body.catalog.some((row: { sku: string }) => row.sku === 'brewer.clear-glass-500')).toBe(
      true,
    );
    expect(body.quotes[0].totalDisplay).toBe('₹2,347.00');
    expect(body.refunds.available).toBe(false);
    expect(body.approvals).toEqual([]);
    expect(JSON.stringify(body)).not.toContain('rzp_');
    await app.close();
  });

  it('lets Register approve PocketGrind Pro and only then changes the cart', async () => {
    const repository = testTenantRepository();
    const { app } = await buildServer(
      {
        DATABASE_URL: 'postgres://charter:charter@127.0.0.1:5432/charter',
        CHARTER_ENV: 'test',
        RAZORPAY_MODE: 'test',
      },
      { authVerifier: testAuthVerifier(), tenantRepository: repository },
    );
    const kit = await app.inject({ method: 'POST', url: '/api/v1/demo/canonical-kit' });
    const cartId = kit.json().cart.id as string;
    await repository.claimResource('cart', 'northstar-demo-in', cartId, TEST_USERS.buyer);
    const preview = await app.inject({
      method: 'POST',
      url: `/api/v1/carts/${cartId}/preview-replace`,
      headers: authHeaders('buyer'),
      payload: {
        shopSlug: 'northstar',
        fromSku: 'grinder.pocket-lite',
        toSku: 'grinder.pocket-pro',
      },
    });
    expect(preview.json().decision.outcome).toBe('require_approval');
    expect(preview.json().approval.status).toBe('pending');
    const approvalId = preview.json().approval.id as string;
    const snapshot = await app.inject({
      method: 'GET',
      url: '/api/v1/register/northstar-demo-in',
      headers: authHeaders('northstar-owner'),
    });
    expect(snapshot.json().approvals[0].id).toBe(approvalId);
    const approved = await app.inject({
      method: 'POST',
      url: `/api/v1/register/approvals/${approvalId}`,
      headers: authHeaders('northstar-owner'),
      payload: { decision: 'approved', tenantId: 'northstar-demo-in' },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().approval.status).toBe('approved');
    expect(
      approved.json().cart.lines.some((line: { sku: string }) => line.sku === 'grinder.pocket-pro'),
    ).toBe(true);
    const quote = await app.inject({
      method: 'POST',
      url: `/api/v1/carts/${cartId}/quotes`,
      headers: authHeaders('buyer'),
      payload: { shopSlug: 'northstar' },
    });
    expect(quote.statusCode).toBe(200);
    expect(quote.json().totalDisplay).toBe('₹2,847.00');
    await app.close();
  });

  it('rejects catalog and finance principals from deciding cart-spend approvals', async () => {
    const repository = testTenantRepository();
    const { app } = await buildServer(
      {
        DATABASE_URL: 'postgres://charter:charter@127.0.0.1:5432/charter',
        CHARTER_ENV: 'test',
        RAZORPAY_MODE: 'test',
      },
      { authVerifier: testAuthVerifier(), tenantRepository: repository },
    );
    const kit = await app.inject({ method: 'POST', url: '/api/v1/demo/canonical-kit' });
    const cartId = kit.json().cart.id as string;
    await repository.claimResource('cart', 'northstar-demo-in', cartId, TEST_USERS.buyer);
    const preview = await app.inject({
      method: 'POST',
      url: `/api/v1/carts/${cartId}/preview-replace`,
      headers: authHeaders('buyer'),
      payload: {
        shopSlug: 'northstar',
        fromSku: 'grinder.pocket-lite',
        toSku: 'grinder.pocket-pro',
      },
    });
    const approvalId = preview.json().approval.id as string;
    const finance = await app.inject({
      method: 'POST',
      url: `/api/v1/register/approvals/${approvalId}`,
      headers: authHeaders('northstar-finance'),
      payload: { decision: 'approved', tenantId: 'northstar-demo-in' },
    });
    const catalog = await app.inject({
      method: 'POST',
      url: `/api/v1/register/approvals/${approvalId}`,
      headers: authHeaders('northstar-catalog'),
      payload: { decision: 'approved', tenantId: 'northstar-demo-in' },
    });
    expect(finance.statusCode).toBe(403);
    expect(catalog.statusCode).toBe(403);
    await app.close();
  });

  it('loads and decides the exact durable approval after process memory resets', async () => {
    const repository = testTenantRepository();
    const { cart } = buildCanonicalKit();
    const preview = previewReplace(cart.id, 'grinder.pocket-lite', 'grinder.pocket-pro');
    const durableApproval = { ...preview.approval! };
    const durableCart = {
      ...cart,
      lines: cart.lines.map((line) => ({ ...line })),
    };
    const loadApproval = vi.fn(async (tenantId: string, approvalId: string) =>
      tenantId === durableApproval.tenantId && approvalId === durableApproval.id
        ? { ...durableApproval }
        : undefined,
    );
    const decideDurableApproval = vi.fn(
      async (
        tenantId: string,
        approvalId: string,
        decision: 'approved' | 'denied',
        _decidedBy: string,
      ) => {
        hydrateCart({
          ...durableCart,
          lines: durableCart.lines.map((line) => ({ ...line })),
        });
        hydrateApproval({ ...durableApproval });
        if (tenantId !== durableApproval.tenantId) {
          throw new Error('APPROVAL_NOT_FOUND');
        }
        return decideApproval(approvalId, decision, {
          decidedBy: _decidedBy,
          shopRole: 'owner',
        });
      },
    );
    const persist = {
      loadApproval,
      decideApproval: decideDurableApproval,
    } as unknown as MoneyPersist;
    resetKernel();

    const app = Fastify();
    const config = loadConfig({
      DATABASE_URL: 'postgres://unused',
      CHARTER_ENV: 'test',
      RAZORPAY_MODE: 'test',
    });
    await registerAuthContext(app, testAuthVerifier(), repository);
    await registerOperatorRoutes(app, config, repository, persist);
    const approved = await app.inject({
      method: 'POST',
      url: `/v1/register/approvals/${durableApproval.id}`,
      headers: authHeaders('northstar-owner'),
      payload: { decision: 'approved', tenantId: 'northstar-demo-in' },
    });

    expect(approved.statusCode, approved.body).toBe(200);
    expect(loadApproval).toHaveBeenCalledWith('northstar-demo-in', durableApproval.id);
    expect(decideDurableApproval).toHaveBeenCalledWith(
      'northstar-demo-in',
      durableApproval.id,
      'approved',
      TEST_USERS.northstarOwner,
    );
    expect(approved.json().approval.status).toBe('approved');
    expect(
      approved.json().cart.lines.some((line: { sku: string }) => line.sku === 'grinder.pocket-pro'),
    ).toBe(true);
    await app.close();
  });

  it('checks tenant membership before loading durable approval details', async () => {
    const repository = testTenantRepository();
    const loadApproval = vi.fn();
    const persist = {
      loadApproval,
    } as unknown as MoneyPersist;
    const app = Fastify();
    const config = loadConfig({
      DATABASE_URL: 'postgres://unused',
      CHARTER_ENV: 'test',
      RAZORPAY_MODE: 'test',
    });
    await registerAuthContext(app, testAuthVerifier(), repository);
    await registerOperatorRoutes(app, config, repository, persist);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/register/approvals/85000000-0000-4000-8000-000000000099',
      headers: authHeaders('buyer'),
      payload: { decision: 'approved', tenantId: 'northstar-demo-in' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe('SHOP_MEMBERSHIP_REQUIRED');
    expect(loadApproval).not.toHaveBeenCalled();
    await app.close();
  });

  it('renders Register analytics and approvals from the durable tenant snapshot after restart', async () => {
    const repository = testTenantRepository();
    const { cart, quote } = buildCanonicalKit();
    const preview = previewReplace(cart.id, 'grinder.pocket-lite', 'grinder.pocket-pro');
    const approval = {
      ...preview.approval!,
      fromTitle: 'Durable PocketGrind Lite',
      toTitle: 'Durable PocketGrind Pro',
    };
    const loadRegisterSnapshot = vi.fn(async () => ({
      quotes: [{ ...quote, lines: quote.lines.map((line) => ({ ...line })) }],
      checkouts: [
        {
          id: '85000000-0000-4000-8000-000000000001',
          tenantId: 'northstar-demo-in',
          quoteId: quote.id,
          receipt: 'rcpt_durable_register',
          razorpayOrderId: 'order_durable_register',
          amountMinor: Number(quote.totalMinor),
          currency: 'INR' as const,
          status: 'FAILED_PROVISIONAL' as const,
          paymentId: null,
          providerStatus: 'failed',
          copy: 'Durable failed checkout.',
        },
      ],
      approvals: [{ ...approval }],
    }));
    const persist = {
      loadRegisterSnapshot,
      listCaptures: async () => [],
    } as unknown as MoneyPersist;
    resetKernel();
    resetCheckouts();

    const app = Fastify();
    const config = loadConfig({
      DATABASE_URL: 'postgres://unused',
      CHARTER_ENV: 'test',
      RAZORPAY_MODE: 'test',
    });
    await registerAuthContext(app, testAuthVerifier(), repository);
    await registerOperatorRoutes(app, config, repository, persist);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/register/northstar-demo-in',
      headers: authHeaders('northstar-owner'),
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(loadRegisterSnapshot).toHaveBeenCalledWith('northstar-demo-in');
    expect(response.json()).toMatchObject({
      failedPays: 1,
      uniqueOrders: 1,
      quotes: [{ id: quote.id }],
      checkouts: [{ id: '85000000-0000-4000-8000-000000000001' }],
      approvals: [
        {
          id: approval.id,
          fromTitle: 'Durable PocketGrind Lite',
          toTitle: 'Durable PocketGrind Pro',
        },
      ],
    });
    await app.close();
  });

  it('passes the authenticated platform principal to the durable Control inbox query', async () => {
    const repository = testTenantRepository();
    const listInbox = vi.fn(async (_userId: string) => []);
    const persist = { listInbox } as unknown as MoneyPersist;
    const app = Fastify();
    const config = loadConfig({
      DATABASE_URL: 'postgres://unused',
      CHARTER_ENV: 'test',
      RAZORPAY_MODE: 'test',
    });
    await registerAuthContext(app, testAuthVerifier(), repository);
    await registerOperatorRoutes(app, config, repository, persist);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/control',
      headers: authHeaders('platform-admin'),
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(listInbox).toHaveBeenCalledWith(TEST_USERS.platformAdmin);
    await app.close();
  });

  it('blocks checkout when Control kills the tenant', async () => {
    const repository = testTenantRepository();
    const { app } = await buildServer(
      {
        DATABASE_URL: 'postgres://charter:charter@127.0.0.1:5432/charter',
        CHARTER_ENV: 'test',
        RAZORPAY_MODE: 'test',
        RAZORPAY_KEY_ID: 'rzp_test_x',
        RAZORPAY_KEY_SECRET: 'hidden',
      },
      { authVerifier: testAuthVerifier(), tenantRepository: repository },
    );
    const kit = await app.inject({ method: 'POST', url: '/api/v1/demo/canonical-kit' });
    const quoteId = kit.json().quote.id as string;
    await repository.claimResource('quote', 'northstar-demo-in', quoteId, TEST_USERS.buyer);
    const killed = await app.inject({
      method: 'POST',
      url: '/api/v1/control/kill',
      headers: authHeaders('platform-admin'),
      payload: { scope: 'tenant', tenantId: 'northstar-demo-in', on: true },
    });
    expect(killed.statusCode).toBe(200);
    expect(killed.json().kill.tenants['northstar-demo-in']).toBe(true);
    const checkout = await app.inject({
      method: 'POST',
      url: `/api/v1/quotes/${quoteId}/checkout`,
      headers: authHeaders('buyer'),
      payload: { shopSlug: 'northstar' },
    });
    expect(checkout.statusCode).toBe(423);
    expect(checkout.json().error).toBe('CHECKOUT_KILLED');
    await app.close();
  });
});

describe('typed register approvals', () => {
  beforeEach(() => {
    resetKernel();
    resetCheckouts();
    resetApprovals();
  });

  async function registerApp() {
    return buildServer(
      {
        DATABASE_URL: 'postgres://charter:charter@127.0.0.1:5432/charter',
        CHARTER_ENV: 'test',
        RAZORPAY_MODE: 'test',
      },
      { authVerifier: testAuthVerifier(), tenantRepository: testTenantRepository() },
    );
  }

  it('lists catalog, refund, and campaign approvals by kind', async () => {
    openTypedApproval({
      kind: 'catalog_publish',
      tenantId: 'northstar-demo-in',
      resourceId: 'product-1',
      resourceVersion: 1,
      amountMinor: 0n,
      reason: 'CATALOG_PUBLISH_APPROVAL_REQUIRED',
      requestedBy: TEST_USERS.buyer,
    });
    openTypedApproval({
      kind: 'refund',
      tenantId: 'northstar-demo-in',
      resourceId: 'order-1',
      resourceVersion: 1,
      amountMinor: 99900n,
      reason: 'REFUND_APPROVAL_REQUIRED',
      requestedBy: TEST_USERS.buyer,
    });
    openTypedApproval({
      kind: 'campaign',
      tenantId: 'northstar-demo-in',
      resourceId: 'offer-1',
      resourceVersion: 1,
      amountMinor: 50000n,
      reason: 'CAMPAIGN_APPROVAL_REQUIRED',
      requestedBy: TEST_USERS.buyer,
    });
    const { app } = await registerApp();
    const catalog = await app.inject({
      method: 'GET',
      url: '/api/v1/register/northstar-demo-in/approvals?kind=catalog_publish',
      headers: authHeaders('northstar-owner'),
    });
    const refunds = await app.inject({
      method: 'GET',
      url: '/api/v1/register/northstar-demo-in/approvals?kind=refund',
      headers: authHeaders('northstar-finance'),
    });
    expect(catalog.statusCode, catalog.body).toBe(200);
    expect(catalog.json().approvals).toEqual([
      expect.objectContaining({ kind: 'catalog_publish', resourceId: 'product-1' }),
    ]);
    expect(refunds.statusCode, refunds.body).toBe(200);
    expect(refunds.json().approvals).toEqual([
      expect.objectContaining({ kind: 'refund', resourceId: 'order-1' }),
    ]);
    expect(refunds.json().refunds).toEqual({
      available: false,
      note: 'Refunds are Register-only. Not enabled in v1.',
    });
    await app.close();
  });

  it('lets catalog decide catalog_publish and finance decide refund without mutating a cart or enabling refunds', async () => {
    const { cart } = buildCanonicalKit();
    const originalLines = cart.lines.map((line) => ({ ...line }));
    const catalogApproval = openTypedApproval({
      kind: 'catalog_publish',
      tenantId: 'northstar-demo-in',
      resourceId: 'product-1',
      resourceVersion: 1,
      amountMinor: 0n,
      reason: 'CATALOG_PUBLISH_APPROVAL_REQUIRED',
      requestedBy: TEST_USERS.buyer,
    });
    const refundApproval = openTypedApproval({
      kind: 'refund',
      tenantId: 'northstar-demo-in',
      resourceId: 'order-1',
      resourceVersion: 1,
      amountMinor: 99900n,
      reason: 'REFUND_APPROVAL_REQUIRED',
      requestedBy: TEST_USERS.buyer,
    });
    const { app } = await registerApp();
    const catalog = await app.inject({
      method: 'POST',
      url: `/api/v1/register/northstar-demo-in/approvals/${catalogApproval.id}`,
      headers: authHeaders('northstar-catalog'),
      payload: { decision: 'approved', kind: 'catalog_publish' },
    });
    const refund = await app.inject({
      method: 'POST',
      url: `/api/v1/register/northstar-demo-in/approvals/${refundApproval.id}`,
      headers: authHeaders('northstar-finance'),
      payload: { decision: 'approved', kind: 'refund' },
    });
    const register = await app.inject({
      method: 'GET',
      url: '/api/v1/register/northstar-demo-in',
      headers: authHeaders('northstar-owner'),
    });
    expect(catalog.statusCode, catalog.body).toBe(200);
    expect(catalog.json().approval.status).toBe('approved');
    expect(catalog.json().cart).toBeUndefined();
    expect(refund.statusCode, refund.body).toBe(200);
    expect(refund.json().approval.status).toBe('approved');
    expect(refund.json().cart).toBeUndefined();
    expect(register.json().refunds.available).toBe(false);
    expect(cart.lines).toEqual(originalLines);
    await app.close();
  });

  it('enforces kind-specific capability, SoD, hash, and amount asserts on typed decide', async () => {
    const catalogApproval = openTypedApproval({
      kind: 'catalog_publish',
      tenantId: 'northstar-demo-in',
      resourceId: 'product-1',
      resourceVersion: 1,
      amountMinor: 0n,
      reason: 'CATALOG_PUBLISH_APPROVAL_REQUIRED',
      requestedBy: TEST_USERS.northstarCatalog,
    });
    const refundApproval = openTypedApproval({
      kind: 'refund',
      tenantId: 'northstar-demo-in',
      resourceId: 'order-1',
      resourceVersion: 1,
      amountMinor: 99900n,
      reason: 'REFUND_APPROVAL_REQUIRED',
      requestedBy: TEST_USERS.buyer,
    });
    const campaignApproval = openTypedApproval({
      kind: 'campaign',
      tenantId: 'northstar-demo-in',
      resourceId: 'offer-1',
      resourceVersion: 1,
      amountMinor: 50000n,
      reason: 'CAMPAIGN_APPROVAL_REQUIRED',
      requestedBy: TEST_USERS.buyer,
    });
    const { app } = await registerApp();
    const financeOnCatalog = await app.inject({
      method: 'POST',
      url: `/api/v1/register/northstar-demo-in/approvals/${catalogApproval.id}`,
      headers: authHeaders('northstar-finance'),
      payload: { decision: 'approved', kind: 'catalog_publish' },
    });
    const catalogSelf = await app.inject({
      method: 'POST',
      url: `/api/v1/register/northstar-demo-in/approvals/${catalogApproval.id}`,
      headers: authHeaders('northstar-catalog'),
      payload: { decision: 'approved', kind: 'catalog_publish' },
    });
    refundApproval.resourceId = 'order-changed';
    const staleRefund = await app.inject({
      method: 'POST',
      url: `/api/v1/register/northstar-demo-in/approvals/${refundApproval.id}`,
      headers: authHeaders('northstar-finance'),
      payload: { decision: 'approved', kind: 'refund' },
    });
    campaignApproval.proposedTotalMinor = 60000n;
    const driftedCampaign = await app.inject({
      method: 'POST',
      url: `/api/v1/register/northstar-demo-in/approvals/${campaignApproval.id}`,
      headers: authHeaders('northstar-owner'),
      payload: { decision: 'approved', kind: 'campaign' },
    });
    const kindMismatch = await app.inject({
      method: 'POST',
      url: `/api/v1/register/northstar-demo-in/approvals/${catalogApproval.id}`,
      headers: authHeaders('northstar-owner'),
      payload: { decision: 'approved', kind: 'refund' },
    });
    const cartShaped = await app.inject({
      method: 'POST',
      url: `/api/v1/register/approvals/${catalogApproval.id}`,
      headers: authHeaders('northstar-owner'),
      payload: { decision: 'approved', tenantId: 'northstar-demo-in' },
    });
    expect(financeOnCatalog.statusCode).toBe(403);
    expect(catalogSelf.statusCode).toBe(403);
    expect(catalogSelf.json().error).toBe('APPROVAL_SELF_DECISION');
    expect(staleRefund.statusCode).toBe(409);
    expect(staleRefund.json().error).toBe('APPROVAL_STALE');
    expect(driftedCampaign.statusCode).toBe(409);
    expect(driftedCampaign.json().error).toBe('APPROVAL_AMOUNT_CHANGED');
    expect(kindMismatch.statusCode).toBe(409);
    expect(kindMismatch.json().error).toBe('APPROVAL_KIND_MISMATCH');
    expect(cartShaped.statusCode).toBe(409);
    expect(cartShaped.json().error).toBe('APPROVAL_KIND_MISMATCH');
    await app.close();
  });

  it('lets owner decide campaign and rejects catalog from campaign decide', async () => {
    const approval = openTypedApproval({
      kind: 'campaign',
      tenantId: 'northstar-demo-in',
      resourceId: 'offer-1',
      resourceVersion: 1,
      amountMinor: 50000n,
      reason: 'CAMPAIGN_APPROVAL_REQUIRED',
      requestedBy: TEST_USERS.buyer,
    });
    const { app } = await registerApp();
    const catalog = await app.inject({
      method: 'POST',
      url: `/api/v1/register/northstar-demo-in/approvals/${approval.id}`,
      headers: authHeaders('northstar-catalog'),
      payload: { decision: 'approved', kind: 'campaign' },
    });
    const owner = await app.inject({
      method: 'POST',
      url: `/api/v1/register/northstar-demo-in/approvals/${approval.id}`,
      headers: authHeaders('northstar-owner'),
      payload: { decision: 'approved', kind: 'campaign' },
    });
    expect(catalog.statusCode).toBe(403);
    expect(owner.statusCode, owner.body).toBe(200);
    expect(owner.json().approval.status).toBe('approved');
    await app.close();
  });
});
