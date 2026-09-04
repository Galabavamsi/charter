import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@charter/config';
import { createDb, sql, type Database, type Kysely } from '@charter/db';
import { createPostgresTenantRepository } from './tenant/postgres-repository.js';

loadConfig();
if (!process.env.TEST_DATABASE_URL && process.env.DATABASE_URL) {
  process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
}
const ownerUrl = process.env.TEST_DATABASE_URL ?? '';
const rolePassword = process.env.CHARTER_APP_PASSWORD ?? '';
if (process.env.CI_REQUIRE_TEST_DATABASE_URL === 'true' && !ownerUrl) {
  throw new Error('TEST_DATABASE_URL_REQUIRED_IN_CI');
}
if (process.env.CI_REQUIRE_TEST_DATABASE_URL === 'true' && !rolePassword) {
  throw new Error('CHARTER_APP_PASSWORD_REQUIRED_IN_CI');
}

function applicationRoleUrl(url: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = 'charter_app';
  parsed.password = password;
  return parsed.toString();
}

const appUrl = ownerUrl && rolePassword ? applicationRoleUrl(ownerUrl, rolePassword) : '';
const describeWithPostgres = appUrl ? describe.sequential : describe.skip;

describeWithPostgres('charter_app merchant repository', () => {
  let ownerDb: Kysely<Database>;
  let appDb: Kysely<Database>;
  const tenantIds: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    ownerDb = createDb(ownerUrl);
    appDb = createDb(appUrl);
    const role = await sql<{ role: string }>`select current_user as role`.execute(appDb);
    expect(role.rows).toEqual([{ role: 'charter_app' }]);
  });

  afterAll(async () => {
    for (const tenantId of tenantIds) {
      await sql`delete from payments.reconciliation_snapshots where tenant_id = ${tenantId}`.execute(
        ownerDb,
      );
      await sql`delete from payments.payment_transitions where tenant_id = ${tenantId}`.execute(
        ownerDb,
      );
      await sql`delete from recovery.attempts where tenant_id = ${tenantId}`.execute(ownerDb);
      await sql`delete from recovery.checkout_consents where tenant_id = ${tenantId}`.execute(
        ownerDb,
      );
      await sql`delete from recovery.consents where tenant_id = ${tenantId}`.execute(ownerDb);
      await sql`delete from recovery.suppressions where tenant_id = ${tenantId}`.execute(ownerDb);
      await sql`delete from ledger.ledger_entries where tenant_id = ${tenantId}`.execute(ownerDb);
      await sql`delete from payments.checkout_sessions where tenant_id = ${tenantId}`.execute(
        ownerDb,
      );
      await sql`delete from commerce.offer_redemptions where tenant_id = ${tenantId}`.execute(
        ownerDb,
      );
      await sql`delete from commerce.quote_lines where tenant_id = ${tenantId}`.execute(ownerDb);
      await sql`delete from commerce.quotes where tenant_id = ${tenantId}`.execute(ownerDb);
      await sql`delete from commerce.cart_lines where tenant_id = ${tenantId}`.execute(ownerDb);
      await sql`delete from commerce.carts where tenant_id = ${tenantId}`.execute(ownerDb);
      await sql`delete from operations.merchant_commands where tenant_id = ${tenantId}`.execute(
        ownerDb,
      );
      await sql`delete from catalog.inventory_adjustments where tenant_id = ${tenantId}`.execute(
        ownerDb,
      );
      await sql`delete from catalog.product_audits where tenant_id = ${tenantId}`.execute(ownerDb);
      await sql`delete from catalog.shop_audits where tenant_id = ${tenantId}`.execute(ownerDb);
      await sql`delete from policy.shop_policy_audits where tenant_id = ${tenantId}`.execute(
        ownerDb,
      );
      await sql`delete from identity.shop_memberships where tenant_id = ${tenantId}`.execute(
        ownerDb,
      );
      await sql`delete from catalog.inventory where tenant_id = ${tenantId}`.execute(ownerDb);
      await sql`delete from catalog.variants where tenant_id = ${tenantId}`.execute(ownerDb);
      await sql`delete from catalog.products where tenant_id = ${tenantId}`.execute(ownerDb);
      await sql`delete from policy.shop_policies where tenant_id = ${tenantId}`.execute(ownerDb);
      await sql`delete from catalog.shops where tenant_id = ${tenantId}`.execute(ownerDb);
      await sql`delete from identity.tenants where id = ${tenantId}`.execute(ownerDb);
    }
    for (const userId of userIds) {
      await sql`
        delete from operations.merchant_commands
        where actor_id = ${userId}::uuid
      `.execute(ownerDb);
      await sql`delete from identity.users where id = ${userId}::uuid`.execute(ownerDb);
    }
    await appDb.destroy();
    await ownerDb.destroy();
  });

  async function fixture() {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const tenantId = `merchant-${suffix}`;
    const ownerId = randomUUID();
    const viewerId = randomUUID();
    tenantIds.push(tenantId);
    userIds.push(ownerId, viewerId);
    await ownerDb.transaction().execute(async (trx) => {
      await sql`
        insert into identity.users (id, email, status, synthetic)
        values
          (${ownerId}::uuid, ${`owner-${suffix}@example.invalid`}, 'active', true),
          (${viewerId}::uuid, ${`viewer-${suffix}@example.invalid`}, 'active', true)
      `.execute(trx);
      await sql`
        insert into identity.tenants (id, label, status, synthetic)
        values (${tenantId}, ${tenantId}, 'active', true)
      `.execute(trx);
      await sql`
        insert into identity.shop_memberships (tenant_id, user_id, role, status, joined_at)
        values
          (${tenantId}, ${ownerId}::uuid, 'owner', 'active', now()),
          (${tenantId}, ${viewerId}::uuid, 'viewer', 'active', now())
      `.execute(trx);
      await sql`
        insert into catalog.shops (
          tenant_id, slug, name, label, blurb, currency, status, synthetic, published_at
        )
        values (
          ${tenantId}, ${`merchant-${suffix}`}, 'Merchant fixture', 'Merchant fixture',
          'Synthetic merchant repository fixture.', 'INR', 'published', true, now()
        )
      `.execute(trx);
      await sql`
        insert into policy.shop_policies (
          tenant_id, currency, hard_cap_minor, autonomous_cap_minor,
          forbidden_materials, rules, updated_by
        )
        values (
          ${tenantId}, 'INR', 300000, 250000, array['glass'], '{"offers":[]}'::jsonb,
          ${ownerId}::uuid
        )
      `.execute(trx);
    });
    return { tenantId, ownerId, viewerId };
  }

  it('replays owner shop creation after a repository restart', async () => {
    const userId = randomUUID();
    const email = `first-shop-${userId}@example.invalid`;
    userIds.push(userId);
    const command = {
      idempotencyKey: 'postgres-first-shop-create-001',
      requestHash: '9'.repeat(64),
    };
    const first = await createPostgresTenantRepository(appDb).provisionShop(
      { userId, email },
      { name: 'Restart Durable Shop', blurb: 'Durable owner onboarding.' },
      command,
    );
    tenantIds.push(first.tenantId);
    const replay = await createPostgresTenantRepository(appDb).provisionShop(
      { userId, email },
      { name: 'Restart Durable Shop', blurb: 'Durable owner onboarding.' },
      command,
    );

    expect(replay.tenantId).toBe(first.tenantId);
    expect(await createPostgresTenantRepository(appDb).membershipRole(userId, first.tenantId)).toBe(
      'owner',
    );
  });

  it('persists idempotent catalog creation, versioned stock audit, and cross-role denial', async () => {
    const { tenantId, ownerId, viewerId } = await fixture();
    const repository = createPostgresTenantRepository(appDb);
    const command = {
      userId: ownerId,
      tenantId,
      title: 'Field brewer',
      description: 'Compact steel field brewer.',
      category: 'Brewers',
      sku: `brewer.${tenantId}`,
      material: 'steel' as const,
      priceMinor: '129900',
      stock: 5,
      status: 'published' as const,
      idempotencyKey: 'postgres-catalog-create-001',
      requestHash: 'a'.repeat(64),
    };

    const created = await repository.createMerchantProduct(command);
    const afterRestart = await createPostgresTenantRepository(appDb).createMerchantProduct(command);
    expect(afterRestart.productId).toBe(created.productId);

    const adjusted = await repository.adjustMerchantStock({
      userId: ownerId,
      tenantId,
      variantId: created.variantId,
      expectedVersion: created.inventory.version,
      delta: 2,
      reason: 'Warehouse cycle count.',
      idempotencyKey: 'postgres-stock-adjust-001',
      requestHash: 'b'.repeat(64),
    });
    expect(adjusted).toMatchObject({ onHand: 7, version: 2 });
    const audits = await sql<{ actor_id: string; reason: string }>`
      select actor_id::text, reason
      from catalog.inventory_adjustments
      where tenant_id = ${tenantId}
        and variant_id = ${created.variantId}::uuid
    `.execute(ownerDb);
    expect(audits.rows).toEqual([{ actor_id: ownerId, reason: 'Warehouse cycle count.' }]);
    await expect(
      repository.adjustMerchantStock({
        userId: ownerId,
        tenantId,
        variantId: created.variantId,
        expectedVersion: 1,
        delta: 1,
        reason: 'Stale adjustment.',
        idempotencyKey: 'postgres-stock-adjust-stale',
        requestHash: 'c'.repeat(64),
      }),
    ).rejects.toThrow('INVENTORY_VERSION_CONFLICT');
    await expect(
      repository.createMerchantProduct({
        ...command,
        userId: viewerId,
        idempotencyKey: 'postgres-viewer-create',
        requestHash: 'd'.repeat(64),
      }),
    ).rejects.toThrow('SHOP_MEMBERSHIP_REQUIRED');

    const createdAudits = await sql<{
      reason: string;
      version_before: number;
      version_after: number;
    }>`
      select reason, version_before, version_after
      from catalog.product_audits
      where tenant_id = ${tenantId}
        and product_id = ${created.productId}::uuid
      order by created_at, version_after
    `.execute(ownerDb);
    expect(createdAudits.rows).toEqual([
      {
        reason: 'Direct published product creation',
        version_before: 0,
        version_after: created.productVersion,
      },
    ]);
    const draft = await repository.createMerchantProduct({
      userId: ownerId,
      tenantId,
      title: 'Draft flask',
      description: 'Steel flask draft.',
      category: 'Brewers',
      sku: `flask.${tenantId}`,
      material: 'steel',
      priceMinor: '89900',
      stock: 4,
      status: 'draft',
      idempotencyKey: 'postgres-catalog-draft-001',
      requestHash: 'a1'.repeat(32),
    });
    const later = await repository.updateMerchantProduct({
      userId: ownerId,
      tenantId,
      productId: draft.productId,
      expectedVersion: draft.productVersion,
      title: draft.title,
      description: draft.description,
      category: 'Brewers',
      sku: draft.sku,
      material: 'steel',
      priceMinor: draft.priceMinor,
      status: 'published',
      reason: 'Later publish after required facts were complete.',
      idempotencyKey: 'postgres-catalog-later-publish',
      requestHash: 'a2'.repeat(32),
    });
    const replay = await repository.updateMerchantProduct({
      userId: ownerId,
      tenantId,
      productId: draft.productId,
      expectedVersion: draft.productVersion,
      title: draft.title,
      description: draft.description,
      category: 'Brewers',
      sku: draft.sku,
      material: 'steel',
      priceMinor: draft.priceMinor,
      status: 'published',
      reason: 'Later publish after required facts were complete.',
      idempotencyKey: 'postgres-catalog-later-publish',
      requestHash: 'a2'.repeat(32),
    });
    expect(replay.productVersion).toBe(later.productVersion);
    const restarted = createPostgresTenantRepository(appDb);
    const replayAfterRestart = await restarted.updateMerchantProduct({
      userId: ownerId,
      tenantId,
      productId: draft.productId,
      expectedVersion: draft.productVersion,
      title: draft.title,
      description: draft.description,
      category: 'Brewers',
      sku: draft.sku,
      material: 'steel',
      priceMinor: draft.priceMinor,
      status: 'published',
      reason: 'Later publish after required facts were complete.',
      idempotencyKey: 'postgres-catalog-later-publish',
      requestHash: 'a2'.repeat(32),
    });
    expect(replayAfterRestart.productVersion).toBe(later.productVersion);
    const productAudits = await sql<{ reason: string }>`
      select reason
      from catalog.product_audits
      where tenant_id = ${tenantId}
        and product_id = ${draft.productId}::uuid
      order by created_at, version_after
    `.execute(ownerDb);
    expect(productAudits.rows.map((row) => row.reason)).toEqual([
      'Initial draft product creation',
      'Later publish after required facts were complete.',
    ]);
    const updated = await repository.updateMerchantProduct({
      userId: ownerId,
      tenantId,
      productId: later.productId,
      expectedVersion: later.productVersion,
      title: 'Draft flask steel',
      description: later.description,
      category: 'Brewers',
      sku: later.sku,
      material: 'steel',
      priceMinor: later.priceMinor,
      status: 'published',
      reason: 'Clarify the published title after facts stayed the same.',
      idempotencyKey: 'postgres-catalog-later-update',
      requestHash: 'a3'.repeat(32),
    });
    const updateAudits = await sql<{ reason: string }>`
      select reason
      from catalog.product_audits
      where tenant_id = ${tenantId}
        and product_id = ${later.productId}::uuid
      order by created_at, version_after
    `.execute(ownerDb);
    expect(updateAudits.rows.map((row) => row.reason)).toEqual([
      'Initial draft product creation',
      'Later publish after required facts were complete.',
      'Clarify the published title after facts stayed the same.',
    ]);
    expect(updated.productVersion).toBe(later.productVersion + 1);
  });

  it('uses tenant/date filtered captured ledger truth and versions rules/settings', async () => {
    const { tenantId, ownerId, viewerId } = await fixture();
    const repository = createPostgresTenantRepository(appDb);
    const cartId = randomUUID();
    const quoteId = randomUUID();
    const checkoutId = randomUUID();
    await ownerDb.transaction().execute(async (trx) => {
      await sql`
        insert into commerce.carts (id, tenant_id, user_id, version)
        values (${cartId}::uuid, ${tenantId}, ${viewerId}::uuid, 1)
      `.execute(trx);
      await sql`
        insert into commerce.quotes (
          id, tenant_id, cart_id, cart_version, status, bound_checkout_id, currency,
          subtotal_minor, discount_minor, total_minor, delivery_by, merchant, fact_hash, created_at
        )
        values (
          ${quoteId}::uuid, ${tenantId}, ${cartId}::uuid, 1, 'SETTLED',
          ${checkoutId}::uuid, 'INR', 234700, 0, 234700, '2026-08-30',
          'Merchant fixture', ${'0'.repeat(64)}, '2026-08-04T00:00:00.000Z'
        )
      `.execute(trx);
      await sql`
        insert into payments.checkout_sessions (
          id, tenant_id, quote_id, receipt, razorpay_order_id, amount_minor,
          currency, status, payment_id, provider_status, copy, created_at, updated_at
        )
        values (
          ${checkoutId}::uuid, ${tenantId}, ${quoteId}::uuid, ${`cht_${checkoutId}`},
          ${`order_${checkoutId}`}, 234700, 'INR', 'SETTLED', ${`pay_${checkoutId}`},
          'captured', 'Captured fixture.', '2026-08-04T00:00:00.000Z',
          '2026-08-04T00:02:00.000Z'
        )
      `.execute(trx);
      await sql`
        insert into ledger.ledger_entries (
          id, tenant_id, checkout_id, quote_id, kind, amount_minor,
          currency, provider_payment_id, created_at
        )
        values (
          ${randomUUID()}::uuid, ${tenantId}, ${checkoutId}::uuid, ${quoteId}::uuid,
          'capture', 234700, 'INR', ${`pay_${checkoutId}`}, '2026-08-04T00:02:00.000Z'
        )
      `.execute(trx);
      const extraCart = randomUUID();
      const beforeQuote = randomUUID();
      const lateQuote = randomUUID();
      const unboundQuote = randomUUID();
      const expiredQuote = randomUUID();
      const supersededQuote = randomUUID();
      const beforeCheckout = randomUUID();
      const lateCheckout = randomUUID();
      await sql`
        insert into commerce.carts (id, tenant_id, user_id, version)
        values
          (${extraCart}::uuid, ${tenantId}, ${viewerId}::uuid, 1)
      `.execute(trx);
      await sql`
        insert into commerce.quotes (
          id, tenant_id, cart_id, cart_version, status, bound_checkout_id, currency,
          subtotal_minor, discount_minor, total_minor, delivery_by, merchant, fact_hash, created_at
        )
        values
          (${beforeQuote}::uuid, ${tenantId}, ${extraCart}::uuid, 1, 'SETTLED',
           ${beforeCheckout}::uuid, 'INR', 88000, 0, 88000, '2026-08-30', 'Merchant fixture', ${'0'.repeat(64)}, '2026-07-20T00:00:00.000Z'),
          (${lateQuote}::uuid, ${tenantId}, ${extraCart}::uuid, 1, 'FROZEN',
           null, 'INR', 11000, 0, 11000, '2026-08-30', 'Merchant fixture', ${'0'.repeat(64)}, '2026-08-08T00:00:00.000Z'),
          (${unboundQuote}::uuid, ${tenantId}, ${extraCart}::uuid, 1, 'FROZEN',
           null, 'INR', 5000, 0, 5000, '2026-08-30', 'Merchant fixture', ${'0'.repeat(64)}, '2026-08-09T00:00:00.000Z'),
          (${expiredQuote}::uuid, ${tenantId}, ${extraCart}::uuid, 1, 'FROZEN',
           null, 'INR', 4000, 0, 4000, '2026-08-30', 'Merchant fixture', ${'0'.repeat(64)}, '2026-08-06T00:00:00.000Z'),
          (${supersededQuote}::uuid, ${tenantId}, ${extraCart}::uuid, 1, 'FROZEN',
           null, 'INR', 3000, 0, 3000, '2026-08-30', 'Merchant fixture', ${'0'.repeat(64)}, '2026-08-07T00:00:00.000Z')
      `.execute(trx);
      await sql`
        insert into payments.checkout_sessions (
          id, tenant_id, quote_id, receipt, razorpay_order_id, amount_minor,
          currency, status, payment_id, provider_status, copy, created_at, updated_at
        )
        values
          (${beforeCheckout}::uuid, ${tenantId}, ${beforeQuote}::uuid, ${`cht_${beforeCheckout}`},
           ${`order_${beforeCheckout}`}, 88000, 'INR', 'SETTLED', ${`pay_${beforeCheckout}`},
           'captured', 'Capture in window for a quote created before the window.',
           '2026-08-10T00:00:00.000Z', '2026-08-10T00:02:00.000Z'),
          (${lateCheckout}::uuid, ${tenantId}, ${lateQuote}::uuid, ${`cht_${lateCheckout}`},
           ${`order_${lateCheckout}`}, 11000, 'INR', 'SETTLED', ${`pay_${lateCheckout}`},
           'captured', 'Quote in window, capture after window.',
           '2026-08-08T00:00:00.000Z', '2026-09-02T00:00:00.000Z')
      `.execute(trx);
      await sql`
        insert into ledger.ledger_entries (
          id, tenant_id, checkout_id, quote_id, kind, amount_minor,
          currency, provider_payment_id, created_at
        )
        values
          (${randomUUID()}::uuid, ${tenantId}, ${beforeCheckout}::uuid, ${beforeQuote}::uuid,
           'capture', 88000, 'INR', ${`pay_${beforeCheckout}`}, '2026-08-10T00:02:00.000Z'),
          (${randomUUID()}::uuid, ${tenantId}, ${lateCheckout}::uuid, ${lateQuote}::uuid,
           'capture', 11000, 'INR', ${`pay_${lateCheckout}`}, '2026-09-02T00:00:00.000Z')
      `.execute(trx);
    });

    await expect(
      sql`
        insert into ledger.ledger_entries (
          id, tenant_id, checkout_id, quote_id, kind, amount_minor,
          currency, provider_payment_id, created_at
        )
        values (
          ${randomUUID()}::uuid, ${tenantId}, ${checkoutId}::uuid, ${quoteId}::uuid,
          'capture', 234700, 'INR', ${`pay_${checkoutId}_dup`}, '2026-08-04T00:03:00.000Z'
        )
      `.execute(ownerDb),
    ).rejects.toThrow(/ledger_entries_tenant_id_checkout_id_kind_key|duplicate key/i);

    const metrics = await repository.getMerchantOverview({
      userId: viewerId,
      tenantId,
      from: '2026-08-01',
      to: '2026-08-31',
    });
    expect(metrics).toMatchObject({
      capturedGmvMinor: '234700',
      capturedOrders: 1,
      validFrozenQuotes: 5,
      conversion: { numerator: 1, denominator: 5, rate: 1 / 5 },
    });
    expect(metrics.conversion.numerator).toBeLessThanOrEqual(metrics.conversion.denominator);
    expect(metrics.attributionNote).toMatch(/quotes created in this window/i);

    const rules = await repository.getMerchantRules({ userId: ownerId, tenantId });
    const updatedRules = await repository.updateMerchantRules({
      userId: ownerId,
      tenantId,
      expectedVersion: rules!.version,
      hardCapMinor: '300000',
      autonomousCapMinor: '250000',
      forbiddenMaterials: ['glass'],
      offers: [],
      reason: 'Postgres policy version test.',
      idempotencyKey: 'postgres-rules-update',
      requestHash: 'e'.repeat(64),
    });
    expect(updatedRules.version).toBe(rules!.version + 1);
    expect(updatedRules.offers).toEqual([]);

    const stacked = await repository.updateMerchantRules({
      userId: ownerId,
      tenantId,
      expectedVersion: updatedRules.version,
      hardCapMinor: '300000',
      autonomousCapMinor: '250000',
      forbiddenMaterials: ['glass'],
      offers: [
        {
          id: 'bundle-stack',
          discountMinor: '10000',
          requiredSkuGroups: [['sku.a']],
          stackable: true,
          marginFloorMinor: '180000',
          budgetRemainingMinor: '40000',
          maxRedemptions: 5,
          redemptions: 2,
          expiresAt: '2099-12-31T00:00:00.000Z',
        },
      ],
      reason: 'Persist offer stack budget and margin.',
      idempotencyKey: 'postgres-rules-offer-safety',
      requestHash: 'e1'.repeat(32),
    });
    expect(stacked.offers).toEqual([
      expect.objectContaining({
        id: 'bundle-stack',
        discountMinor: '10000',
        stackable: true,
        marginFloorMinor: '180000',
        budgetRemainingMinor: '40000',
        maxRedemptions: 5,
        redemptions: 2,
        expiresAt: '2099-12-31T00:00:00.000Z',
      }),
    ]);
    const reloaded = await createPostgresTenantRepository(appDb).getMerchantRules({
      userId: viewerId,
      tenantId,
    });
    expect(reloaded?.offers).toEqual(stacked.offers);
    expect(await repository.getPolicy(tenantId)).toMatchObject({
      offers: [
        expect.objectContaining({
          id: 'bundle-stack',
          discountMinor: 10000n,
          stackable: true,
          marginFloorMinor: 180000n,
          budgetRemainingMinor: 40000n,
          maxRedemptions: 5,
          redemptions: 2,
          expiresAt: '2099-12-31T00:00:00.000Z',
        }),
      ],
    });

    const settings = await repository.getMerchantSettings({
      userId: ownerId,
      tenantId,
      testMode: true,
    });
    const updatedSettings = await repository.updateMerchantSettings({
      userId: ownerId,
      tenantId,
      expectedVersion: settings!.version,
      name: 'Merchant fixture renamed',
      blurb: 'Updated without changing the public slug.',
      reason: 'Postgres settings version test.',
      testMode: true,
      idempotencyKey: 'postgres-settings-update',
      requestHash: 'f'.repeat(64),
    });
    expect(updatedSettings).toMatchObject({
      version: settings!.version + 1,
      slug: settings!.slug,
      name: 'Merchant fixture renamed',
      synthetic: true,
    });
    const renamed = await sql<{ label: string; synthetic: boolean }>`
      select label, synthetic
      from catalog.shops
      where tenant_id = ${tenantId}
    `.execute(ownerDb);
    expect(renamed.rows[0]).toEqual({
      label: 'Merchant fixture renamed (synthetic)',
      synthetic: true,
    });
    const publicShop = await repository.findShopBySlug(updatedSettings.slug);
    expect(publicShop).toMatchObject({
      name: 'Merchant fixture renamed',
      label: 'Merchant fixture renamed (synthetic)',
      synthetic: true,
    });
    const metricsAfterRename = await repository.getMerchantOverview({
      userId: viewerId,
      tenantId,
      from: '2026-08-01',
      to: '2026-08-31',
    });
    expect(metricsAfterRename.synthetic).toBe(true);
  });

  it('excludes capture-then-refund in-window from captured GMV and failedUnresolvedPays', async () => {
    const { tenantId, viewerId } = await fixture();
    const repository = createPostgresTenantRepository(appDb);
    const cartId = randomUUID();
    const quoteId = randomUUID();
    const checkoutId = randomUUID();
    await ownerDb.transaction().execute(async (trx) => {
      await sql`
        insert into commerce.carts (id, tenant_id, user_id, version)
        values (${cartId}::uuid, ${tenantId}, ${viewerId}::uuid, 1)
      `.execute(trx);
      await sql`
        insert into commerce.quotes (
          id, tenant_id, cart_id, cart_version, status, bound_checkout_id, currency,
          subtotal_minor, discount_minor, total_minor, delivery_by, merchant, fact_hash, created_at
        )
        values (
          ${quoteId}::uuid, ${tenantId}, ${cartId}::uuid, 1, 'BOUND',
          ${checkoutId}::uuid, 'INR', 234700, 0, 234700, '2026-08-30',
          'Merchant fixture', ${'0'.repeat(64)}, '2026-08-10T00:00:00.000Z'
        )
      `.execute(trx);
      await sql`
        insert into payments.checkout_sessions (
          id, tenant_id, quote_id, receipt, razorpay_order_id, amount_minor,
          currency, status, payment_id, provider_status, copy, created_at, updated_at
        )
        values (
          ${checkoutId}::uuid, ${tenantId}, ${quoteId}::uuid, ${`cht_${checkoutId}`},
          ${`order_${checkoutId}`}, 234700, 'INR', 'RECONCILING', ${`pay_${checkoutId}`},
          'refunded', 'Capture then refund.', '2026-08-10T00:00:00.000Z',
          '2026-08-10T00:04:00.000Z'
        )
      `.execute(trx);
      await sql`
        insert into ledger.ledger_entries (
          id, tenant_id, checkout_id, quote_id, kind, amount_minor,
          currency, provider_payment_id, created_at
        )
        values
          (${randomUUID()}::uuid, ${tenantId}, ${checkoutId}::uuid, ${quoteId}::uuid,
           'capture', 234700, 'INR', ${`pay_${checkoutId}`}, '2026-08-10T00:02:00.000Z'),
          (${randomUUID()}::uuid, ${tenantId}, ${checkoutId}::uuid, ${quoteId}::uuid,
           'refund', 234700, 'INR', ${`pay_${checkoutId}`}, '2026-08-10T00:04:00.000Z')
      `.execute(trx);
    });

    const metrics = await repository.getMerchantOverview({
      userId: viewerId,
      tenantId,
      from: '2026-08-01',
      to: '2026-08-31',
    });
    expect(metrics).toMatchObject({
      capturedGmvMinor: '0',
      capturedOrders: 0,
      failedUnresolvedPays: 0,
    });
  });

  it('returns signed-cursor page two for catalog, orders, and recovery lists', async () => {
    const { tenantId, ownerId, viewerId } = await fixture();
    const repository = createPostgresTenantRepository(appDb);

    const firstProduct = await repository.createMerchantProduct({
      userId: ownerId,
      tenantId,
      title: 'Cursor mill',
      description: 'First catalog page row.',
      category: 'Mills',
      sku: `mill.${tenantId}.one`,
      material: 'steel',
      priceMinor: '11100',
      stock: 3,
      status: 'published',
      idempotencyKey: 'postgres-catalog-cursor-1',
      requestHash: '1'.repeat(64),
    });
    const secondProduct = await repository.createMerchantProduct({
      userId: ownerId,
      tenantId,
      title: 'Cursor kettle',
      description: 'Second catalog page row.',
      category: 'Kettles',
      sku: `kettle.${tenantId}.two`,
      material: 'steel',
      priceMinor: '22200',
      stock: 4,
      status: 'published',
      idempotencyKey: 'postgres-catalog-cursor-2',
      requestHash: '2'.repeat(64),
    });

    const catalogFirst = await repository.listMerchantCatalog({
      userId: viewerId,
      tenantId,
      limit: 1,
      after: null,
    });
    expect(catalogFirst.items).toHaveLength(1);
    expect(catalogFirst.cursor).toEqual({
      sortValue: catalogFirst.items[0]!.updatedAt,
      id: catalogFirst.items[0]!.productId,
    });
    const catalogSecond = await repository.listMerchantCatalog({
      userId: viewerId,
      tenantId,
      limit: 1,
      after: catalogFirst.cursor,
    });
    expect(catalogSecond.items).toHaveLength(1);
    expect(catalogSecond.items[0]!.productId).not.toBe(catalogFirst.items[0]!.productId);
    expect([firstProduct.productId, secondProduct.productId]).toEqual(
      expect.arrayContaining([catalogFirst.items[0]!.productId, catalogSecond.items[0]!.productId]),
    );

    const olderOrder = await insertCheckout({
      tenantId,
      userId: viewerId,
      status: 'SETTLED',
      updatedAt: '2026-08-20T10:00:00.000Z',
    });
    const newerOrder = await insertCheckout({
      tenantId,
      userId: viewerId,
      status: 'SETTLED',
      updatedAt: '2026-08-21T10:00:00.000Z',
    });
    const ordersFirst = await repository.listMerchantOrders({
      userId: viewerId,
      tenantId,
      query: '',
      status: '',
      from: null,
      to: null,
      limit: 1,
      after: null,
    });
    expect(ordersFirst.items).toHaveLength(1);
    expect(ordersFirst.items[0]!.id).toBe(newerOrder.checkoutId);
    expect(ordersFirst.cursor).toEqual({
      sortValue: ordersFirst.items[0]!.updatedAt,
      id: ordersFirst.items[0]!.id,
    });
    const ordersSecond = await repository.listMerchantOrders({
      userId: viewerId,
      tenantId,
      query: '',
      status: '',
      from: null,
      to: null,
      limit: 1,
      after: ordersFirst.cursor,
    });
    expect(ordersSecond.items.map((row) => row.id)).toEqual([olderOrder.checkoutId]);

    const olderRecovery = await insertCheckout({
      tenantId,
      userId: viewerId,
      status: 'FAILED_PROVISIONAL',
      updatedAt: '2026-08-22T10:00:00.000Z',
    });
    const newerRecovery = await insertCheckout({
      tenantId,
      userId: viewerId,
      status: 'FAILED_PROVISIONAL',
      updatedAt: '2026-08-23T10:00:00.000Z',
    });
    const recoveryFirst = await repository.listMerchantRecovery({
      userId: ownerId,
      tenantId,
      status: '',
      limit: 1,
      after: null,
    });
    expect(recoveryFirst.items).toHaveLength(1);
    expect(recoveryFirst.items[0]!.checkoutId).toBe(newerRecovery.checkoutId);
    expect(recoveryFirst.cursor).toEqual({
      sortValue: recoveryFirst.items[0]!.updatedAt,
      id: recoveryFirst.items[0]!.checkoutId,
    });
    const recoverySecond = await repository.listMerchantRecovery({
      userId: ownerId,
      tenantId,
      status: '',
      limit: 1,
      after: recoveryFirst.cursor,
    });
    expect(recoverySecond.items.map((row) => row.checkoutId)).toEqual([olderRecovery.checkoutId]);
  });

  async function insertCheckout(input: {
    tenantId: string;
    userId: string;
    status: string;
    updatedAt: string;
  }) {
    const cartId = randomUUID();
    const quoteId = randomUUID();
    const checkoutId = randomUUID();
    const receipt = `cht_${checkoutId}`;
    await ownerDb.transaction().execute(async (trx) => {
      await sql`
        insert into commerce.carts (id, tenant_id, user_id, version)
        values (${cartId}::uuid, ${input.tenantId}, ${input.userId}::uuid, 1)
      `.execute(trx);
      await sql`
        insert into commerce.quotes (
          id, tenant_id, cart_id, cart_version, status, currency,
          subtotal_minor, discount_minor, total_minor, delivery_by, merchant, fact_hash
        )
        values (
          ${quoteId}::uuid, ${input.tenantId}, ${cartId}::uuid, 1, 'FROZEN', 'INR',
          10000, 0, 10000, '2026-08-30', 'Merchant fixture', ${'0'.repeat(64)}
        )
      `.execute(trx);
      await sql`
        insert into payments.checkout_sessions (
          id, tenant_id, quote_id, receipt, razorpay_order_id, amount_minor,
          currency, status, payment_id, provider_status, copy, created_at, updated_at
        )
        values (
          ${checkoutId}::uuid, ${input.tenantId}, ${quoteId}::uuid, ${receipt},
          ${`order_${checkoutId}`}, 10000, 'INR', ${input.status},
          ${`pay_${checkoutId}`}, 'failed', 'Cursor page fixture.',
          ${input.updatedAt}::timestamptz, ${input.updatedAt}::timestamptz
        )
      `.execute(trx);
    });
    return { checkoutId, quoteId };
  }
});
