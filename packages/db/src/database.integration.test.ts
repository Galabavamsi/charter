import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { sql, type Kysely } from 'kysely';
import { loadConfig } from '@charter/config';
import { createAuthorizationRepository, createDb } from './index.js';
import { migrateDatabase, resetApplicationDatabase, seedDatabase } from './migrations.js';
import { withAuthContext } from './tenant.js';
import type { Database } from './types.js';

loadConfig();
if (!process.env.TEST_DATABASE_URL && process.env.DATABASE_URL) {
  process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
}
const baseUrl = process.env.TEST_DATABASE_URL;
if (process.env.CI_REQUIRE_TEST_DATABASE_URL === 'true' && !baseUrl) {
  throw new Error('TEST_DATABASE_URL_REQUIRED_IN_CI');
}
const describeDatabase = baseUrl ? describe.sequential : describe.skip;

describeDatabase('plain PostgreSQL migrations, seeds, constraints, and RLS', () => {
  const databaseName = `charter_schema_auth_${randomUUID().replaceAll('-', '')}`;
  const roleName = `charter_ci_${randomUUID().replaceAll('-', '')}`;
  let administration: pg.Client;
  let databaseUrl: string;
  let db: Kysely<Database>;
  let administrationConnected = false;
  let databaseCreated = false;

  beforeAll(async () => {
    if (!baseUrl) {
      return;
    }
    const target = new URL(baseUrl);
    target.pathname = `/${databaseName}`;
    databaseUrl = target.toString();
    administration = new pg.Client({ connectionString: baseUrl });
    await administration.connect();
    administrationConnected = true;
    await administration.query(`create database "${databaseName}"`);
    databaseCreated = true;
    db = createDb(databaseUrl);
  });

  afterAll(async () => {
    if (!baseUrl) {
      return;
    }
    await db?.destroy();
    if (administrationConnected) {
      if (databaseCreated) {
        await administration.query(
          'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1',
          [databaseName],
        );
        await administration.query(`drop database if exists "${databaseName}"`);
      }
      await administration.query(`drop role if exists "${roleName}"`);
      await administration.end();
    }
  });

  it('applies, replays, resets, and reapplies canonical migrations', async () => {
    const first = await migrateDatabase(db);
    const replay = await migrateDatabase(db);

    expect(first.applied).toHaveLength(24);
    expect(replay.applied).toEqual([]);
    expect(replay.skipped).toEqual(first.applied);

    await resetApplicationDatabase(db);
    const missingResult = await sql<{ table_name: string | null }>`
      select to_regclass('catalog.products')::text as table_name
    `.execute(db);
    const missing = missingResult.rows[0];
    if (!missing) {
      throw new Error('TEST_QUERY_EMPTY');
    }
    expect(missing.table_name).toBeNull();

    const reapplied = await migrateDatabase(db);
    expect(reapplied.applied).toEqual(first.applied);
  }, 30_000);

  it('seeds all synthetic shops idempotently and preserves the ₹2,347 scenario', async () => {
    await seedDatabase(db);
    const firstTimestamp = await sql<{ updated_at: string }>`
      select updated_at::text
      from catalog.products
      where id = '11000000-0000-4000-8000-000000000001'
    `.execute(db);
    await seedDatabase(db);
    const secondTimestamp = await sql<{ updated_at: string }>`
      select updated_at::text
      from catalog.products
      where id = '11000000-0000-4000-8000-000000000001'
    `.execute(db);
    expect(secondTimestamp.rows[0]?.updated_at).toBe(firstTimestamp.rows[0]?.updated_at);

    const countResult = await sql<{
      tenants: number;
      memberships: number;
      variants: number;
    }>`
      select
        (select count(*)::int from identity.tenants) as tenants,
        (select count(*)::int from identity.shop_memberships) as memberships,
        (select count(*)::int from catalog.variants) as variants
    `.execute(db);
    const counts = countResult.rows[0];
    if (!counts) {
      throw new Error('TEST_QUERY_EMPTY');
    }
    expect(counts).toEqual({ tenants: 6, memberships: 6, variants: 40 });

    const canonicalResult = await sql<{
      subtotal_minor: string;
      discount_minor: string;
      total_minor: string;
    }>`
      select
        sum(variant.price_minor)::text as subtotal_minor,
        (shop_policy.rules #>> '{offers,0,discount_minor}') as discount_minor,
        (
          sum(variant.price_minor)
          - (shop_policy.rules #>> '{offers,0,discount_minor}')::bigint
        )::text as total_minor
      from catalog.variants variant
      join policy.shop_policies shop_policy
        on shop_policy.tenant_id = variant.tenant_id
      where variant.tenant_id = 'northstar-demo-in'
        and variant.sku in (
          'brewer.trailpress-steel-750',
          'grinder.pocket-lite',
          'filters.travel-30'
        )
      group by shop_policy.rules
    `.execute(db);
    const canonical = canonicalResult.rows[0];
    if (!canonical) {
      throw new Error('TEST_QUERY_EMPTY');
    }
    expect(canonical).toEqual({
      subtotal_minor: '244700',
      discount_minor: '10000',
      total_minor: '234700',
    });

    const stock = await sql<{ sku: string; price_minor: string; on_hand: number }>`
      select variant.sku, variant.price_minor::text, inventory.on_hand
      from catalog.variants variant
      join catalog.inventory inventory
        on inventory.tenant_id = variant.tenant_id
       and inventory.variant_id = variant.id
      where variant.tenant_id = 'northstar-demo-in'
      order by variant.sku
    `.execute(db);
    expect(stock.rows).toContainEqual({
      sku: 'brewer.trailpress-steel-750',
      price_minor: '119900',
      on_hand: 12,
    });
    expect(stock.rows).toContainEqual({
      sku: 'kettle.road-mini',
      price_minor: '129900',
      on_hand: 0,
    });
  });

  it('enforces INR, nonnegative amounts, inventory, and tenant-aware foreign keys', async () => {
    await expect(
      db.transaction().execute(async (trx) => {
        await sql`
          insert into catalog.inventory (tenant_id, variant_id, on_hand, reserved)
          values (
            'indigo-desk-in',
            '12000000-0000-4000-8000-000000000001',
            1,
            0
          )
        `.execute(trx);
      }),
    ).rejects.toThrow();

    await expect(
      db.transaction().execute(async (trx) => {
        await sql`
          update catalog.inventory
          set reserved = on_hand + 1
          where tenant_id = 'northstar-demo-in'
            and variant_id = '12000000-0000-4000-8000-000000000001'
        `.execute(trx);
      }),
    ).rejects.toThrow();

    await expect(
      db.transaction().execute(async (trx) => {
        await sql`
          update catalog.variants
          set currency = 'USD'
          where id = '12000000-0000-4000-8000-000000000001'
        `.execute(trx);
      }),
    ).rejects.toThrow();
  });

  it('sets both trusted context values transaction-locally', async () => {
    const observed = await withAuthContext(
      db,
      {
        userId: '01000000-0000-4000-8000-000000000001',
        tenantId: 'northstar-demo-in',
      },
      async (trx) => {
        const result = await sql<{ user_id: string; tenant_id: string }>`
          select
            current_setting('app.user_id', true) as user_id,
            current_setting('app.tenant_id', true) as tenant_id
        `.execute(trx);
        const row = result.rows[0];
        if (!row) {
          throw new Error('TEST_QUERY_EMPTY');
        }
        return row;
      },
    );

    expect(observed).toEqual({
      user_id: '01000000-0000-4000-8000-000000000001',
      tenant_id: 'northstar-demo-in',
    });
  });

  it('resolves authorization from membership rows rather than contact data', async () => {
    const authorization = createAuthorizationRepository(db);
    const northstar = await authorization.resolve({
      userId: '01000000-0000-4000-8000-000000000001',
      tenantId: 'northstar-demo-in',
    });
    const forged = await authorization.resolve({
      userId: '01000000-0000-4000-8000-000000000001',
      tenantId: 'indigo-desk-in',
    });

    expect(northstar.membership).toMatchObject({ role: 'owner', status: 'active' });
    expect(forged.membership).toBeUndefined();
    await expect(
      authorization.requireActiveMembership({
        userId: '01000000-0000-4000-8000-000000000001',
        tenantId: 'indigo-desk-in',
      }),
    ).rejects.toThrow('SHOP_MEMBERSHIP_REQUIRED');

    await sql`
      update identity.users
      set status = 'disabled'
      where id = '01000000-0000-4000-8000-000000000001'
    `.execute(db);
    const disabled = await authorization.resolve({
      userId: '01000000-0000-4000-8000-000000000001',
      tenantId: 'northstar-demo-in',
    });
    expect(disabled.membership).toBeUndefined();
    expect(disabled.platformRoles).toEqual([]);
    await sql`
      update identity.users
      set status = 'active'
      where id = '01000000-0000-4000-8000-000000000001'
    `.execute(db);

    await sql`
      update identity.tenants
      set status = 'suspended'
      where id = 'northstar-demo-in'
    `.execute(db);
    const suspended = await authorization.resolve({
      userId: '01000000-0000-4000-8000-000000000001',
      tenantId: 'northstar-demo-in',
    });
    expect(suspended.membership).toBeUndefined();
    expect(suspended.platformRoles).toEqual([]);
    await sql`
      update identity.tenants
      set status = 'active'
      where id = 'northstar-demo-in'
    `.execute(db);
  });

  it('blocks forged tenant context and permits only published public catalog rows', async () => {
    await sql.raw(`create role "${roleName}" nologin`).execute(db);
    await sql
      .raw(
        `grant usage on schema app_private, identity, commerce, payments, ledger, integration, catalog, policy, conversation, recovery, operations to "${roleName}"`,
      )
      .execute(db);
    await sql
      .raw(
        `grant select, insert, update, delete on all tables in schema identity, commerce, payments, ledger, integration, catalog, policy, conversation, recovery, operations to "${roleName}"`,
      )
      .execute(db);
    await sql
      .raw(
        `grant execute on function app_private.resolve_webhook_checkout_by_order(text) to "${roleName}"`,
      )
      .execute(db);

    await sql`
      insert into identity.users (id, email, status, synthetic)
      values
        ('01000000-0000-4000-8000-000000000004', 'admin@schema-auth.example.invalid', 'active', true),
        ('01000000-0000-4000-8000-000000000005', 'operator@schema-auth.example.invalid', 'active', true),
        ('01000000-0000-4000-8000-000000000006', 'auditor@schema-auth.example.invalid', 'active', true)
      on conflict (id) do nothing
    `.execute(db);
    await sql`
      insert into identity.profiles (user_id, display_name)
      values
        ('01000000-0000-4000-8000-000000000004', 'Synthetic admin'),
        ('01000000-0000-4000-8000-000000000005', 'Synthetic operator'),
        ('01000000-0000-4000-8000-000000000006', 'Synthetic auditor')
      on conflict (user_id) do nothing
    `.execute(db);
    await sql`
      insert into identity.shop_memberships (
        tenant_id, user_id, role, status, joined_at
      )
      values (
        'northstar-demo-in',
        '01000000-0000-4000-8000-000000000004',
        'admin',
        'active',
        now()
      )
      on conflict (tenant_id, user_id) do update set role = excluded.role, status = excluded.status
    `.execute(db);
    await sql`
      update identity.shop_memberships
      set role = 'support'
      where tenant_id = 'indigo-desk-in'
        and user_id = '01000000-0000-4000-8000-000000000002';
      update identity.shop_memberships
      set role = 'viewer'
      where tenant_id = 'harbor-spice-in'
        and user_id = '01000000-0000-4000-8000-000000000003';
      insert into identity.platform_roles (user_id, role)
      values
        ('01000000-0000-4000-8000-000000000005', 'operator'),
        ('01000000-0000-4000-8000-000000000006', 'auditor')
      on conflict do nothing
    `.execute(db);
    await sql`
      insert into commerce.carts (id, tenant_id, version)
      values
        ('41000000-0000-4000-8000-000000000001', 'northstar-demo-in', 1),
        ('41000000-0000-4000-8000-000000000002', 'indigo-desk-in', 1)
      on conflict (id) do nothing
    `.execute(db);
    await sql`
      insert into commerce.quotes (
        id,
        tenant_id,
        cart_id,
        cart_version,
        status,
        bound_checkout_id,
        currency,
        subtotal_minor,
        discount_minor,
        total_minor,
        delivery_by,
        merchant,
        fact_hash
      )
      values (
        '42000000-0000-4000-8000-000000000002',
        'indigo-desk-in',
        '41000000-0000-4000-8000-000000000002',
        1,
        'BOUND',
        '43000000-0000-4000-8000-000000000002',
        'INR',
        19900,
        0,
        19900,
        '2026-08-30',
        'Indigo Desk (synthetic)',
        ${'0'.repeat(64)}
      )
      on conflict (id) do nothing
    `.execute(db);
    await sql`
      insert into payments.checkout_sessions (
        id,
        tenant_id,
        quote_id,
        receipt,
        razorpay_order_id,
        amount_minor,
        currency,
        status,
        payment_id,
        provider_status,
        copy
      )
      values (
        '43000000-0000-4000-8000-000000000002',
        'indigo-desk-in',
        '42000000-0000-4000-8000-000000000002',
        'rcpt_rls_restart',
        'order_rls_restart',
        19900,
        'INR',
        'CREATED',
        null,
        'created',
        'Restricted webhook resolution test.'
      )
      on conflict (id) do nothing
    `.execute(db);
    await sql`
      insert into integration.inbox_events (
        provider,
        event_id,
        event_type,
        payload,
        tenant_id,
        state,
        order_id,
        resolved_at
      )
      values
        (
          'razorpay',
          'evt_rls_unresolved',
          'payment.failed',
          '{}'::jsonb,
          null,
          'unresolved',
          'order_unresolved',
          null
        ),
        (
          'razorpay',
          'evt_rls_indigo',
          'payment.failed',
          '{}'::jsonb,
          'indigo-desk-in',
          'attributed',
          'order_indigo',
          now()
        )
      on conflict (provider, event_id) do nothing
    `.execute(db);

    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    const queryAsRole = async <Row extends pg.QueryResultRow>(
      query: string,
      context?: {
        userId?: string;
        tenantId: string;
        serviceContext?: 'machine' | 'webhook' | 'public_catalog';
      },
    ): Promise<Row[]> => {
      await client.query('begin');
      try {
        await client.query(`set local role "${roleName}"`);
        if (context) {
          if (context.userId) {
            await client.query(`select set_config('app.user_id', $1, true)`, [context.userId]);
          }
          await client.query(`select set_config('app.tenant_id', $1, true)`, [context.tenantId]);
          if (context.serviceContext) {
            await client.query(`select set_config('app.service_context', $1, true)`, [
              context.serviceContext,
            ]);
          }
        }
        return (await client.query<Row>(query)).rows;
      } finally {
        await client.query('rollback');
      }
    };

    try {
      const unmarkedPublicRows = await queryAsRole<{
        shops: number;
        products: number;
        variants: number;
        inventory: number;
      }>(
        `select
          (select count(*)::int from catalog.shops) as shops,
          (select count(*)::int from catalog.products) as products,
          (select count(*)::int from catalog.variants) as variants,
          (select count(*)::int from catalog.inventory) as inventory`,
      );
      expect(unmarkedPublicRows[0]).toEqual({
        shops: 0,
        products: 0,
        variants: 0,
        inventory: 0,
      });

      const publicRows = await queryAsRole<{
        shops: number;
        products: number;
        variants: number;
        inventory: number;
        units_available: number;
      }>(
        `select
          (select count(*)::int from catalog.shops) as shops,
          (select count(*)::int from catalog.products) as products,
          (select count(*)::int from catalog.variants) as variants,
          (select count(*)::int from catalog.inventory) as inventory,
          (select coalesce(sum(available), 0)::int from catalog.inventory) as units_available`,
        { tenantId: '', serviceContext: 'public_catalog' },
      );
      expect(publicRows[0]).toEqual({
        shops: 6,
        products: 40,
        variants: 40,
        inventory: 40,
        units_available: expect.any(Number),
      });

      const northstarPrivate = await queryAsRole<{ own: number; other: number }>(
        `select
          (
            select count(*)::int
            from catalog.inventory
            where tenant_id = 'northstar-demo-in'
          ) as own,
          (
            select count(*)::int
            from catalog.inventory
            where tenant_id = 'indigo-desk-in'
          ) as other`,
        {
          userId: '01000000-0000-4000-8000-000000000001',
          tenantId: 'northstar-demo-in',
        },
      );
      expect(northstarPrivate[0]).toEqual({ own: 8, other: 0 });

      const ownerWrite = await queryAsRole<{ tenant_id: string; available: number }>(
        `update catalog.inventory
         set on_hand = on_hand + 1
         where tenant_id = 'northstar-demo-in'
           and variant_id = '12000000-0000-4000-8000-000000000001'
         returning tenant_id, available`,
        {
          userId: '01000000-0000-4000-8000-000000000001',
          tenantId: 'northstar-demo-in',
        },
      );
      expect(ownerWrite).toEqual([
        { tenant_id: 'northstar-demo-in', available: expect.any(Number) },
      ]);
      const crossTenantWrite = await queryAsRole<{ tenant_id: string }>(
        `update catalog.inventory
         set on_hand = on_hand + 1
         where tenant_id = 'indigo-desk-in'
         returning tenant_id`,
        {
          userId: '01000000-0000-4000-8000-000000000001',
          tenantId: 'northstar-demo-in',
        },
      );
      expect(crossTenantWrite).toEqual([]);

      for (const actor of [
        {
          label: 'viewer',
          userId: '01000000-0000-4000-8000-000000000003',
          tenantId: 'harbor-spice-in',
        },
        {
          label: 'support',
          userId: '01000000-0000-4000-8000-000000000002',
          tenantId: 'indigo-desk-in',
        },
      ]) {
        const deniedWrite = await queryAsRole<{ tenant_id: string }>(
          `update catalog.inventory
           set on_hand = on_hand + 1
           where tenant_id = '${actor.tenantId}'
           returning tenant_id`,
          { userId: actor.userId, tenantId: actor.tenantId },
        );
        expect(deniedWrite, `${actor.label} inventory write`).toEqual([]);
      }

      const forgedTenant = await queryAsRole<{
        inventory: number;
        claimed_memberships: number;
        visible_memberships: number;
      }>(
        `select
          (select count(*)::int from catalog.inventory) as inventory,
          (select count(*)::int
             from identity.shop_memberships
            where tenant_id = current_setting('app.tenant_id', true)) as claimed_memberships,
          (select count(*)::int from identity.shop_memberships) as visible_memberships`,
        {
          userId: '01000000-0000-4000-8000-000000000001',
          tenantId: 'indigo-desk-in',
        },
      );
      expect(forgedTenant[0]).toEqual({
        inventory: 0,
        claimed_memberships: 0,
        visible_memberships: 1,
      });

      const platformAccess = await queryAsRole<{ memberships: number }>(
        `select count(*)::int as memberships from identity.shop_memberships`,
        {
          userId: '01000000-0000-4000-8000-000000000006',
          tenantId: 'indigo-desk-in',
        },
      );
      expect(platformAccess[0]?.memberships).toBe(7);

      const withoutMachineMarker = await queryAsRole<{ carts: number }>(
        `select count(*)::int as carts from commerce.carts`,
        { tenantId: 'northstar-demo-in' },
      );
      expect(withoutMachineMarker[0]?.carts).toBe(0);
      const machineScoped = await queryAsRole<{ own: number; other: number }>(
        `select
          count(*) filter (where tenant_id = 'northstar-demo-in')::int as own,
          count(*) filter (where tenant_id = 'indigo-desk-in')::int as other
        from commerce.carts`,
        { tenantId: 'northstar-demo-in', serviceContext: 'machine' },
      );
      expect(machineScoped[0]).toEqual({ own: 1, other: 0 });

      const machineCatalog = await queryAsRole<{
        shops: number;
        products: number;
        variants: number;
        inventory: number;
      }>(
        `select
          (select count(*)::int from catalog.shops where tenant_id = 'northstar-demo-in') as shops,
          (select count(*)::int from catalog.products where tenant_id = 'northstar-demo-in') as products,
          (select count(*)::int from catalog.variants where tenant_id = 'northstar-demo-in') as variants,
          (select count(*)::int from catalog.inventory where tenant_id = 'northstar-demo-in') as inventory`,
        { tenantId: 'northstar-demo-in', serviceContext: 'machine' },
      );
      expect(machineCatalog[0]).toEqual({
        shops: 1,
        products: 8,
        variants: 8,
        inventory: 8,
      });
      const machineOtherShop = await queryAsRole<{ shops: number }>(
        `select count(*)::int as shops from catalog.shops where tenant_id = 'indigo-desk-in'`,
        { tenantId: 'northstar-demo-in', serviceContext: 'machine' },
      );
      expect(machineOtherShop[0]?.shops).toBe(0);

      const viewerMemberships = await queryAsRole<{ user_id: string }>(
        `select user_id::text as user_id
         from identity.shop_memberships
         where tenant_id = 'harbor-spice-in'
         order by user_id`,
        {
          userId: '01000000-0000-4000-8000-000000000003',
          tenantId: 'harbor-spice-in',
        },
      );
      expect(viewerMemberships).toEqual([{ user_id: '01000000-0000-4000-8000-000000000003' }]);
      const viewerTeammateEmails = await queryAsRole<{ email: string }>(
        `select email
         from identity.users
         where id <> '01000000-0000-4000-8000-000000000003'::uuid`,
        {
          userId: '01000000-0000-4000-8000-000000000003',
          tenantId: 'harbor-spice-in',
        },
      );
      expect(viewerTeammateEmails).toEqual([]);
      const viewerConsentContacts = await queryAsRole<{ contact_value: string }>(
        `select contact_value from recovery.consents`,
        {
          userId: '01000000-0000-4000-8000-000000000003',
          tenantId: 'harbor-spice-in',
        },
      );
      expect(viewerConsentContacts).toEqual([]);

      await expect(
        queryAsRole(
          `insert into integration.inbox_events (
             provider, event_id, event_type, payload, state
           )
           values (
             'razorpay', 'evt_machine_denied', 'payment.failed', '{}'::jsonb, 'unresolved'
           )
           returning event_id`,
          { tenantId: 'northstar-demo-in', serviceContext: 'machine' },
        ),
      ).rejects.toThrow();
      const webhookIntake = await queryAsRole<{ event_id: string }>(
        `insert into integration.inbox_events (
           provider, event_id, event_type, payload, state
         )
         values (
           'razorpay', 'evt_webhook_allowed', 'payment.failed', '{}'::jsonb, 'unresolved'
         )
         returning event_id`,
        { tenantId: '', serviceContext: 'webhook' },
      );
      expect(webhookIntake).toEqual([{ event_id: 'evt_webhook_allowed' }]);
      const resolvedCheckout = await queryAsRole<{
        tenant_id: string;
        checkout_id: string;
      }>(
        `select tenant_id, checkout_id
         from app_private.resolve_webhook_checkout_by_order('order_rls_restart')`,
        { tenantId: '', serviceContext: 'webhook' },
      );
      expect(resolvedCheckout).toEqual([
        {
          tenant_id: 'indigo-desk-in',
          checkout_id: '43000000-0000-4000-8000-000000000002',
        },
      ]);
      const unmarkedResolution = await queryAsRole<{
        tenant_id: string;
        checkout_id: string;
      }>(
        `select tenant_id, checkout_id
         from app_private.resolve_webhook_checkout_by_order('order_rls_restart')`,
        { tenantId: '' },
      );
      expect(unmarkedResolution).toEqual([]);
      const generalWebhookCheckoutRead = await queryAsRole<{
        tenant_id: string;
        id: string;
      }>(
        `select tenant_id, id
         from payments.checkout_sessions
         where razorpay_order_id = 'order_rls_restart'`,
        { tenantId: '', serviceContext: 'webhook' },
      );
      expect(generalWebhookCheckoutRead).toEqual([]);
      const crossTenantAttribution = await queryAsRole<{ event_id: string }>(
        `update integration.inbox_events
         set tenant_id = 'northstar-demo-in',
             state = 'attributed',
             resolved_at = now()
         where provider = 'razorpay'
           and event_id = 'evt_rls_indigo'
         returning event_id`,
        { tenantId: 'northstar-demo-in', serviceContext: 'webhook' },
      );
      expect(crossTenantAttribution).toEqual([]);

      const deniedActors = [
        {
          label: 'viewer',
          userId: '01000000-0000-4000-8000-000000000003',
          tenantId: 'harbor-spice-in',
          productId: '31000000-0000-4000-8000-000000000001',
        },
        {
          label: 'support',
          userId: '01000000-0000-4000-8000-000000000002',
          tenantId: 'indigo-desk-in',
          productId: '21000000-0000-4000-8000-000000000001',
        },
        {
          label: 'operator',
          userId: '01000000-0000-4000-8000-000000000005',
          tenantId: 'northstar-demo-in',
          productId: '11000000-0000-4000-8000-000000000001',
        },
        {
          label: 'auditor',
          userId: '01000000-0000-4000-8000-000000000006',
          tenantId: 'northstar-demo-in',
          productId: '11000000-0000-4000-8000-000000000001',
        },
      ] as const;
      for (const actor of deniedActors) {
        const context = { userId: actor.userId, tenantId: actor.tenantId };
        expect(
          await queryAsRole(
            `delete from identity.tenants where id = '${actor.tenantId}' returning id`,
            context,
          ),
          `${actor.label} tenant delete`,
        ).toEqual([]);
        expect(
          await queryAsRole(
            `delete from identity.profiles where user_id = '${actor.userId}' returning user_id`,
            context,
          ),
          `${actor.label} profile delete`,
        ).toEqual([]);
        expect(
          await queryAsRole(
            `delete from catalog.products where id = '${actor.productId}' returning id`,
            context,
          ),
          `${actor.label} catalog delete`,
        ).toEqual([]);
        expect(
          await queryAsRole(
            `delete from policy.shop_policies where tenant_id = '${actor.tenantId}' returning tenant_id`,
            context,
          ),
          `${actor.label} policy delete`,
        ).toEqual([]);
      }

      const ownerCatalogDelete = await queryAsRole<{ id: string }>(
        `delete from catalog.products
         where id = '11000000-0000-4000-8000-000000000001'
         returning id`,
        {
          userId: '01000000-0000-4000-8000-000000000001',
          tenantId: 'northstar-demo-in',
        },
      );
      expect(ownerCatalogDelete).toEqual([{ id: '11000000-0000-4000-8000-000000000001' }]);
      const adminPolicyDelete = await queryAsRole<{ tenant_id: string }>(
        `delete from policy.shop_policies
         where tenant_id = 'northstar-demo-in'
         returning tenant_id`,
        {
          userId: '01000000-0000-4000-8000-000000000004',
          tenantId: 'northstar-demo-in',
        },
      );
      expect(adminPolicyDelete).toEqual([{ tenant_id: 'northstar-demo-in' }]);

      await sql`
        update identity.users
        set status = 'disabled'
        where id = '01000000-0000-4000-8000-000000000001'
      `.execute(db);
      const disabledAccess = await queryAsRole<{ inventory: number }>(
        `select count(*)::int as inventory from catalog.inventory`,
        {
          userId: '01000000-0000-4000-8000-000000000001',
          tenantId: 'northstar-demo-in',
        },
      );
      expect(disabledAccess[0]?.inventory).toBe(0);
      const selfReactivation = await queryAsRole<{ id: string }>(
        `update identity.users
         set status = 'active'
         where id = '01000000-0000-4000-8000-000000000001'
         returning id`,
        {
          userId: '01000000-0000-4000-8000-000000000001',
          tenantId: 'northstar-demo-in',
        },
      );
      expect(selfReactivation).toEqual([]);
      await sql`
        update identity.users
        set status = 'active'
        where id = '01000000-0000-4000-8000-000000000001'
      `.execute(db);

      await sql`
        update identity.tenants
        set status = 'suspended'
        where id = 'northstar-demo-in'
      `.execute(db);
      const suspendedAccess = await queryAsRole<{ inventory: number }>(
        `select count(*)::int as inventory from catalog.inventory`,
        {
          userId: '01000000-0000-4000-8000-000000000001',
          tenantId: 'northstar-demo-in',
        },
      );
      expect(suspendedAccess[0]?.inventory).toBe(0);
      await sql`
        update identity.tenants
        set status = 'active'
        where id = 'northstar-demo-in'
      `.execute(db);

      await sql`
        update catalog.shops
        set status = 'draft', published_at = null
        where tenant_id = 'harbor-spice-in'
      `.execute(db);
      const unpublishedHidden = await queryAsRole<{
        shops: number;
        products: number;
        variants: number;
      }>(
        `select
          (select count(*)::int from catalog.shops) as shops,
          (select count(*)::int from catalog.products) as products,
          (select count(*)::int from catalog.variants) as variants`,
        { tenantId: '', serviceContext: 'public_catalog' },
      );
      expect(unpublishedHidden[0]).toEqual({ shops: 5, products: 33, variants: 33 });
    } finally {
      await client.end();
    }
  }, 30_000);
});
