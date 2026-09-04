import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDb,
  sql,
  withAuthContext,
  withUserContext,
  type Database,
  type Kysely,
} from '@charter/db';
import { loadConfig } from '@charter/config';
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

describeWithPostgres('charter_app self-membership discovery', () => {
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
      await sql`delete from policy.shop_policies where tenant_id = ${tenantId}`.execute(ownerDb);
      await sql`delete from identity.shop_memberships where tenant_id = ${tenantId}`.execute(
        ownerDb,
      );
      await sql`delete from catalog.shops where tenant_id = ${tenantId}`.execute(ownerDb);
      await sql`delete from identity.tenants where id = ${tenantId}`.execute(ownerDb);
    }
    for (const userId of userIds) {
      await sql`delete from identity.users where id = ${userId}::uuid`.execute(ownerDb);
    }
    await appDb.destroy();
    await ownerDb.destroy();
  });

  async function createUser(label: string): Promise<string> {
    const userId = randomUUID();
    userIds.push(userId);
    await sql`
      insert into identity.users (id, email, status, synthetic)
      values (${userId}::uuid, ${`${label}-${userId}@example.invalid`}, 'active', true)
    `.execute(ownerDb);
    return userId;
  }

  async function createShop(input: {
    suffix: string;
    status?: 'draft' | 'published' | 'archived';
  }): Promise<string> {
    const tenantId = `membership-${input.suffix}`;
    tenantIds.push(tenantId);
    await sql`
      insert into identity.tenants (id, label, status, synthetic)
      values (${tenantId}, ${tenantId}, 'active', true)
    `.execute(ownerDb);
    await sql`
      insert into catalog.shops (
        tenant_id, slug, name, label, blurb, currency, status, synthetic, published_at
      )
      values (
        ${tenantId}, ${tenantId}, ${tenantId}, ${tenantId},
        'Self-membership discovery fixture.', 'INR', ${input.status ?? 'published'},
        true, now()
      )
    `.execute(ownerDb);
    return tenantId;
  }

  async function addMembership(input: {
    tenantId: string;
    userId: string;
    role?: 'owner' | 'viewer';
    status?: 'active' | 'invited' | 'suspended';
  }): Promise<void> {
    await sql`
      insert into identity.shop_memberships (tenant_id, user_id, role, status, joined_at)
      values (
        ${input.tenantId},
        ${input.userId}::uuid,
        ${input.role ?? 'owner'},
        ${input.status ?? 'active'},
        now()
      )
    `.execute(ownerDb);
  }

  it('lists only the current subject active shops without a selected tenant', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
    const subject = await createUser('subject');
    const other = await createUser('other');
    const firstShop = await createShop({ suffix: `${suffix}-a` });
    const secondShop = await createShop({ suffix: `${suffix}-b` });
    const archivedShop = await createShop({ suffix: `${suffix}-archived`, status: 'archived' });
    const revokedShop = await createShop({ suffix: `${suffix}-revoked` });
    const foreignShop = await createShop({ suffix: `${suffix}-foreign` });
    await addMembership({ tenantId: firstShop, userId: subject });
    await addMembership({ tenantId: secondShop, userId: subject, role: 'viewer' });
    await addMembership({ tenantId: archivedShop, userId: subject });
    await addMembership({ tenantId: revokedShop, userId: subject, status: 'suspended' });
    await addMembership({ tenantId: foreignShop, userId: other });
    await addMembership({ tenantId: firstShop, userId: other, role: 'viewer', status: 'invited' });

    const repository = createPostgresTenantRepository(appDb);
    const shops = await repository.listMemberShops(subject);
    const otherShops = await repository.listMemberShops(other);
    const membershipRows = await withUserContext(appDb, { userId: subject }, async (trx) => {
      const result = await sql<{ tenant_id: string; user_id: string; status: string }>`
        select tenant_id, user_id::text, status
        from identity.shop_memberships
        order by tenant_id, user_id
      `.execute(trx);
      return result.rows;
    });
    const forgedTenantRows = await withAuthContext(
      appDb,
      { userId: subject, tenantId: foreignShop },
      async (trx) => {
        const result = await sql<{ tenant_id: string; user_id: string }>`
          select tenant_id, user_id::text
          from identity.shop_memberships
          where tenant_id = ${foreignShop}
        `.execute(trx);
        return result.rows;
      },
    );

    expect(shops.map((shop) => shop.tenantId).sort()).toEqual([firstShop, secondShop].sort());
    expect(otherShops.map((shop) => shop.tenantId)).toEqual([foreignShop]);
    expect(membershipRows).toEqual(
      expect.arrayContaining([
        { tenant_id: firstShop, user_id: subject, status: 'active' },
        { tenant_id: secondShop, user_id: subject, status: 'active' },
      ]),
    );
    expect(membershipRows).not.toEqual(
      expect.arrayContaining([{ tenant_id: foreignShop, user_id: other, status: 'active' }]),
    );
    expect(membershipRows.filter((row) => row.status !== 'active')).toEqual([]);
    expect(forgedTenantRows).toEqual([]);
  });
});
