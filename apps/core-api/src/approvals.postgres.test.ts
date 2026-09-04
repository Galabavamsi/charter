import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NORTHSTAR_TENANT, resetMerchantSeeds } from '@charter/catalog';
import { openTypedApproval, resetKernel, saveApproval } from '@charter/commerce';
import { loadConfig } from '@charter/config';
import { createDb, seedDatabase, sql, type Database, type Kysely } from '@charter/db';
import { buildServer } from './server.js';
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

describeWithPostgres('charter_app typed approval HTTP', () => {
  let ownerDb: Kysely<Database>;
  let appDb: Kysely<Database>;
  const userIds: string[] = [];
  const requesterId = '01000000-0000-4000-8000-000000000002';

  beforeAll(async () => {
    ownerDb = createDb(ownerUrl);
    appDb = createDb(appUrl);
    await seedDatabase(ownerDb);
    const role = await sql<{ role: string }>`select current_user as role`.execute(appDb);
    expect(role.rows).toEqual([{ role: 'charter_app' }]);
  });

  afterAll(async () => {
    await sql`delete from policy.approvals where tenant_id = ${NORTHSTAR_TENANT} and kind <> 'cart_spend'`.execute(
      ownerDb,
    );
    for (const userId of userIds) {
      await sql`delete from identity.shop_memberships where user_id = ${userId}::uuid`.execute(
        ownerDb,
      );
      await sql`delete from identity.users where id = ${userId}::uuid`.execute(ownerDb);
    }
    await appDb.destroy();
    await ownerDb.destroy();
  });

  beforeEach(() => {
    resetKernel();
    resetMerchantSeeds();
  });

  async function createMember(role: 'catalog' | 'finance'): Promise<string> {
    const userId = randomUUID();
    userIds.push(userId);
    await sql`
      insert into identity.users (id, email, status, synthetic)
      values (${userId}::uuid, ${`${role}-${userId}@example.invalid`}, 'active', true)
    `.execute(ownerDb);
    await sql`
      insert into identity.shop_memberships (tenant_id, user_id, role, status, joined_at)
      values (${NORTHSTAR_TENANT}, ${userId}::uuid, ${role}, 'active', now())
    `.execute(ownerDb);
    return userId;
  }

  async function serverFor(userId: string, email: string) {
    return buildServer(
      {
        DATABASE_URL: appUrl,
        CHARTER_ENV: 'development',
        RAZORPAY_MODE: 'test',
      },
      {
        db: appDb,
        tenantRepository: createPostgresTenantRepository(appDb),
        authVerifier: {
          async verify() {
            return { userId, email };
          },
        },
      },
    );
  }

  it('lets catalog and finance decide typed kinds as charter_app without mutating a cart or enabling refunds', async () => {
    const catalogUser = await createMember('catalog');
    const financeUser = await createMember('finance');
    const catalogApproval = openTypedApproval({
      kind: 'catalog_publish',
      tenantId: NORTHSTAR_TENANT,
      resourceId: `product-${randomUUID()}`,
      resourceVersion: 1,
      amountMinor: 0n,
      reason: 'CATALOG_PUBLISH_APPROVAL_REQUIRED',
      requestedBy: requesterId,
    });
    const refundApproval = openTypedApproval({
      kind: 'refund',
      tenantId: NORTHSTAR_TENANT,
      resourceId: `order-${randomUUID()}`,
      resourceVersion: 1,
      amountMinor: 99900n,
      reason: 'REFUND_APPROVAL_REQUIRED',
      requestedBy: requesterId,
    });
    await saveApproval(appDb, catalogApproval, requesterId);
    await saveApproval(appDb, refundApproval, requesterId);

    const catalogServer = await serverFor(catalogUser, 'catalog@example.invalid');
    const financeServer = await serverFor(financeUser, 'finance@example.invalid');
    const ownerServer = await serverFor(
      '01000000-0000-4000-8000-000000000001',
      'northstar.owner@example.invalid',
    );
    try {
      const listed = await catalogServer.app.inject({
        method: 'GET',
        url: `/api/v1/register/${NORTHSTAR_TENANT}/approvals?kind=catalog_publish`,
        headers: { authorization: 'Bearer catalog' },
      });
      const catalog = await catalogServer.app.inject({
        method: 'POST',
        url: `/api/v1/register/${NORTHSTAR_TENANT}/approvals/${catalogApproval.id}`,
        headers: { authorization: 'Bearer catalog' },
        payload: { decision: 'approved', kind: 'catalog_publish' },
      });
      const refund = await financeServer.app.inject({
        method: 'POST',
        url: `/api/v1/register/${NORTHSTAR_TENANT}/approvals/${refundApproval.id}`,
        headers: { authorization: 'Bearer finance' },
        payload: { decision: 'approved', kind: 'refund' },
      });
      const register = await ownerServer.app.inject({
        method: 'GET',
        url: `/api/v1/register/${NORTHSTAR_TENANT}`,
        headers: { authorization: 'Bearer owner' },
      });
      expect(listed.statusCode, listed.body).toBe(200);
      expect(listed.json().approvals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: catalogApproval.id, kind: 'catalog_publish' }),
        ]),
      );
      expect(catalog.statusCode, catalog.body).toBe(200);
      expect(catalog.json().approval.status).toBe('approved');
      expect(catalog.json().cart).toBeUndefined();
      expect(refund.statusCode, refund.body).toBe(200);
      expect(refund.json().approval.status).toBe('approved');
      expect(register.json().refunds.available).toBe(false);
    } finally {
      await catalogServer.app.close();
      await financeServer.app.close();
      await ownerServer.app.close();
    }
  });

  it('rejects a stale typed resource hash through charter_app persist', async () => {
    const financeUser = await createMember('finance');
    const approval = openTypedApproval({
      kind: 'refund',
      tenantId: NORTHSTAR_TENANT,
      resourceId: `order-${randomUUID()}`,
      resourceVersion: 1,
      amountMinor: 99900n,
      reason: 'REFUND_APPROVAL_REQUIRED',
      requestedBy: requesterId,
    });
    await saveApproval(appDb, approval, requesterId);
    await sql`
      update policy.approvals
      set resource_id = ${`${approval.resourceId}-changed`}
      where id = ${approval.id}::uuid
        and tenant_id = ${NORTHSTAR_TENANT}
    `.execute(ownerDb);
    const { app } = await serverFor(financeUser, 'finance@example.invalid');
    try {
      const stale = await app.inject({
        method: 'POST',
        url: `/api/v1/register/${NORTHSTAR_TENANT}/approvals/${approval.id}`,
        headers: { authorization: 'Bearer finance' },
        payload: { decision: 'approved', kind: 'refund' },
      });
      expect(stale.statusCode, stale.body).toBe(409);
      expect(stale.json().error).toBe('APPROVAL_STALE');
    } finally {
      await app.close();
    }
  });
});
