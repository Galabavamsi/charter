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

describeWithPostgres('charter_app buyer orders', () => {
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
      await sql`delete from ledger.ledger_entries where tenant_id = ${tenantId}`.execute(ownerDb);
      await sql`delete from payments.checkout_sessions where tenant_id = ${tenantId}`.execute(
        ownerDb,
      );
      await sql`delete from commerce.quote_lines where tenant_id = ${tenantId}`.execute(ownerDb);
      await sql`delete from commerce.quotes where tenant_id = ${tenantId}`.execute(ownerDb);
      await sql`delete from commerce.carts where tenant_id = ${tenantId}`.execute(ownerDb);
      await sql`delete from identity.shop_memberships where tenant_id = ${tenantId}`.execute(
        ownerDb,
      );
      await sql`delete from policy.shop_policies where tenant_id = ${tenantId}`.execute(ownerDb);
      await sql`delete from catalog.shops where tenant_id = ${tenantId}`.execute(ownerDb);
      await sql`delete from identity.tenants where id = ${tenantId}`.execute(ownerDb);
    }
    for (const userId of userIds) {
      await sql`delete from identity.users where id = ${userId}::uuid`.execute(ownerDb);
    }
    await appDb.destroy();
    await ownerDb.destroy();
  });

  it('returns cart-owned receipts to the buyer and the same payment truth to the merchant', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const tenantId = `buyer-orders-${suffix}`;
    const ownerId = randomUUID();
    const buyerA = randomUUID();
    const buyerB = randomUUID();
    const cartId = randomUUID();
    const quoteId = randomUUID();
    const checkoutId = randomUUID();
    tenantIds.push(tenantId);
    userIds.push(ownerId, buyerA, buyerB);

    await ownerDb.transaction().execute(async (trx) => {
      await sql`
        insert into identity.users (id, email, status, synthetic)
        values
          (${ownerId}::uuid, ${`owner-${suffix}@example.invalid`}, 'active', true),
          (${buyerA}::uuid, ${`buyer-a-${suffix}@example.invalid`}, 'active', true),
          (${buyerB}::uuid, ${`buyer-b-${suffix}@example.invalid`}, 'active', true)
      `.execute(trx);
      await sql`
        insert into identity.tenants (id, label, status, synthetic)
        values (${tenantId}, ${tenantId}, 'active', true)
      `.execute(trx);
      await sql`
        insert into identity.shop_memberships (tenant_id, user_id, role, status, joined_at)
        values (${tenantId}, ${ownerId}::uuid, 'owner', 'active', now())
      `.execute(trx);
      await sql`
        insert into catalog.shops (
          tenant_id, slug, name, label, blurb, currency, status, synthetic, published_at
        )
        values (
          ${tenantId}, ${`buyer-${suffix}`}, 'Buyer order fixture', 'Buyer order fixture',
          'Synthetic buyer receipt fixture.', 'INR', 'published', true, now()
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
      await sql`
        insert into commerce.carts (id, tenant_id, user_id, version)
        values (${cartId}::uuid, ${tenantId}, ${buyerA}::uuid, 1)
      `.execute(trx);
      await sql`
        insert into commerce.quotes (
          id, tenant_id, cart_id, cart_version, status, currency,
          subtotal_minor, discount_minor, total_minor, delivery_by, merchant, fact_hash
        )
        values (
          ${quoteId}::uuid, ${tenantId}, ${cartId}::uuid, 1, 'FROZEN', 'INR',
          234700, 0, 234700, '2026-08-30', 'Buyer order fixture', ${'0'.repeat(64)}
        )
      `.execute(trx);
      await sql`
        insert into commerce.quote_lines (
          tenant_id, quote_id, sku, title, quantity, unit_minor, line_minor
        )
        values (
          ${tenantId}, ${quoteId}::uuid, 'grinder.pocket-lite', 'PocketGrind Lite',
          1, 99900, 99900
        )
      `.execute(trx);
      await sql`
        insert into payments.checkout_sessions (
          id, tenant_id, quote_id, receipt, razorpay_order_id, amount_minor,
          currency, status, payment_id, provider_status, copy, created_at, updated_at
        )
        values (
          ${checkoutId}::uuid, ${tenantId}, ${quoteId}::uuid, ${`cht_${checkoutId}`},
          ${`order_${checkoutId}`}, 234700, 'INR', 'SETTLED',
          ${`pay_${checkoutId}`}, 'captured', 'Captured.',
          '2026-08-23T10:00:00.000Z'::timestamptz, '2026-08-23T10:02:00.000Z'::timestamptz
        )
      `.execute(trx);
      await sql`
        insert into ledger.ledger_entries (
          id, tenant_id, checkout_id, quote_id, kind, amount_minor, currency,
          provider_payment_id, created_at
        )
        values (
          ${randomUUID()}::uuid, ${tenantId}, ${checkoutId}::uuid, ${quoteId}::uuid,
          'capture', 234700, 'INR', ${`pay_${checkoutId}`},
          '2026-08-23T10:02:00.000Z'::timestamptz
        )
      `.execute(trx);
    });

    const repository = createPostgresTenantRepository(appDb);
    const listed = await repository.listBuyerOrders({ userId: buyerA, limit: 25, after: null });
    const hidden = await repository.listBuyerOrders({ userId: buyerB, limit: 25, after: null });
    const buyerDetail = await repository.getBuyerOrder({ userId: buyerA, orderId: checkoutId });
    const stranger = await repository.getBuyerOrder({ userId: buyerB, orderId: checkoutId });
    const merchantDetail = await repository.getMerchantOrder({
      userId: ownerId,
      tenantId,
      orderId: checkoutId,
    });

    expect(listed.items.map((row) => row.id)).toEqual([checkoutId]);
    expect(listed.items[0]?.shop).toMatchObject({
      tenantId,
      slug: `buyer-${suffix}`,
      synthetic: true,
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
