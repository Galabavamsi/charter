import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NORTHSTAR_TENANT, liveMerchantFactPin, resetMerchantSeeds } from '@charter/catalog';
import {
  addLine,
  assertDurableQuoteFacts,
  assertQuoteFactsFresh,
  createCart,
  freezeQuote,
  loadDurableFactPin,
  resetKernel,
  saveCart,
  saveQuote,
} from '@charter/commerce';
import { loadConfig } from '@charter/config';
import { createDb, sql, type Database, type Kysely } from '@charter/db';
import { hydrateCatalogCache } from './tenant/catalog-cache.js';
import { createPostgresTenantRepository } from './tenant/postgres-repository.js';

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

describeWithPostgres('charter_app quote fact pinning', () => {
  let db: Kysely<Database>;
  let appDb: Kysely<Database>;

  async function deleteQuoteAndCart(quoteId: string, cartId: string): Promise<void> {
    await sql`delete from commerce.offer_redemptions where quote_id = ${quoteId}::uuid`.execute(db);
    await sql`delete from commerce.quote_lines where quote_id = ${quoteId}::uuid`.execute(db);
    await sql`delete from commerce.quotes where id = ${quoteId}::uuid`.execute(db);
    await sql`delete from commerce.cart_lines where cart_id = ${cartId}::uuid`.execute(db);
    await sql`delete from commerce.carts where id = ${cartId}::uuid`.execute(db);
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
    await appDb?.destroy();
    await db?.destroy();
  });

  it('fails closed when durable catalog price changes after a frozen quote', async () => {
    resetKernel();
    resetMerchantSeeds();
    const repository = createPostgresTenantRepository(appDb);
    const shop = await repository.findShopBySlug('northstar');
    if (!shop) {
      throw new Error('NORTHSTAR_SHOP_MISSING');
    }
    await hydrateCatalogCache(repository, shop);
    expect(liveMerchantFactPin(NORTHSTAR_TENANT)).toEqual(
      await loadDurableFactPin(appDb, NORTHSTAR_TENANT),
    );
    const cart = createCart(NORTHSTAR_TENANT);
    addLine(cart.id, 'brewer.trailpress-steel-750');
    addLine(cart.id, 'grinder.pocket-lite');
    addLine(cart.id, 'filters.travel-30');
    const quote = freezeQuote(cart.id);
    await saveCart(appDb, cart);
    await saveQuote(appDb, quote);
    await expect(assertDurableQuoteFacts(appDb, quote)).resolves.toBeUndefined();

    try {
      await sql`
        update catalog.variants
        set price_minor = price_minor + 100,
            version = version + 1
        where tenant_id = ${NORTHSTAR_TENANT}
          and sku = 'grinder.pocket-lite'
      `.execute(db);

      await expect(assertDurableQuoteFacts(appDb, quote)).rejects.toThrow('FACTS_STALE');
    } finally {
      await sql`
        update catalog.variants
        set price_minor = price_minor - 100,
            version = version + 1
        where tenant_id = ${NORTHSTAR_TENANT}
          and sku = 'grinder.pocket-lite'
      `.execute(db);
      await deleteQuoteAndCart(quote.id, cart.id);
      resetMerchantSeeds();
    }
  });

  it('enforces persisted stack budget and margin after a charter_app policy reload', async () => {
    resetKernel();
    resetMerchantSeeds();
    const repository = createPostgresTenantRepository(appDb);
    const shop = await repository.findShopBySlug('northstar');
    if (!shop) {
      throw new Error('NORTHSTAR_SHOP_MISSING');
    }
    const before = await sql<{ rules: unknown; version: number }>`
      select rules, version
      from policy.shop_policies
      where tenant_id = ${NORTHSTAR_TENANT}
      limit 1
    `.execute(db);
    const original = before.rows[0];
    if (!original) {
      throw new Error('NORTHSTAR_POLICY_MISSING');
    }

    try {
      await sql`
        update policy.shop_policies
        set rules = ${JSON.stringify({
          offers: [
            {
              id: 'filters_bundle',
              discount_minor: 10000,
              required_sku_groups: [['filters.travel-30']],
              stackable: true,
              margin_floor_minor: 240000,
              budget_remaining_minor: 10000,
              max_redemptions: 8,
              redemptions: 0,
              expires_at: '2099-01-01T00:00:00.000Z',
            },
          ],
        })}::jsonb,
            version = version + 1
        where tenant_id = ${NORTHSTAR_TENANT}
      `.execute(db);

      const policy = await repository.getPolicy(NORTHSTAR_TENANT);
      expect(policy?.offers).toEqual([
        expect.objectContaining({
          id: 'filters_bundle',
          discountMinor: 10000n,
          stackable: true,
          marginFloorMinor: 240000n,
          budgetRemainingMinor: 10000n,
          maxRedemptions: 8,
          redemptions: 0,
          expiresAt: '2099-01-01T00:00:00.000Z',
        }),
      ]);
      await hydrateCatalogCache(repository, shop);
      const cart = createCart(NORTHSTAR_TENANT);
      addLine(cart.id, 'brewer.trailpress-steel-750');
      addLine(cart.id, 'grinder.pocket-lite');
      expect(() => addLine(cart.id, 'filters.travel-30')).toThrow('OFFER_MARGIN_FLOOR');
    } finally {
      await sql`
        update policy.shop_policies
        set rules = ${JSON.stringify(original.rules)}::jsonb,
            version = ${original.version}
        where tenant_id = ${NORTHSTAR_TENANT}
      `.execute(db);
      resetMerchantSeeds();
    }
  });

  it('consumes campaign budget durably once and ignores an idempotent saveQuote replay', async () => {
    resetKernel();
    resetMerchantSeeds();
    const repository = createPostgresTenantRepository(appDb);
    const shop = await repository.findShopBySlug('northstar');
    if (!shop) {
      throw new Error('NORTHSTAR_SHOP_MISSING');
    }
    const before = await sql<{ rules: unknown; version: number }>`
      select rules, version
      from policy.shop_policies
      where tenant_id = ${NORTHSTAR_TENANT}
      limit 1
    `.execute(db);
    const original = before.rows[0];
    if (!original) {
      throw new Error('NORTHSTAR_POLICY_MISSING');
    }
    let cartId: string | undefined;
    let quoteId: string | undefined;

    try {
      await sql`
        update policy.shop_policies
        set rules = ${JSON.stringify({
          offers: [
            {
              id: 'filters_bundle',
              discount_minor: 10000,
              required_sku_groups: [['filters.travel-30']],
              stackable: true,
              budget_remaining_minor: 10000,
              max_redemptions: 1,
              redemptions: 0,
            },
          ],
        })}::jsonb,
            version = version + 1
        where tenant_id = ${NORTHSTAR_TENANT}
      `.execute(db);
      await sql`
        delete from commerce.offer_redemptions
        where tenant_id = ${NORTHSTAR_TENANT}
      `.execute(db);
      await hydrateCatalogCache(repository, shop);
      const cart = createCart(NORTHSTAR_TENANT);
      cartId = cart.id;
      addLine(cart.id, 'brewer.trailpress-steel-750');
      addLine(cart.id, 'grinder.pocket-lite');
      addLine(cart.id, 'filters.travel-30');
      const quote = freezeQuote(cart.id);
      quoteId = quote.id;
      expect(quote.discountMinor).toBe(10000n);
      await saveCart(appDb, cart);
      await saveQuote(appDb, quote);
      await saveQuote(appDb, quote);
      const budget = await sql<{ remaining: string; redemptions: number }>`
        select
          (rules -> 'offers' -> 0 ->> 'budget_remaining_minor') as remaining,
          coalesce((rules -> 'offers' -> 0 ->> 'redemptions')::int, 0) as redemptions
        from policy.shop_policies
        where tenant_id = ${NORTHSTAR_TENANT}
      `.execute(db);
      expect(budget.rows[0]).toEqual({ remaining: '0', redemptions: 1 });
      const redemptions = await sql<{ count: number }>`
        select count(*)::int as count
        from commerce.offer_redemptions
        where tenant_id = ${NORTHSTAR_TENANT}
          and quote_id = ${quote.id}::uuid
      `.execute(db);
      expect(redemptions.rows[0]?.count).toBe(1);
      resetKernel();
      await hydrateCatalogCache(repository, shop);
      const secondCart = createCart(NORTHSTAR_TENANT);
      addLine(secondCart.id, 'brewer.trailpress-steel-750');
      addLine(secondCart.id, 'grinder.pocket-lite');
      addLine(secondCart.id, 'filters.travel-30');
      expect(freezeQuote(secondCart.id).discountMinor).toBe(0n);
    } finally {
      if (quoteId && cartId) {
        await deleteQuoteAndCart(quoteId, cartId);
      }
      await sql`
        update policy.shop_policies
        set rules = ${JSON.stringify(original.rules)}::jsonb,
            version = ${original.version}
        where tenant_id = ${NORTHSTAR_TENANT}
      `.execute(db);
      resetMerchantSeeds();
    }
  });

  it('lets a budgeted freeze persist without FACTS_STALE', async () => {
    resetKernel();
    resetMerchantSeeds();
    const repository = createPostgresTenantRepository(appDb);
    const shop = await repository.findShopBySlug('northstar');
    if (!shop) {
      throw new Error('NORTHSTAR_SHOP_MISSING');
    }
    const before = await sql<{ rules: unknown; version: number }>`
      select rules, version
      from policy.shop_policies
      where tenant_id = ${NORTHSTAR_TENANT}
      limit 1
    `.execute(db);
    const original = before.rows[0];
    if (!original) {
      throw new Error('NORTHSTAR_POLICY_MISSING');
    }
    let cartId: string | undefined;
    let quoteId: string | undefined;

    try {
      await sql`
        update policy.shop_policies
        set rules = ${JSON.stringify({
          offers: [
            {
              id: 'filters_bundle',
              discount_minor: 10000,
              required_sku_groups: [['filters.travel-30']],
              stackable: true,
              budget_remaining_minor: 10000,
              max_redemptions: 8,
              redemptions: 0,
            },
          ],
        })}::jsonb,
            version = version + 1
        where tenant_id = ${NORTHSTAR_TENANT}
      `.execute(db);
      await sql`
        delete from commerce.offer_redemptions
        where tenant_id = ${NORTHSTAR_TENANT}
      `.execute(db);
      await hydrateCatalogCache(repository, shop);
      const cart = createCart(NORTHSTAR_TENANT);
      cartId = cart.id;
      addLine(cart.id, 'brewer.trailpress-steel-750');
      addLine(cart.id, 'grinder.pocket-lite');
      addLine(cart.id, 'filters.travel-30');
      const quote = freezeQuote(cart.id);
      quoteId = quote.id;
      expect(quote.discountMinor).toBe(10000n);
      expect(() => assertQuoteFactsFresh(quote)).not.toThrow();
      await saveCart(appDb, cart);
      await expect(assertDurableQuoteFacts(appDb, quote)).resolves.toBeUndefined();
      await saveQuote(appDb, quote);
      await expect(assertDurableQuoteFacts(appDb, quote)).resolves.toBeUndefined();
    } finally {
      if (quoteId && cartId) {
        await deleteQuoteAndCart(quoteId, cartId);
      }
      await sql`
        update policy.shop_policies
        set rules = ${JSON.stringify(original.rules)}::jsonb,
            version = ${original.version}
        where tenant_id = ${NORTHSTAR_TENANT}
      `.execute(db);
      resetMerchantSeeds();
    }
  });

  it('refuses a second hydrated saveQuote when the live budget cannot cover', async () => {
    resetKernel();
    resetMerchantSeeds();
    const repository = createPostgresTenantRepository(appDb);
    const shop = await repository.findShopBySlug('northstar');
    if (!shop) {
      throw new Error('NORTHSTAR_SHOP_MISSING');
    }
    const before = await sql<{ rules: unknown; version: number }>`
      select rules, version
      from policy.shop_policies
      where tenant_id = ${NORTHSTAR_TENANT}
      limit 1
    `.execute(db);
    const original = before.rows[0];
    if (!original) {
      throw new Error('NORTHSTAR_POLICY_MISSING');
    }
    let firstQuoteId: string | undefined;
    let firstCartId: string | undefined;
    let secondQuoteId: string | undefined;
    let secondCartId: string | undefined;

    try {
      await sql`
        update policy.shop_policies
        set rules = ${JSON.stringify({
          offers: [
            {
              id: 'filters_bundle',
              discount_minor: 10000,
              required_sku_groups: [['filters.travel-30']],
              stackable: true,
              budget_remaining_minor: 10000,
              max_redemptions: 1,
              redemptions: 0,
            },
          ],
        })}::jsonb,
            version = version + 1
        where tenant_id = ${NORTHSTAR_TENANT}
      `.execute(db);
      await sql`
        delete from commerce.offer_redemptions
        where tenant_id = ${NORTHSTAR_TENANT}
      `.execute(db);
      await hydrateCatalogCache(repository, shop);
      const firstCart = createCart(NORTHSTAR_TENANT);
      firstCartId = firstCart.id;
      addLine(firstCart.id, 'brewer.trailpress-steel-750');
      addLine(firstCart.id, 'grinder.pocket-lite');
      addLine(firstCart.id, 'filters.travel-30');
      const first = freezeQuote(firstCart.id);
      firstQuoteId = first.id;
      expect(first.discountMinor).toBe(10000n);

      resetKernel();
      await hydrateCatalogCache(repository, shop);
      const secondCart = createCart(NORTHSTAR_TENANT);
      secondCartId = secondCart.id;
      addLine(secondCart.id, 'brewer.trailpress-steel-750');
      addLine(secondCart.id, 'grinder.pocket-lite');
      addLine(secondCart.id, 'filters.travel-30');
      const second = freezeQuote(secondCart.id);
      secondQuoteId = second.id;
      expect(second.discountMinor).toBe(10000n);

      await saveCart(appDb, firstCart);
      await saveCart(appDb, secondCart);
      await sql`
        update policy.shop_policies
        set rules = ${JSON.stringify({
          offers: [
            {
              id: 'filters_bundle',
              discount_minor: 10000,
              required_sku_groups: [['filters.travel-30']],
              stackable: true,
              budget_remaining_minor: 10000,
              max_redemptions: 1,
              redemptions: 0,
            },
          ],
        })}::jsonb
        where tenant_id = ${NORTHSTAR_TENANT}
      `.execute(db);
      await saveQuote(appDb, first);
      const afterFirst = await sql<{ remaining: string; redemptions: number }>`
        select
          (rules -> 'offers' -> 0 ->> 'budget_remaining_minor') as remaining,
          coalesce((rules -> 'offers' -> 0 ->> 'redemptions')::int, 0) as redemptions
        from policy.shop_policies
        where tenant_id = ${NORTHSTAR_TENANT}
      `.execute(db);
      expect(afterFirst.rows[0]).toEqual({ remaining: '0', redemptions: 1 });
      await sql`
        update policy.shop_policies
        set rules = ${JSON.stringify({
          offers: [
            {
              id: 'filters_bundle',
              discount_minor: 10000,
              required_sku_groups: [['filters.travel-30']],
              stackable: true,
              budget_remaining_minor: 10000,
              max_redemptions: 1,
              redemptions: 0,
            },
          ],
        })}::jsonb
        where tenant_id = ${NORTHSTAR_TENANT}
      `.execute(db);
      await expect(saveQuote(appDb, second)).rejects.toThrow(
        /OFFER_BUDGET_EXHAUSTED|OFFER_FREQUENCY_EXHAUSTED/,
      );
      const quotes = await sql<{ count: number }>`
        select count(*)::int as count
        from commerce.quotes
        where tenant_id = ${NORTHSTAR_TENANT}
          and id = ${second.id}::uuid
      `.execute(appDb);
      expect(quotes.rows[0]?.count).toBe(0);
    } finally {
      if (firstQuoteId && firstCartId) {
        await deleteQuoteAndCart(firstQuoteId, firstCartId);
      }
      if (secondQuoteId && secondCartId) {
        await deleteQuoteAndCart(secondQuoteId, secondCartId);
      }
      await sql`
        update policy.shop_policies
        set rules = ${JSON.stringify(original.rules)}::jsonb,
            version = ${original.version}
        where tenant_id = ${NORTHSTAR_TENANT}
      `.execute(db);
      resetMerchantSeeds();
    }
  });

  it('lets leftover campaign budget cover a second quote then refuses a third', async () => {
    resetKernel();
    resetMerchantSeeds();
    const repository = createPostgresTenantRepository(appDb);
    const shop = await repository.findShopBySlug('northstar');
    if (!shop) {
      throw new Error('NORTHSTAR_SHOP_MISSING');
    }
    const before = await sql<{ rules: unknown; version: number }>`
      select rules, version
      from policy.shop_policies
      where tenant_id = ${NORTHSTAR_TENANT}
      limit 1
    `.execute(db);
    const original = before.rows[0];
    if (!original) {
      throw new Error('NORTHSTAR_POLICY_MISSING');
    }
    const twoDiscountBudget = {
      offers: [
        {
          id: 'filters_bundle',
          discount_minor: 10000,
          required_sku_groups: [['filters.travel-30']],
          stackable: true,
          budget_remaining_minor: 20000,
          max_redemptions: 8,
          redemptions: 0,
        },
      ],
    };
    const carts: Array<{ quoteId: string; cartId: string }> = [];

    try {
      await sql`
        update policy.shop_policies
        set rules = ${JSON.stringify(twoDiscountBudget)}::jsonb,
            version = version + 1
        where tenant_id = ${NORTHSTAR_TENANT}
      `.execute(db);
      await sql`
        delete from commerce.offer_redemptions
        where tenant_id = ${NORTHSTAR_TENANT}
      `.execute(db);

      const quotes = [];
      for (let index = 0; index < 3; index += 1) {
        resetKernel();
        await hydrateCatalogCache(repository, shop);
        const cart = createCart(NORTHSTAR_TENANT);
        addLine(cart.id, 'brewer.trailpress-steel-750');
        addLine(cart.id, 'grinder.pocket-lite');
        addLine(cart.id, 'filters.travel-30');
        const quote = freezeQuote(cart.id);
        expect(quote.discountMinor).toBe(10000n);
        carts.push({ quoteId: quote.id, cartId: cart.id });
        quotes.push(quote);
        await saveCart(appDb, cart);
      }

      await saveQuote(appDb, quotes[0]!);
      const afterFirst = await sql<{ remaining: string; redemptions: number }>`
        select
          (rules -> 'offers' -> 0 ->> 'budget_remaining_minor') as remaining,
          coalesce((rules -> 'offers' -> 0 ->> 'redemptions')::int, 0) as redemptions
        from policy.shop_policies
        where tenant_id = ${NORTHSTAR_TENANT}
      `.execute(db);
      expect(afterFirst.rows[0]).toEqual({ remaining: '10000', redemptions: 1 });

      await saveQuote(appDb, quotes[1]!);
      const afterSecond = await sql<{ remaining: string; redemptions: number }>`
        select
          (rules -> 'offers' -> 0 ->> 'budget_remaining_minor') as remaining,
          coalesce((rules -> 'offers' -> 0 ->> 'redemptions')::int, 0) as redemptions
        from policy.shop_policies
        where tenant_id = ${NORTHSTAR_TENANT}
      `.execute(db);
      expect(afterSecond.rows[0]).toEqual({ remaining: '0', redemptions: 2 });

      await expect(saveQuote(appDb, quotes[2]!)).rejects.toThrow('OFFER_BUDGET_EXHAUSTED');
      const persisted = await sql<{ count: number }>`
        select count(*)::int as count
        from commerce.quotes
        where tenant_id = ${NORTHSTAR_TENANT}
          and id = ${quotes[2]!.id}::uuid
      `.execute(appDb);
      expect(persisted.rows[0]?.count).toBe(0);
    } finally {
      for (const row of carts) {
        await deleteQuoteAndCart(row.quoteId, row.cartId);
      }
      await sql`
        update policy.shop_policies
        set rules = ${JSON.stringify(original.rules)}::jsonb,
            version = ${original.version}
        where tenant_id = ${NORTHSTAR_TENANT}
      `.execute(db);
      resetMerchantSeeds();
    }
  });

  it('lets leftover budget-only campaign cover a second quote then refuses a third', async () => {
    resetKernel();
    resetMerchantSeeds();
    const repository = createPostgresTenantRepository(appDb);
    const shop = await repository.findShopBySlug('northstar');
    if (!shop) {
      throw new Error('NORTHSTAR_SHOP_MISSING');
    }
    const before = await sql<{ rules: unknown; version: number }>`
      select rules, version
      from policy.shop_policies
      where tenant_id = ${NORTHSTAR_TENANT}
      limit 1
    `.execute(db);
    const original = before.rows[0];
    if (!original) {
      throw new Error('NORTHSTAR_POLICY_MISSING');
    }
    const twoDiscountBudget = {
      offers: [
        {
          id: 'filters_bundle',
          discount_minor: 10000,
          required_sku_groups: [['filters.travel-30']],
          stackable: true,
          budget_remaining_minor: 20000,
          redemptions: 0,
        },
      ],
    };
    const carts: Array<{ quoteId: string; cartId: string }> = [];

    try {
      await sql`
        update policy.shop_policies
        set rules = ${JSON.stringify(twoDiscountBudget)}::jsonb,
            version = version + 1
        where tenant_id = ${NORTHSTAR_TENANT}
      `.execute(db);
      await sql`
        delete from commerce.offer_redemptions
        where tenant_id = ${NORTHSTAR_TENANT}
      `.execute(db);

      const quotes = [];
      for (let index = 0; index < 3; index += 1) {
        resetKernel();
        await hydrateCatalogCache(repository, shop);
        const cart = createCart(NORTHSTAR_TENANT);
        addLine(cart.id, 'brewer.trailpress-steel-750');
        addLine(cart.id, 'grinder.pocket-lite');
        addLine(cart.id, 'filters.travel-30');
        const quote = freezeQuote(cart.id);
        expect(quote.discountMinor).toBe(10000n);
        carts.push({ quoteId: quote.id, cartId: cart.id });
        quotes.push(quote);
        await saveCart(appDb, cart);
      }

      await saveQuote(appDb, quotes[0]!);
      const afterFirst = await sql<{ remaining: string; redemptions: number }>`
        select
          (rules -> 'offers' -> 0 ->> 'budget_remaining_minor') as remaining,
          coalesce((rules -> 'offers' -> 0 ->> 'redemptions')::int, 0) as redemptions
        from policy.shop_policies
        where tenant_id = ${NORTHSTAR_TENANT}
      `.execute(db);
      expect(afterFirst.rows[0]).toEqual({ remaining: '10000', redemptions: 1 });

      await saveQuote(appDb, quotes[1]!);
      const afterSecond = await sql<{ remaining: string; redemptions: number }>`
        select
          (rules -> 'offers' -> 0 ->> 'budget_remaining_minor') as remaining,
          coalesce((rules -> 'offers' -> 0 ->> 'redemptions')::int, 0) as redemptions
        from policy.shop_policies
        where tenant_id = ${NORTHSTAR_TENANT}
      `.execute(db);
      expect(afterSecond.rows[0]).toEqual({ remaining: '0', redemptions: 2 });

      await expect(saveQuote(appDb, quotes[2]!)).rejects.toThrow('OFFER_BUDGET_EXHAUSTED');
      const persisted = await sql<{ count: number }>`
        select count(*)::int as count
        from commerce.quotes
        where tenant_id = ${NORTHSTAR_TENANT}
          and id = ${quotes[2]!.id}::uuid
      `.execute(appDb);
      expect(persisted.rows[0]?.count).toBe(0);
    } finally {
      for (const row of carts) {
        await deleteQuoteAndCart(row.quoteId, row.cartId);
      }
      await sql`
        update policy.shop_policies
        set rules = ${JSON.stringify(original.rules)}::jsonb,
            version = ${original.version}
        where tenant_id = ${NORTHSTAR_TENANT}
      `.execute(db);
      resetMerchantSeeds();
    }
  });

  it('rejects saveQuote when fact_hash is not a sha256 pin', async () => {
    resetKernel();
    resetMerchantSeeds();
    const repository = createPostgresTenantRepository(appDb);
    const shop = await repository.findShopBySlug('northstar');
    if (!shop) {
      throw new Error('NORTHSTAR_SHOP_MISSING');
    }
    await hydrateCatalogCache(repository, shop);
    const cart = createCart(NORTHSTAR_TENANT);
    addLine(cart.id, 'brewer.trailpress-steel-750');
    const quote = freezeQuote(cart.id);
    await saveCart(appDb, cart);
    await expect(saveQuote(appDb, { ...quote, factHash: '' })).rejects.toThrow('FACTS_UNPINNED');
    await expect(saveQuote(appDb, { ...quote, factHash: 'not-a-pin' })).rejects.toThrow(
      'FACTS_UNPINNED',
    );
    await deleteQuoteAndCart(quote.id, cart.id);
  });
});
