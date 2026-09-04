import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, sql, type Database, type Kysely } from '@charter/db';
import { bootPersistence } from './persist.js';
import { createPostgresTenantRepository } from './tenant/postgres-repository.js';
import { loadConfig } from '@charter/config';
import { parsePublicCatalogQuery } from './tenant/public-catalog-query.js';

loadConfig();
if (!process.env.TEST_DATABASE_URL && process.env.DATABASE_URL) {
  process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
}
const url = process.env.TEST_DATABASE_URL ?? '';
const rolePassword = process.env.CHARTER_APP_PASSWORD ?? '';
if (process.env.CI_REQUIRE_TEST_DATABASE_URL === 'true' && !url) {
  throw new Error('TEST_DATABASE_URL_REQUIRED_IN_CI');
}
if (process.env.CI_REQUIRE_TEST_DATABASE_URL === 'true' && !rolePassword) {
  throw new Error('CHARTER_APP_PASSWORD_REQUIRED_IN_CI');
}

function applicationRoleUrl(ownerUrl: string, password: string): string {
  const applicationUrl = new URL(ownerUrl);
  applicationUrl.username = 'charter_app';
  applicationUrl.password = password;
  return applicationUrl.toString();
}

const appUrl = url && rolePassword ? applicationRoleUrl(url, rolePassword) : '';
const describeWithPostgres = appUrl ? describe.sequential : describe.skip;

describeWithPostgres('charter_app tenant API concurrency and inbox RLS', () => {
  let db: Kysely<Database>;
  let appDb: Kysely<Database>;
  const tenantIds: string[] = [];
  const userIds: string[] = [];
  const inboxEventIds: string[] = [];

  async function createUser(label: string): Promise<string> {
    const userId = randomUUID();
    userIds.push(userId);
    await sql`
      insert into identity.users (id, email, status, synthetic)
      values (${userId}::uuid, ${`${label}-${userId}@example.invalid`}, 'active', true)
    `.execute(db);
    return userId;
  }

  beforeAll(async () => {
    db = createDb(url);
    appDb = createDb(appUrl);
    const currentRole = await sql<{ role: string }>`
      select current_user as role
    `.execute(appDb);
    expect(currentRole.rows).toEqual([{ role: 'charter_app' }]);
  });

  afterAll(async () => {
    for (const eventId of inboxEventIds) {
      await sql`
        delete from integration.inbox_events
        where provider = 'razorpay'
          and event_id = ${eventId}
      `.execute(db);
    }
    for (const tenantId of tenantIds) {
      await sql`delete from conversation.messages where tenant_id = ${tenantId}`.execute(db);
      await sql`delete from conversation.conversations where tenant_id = ${tenantId}`.execute(db);
      await sql`delete from identity.tenants where id = ${tenantId}`.execute(db);
    }
    for (const userId of userIds) {
      await sql`delete from identity.users where id = ${userId}::uuid`.execute(db);
    }
    await appDb.destroy();
    await db.destroy();
  });

  it('returns a persisted pending checkout to exactly one concurrent consumer', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const tenantId = `checkout-${suffix}`;
    const userId = await createUser('checkout-consumer');
    const conversationId = randomUUID();
    const pendingCheckout = {
      checkoutId: randomUUID(),
      orderId: `order_${suffix}`,
      amount: 234700,
      currency: 'INR',
    };
    tenantIds.push(tenantId);
    await sql`
      insert into identity.tenants (id, label, status, synthetic)
      values (${tenantId}, ${tenantId}, 'active', true)
    `.execute(db);
    const repository = createPostgresTenantRepository(appDb);
    const input = { id: conversationId, tenantId, userId };
    await repository.saveConversation({
      ...input,
      expectedRevision: 0,
      state: {
        cartId: null,
        quoteId: null,
        catalogLoaded: false,
        pendingCheckout,
        messages: [],
      },
    });

    const consumed = await Promise.all([
      repository.consumePendingCheckout(input),
      repository.consumePendingCheckout(input),
    ]);

    expect(
      consumed.map((result) => result?.checkout).filter((checkout) => checkout !== null),
    ).toEqual([pendingCheckout]);
    expect(
      consumed.map((result) => result?.checkout).filter((checkout) => checkout === null),
    ).toHaveLength(1);
    expect((await repository.loadConversation(input))?.state.pendingCheckout).toBeNull();
  });

  it('persists a later conversation turn against the current revision as charter_app', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const tenantId = `turn-cas-${suffix}`;
    const userId = await createUser('turn-cas');
    const conversationId = randomUUID();
    tenantIds.push(tenantId);
    await sql`
      insert into identity.tenants (id, label, status, synthetic)
      values (${tenantId}, ${tenantId}, 'active', true)
    `.execute(db);
    const repository = createPostgresTenantRepository(appDb);
    const input = { id: conversationId, tenantId, userId };
    const initial = await repository.saveConversation({
      ...input,
      expectedRevision: 0,
      state: {
        cartId: null,
        quoteId: null,
        catalogLoaded: false,
        pendingCheckout: null,
        messages: [],
      },
    });
    const next = await repository.saveConversation({
      ...input,
      expectedRevision: initial,
      state: {
        cartId: null,
        quoteId: null,
        catalogLoaded: true,
        pendingCheckout: null,
        messages: [{ role: 'user', content: 'Build the travel kit.' }],
      },
    });

    expect(initial).toBe(1);
    expect(next).toBe(2);
    await expect(repository.loadConversation(input)).resolves.toMatchObject({
      revision: 2,
      state: {
        catalogLoaded: true,
        messages: [{ role: 'user', content: 'Build the travel kit.' }],
      },
    });
  });

  it('never lets a concurrent stale save resurrect a consumed pending checkout', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const tenantId = `checkout-cas-${suffix}`;
    const userId = await createUser('checkout-cas');
    const conversationId = randomUUID();
    const pendingCheckout = {
      checkoutId: randomUUID(),
      orderId: `order_cas_${suffix}`,
      amount: 234700,
      currency: 'INR',
    };
    tenantIds.push(tenantId);
    await sql`
      insert into identity.tenants (id, label, status, synthetic)
      values (${tenantId}, ${tenantId}, 'active', true)
    `.execute(db);
    const repository = createPostgresTenantRepository(appDb);
    const input = { id: conversationId, tenantId, userId };
    await repository.saveConversation({
      ...input,
      expectedRevision: 0,
      state: {
        cartId: null,
        quoteId: null,
        catalogLoaded: false,
        pendingCheckout,
        messages: [],
      },
    });
    const stale = await repository.loadConversation(input);

    const [firstConsumer, secondConsumer, racingSave] = await Promise.allSettled([
      repository.consumePendingCheckout(input),
      repository.consumePendingCheckout(input),
      repository.saveConversation({
        ...input,
        expectedRevision: stale!.revision,
        state: {
          ...stale!.state,
          messages: [{ role: 'user', content: 'stale database turn' }],
        },
      }),
    ]);

    const consumedCheckouts = [firstConsumer, secondConsumer].flatMap((result) =>
      result.status === 'fulfilled' ? [result.value?.checkout ?? null] : [],
    );
    expect(consumedCheckouts.filter((checkout) => checkout !== null)).toEqual([pendingCheckout]);
    expect(consumedCheckouts.filter((checkout) => checkout === null)).toHaveLength(1);
    if (racingSave.status === 'rejected') {
      expect(racingSave.reason).toMatchObject({ message: 'CONVERSATION_VERSION_CONFLICT' });
    }
    await expect(
      repository.saveConversation({
        ...input,
        expectedRevision: stale!.revision,
        state: stale!.state,
      }),
    ).rejects.toThrow('CONVERSATION_VERSION_CONFLICT');
    const latest = await repository.loadConversation(input);
    expect(latest?.state.pendingCheckout).toBeNull();
  });

  it('allows a platform principal to read the global inbox through charter_app RLS', async () => {
    const platformUserId = await createUser('platform-inbox');
    const eventId = `evt_platform_${randomUUID()}`;
    inboxEventIds.push(eventId);
    await sql`
      insert into identity.platform_roles (user_id, role)
      values (${platformUserId}::uuid, 'operator')
    `.execute(db);
    await sql`
      insert into integration.inbox_events (
        provider, event_id, event_type, payload, state
      )
      values (
        'razorpay', ${eventId}, 'payment.failed', '{}'::jsonb, 'unresolved'
      )
    `.execute(db);
    const persist = await bootPersistence(appDb);

    const inbox = await persist.listInbox(platformUserId);

    expect(inbox).toContainEqual(expect.objectContaining({ eventId, state: 'unresolved' }));
  });

  it('returns an empty global inbox to an ordinary user through charter_app RLS', async () => {
    const ordinaryUserId = await createUser('ordinary-inbox');
    const eventId = `evt_ordinary_${randomUUID()}`;
    inboxEventIds.push(eventId);
    await sql`
      insert into integration.inbox_events (
        provider, event_id, event_type, payload, state
      )
      values (
        'razorpay', ${eventId}, 'payment.failed', '{}'::jsonb, 'unresolved'
      )
    `.execute(db);
    const persist = await bootPersistence(appDb);

    const inbox = await persist.listInbox(ordinaryUserId);

    expect(inbox).toEqual([]);
  });

  it('queries only published directory facts through the charter_app public context', async () => {
    const repository = createPostgresTenantRepository(appDb);

    const directory = await repository.searchPublicShops(
      parsePublicCatalogQuery(
        {
          q: 'POCKETGRIND',
          category: 'travel-coffee',
          inStock: 'true',
          minPriceMinor: '99900',
          maxPriceMinor: '149900',
        },
        'shops',
        'postgres-test-cursor-secret-at-least-32-characters',
      ),
    );
    const catalog = await repository.searchPublicCatalog(
      'northstar',
      parsePublicCatalogQuery(
        {
          q: 'manual grinder',
          minPriceMinor: '99900',
          maxPriceMinor: '99900',
        },
        'shop:northstar',
        'postgres-test-cursor-secret-at-least-32-characters',
      ),
    );

    expect(directory.items.map((shop) => shop.slug)).toEqual(['northstar']);
    expect(directory.facets.categories).toContainEqual(
      expect.objectContaining({ slug: 'travel-coffee', title: 'Travel coffee' }),
    );
    expect(catalog?.items).toEqual([
      expect.objectContaining({
        sku: 'grinder.pocket-lite',
        availableStock: 8,
        priceMinor: '99900',
        category: { slug: 'travel-coffee', title: 'Travel coffee' },
        provenance: 'merchant',
      }),
    ]);
  });
});
