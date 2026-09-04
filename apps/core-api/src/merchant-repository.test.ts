import { describe, expect, it } from 'vitest';
import { addLine, createCart, freezeQuote, resetKernel } from '@charter/commerce';
import { getMerchant, resetMerchantSeeds } from '@charter/catalog';
import { createMemoryTenantRepository } from './testing/memory-tenant-repository.js';

const OWNER = 'a1000000-0000-4000-8000-000000000001';
const CATALOG = 'a1000000-0000-4000-8000-000000000002';
const VIEWER = 'a1000000-0000-4000-8000-000000000003';
const TENANT_ID = 'northstar-demo-in';

function repository() {
  return createMemoryTenantRepository({
    memberships: [
      { userId: OWNER, tenantId: TENANT_ID, role: 'owner' },
      { userId: CATALOG, tenantId: TENANT_ID, role: 'catalog' },
      { userId: VIEWER, tenantId: TENANT_ID, role: 'viewer' },
    ],
  });
}

describe('memory merchant repository', () => {
  it('replays first-shop creation by owner idempotency key', async () => {
    const store = createMemoryTenantRepository();
    const identity = {
      userId: 'a1000000-0000-4000-8000-000000000099',
      email: 'first-shop@example.invalid',
    };
    const provision = store.provisionShop as unknown as (
      currentIdentity: typeof identity,
      input: { name: string; blurb: string },
      command: { idempotencyKey: string; requestHash: string },
    ) => ReturnType<typeof store.provisionShop>;
    const create = (
      currentIdentity: typeof identity,
      input: { name: string; blurb: string },
      command: { idempotencyKey: string; requestHash: string },
    ) => provision.call(store, currentIdentity, input, command);

    const first = await create(
      identity,
      { name: 'First Record Shop', blurb: 'Operationally calm goods.' },
      { idempotencyKey: 'first-shop-create-001', requestHash: 'a'.repeat(64) },
    );
    const replay = await create(
      identity,
      { name: 'First Record Shop', blurb: 'Operationally calm goods.' },
      { idempotencyKey: 'first-shop-create-001', requestHash: 'a'.repeat(64) },
    );

    expect(replay.tenantId).toBe(first.tenantId);
    expect(await store.listMemberShops(identity.userId)).toHaveLength(1);
  });

  it('persists exact catalog facts, validates publish, and audits versioned stock changes', async () => {
    const store = repository();
    const command = {
      userId: CATALOG,
      tenantId: TENANT_ID,
      title: 'Trail brewer',
      description: '',
      category: '',
      sku: 'brewer.trail',
      material: 'steel' as const,
      priceMinor: '0',
      stock: 0,
      status: 'draft' as const,
      idempotencyKey: 'create-trail-brewer',
      requestHash: 'create-hash',
    };

    const created = await store.createMerchantProduct(command);
    const replay = await store.createMerchantProduct(command);

    expect(created).toMatchObject({
      title: 'Trail brewer',
      priceMinor: '0',
      status: 'draft',
      inventory: { onHand: 0, version: 1 },
    });
    expect(replay.productId).toBe(created.productId);
    expect(
      (
        await store.listMerchantCatalog({
          userId: VIEWER,
          tenantId: TENANT_ID,
          limit: 100,
          after: null,
        })
      ).items.filter((item) => item.sku === 'brewer.trail'),
    ).toHaveLength(1);
    await expect(
      store.createMerchantProduct({ ...command, requestHash: 'different-hash' }),
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    await expect(
      store.updateMerchantProduct({
        userId: CATALOG,
        tenantId: TENANT_ID,
        productId: created.productId,
        expectedVersion: 1,
        title: 'Trail brewer',
        description: '',
        category: '',
        sku: 'brewer.trail',
        material: 'steel',
        priceMinor: '0',
        status: 'published',
        reason: 'Attempt an incomplete publish.',
        idempotencyKey: 'publish-invalid',
        requestHash: 'publish-invalid-hash',
      }),
    ).rejects.toThrow('CATALOG_PUBLISH_INVALID');

    const inventory = await store.adjustMerchantStock({
      userId: CATALOG,
      tenantId: TENANT_ID,
      variantId: created.variantId,
      expectedVersion: 1,
      delta: 5,
      reason: 'Opening stock count.',
      idempotencyKey: 'trail-stock-001',
      requestHash: 'trail-stock-hash',
    });
    expect(inventory).toMatchObject({ onHand: 5, available: 5, version: 2 });
    expect(store.state.inventoryAdjustments).toContainEqual(
      expect.objectContaining({
        actorId: CATALOG,
        variantId: created.variantId,
        reason: 'Opening stock count.',
        before: 0,
        after: 5,
        versionBefore: 1,
        versionAfter: 2,
      }),
    );

    const published = await store.updateMerchantProduct({
      userId: CATALOG,
      tenantId: TENANT_ID,
      productId: created.productId,
      expectedVersion: 1,
      title: 'Trail brewer',
      description: 'Compact steel brewer for a travel kit.',
      category: 'Travel coffee',
      sku: 'brewer.trail',
      material: 'steel',
      priceMinor: '129900',
      status: 'published',
      reason: 'Required catalog facts are complete.',
      idempotencyKey: 'publish-trail-001',
      requestHash: 'publish-trail-hash',
    });
    expect(published).toMatchObject({
      productVersion: 2,
      priceMinor: '129900',
      priceDisplay: '₹1,299.00',
      status: 'published',
    });
    await expect(
      store.updateMerchantProduct({
        userId: CATALOG,
        tenantId: TENANT_ID,
        productId: created.productId,
        expectedVersion: 1,
        title: 'Stale title',
        description: published.description,
        category: published.category!.title,
        sku: published.sku,
        material: published.material,
        priceMinor: published.priceMinor,
        status: 'published',
        reason: 'Stale browser tab.',
        idempotencyKey: 'publish-trail-stale',
        requestHash: 'publish-trail-stale-hash',
      }),
    ).rejects.toThrow('CATALOG_VERSION_CONFLICT');
    await expect(store.createMerchantProduct({ ...command, userId: VIEWER })).rejects.toThrow(
      'SHOP_MEMBERSHIP_REQUIRED',
    );
  });

  it('uses captured ledger truth and explicit quote denominators for date-filtered metrics', async () => {
    const store = repository();
    store.state.merchantQuotes.set(TENANT_ID, [
      { id: 'q-1', status: 'FROZEN', createdAt: '2026-08-02T00:00:00.000Z' },
      { id: 'q-2', status: 'BOUND', createdAt: '2026-08-03T00:00:00.000Z' },
      { id: 'q-3', status: 'SETTLED', createdAt: '2026-08-04T00:00:00.000Z' },
      { id: 'q-old', status: 'SETTLED', createdAt: '2026-07-20T00:00:00.000Z' },
      { id: 'q-expired', status: 'EXPIRED', createdAt: '2026-08-06T00:00:00.000Z' },
      { id: 'q-superseded', status: 'SUPERSEDED', createdAt: '2026-08-07T00:00:00.000Z' },
      { id: 'q-unbound', status: 'FROZEN', createdAt: '2026-08-09T00:00:00.000Z' },
      {
        id: 'q-late',
        status: 'SETTLED',
        createdAt: '2026-08-08T00:00:00.000Z',
        totalMinor: '11000',
      },
    ]);
    store.state.merchantOrders.set(TENANT_ID, [
      {
        id: 'o-captured',
        quoteId: 'q-3',
        receipt: 'cht_captured',
        razorpayOrderId: 'order_captured',
        amountMinor: '234700',
        status: 'SETTLED',
        paymentId: 'pay_captured',
        providerStatus: 'captured',
        copy: 'Captured.',
        createdAt: '2026-08-04T00:00:00.000Z',
        updatedAt: '2026-08-04T00:02:00.000Z',
        capturedAt: '2026-08-04T00:02:00.000Z',
        recovered: true,
      },
      {
        id: 'o-failed',
        quoteId: 'q-2',
        receipt: 'cht_failed',
        razorpayOrderId: 'order_failed',
        amountMinor: '99900',
        status: 'FAILED_PROVISIONAL',
        paymentId: 'pay_failed',
        providerStatus: 'failed',
        copy: 'Unresolved.',
        createdAt: '2026-08-03T00:00:00.000Z',
        updatedAt: '2026-08-03T00:02:00.000Z',
        capturedAt: null,
        recovered: false,
      },
      {
        id: 'o-old',
        quoteId: 'q-old',
        receipt: 'cht_old',
        razorpayOrderId: 'order_old',
        amountMinor: '50000',
        status: 'SETTLED',
        paymentId: 'pay_old',
        providerStatus: 'captured',
        copy: 'Outside range.',
        createdAt: '2026-07-20T00:00:00.000Z',
        updatedAt: '2026-07-20T00:02:00.000Z',
        capturedAt: '2026-07-20T00:02:00.000Z',
        recovered: false,
      },
      {
        id: 'o-late-old-quote',
        quoteId: 'q-old',
        receipt: 'cht_late_old',
        razorpayOrderId: 'order_late_old',
        amountMinor: '88000',
        status: 'SETTLED',
        paymentId: 'pay_late_old',
        providerStatus: 'captured',
        copy: 'Capture in window for a quote created before the window.',
        createdAt: '2026-08-10T00:00:00.000Z',
        updatedAt: '2026-08-10T00:02:00.000Z',
        capturedAt: '2026-08-10T00:02:00.000Z',
        recovered: false,
      },
      {
        id: 'o-captured-dup',
        quoteId: 'q-3',
        receipt: 'cht_captured_dup',
        razorpayOrderId: 'order_captured_dup',
        amountMinor: '234700',
        status: 'SETTLED',
        paymentId: 'pay_captured_dup',
        providerStatus: 'captured',
        copy: 'Duplicate capture ledger row for the same quote.',
        createdAt: '2026-08-04T00:03:00.000Z',
        updatedAt: '2026-08-04T00:03:00.000Z',
        capturedAt: '2026-08-04T00:03:00.000Z',
        recovered: true,
      },
      {
        id: 'o-late-capture',
        quoteId: 'q-late',
        receipt: 'cht_late',
        razorpayOrderId: 'order_late',
        amountMinor: '11000',
        status: 'SETTLED',
        paymentId: 'pay_late',
        providerStatus: 'captured',
        copy: 'Quote in window, capture after window.',
        createdAt: '2026-08-08T00:00:00.000Z',
        updatedAt: '2026-09-02T00:00:00.000Z',
        capturedAt: '2026-09-02T00:00:00.000Z',
        recovered: false,
      },
    ]);

    const metrics = await store.getMerchantOverview({
      userId: VIEWER,
      tenantId: TENANT_ID,
      from: '2026-08-01',
      to: '2026-08-31',
    });

    expect(metrics).toMatchObject({
      capturedGmvMinor: '234700',
      capturedGmvDisplay: '₹2,347.00',
      capturedOrders: 1,
      validFrozenQuotes: 7,
      conversion: { numerator: 1, denominator: 7, rate: 1 / 7 },
      failedUnresolvedPays: 1,
      recoveredAmountMinor: '234700',
    });
    expect(metrics.attributionNote).toMatch(/quotes created in this window/i);
    expect(metrics.conversion.numerator).toBeLessThanOrEqual(metrics.conversion.denominator);
    expect(metrics.attributionNote).toMatch(/no incremental lift/i);
  });

  it('formats captured GMV with the same bigint-safe Indian grouping as formatInr', async () => {
    const store = repository();
    store.state.merchantQuotes.set(TENANT_ID, [
      {
        id: 'q-lakh',
        status: 'SETTLED',
        createdAt: '2026-08-10T00:00:00.000Z',
        totalMinor: '10000000',
      },
    ]);
    store.state.merchantOrders.set(TENANT_ID, [
      {
        id: 'o-lakh',
        quoteId: 'q-lakh',
        receipt: 'cht_lakh',
        razorpayOrderId: 'order_lakh',
        amountMinor: '10000000',
        status: 'SETTLED',
        paymentId: 'pay_lakh',
        providerStatus: 'captured',
        copy: 'Captured.',
        createdAt: '2026-08-10T00:00:00.000Z',
        updatedAt: '2026-08-10T00:02:00.000Z',
        capturedAt: '2026-08-10T00:02:00.000Z',
        recovered: false,
      },
    ]);
    const metrics = await store.getMerchantOverview({
      userId: VIEWER,
      tenantId: TENANT_ID,
      from: '2026-08-01',
      to: '2026-08-31',
    });
    expect(metrics.capturedGmvMinor).toBe('10000000');
    expect(metrics.capturedGmvDisplay).toBe('₹1,00,000.00');
  });

  it('excludes capture-then-refund from captured GMV and failedUnresolvedPays', async () => {
    const store = repository();
    store.state.merchantQuotes.set(TENANT_ID, [
      {
        id: 'q-refunded',
        status: 'BOUND',
        createdAt: '2026-08-10T00:00:00.000Z',
        totalMinor: '234700',
      },
      {
        id: 'q-refunded-snapshot',
        status: 'BOUND',
        createdAt: '2026-08-11T00:00:00.000Z',
        totalMinor: '99900',
      },
    ]);
    store.state.merchantOrders.set(TENANT_ID, [
      {
        id: 'o-refunded',
        quoteId: 'q-refunded',
        receipt: 'cht_refunded',
        razorpayOrderId: 'order_refunded',
        amountMinor: '234700',
        status: 'RECONCILING',
        paymentId: 'pay_refunded',
        providerStatus: 'refunded',
        copy: 'Capture then refund.',
        createdAt: '2026-08-10T00:00:00.000Z',
        updatedAt: '2026-08-10T00:04:00.000Z',
        capturedAt: '2026-08-10T00:02:00.000Z',
        recovered: false,
      },
      {
        id: 'o-refunded-snapshot',
        quoteId: 'q-refunded-snapshot',
        receipt: 'cht_refunded_snapshot',
        razorpayOrderId: 'order_refunded_snapshot',
        amountMinor: '99900',
        status: 'RECONCILING',
        paymentId: 'pay_refunded_snapshot',
        providerStatus: 'failed',
        copy: 'Refunded by reconciliation snapshot.',
        createdAt: '2026-08-11T00:00:00.000Z',
        updatedAt: '2026-08-11T00:04:00.000Z',
        capturedAt: null,
        recovered: false,
        reconciliationOutcome: 'refunded',
      },
    ]);

    const metrics = await store.getMerchantOverview({
      userId: VIEWER,
      tenantId: TENANT_ID,
      from: '2026-08-01',
      to: '2026-08-31',
    });

    expect(metrics).toMatchObject({
      capturedGmvMinor: '0',
      capturedOrders: 0,
      failedUnresolvedPays: 0,
    });
  });

  it('marks only captured orders paid and builds a safe durable timeline', async () => {
    const store = repository();
    store.state.merchantQuotes.set(TENANT_ID, [
      { id: 'q-settled', status: 'SETTLED', createdAt: '2026-08-04T00:00:00.000Z' },
      { id: 'q-failed', status: 'BOUND', createdAt: '2026-08-05T00:00:00.000Z' },
    ]);
    store.state.merchantOrders.set(TENANT_ID, [
      {
        id: 'o-settled',
        quoteId: 'q-settled',
        receipt: 'cht_settled',
        razorpayOrderId: 'order_settled',
        amountMinor: '234700',
        status: 'SETTLED',
        paymentId: 'pay_settled',
        providerStatus: 'captured',
        copy: 'Captured.',
        createdAt: '2026-08-04T00:00:00.000Z',
        updatedAt: '2026-08-04T00:02:00.000Z',
        capturedAt: '2026-08-04T00:02:00.000Z',
        recovered: false,
      },
      {
        id: 'o-failed',
        quoteId: 'q-failed',
        receipt: 'cht_failed',
        razorpayOrderId: 'order_failed',
        amountMinor: '234700',
        status: 'FAILED_PROVISIONAL',
        paymentId: 'pay_failed',
        providerStatus: 'failed',
        copy: 'Provisional failure.',
        createdAt: '2026-08-05T00:00:00.000Z',
        updatedAt: '2026-08-05T00:02:00.000Z',
        capturedAt: null,
        recovered: false,
      },
    ]);

    const captured = await store.getMerchantOrder({
      userId: OWNER,
      tenantId: TENANT_ID,
      orderId: 'o-settled',
    });
    const failed = await store.getMerchantOrder({
      userId: OWNER,
      tenantId: TENANT_ID,
      orderId: 'o-failed',
    });

    expect(captured).toMatchObject({ paid: true, fulfillmentReady: true });
    expect(captured?.timeline.map((event) => event.status)).toContain('captured');
    expect(failed).toMatchObject({ paid: false, fulfillmentReady: false });
    expect(failed?.timeline.map((event) => event.status)).toContain('failed_provisional');
    expect(JSON.stringify(captured)).not.toMatch(/secret|payload/i);
  });

  it('persists a Charter sandbox address and tracking id for captured orders', async () => {
    const store = repository();
    store.state.merchantQuotes.set(TENANT_ID, [
      { id: 'q-settled', status: 'SETTLED', createdAt: '2026-08-04T00:00:00.000Z' },
    ]);
    store.state.merchantOrders.set(TENANT_ID, [
      {
        id: 'o-settled',
        quoteId: 'q-settled',
        receipt: 'cht_settled',
        razorpayOrderId: 'order_settled',
        amountMinor: '234700',
        status: 'SETTLED',
        paymentId: 'pay_settled',
        providerStatus: 'captured',
        copy: 'Captured.',
        createdAt: '2026-08-04T00:00:00.000Z',
        updatedAt: '2026-08-04T00:02:00.000Z',
        capturedAt: '2026-08-04T00:02:00.000Z',
        recovered: false,
      },
    ]);

    const first = await store.getMerchantOrder({
      userId: OWNER,
      tenantId: TENANT_ID,
      orderId: 'o-settled',
    });
    const second = await store.getMerchantOrder({
      userId: OWNER,
      tenantId: TENANT_ID,
      orderId: 'o-settled',
    });
    const packed = await store.advanceMerchantFulfillment({
      userId: OWNER,
      tenantId: TENANT_ID,
      orderId: 'o-settled',
      status: 'packed',
    });

    expect(first?.trackingId).toMatch(/^CHR-TRK-[0-9A-F]{12}$/);
    expect(second?.trackingId).toBe(first?.trackingId);
    expect(first?.shippingAddress?.source).toBe('sandbox_mock');
    expect(first?.shippingAddress?.city).toBe('Bengaluru');
    expect(first?.fulfillmentStatus).toBe('confirmed');
    expect(first?.timeline.map((event) => event.status)).toContain('confirmed');
    expect(packed.fulfillmentStatus).toBe('packed');
    expect(packed.trackingId).toBe(first?.trackingId);
    expect(packed.timeline.map((event) => event.status)).toEqual(
      expect.arrayContaining(['confirmed', 'packed']),
    );
  });

  it('builds the merchant order timeline from provider transitions, not only the latest status', async () => {
    const store = repository();
    store.state.merchantQuotes.set(TENANT_ID, [
      { id: 'q-chain', status: 'SETTLED', createdAt: '2026-08-04T00:00:00.000Z' },
    ]);
    store.state.merchantOrders.set(TENANT_ID, [
      {
        id: 'o-chain',
        quoteId: 'q-chain',
        receipt: 'cht_chain',
        razorpayOrderId: 'order_chain',
        amountMinor: '234700',
        status: 'SETTLED',
        paymentId: 'pay_chain',
        providerStatus: 'captured',
        copy: 'Captured after authorization.',
        createdAt: '2026-08-04T00:00:00.000Z',
        updatedAt: '2026-08-04T00:06:00.000Z',
        capturedAt: '2026-08-04T00:06:00.000Z',
        recovered: false,
        transitions: [
          {
            id: 't-fail',
            at: '2026-08-04T00:01:00.000Z',
            status: 'failed_provisional',
            label: 'Payment not confirmed',
            detail: 'Provisional provider failure.',
          },
          {
            id: 't-auth',
            at: '2026-08-04T00:03:00.000Z',
            status: 'authorized',
            label: 'Awaiting capture',
            detail: 'Waiting for automatic capture. Not fulfilled.',
          },
          {
            id: 't-cap',
            at: '2026-08-04T00:06:00.000Z',
            status: 'captured',
            label: 'Payment captured',
            detail: 'Captured ledger evidence. Eligible for fulfillment.',
          },
        ],
      },
    ]);
    const detail = await store.getMerchantOrder({
      userId: OWNER,
      tenantId: TENANT_ID,
      orderId: 'o-chain',
    });
    expect(detail?.timeline.map((event) => event.status)).toEqual(
      expect.arrayContaining(['failed_provisional', 'authorized', 'captured']),
    );
    const indexes = ['failed_provisional', 'authorized', 'captured'].map((status) =>
      detail!.timeline.findIndex((event) => event.status === status),
    );
    expect(indexes[0]).toBeGreaterThanOrEqual(0);
    expect(indexes[1]).toBeGreaterThan(indexes[0]!);
    expect(indexes[2]).toBeGreaterThan(indexes[1]!);
  });

  it('audits the first draft and a later direct publish of a product', async () => {
    const store = repository();
    const draft = await store.createMerchantProduct({
      userId: CATALOG,
      tenantId: TENANT_ID,
      title: 'Road Press',
      description: 'Steel travel press.',
      category: 'Travel coffee',
      sku: 'brewer.road-press',
      material: 'steel',
      priceMinor: '249900',
      stock: 3,
      status: 'draft',
      idempotencyKey: 'catalog-create-draft',
      requestHash: 'catalog-create-draft-hash',
    });
    expect(store.state.catalogAudits).toContainEqual(
      expect.objectContaining({
        productId: draft.productId,
        actorId: CATALOG,
        reason: 'Initial draft product creation',
        versionBefore: 0,
        versionAfter: 1,
      }),
    );
    const published = await store.createMerchantProduct({
      userId: CATALOG,
      tenantId: TENANT_ID,
      title: 'Camp Kettle',
      description: 'Steel kettle for the road.',
      category: 'Travel coffee',
      sku: 'kettle.camp-steel',
      material: 'steel',
      priceMinor: '189900',
      stock: 2,
      status: 'published',
      idempotencyKey: 'catalog-create-published',
      requestHash: 'catalog-create-published-hash',
    });
    expect(store.state.catalogAudits).toContainEqual(
      expect.objectContaining({
        productId: published.productId,
        reason: 'Direct published product creation',
        versionBefore: 0,
        versionAfter: 1,
      }),
    );

    const later = await store.updateMerchantProduct({
      userId: CATALOG,
      tenantId: TENANT_ID,
      productId: draft.productId,
      expectedVersion: 1,
      title: draft.title,
      description: draft.description,
      category: 'Travel coffee',
      sku: draft.sku,
      material: 'steel',
      priceMinor: draft.priceMinor,
      status: 'published',
      reason: 'Later publish after required facts were complete.',
      idempotencyKey: 'catalog-later-publish',
      requestHash: 'catalog-later-publish-hash',
    });
    expect(store.state.catalogAudits).toContainEqual(
      expect.objectContaining({
        productId: draft.productId,
        reason: 'Later publish after required facts were complete.',
        versionBefore: 1,
        versionAfter: later.productVersion,
      }),
    );
    const auditsAfterPublish = store.state.catalogAudits.filter(
      (audit) => audit.productId === draft.productId,
    ).length;
    const replay = await store.updateMerchantProduct({
      userId: CATALOG,
      tenantId: TENANT_ID,
      productId: draft.productId,
      expectedVersion: 1,
      title: draft.title,
      description: draft.description,
      category: 'Travel coffee',
      sku: draft.sku,
      material: 'steel',
      priceMinor: draft.priceMinor,
      status: 'published',
      reason: 'Later publish after required facts were complete.',
      idempotencyKey: 'catalog-later-publish',
      requestHash: 'catalog-later-publish-hash',
    });
    expect(replay.productVersion).toBe(later.productVersion);
    expect(
      store.state.catalogAudits.filter((audit) => audit.productId === draft.productId),
    ).toHaveLength(auditsAfterPublish);
    const restarted = createMemoryTenantRepository({
      state: store.state,
      memberships: [
        { userId: OWNER, tenantId: TENANT_ID, role: 'owner' },
        { userId: CATALOG, tenantId: TENANT_ID, role: 'catalog' },
        { userId: VIEWER, tenantId: TENANT_ID, role: 'viewer' },
      ],
    });
    const replayAfterRestart = await restarted.updateMerchantProduct({
      userId: CATALOG,
      tenantId: TENANT_ID,
      productId: draft.productId,
      expectedVersion: 1,
      title: draft.title,
      description: draft.description,
      category: 'Travel coffee',
      sku: draft.sku,
      material: 'steel',
      priceMinor: draft.priceMinor,
      status: 'published',
      reason: 'Later publish after required facts were complete.',
      idempotencyKey: 'catalog-later-publish',
      requestHash: 'catalog-later-publish-hash',
    });
    expect(replayAfterRestart.productVersion).toBe(later.productVersion);
    expect(
      restarted.state.catalogAudits.filter((audit) => audit.productId === draft.productId),
    ).toHaveLength(auditsAfterPublish);
    const updated = await store.updateMerchantProduct({
      userId: CATALOG,
      tenantId: TENANT_ID,
      productId: later.productId,
      expectedVersion: later.productVersion,
      title: 'Road Press Steel',
      description: later.description,
      category: 'Travel coffee',
      sku: later.sku,
      material: 'steel',
      priceMinor: later.priceMinor,
      status: 'published',
      reason: 'Clarify the published title after facts stayed the same.',
      idempotencyKey: 'catalog-later-update',
      requestHash: 'catalog-later-update-hash',
    });
    expect(store.state.catalogAudits).toContainEqual(
      expect.objectContaining({
        productId: later.productId,
        reason: 'Clarify the published title after facts stayed the same.',
        versionBefore: later.productVersion,
        versionAfter: updated.productVersion,
      }),
    );
  });

  it('exposes recovery consent, capture, kill, and suppression gates without sending', async () => {
    const store = repository();
    const checkoutId = 'b1000000-0000-4000-8000-000000000001';
    const consentId = 'b2000000-0000-4000-8000-000000000001';
    store.state.merchantOrders.set(TENANT_ID, [
      {
        id: checkoutId,
        quoteId: 'q-recovery',
        receipt: 'cht_recovery',
        razorpayOrderId: 'order_recovery',
        amountMinor: '99900',
        status: 'FAILED_PROVISIONAL',
        paymentId: 'pay_recovery',
        providerStatus: 'failed',
        copy: 'Unresolved.',
        createdAt: '2026-08-05T00:00:00.000Z',
        updatedAt: '2026-08-05T00:02:00.000Z',
        capturedAt: null,
        recovered: false,
        reconciliationOutcome: 'same_order_retry_safe',
        reconciliationReconciledAt: '2026-08-05T00:04:00.000Z',
        reconciliationCorrelationId: 'corr-recovery-1',
      },
    ]);
    await store.saveRecoveryConsent({
      id: consentId,
      tenantId: TENANT_ID,
      userId: OWNER,
      email: 'buyer@example.invalid',
      purpose: 'payment_recovery',
      channel: 'email',
      grantedAt: '2026-08-05T00:00:00.000Z',
    });
    await store.bindRecoveryConsent({
      tenantId: TENANT_ID,
      checkoutId,
      consentId,
      userId: OWNER,
    });

    const sendable = await store.getMerchantRecovery({
      userId: OWNER,
      tenantId: TENANT_ID,
      checkoutId,
    });
    expect(sendable).toMatchObject({
      consentStatus: 'granted',
      canSend: true,
      blockedReason: null,
    });

    const staleReserve = await store.reserveRecoveryAttempt({
      tenantId: TENANT_ID,
      checkoutId,
      purpose: 'payment_recovery',
      channel: 'email',
      maxAttempts: 2,
      evidence: {
        reconciledAt: '2026-08-01T00:00:00.000Z',
        quoteId: 'q-recovery',
        orderId: 'order_recovery',
        orderStatus: 'attempted',
        outcome: 'same_order_retry_safe',
        paymentAttempts: [{ paymentId: 'pay_recovery', status: 'failed' }],
      },
    });
    expect(staleReserve).toEqual({ action: 'suppressed', reason: 'RECONCILIATION_REQUIRED' });
    const reserved = await store.reserveRecoveryAttempt({
      tenantId: TENANT_ID,
      checkoutId,
      purpose: 'payment_recovery',
      channel: 'email',
      maxAttempts: 2,
      evidence: {
        reconciledAt: '2026-08-05T00:04:00.000Z',
        quoteId: 'q-recovery',
        orderId: 'order_recovery',
        orderStatus: 'attempted',
        outcome: 'same_order_retry_safe',
        paymentAttempts: [{ paymentId: 'pay_recovery', status: 'failed' }],
      },
    });
    expect(reserved.action).toBe('reserved');
    expect(store.state.recoveryAttempts.at(-1)).toMatchObject({
      checkoutId,
      status: 'pending',
      reconciliationOutcome: 'same_order_retry_safe',
      reconciledAt: '2026-08-05T00:04:00.000Z',
    });
    store.state.recoveryAttempts.length = 0;

    for (const attemptNumber of [1, 2]) {
      store.state.recoveryAttempts.push({
        id: `attempt-${attemptNumber}`,
        tenantId: TENANT_ID,
        checkoutId,
        consentId,
        userId: OWNER,
        purpose: 'payment_recovery',
        channel: 'email',
        attemptNumber,
        status: 'failed',
        providerMessageId: null,
        failureCode: 'PROVIDER_UNAVAILABLE',
        completedAt: `2026-08-05T00:0${attemptNumber}:00.000Z`,
      });
    }
    const limited = await store.getMerchantRecovery({
      userId: OWNER,
      tenantId: TENANT_ID,
      checkoutId,
    });
    expect(limited).toMatchObject({
      canSend: false,
      blockedReason: 'RETRY_LIMIT_REACHED',
    });
    store.state.recoveryAttempts.length = 0;

    store.state.recoverySuppressions.add(`${TENANT_ID}:buyer@example.invalid`);
    const suppressed = await store.getMerchantRecovery({
      userId: OWNER,
      tenantId: TENANT_ID,
      checkoutId,
    });
    expect(suppressed).toMatchObject({
      canSend: false,
      blockedReason: 'SUPPRESSED',
      stopStatus: 'suppressed',
    });
    store.state.recoverySuppressions.clear();
    await store.setKillSwitch({ scope: 'tenant', tenantId: TENANT_ID, on: true, changedBy: OWNER });
    const killed = await store.getMerchantRecovery({
      userId: OWNER,
      tenantId: TENANT_ID,
      checkoutId,
    });
    expect(killed).toMatchObject({ canSend: false, blockedReason: 'CHECKOUT_KILLED' });
    await store.setKillSwitch({
      scope: 'tenant',
      tenantId: TENANT_ID,
      on: false,
      changedBy: OWNER,
    });
    store.state.merchantOrders.get(TENANT_ID)![0]!.status = 'SETTLED';
    const captured = await store.getMerchantRecovery({
      userId: OWNER,
      tenantId: TENANT_ID,
      checkoutId,
    });
    expect(captured).toMatchObject({ canSend: false, blockedReason: 'PAYMENT_CAPTURED' });
    store.state.merchantOrders.get(TENANT_ID)![0] = {
      ...store.state.merchantOrders.get(TENANT_ID)![0]!,
      status: 'RECONCILING',
      providerStatus: 'refunded',
      capturedAt: '2026-08-05T00:03:00.000Z',
      reconciliationOutcome: 'refunded',
    };
    const refunded = await store.getMerchantRecovery({
      userId: OWNER,
      tenantId: TENANT_ID,
      checkoutId,
    });
    expect(refunded).toMatchObject({
      canSend: false,
      blockedReason: 'PAYMENT_REFUNDED',
    });
    expect(refunded?.reconciliationStatus).not.toBe('captured');
    expect(refunded?.stopStatus).not.toBe('captured');
  });

  it('versions and audits rules and settings while keeping the slug immutable', async () => {
    const store = repository();
    const rules = await store.getMerchantRules({ userId: VIEWER, tenantId: TENANT_ID });
    const updatedRules = await store.updateMerchantRules({
      userId: OWNER,
      tenantId: TENANT_ID,
      expectedVersion: rules!.version,
      hardCapMinor: '300000',
      autonomousCapMinor: '250000',
      forbiddenMaterials: ['glass'],
      offers: [
        {
          id: 'filters',
          discountMinor: '10000',
          requiredSkuGroups: [['brewer.steel-press-500'], ['grinder.pocket-lite']],
          stackable: false,
          marginFloorMinor: '200000',
          budgetRemainingMinor: '50000',
          maxRedemptions: 3,
          redemptions: 1,
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      ],
      reason: 'Publish bounded current offers.',
      idempotencyKey: 'rules-001',
      requestHash: 'rules-hash',
    });
    expect(updatedRules.version).toBe(rules!.version + 1);
    expect(updatedRules.offers).toEqual([
      expect.objectContaining({
        id: 'filters',
        discountMinor: '10000',
        stackable: false,
        marginFloorMinor: '200000',
        budgetRemainingMinor: '50000',
        maxRedemptions: 3,
        redemptions: 1,
        expiresAt: '2099-01-01T00:00:00.000Z',
      }),
    ]);
    const reloaded = await store.getMerchantRules({ userId: VIEWER, tenantId: TENANT_ID });
    expect(reloaded?.offers).toEqual(updatedRules.offers);
    expect(store.state.policyAudits).toContainEqual(
      expect.objectContaining({ actorId: OWNER, reason: 'Publish bounded current offers.' }),
    );
    await expect(
      store.updateMerchantRules({
        userId: OWNER,
        tenantId: TENANT_ID,
        expectedVersion: rules!.version,
        hardCapMinor: '300000',
        autonomousCapMinor: '250000',
        forbiddenMaterials: ['glass'],
        offers: [],
        reason: 'Stale update.',
        idempotencyKey: 'rules-stale',
        requestHash: 'rules-stale-hash',
      }),
    ).rejects.toThrow('RULES_VERSION_CONFLICT');
    const preview = await store.previewMerchantRules({ userId: VIEWER, tenantId: TENANT_ID });
    expect(preview.items).toContainEqual(
      expect.objectContaining({
        sku: 'brewer.clear-glass-500',
        outcome: 'deny',
        reason: 'PRODUCT_MATERIAL_FORBIDDEN',
      }),
    );

    const settings = await store.getMerchantSettings({
      userId: VIEWER,
      tenantId: TENANT_ID,
      testMode: true,
    });
    const changed = await store.updateMerchantSettings({
      userId: OWNER,
      tenantId: TENANT_ID,
      expectedVersion: settings!.version,
      name: 'Northstar Field Coffee',
      blurb: 'Travel coffee with bounded offers.',
      reason: 'Clarify the merchant record.',
      testMode: true,
      idempotencyKey: 'settings-001',
      requestHash: 'settings-hash',
    });
    expect(changed).toMatchObject({
      version: settings!.version + 1,
      slug: settings!.slug,
      name: 'Northstar Field Coffee',
      synthetic: true,
    });
    expect(store.state.shops.get(TENANT_ID)?.label).toBe('Northstar Field Coffee (synthetic)');
    expect(store.state.shops.get(TENANT_ID)?.synthetic).toBe(true);
    const directory = await store.listPublicShops();
    expect(directory.find((shop) => shop.tenantId === TENANT_ID)).toMatchObject({
      name: 'Northstar Field Coffee',
      synthetic: true,
    });
    expect(await store.findShopBySlug(changed.slug)).toMatchObject({
      name: 'Northstar Field Coffee',
      label: 'Northstar Field Coffee (synthetic)',
      synthetic: true,
    });
    expect(getMerchant(TENANT_ID)?.synthetic).toBe(true);
    expect(getMerchant(TENANT_ID)?.label).toBe('Northstar Field Coffee (synthetic)');
    resetKernel();
    const quoteCart = createCart(TENANT_ID);
    addLine(quoteCart.id, 'brewer.trailpress-steel-750');
    addLine(quoteCart.id, 'grinder.pocket-lite');
    addLine(quoteCart.id, 'filters.travel-30');
    expect(freezeQuote(quoteCart.id).merchant).toBe('Northstar Field Coffee (synthetic)');
    const overview = await store.getMerchantOverview({
      userId: VIEWER,
      tenantId: TENANT_ID,
      from: '2026-08-01',
      to: '2026-08-31',
    });
    expect(overview.synthetic).toBe(true);
    const receiptOrderId = 'a2000000-0000-4000-8000-000000000088';
    store.state.merchantQuotes.set(TENANT_ID, [
      {
        id: 'q-rename-receipt',
        status: 'SETTLED',
        createdAt: '2026-08-23T10:00:00.000Z',
        totalMinor: '234700',
      },
    ]);
    store.state.merchantOrders.set(TENANT_ID, [
      {
        id: receiptOrderId,
        quoteId: 'q-rename-receipt',
        receipt: 'cht_rename_receipt',
        razorpayOrderId: 'order_rename_receipt',
        amountMinor: '234700',
        status: 'SETTLED',
        paymentId: 'pay_rename_receipt',
        providerStatus: 'captured',
        copy: 'Captured.',
        createdAt: '2026-08-23T10:00:00.000Z',
        updatedAt: '2026-08-23T10:02:00.000Z',
        capturedAt: '2026-08-23T10:02:00.000Z',
        recovered: false,
      },
    ]);
    await store.claimResource('checkout', TENANT_ID, receiptOrderId, VIEWER);
    const receipt = await store.getBuyerOrder({ userId: VIEWER, orderId: receiptOrderId });
    expect(receipt?.shop).toMatchObject({
      tenantId: TENANT_ID,
      name: 'Northstar Field Coffee',
      synthetic: true,
    });
    resetMerchantSeeds();
    expect(changed.members).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: 'owner', label: 'owner' })]),
    );
    const viewerSettings = await store.getMerchantSettings({
      userId: VIEWER,
      tenantId: TENANT_ID,
      testMode: true,
    });
    expect(viewerSettings?.members).toEqual([]);
    expect(store.state.shopAudits).toContainEqual(
      expect.objectContaining({ actorId: OWNER, reason: 'Clarify the merchant record.' }),
    );
  });

  it('records discovery impressions for merchant overview plots', async () => {
    const store = repository();
    await store.recordDiscovery({
      requestId: 'req-directory-1',
      query: 'gift coffee',
      surface: 'shops.search',
      agentSource: 'directory_http',
      hits: [
        { tenantId: TENANT_ID, shopSlug: 'northstar', rank: 1 },
        { tenantId: 'harbor-spice-in', shopSlug: 'harbor-spice', rank: 2 },
      ],
    });
    await store.recordDiscovery({
      requestId: 'req-catalog-1',
      query: 'grinder',
      surface: 'catalog.search',
      agentSource: 'concierge_web',
      hits: [
        { tenantId: TENANT_ID, shopSlug: 'northstar', sku: 'grinder.pocket-lite', rank: 1 },
        { tenantId: TENANT_ID, shopSlug: 'northstar', sku: 'grinder.pocket-pro', rank: 2 },
      ],
    });
    const overview = await store.getMerchantOverview({
      userId: VIEWER,
      tenantId: TENANT_ID,
      from: new Date().toISOString().slice(0, 10),
      to: new Date().toISOString().slice(0, 10),
    });
    expect(overview.searches).toBe(2);
    expect(overview.recommendationsBySku).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sku: 'grinder.pocket-lite', count: 1 }),
        expect.objectContaining({ sku: 'grinder.pocket-pro', count: 1 }),
      ]),
    );
    expect(overview.recommendationsBySource).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'directory_http', count: 1 }),
        expect.objectContaining({ source: 'concierge_web', count: 2 }),
      ]),
    );
    const settings = await store.getMerchantSettings({
      userId: OWNER,
      tenantId: TENANT_ID,
      testMode: true,
    });
    expect(settings).toMatchObject({
      gstin: '29AAAAA0000A1Z5',
      profileVerified: false,
    });
    expect(settings?.refundPolicy).toMatch(/7 days of capture/i);
    await expect(
      store.updateMerchantSettings({
        userId: OWNER,
        tenantId: TENANT_ID,
        expectedVersion: settings!.version,
        name: settings!.name,
        blurb: settings!.blurb,
        gstin: 'NOT-A-GSTIN',
        reason: 'Reject invalid mock GSTIN.',
        testMode: true,
        idempotencyKey: 'settings-bad-gstin',
        requestHash: 'settings-bad-gstin-hash',
      }),
    ).rejects.toThrow('SETTINGS_INVALID');
  });

  it('lists buyer receipts by cart ownership and matches merchant timeline labels', async () => {
    const store = repository();
    const buyer = 'a1000000-0000-4000-8000-000000000044';
    const other = 'a1000000-0000-4000-8000-000000000045';
    const orderId = 'a2000000-0000-4000-8000-000000000001';
    store.state.merchantQuotes.set(TENANT_ID, [
      {
        id: 'q-buyer',
        status: 'BOUND',
        createdAt: '2026-08-23T10:00:00.000Z',
        subtotalMinor: '234700',
        discountMinor: '0',
        totalMinor: '234700',
        lines: [
          {
            sku: 'grinder.pocket-lite',
            title: 'PocketGrind Lite',
            quantity: 1,
            unitMinor: '99900',
            lineMinor: '99900',
          },
        ],
      },
    ]);
    store.state.merchantOrders.set(TENANT_ID, [
      {
        id: orderId,
        quoteId: 'q-buyer',
        receipt: 'cht_buyer_receipt',
        razorpayOrderId: 'order_buyer_same',
        amountMinor: '234700',
        status: 'SETTLED',
        paymentId: 'pay_buyer',
        providerStatus: 'captured',
        copy: 'Captured.',
        createdAt: '2026-08-23T10:00:00.000Z',
        updatedAt: '2026-08-23T10:02:00.000Z',
        capturedAt: '2026-08-23T10:02:00.000Z',
        recovered: false,
      },
    ]);
    await store.claimResource('checkout', TENANT_ID, orderId, buyer);

    const listed = await store.listBuyerOrders({ userId: buyer, limit: 25, after: null });
    const hidden = await store.listBuyerOrders({ userId: other, limit: 25, after: null });
    const buyerDetail = await store.getBuyerOrder({ userId: buyer, orderId });
    const stranger = await store.getBuyerOrder({ userId: other, orderId });
    const merchantDetail = await store.getMerchantOrder({
      userId: OWNER,
      tenantId: TENANT_ID,
      orderId,
    });

    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      id: orderId,
      receipt: 'cht_buyer_receipt',
      razorpayOrderId: 'order_buyer_same',
      paymentTruth: merchantDetail?.paymentTruth,
      shop: expect.objectContaining({ tenantId: TENANT_ID, slug: 'northstar' }),
    });
    expect(hidden.items).toEqual([]);
    expect(stranger).toBeUndefined();
    expect(buyerDetail?.paymentTruth).toBe(merchantDetail?.paymentTruth);
    expect(buyerDetail?.totalMinor).toBe(merchantDetail?.totalMinor);
    expect(buyerDetail?.razorpayOrderId).toBe(merchantDetail?.razorpayOrderId);
    expect(buyerDetail?.quote.lines).toEqual(merchantDetail?.quote.lines);
    expect(buyerDetail?.timeline.map((event) => event.label)).toEqual(
      merchantDetail?.timeline.map((event) => event.label),
    );
  });
});
