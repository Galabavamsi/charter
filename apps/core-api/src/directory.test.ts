import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '@charter/config';
import { buildServer } from './server.js';
import { testAuthVerifier, testTenantRepository } from './testing/security.js';
import { nextPublicCatalogCursor, parsePublicCatalogQuery } from './tenant/public-catalog-query.js';

const openApps: Array<Awaited<ReturnType<typeof buildServer>>['app']> = [];

async function directoryApp() {
  const tenantRepository = testTenantRepository();
  const { app } = await buildServer(
    {
      DATABASE_URL: 'postgres://charter:charter@127.0.0.1:5432/charter',
      CHARTER_ENV: 'test',
      RAZORPAY_MODE: 'test',
    },
    { authVerifier: testAuthVerifier(), tenantRepository },
  );
  openApps.push(app);
  return { app, tenantRepository };
}

async function directoryAppWithSecret(secret: string) {
  const tenantRepository = testTenantRepository();
  const { app } = await buildServer(
    {
      DATABASE_URL: 'postgres://charter:charter@127.0.0.1:5432/charter',
      CHARTER_ENV: 'test',
      CHARTER_CURSOR_SECRET: secret,
      RAZORPAY_MODE: 'test',
    },
    { authVerifier: testAuthVerifier(), tenantRepository },
  );
  openApps.push(app);
  return { app, tenantRepository };
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe('public shop directory query', () => {
  it('searches published shop, product, and alias text without case sensitivity', async () => {
    const { app } = await directoryApp();

    const alias = await app.inject({
      method: 'GET',
      url: '/api/v1/shops?q=POCKETGRIND',
    });
    const category = await app.inject({
      method: 'GET',
      url: '/api/v1/shops?q=travel%20coffee',
    });

    expect(alias.statusCode).toBe(200);
    expect(alias.json()).toMatchObject({
      total: 1,
      items: [{ slug: 'northstar' }],
      nextCursor: null,
      facets: {
        categories: expect.arrayContaining([
          expect.objectContaining({ slug: 'travel-coffee', title: 'Travel coffee' }),
        ]),
      },
    });
    expect(category.statusCode).toBe(200);
    expect(category.json().items.map((shop: { slug: string }) => shop.slug)).toEqual([
      'northstar',
      'harbor-spice',
    ]);
  });

  it('ranks overlapping category competitors by demo rating then review count then name', async () => {
    const { app } = await directoryApp();

    const byCategory = await app.inject({
      method: 'GET',
      url: '/api/v1/shops?category=travel-coffee&sort=rating',
    });
    const defaultDirectory = await app.inject({
      method: 'GET',
      url: '/api/v1/shops',
    });

    expect(byCategory.statusCode).toBe(200);
    expect(
      byCategory.json().items.map((shop: { slug: string; rating: number }) => shop.slug),
    ).toEqual(['northstar', 'harbor-spice']);
    expect(byCategory.json().items.map((shop: { rating: number }) => shop.rating)).toEqual([
      4.8, 4.2,
    ]);
    expect(byCategory.json().items[0].reviewCount).toBe(128);
    expect(byCategory.json().items[0].synthetic).toBe(true);
    expect(defaultDirectory.json().items.map((shop: { slug: string }) => shop.slug)).toEqual([
      'northstar',
      'sable-atelier',
      'indigo-desk',
      'lotus-gifting',
      'marigold-home',
      'harbor-spice',
    ]);
  });

  it('ranks shops whose catalog text overlaps leftover intent tokens', async () => {
    const { app } = await directoryApp();

    const giftCoffee = await app.inject({
      method: 'GET',
      url: '/api/v1/shops?q=find%20me%20a%20shop%20to%20gift%20coffee&sort=rating',
    });

    expect(giftCoffee.statusCode).toBe(200);
    expect(giftCoffee.json().items.map((shop: { slug: string }) => shop.slug)).toEqual([
      'northstar',
      'sable-atelier',
      'lotus-gifting',
      'marigold-home',
      'harbor-spice',
    ]);
    expect(giftCoffee.json().items[0].rating).toBe(4.8);
  });

  it('ranks a misspelled stationery ask onto the desk shop from live copy', async () => {
    const { app } = await directoryApp();

    const stationery = await app.inject({
      method: 'GET',
      url: '/api/v1/shops?q=i%20want%20to%20buy%20some%20stationaery&sort=rating',
    });

    expect(stationery.statusCode).toBe(200);
    expect(stationery.json().items.map((shop: { slug: string }) => shop.slug)).toEqual([
      'indigo-desk',
    ]);
  });

  it('intersects category, stock, and inclusive minor-unit price filters', async () => {
    const { app } = await directoryApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/shops?category=desk-essentials&inStock=true&minPriceMinor=19900&maxPriceMinor=34900',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      total: 1,
      items: [
        {
          slug: 'indigo-desk',
          startingPriceMinor: '8900',
          categories: [
            expect.objectContaining({ slug: 'desk-essentials', title: 'Desk essentials' }),
          ],
        },
      ],
    });
  });

  it('sorts deterministically and rejects changed or tampered opaque cursors', async () => {
    const { app } = await directoryApp();

    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/shops?sort=name&limit=1',
    });

    expect(first.statusCode).toBe(200);
    expect(first.json().items.map((shop: { name: string }) => shop.name)).toEqual(['Harbor Spice']);
    expect(first.json().total).toBe(6);
    expect(first.json().nextCursor).toEqual(expect.any(String));

    const cursor = encodeURIComponent(first.json().nextCursor as string);
    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/shops?sort=name&limit=1&cursor=${cursor}`,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().items.map((shop: { name: string }) => shop.name)).toEqual(['Indigo Desk']);

    const changedQuery = await app.inject({
      method: 'GET',
      url: `/api/v1/shops?sort=newest&limit=1&cursor=${cursor}`,
    });
    expect(changedQuery.statusCode).toBe(400);
    expect(changedQuery.json().error).toBe('CURSOR_INVALID');

    const tampered = await app.inject({
      method: 'GET',
      url: `/api/v1/shops?sort=name&limit=1&cursor=${encodeURIComponent(
        `${first.json().nextCursor as string}x`,
      )}`,
    });
    expect(tampered.statusCode).toBe(400);
    expect(tampered.json().error).toBe('CURSOR_INVALID');
  });

  it('signs keyset cursors and remains stable when earlier rows mutate', async () => {
    const { app, tenantRepository } = await directoryAppWithSecret(
      'test-directory-cursor-secret-at-least-32-characters',
    );
    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/shops?sort=name&limit=1',
    });
    const cursor = first.json().nextCursor as string;

    tenantRepository.state.shops.set('aardvark-in', {
      tenantId: 'aardvark-in',
      slug: 'aardvark',
      name: 'Aardvark Goods',
      label: 'Aardvark Goods',
      blurb: 'Inserted before the cursor.',
      currency: 'INR',
      status: 'published',
      synthetic: true,
      publishedAt: '2026-01-01T00:00:00.000Z',
    });
    tenantRepository.state.catalog.set('aardvark-in', []);

    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/shops?sort=name&limit=1&cursor=${encodeURIComponent(cursor)}`,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().items.map((shop: { name: string }) => shop.name)).toEqual(['Indigo Desk']);

    const { app: wrongSecretApp } = await directoryAppWithSecret(
      'different-test-cursor-secret-at-least-32-characters',
    );
    const wrongSecret = await wrongSecretApp.inject({
      method: 'GET',
      url: `/api/v1/shops?sort=name&limit=1&cursor=${encodeURIComponent(cursor)}`,
    });
    expect(wrongSecret.statusCode).toBe(400);
    expect(wrongSecret.json().error).toBe('CURSOR_INVALID');
  });

  it('decodes a first-page cursor with the stable default development secret', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://charter:charter@127.0.0.1:5432/charter',
      CHARTER_ENV: 'development',
      RAZORPAY_MODE: 'test',
    });
    expect(config.CHARTER_CURSOR_SECRET).toBe(
      'charter-development-cursor-secret-not-for-deployment',
    );
    const first = parsePublicCatalogQuery(
      { sort: 'name', limit: '1' },
      'shops',
      config.CHARTER_CURSOR_SECRET,
    );
    const cursor = nextPublicCatalogCursor(
      first,
      {
        relevance: 0,
        publishedAt: '2026-01-01T00:00:00.000Z',
        name: 'harbor spice',
        id: 'harbor-spice-in',
        ratingMilli: 4200,
        reviewCount: 36,
      },
      config.CHARTER_CURSOR_SECRET,
    );
    if (!cursor) {
      throw new Error('EXPECTED_DEVELOPMENT_CURSOR');
    }
    const next = parsePublicCatalogQuery(
      { sort: 'name', limit: '1', cursor },
      'shops',
      config.CHARTER_CURSOR_SECRET,
    );

    expect(next.after).toEqual({
      relevance: 0,
      publishedAt: '2026-01-01T00:00:00.000Z',
      name: 'harbor spice',
      id: 'harbor-spice-in',
      ratingMilli: 4200,
      reviewCount: 36,
    });
  });

  it('validates bounds and cursor inputs instead of coercing them', async () => {
    const { app } = await directoryApp();

    for (const url of [
      '/api/v1/shops?limit=0',
      '/api/v1/shops?limit=49',
      '/api/v1/shops?inStock=1',
      '/api/v1/shops?minPriceMinor=200&maxPriceMinor=100',
      '/api/v1/shops?cursor=not-a-cursor',
    ]) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(400);
    }
  });

  it('never reveals draft shops or unpublished catalog rows through public search', async () => {
    const { app, tenantRepository } = await directoryApp();
    tenantRepository.state.shops.set('draft-secret-in', {
      tenantId: 'draft-secret-in',
      slug: 'draft-secret',
      name: 'Draft Secret',
      label: 'Draft Secret internal',
      blurb: 'members only embargo',
      currency: 'INR',
      status: 'draft',
      synthetic: false,
    });
    tenantRepository.state.catalog.set('draft-secret-in', [
      {
        id: 'draft-variant',
        sku: 'draft.sku',
        title: 'Embargo product',
        priceMinor: '12300',
        priceDisplay: '₹123.00',
        stock: 9,
        material: 'other',
        published: true,
        aliases: ['members only'],
      },
    ]);
    const northstar = tenantRepository.state.catalog.get('northstar-demo-in');
    northstar?.push({
      id: 'hidden-variant',
      sku: 'hidden.sku',
      title: 'Internal launch codename',
      priceMinor: '100',
      priceDisplay: '₹1.00',
      stock: 99,
      material: 'other',
      published: false,
      aliases: ['supersecret'],
    });

    const directory = await app.inject({
      method: 'GET',
      url: '/api/v1/shops?q=supersecret',
    });
    const draft = await app.inject({
      method: 'GET',
      url: '/api/v1/shops/draft-secret',
    });

    expect(directory.statusCode).toBe(200);
    expect(directory.json().total).toBe(0);
    expect(draft.statusCode).toBe(404);
    expect(JSON.stringify(directory.json())).not.toContain('Internal launch codename');
    expect(JSON.stringify(directory.json())).not.toContain('members only embargo');
  });
});

describe('public shop catalog query', () => {
  it('supports exact published SKU intent and rejects ambiguous combinations', async () => {
    const { app, tenantRepository } = await directoryApp();
    tenantRepository.state.catalog.get('northstar-demo-in')?.push({
      id: 'alias-outranker',
      productId: 'alias-outranker-product',
      sku: 'different.sku',
      title: 'grinder.pocket-lite',
      priceMinor: '100',
      priceDisplay: '₹1.00',
      stock: 1,
      material: 'other',
      published: true,
      aliases: ['grinder.pocket-lite'],
      category: { slug: 'travel-coffee', title: 'Travel coffee' },
      publishedAt: '2026-02-01T00:00:00.000Z',
    });

    const exact = await app.inject({
      method: 'GET',
      url: '/api/v1/shops/northstar?sku=grinder.pocket-lite',
    });
    expect(exact.statusCode).toBe(200);
    expect(exact.json().items.map((item: { sku: string }) => item.sku)).toEqual([
      'grinder.pocket-lite',
    ]);

    for (const query of ['sku=grinder.pocket-lite&q=grinder', 'sku=grinder.pocket-lite&cursor=x']) {
      const ambiguous = await app.inject({
        method: 'GET',
        url: `/api/v1/shops/northstar?${query}`,
      });
      expect(ambiguous.statusCode).toBe(400);
    }
  });

  it('returns filtered published facts with stable identifiers and merchant provenance', async () => {
    const { app } = await directoryApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/shops/northstar?q=manual%20grinder&category=travel-coffee&inStock=true&minPriceMinor=99900&maxPriceMinor=99900',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      shop: {
        slug: 'northstar',
        synthetic: true,
      },
      total: 1,
      nextCursor: null,
      items: [
        {
          id: expect.any(String),
          productId: expect.any(String),
          sku: 'grinder.pocket-lite',
          title: 'Hand grinder',
          priceMinor: '99900',
          priceDisplay: '₹999.00',
          availableStock: 8,
          category: { slug: 'travel-coffee', title: 'Travel coffee' },
          material: 'steel',
          publishedAt: expect.any(String),
          provenance: 'merchant',
        },
      ],
    });
  });

  it('supports catalog sort, pagination, and stock-only filtering', async () => {
    const { app } = await directoryApp();

    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/shops/northstar?sort=name&inStock=true&limit=2',
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().items.map((item: { title: string }) => item.title)).toEqual([
      'Glass pour-over, 500 ml',
      'Hand grinder',
    ]);
    expect(first.json().total).toBe(7);

    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/shops/northstar?sort=name&inStock=true&limit=2&cursor=${encodeURIComponent(
        first.json().nextCursor as string,
      )}`,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().items).toHaveLength(2);
    expect(second.json().items[0].sku).not.toBe(first.json().items[0].sku);

    const outOfStock = await app.inject({
      method: 'GET',
      url: '/api/v1/shops/northstar?q=kettle',
    });
    const stockedKettle = await app.inject({
      method: 'GET',
      url: '/api/v1/shops/northstar?q=kettle&inStock=true',
    });
    expect(outOfStock.json().total).toBe(1);
    expect(outOfStock.json().items[0].availableStock).toBe(0);
    expect(stockedKettle.json().total).toBe(0);
  });

  it('paginates alias and category matches without duplicates or skips', async () => {
    const { app, tenantRepository } = await directoryApp();
    const catalog = tenantRepository.state.catalog.get('northstar-demo-in');
    expect(catalog).toBeDefined();
    for (const item of catalog?.slice(0, 3) ?? []) {
      item.aliases.push('field kit');
    }

    for (const filter of ['q=field%20kit', 'category=travel-coffee']) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/shops/northstar?sort=name&limit=2&${filter}${
            cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
          }`,
        });
        expect(response.statusCode).toBe(200);
        seen.push(...response.json().items.map((item: { id: string }) => item.id));
        cursor = response.json().nextCursor as string | null;
      } while (cursor);

      const expected = filter.startsWith('q=') ? 3 : catalog?.length;
      expect(seen).toHaveLength(expected ?? 0);
      expect(new Set(seen).size).toBe(seen.length);
    }
  });

  it('keeps full current aggregates when deletion leaves no rows after a cursor', async () => {
    const { app, tenantRepository } = await directoryApp();
    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/shops/northstar?category=travel-coffee&sort=name&limit=2',
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().nextCursor).toEqual(expect.any(String));
    const retainedIds = new Set(
      first.json().items.map((item: { id: string }) => item.id) as string[],
    );
    const catalog = tenantRepository.state.catalog.get('northstar-demo-in') ?? [];
    tenantRepository.state.catalog.set(
      'northstar-demo-in',
      catalog.filter((item) => retainedIds.has(item.id)),
    );

    const afterDeletion = await app.inject({
      method: 'GET',
      url: `/api/v1/shops/northstar?category=travel-coffee&sort=name&limit=2&cursor=${encodeURIComponent(
        first.json().nextCursor as string,
      )}`,
    });

    expect(afterDeletion.statusCode).toBe(200);
    expect(afterDeletion.json()).toMatchObject({
      items: [],
      total: 2,
      nextCursor: null,
      facets: {
        categories: [
          {
            slug: 'travel-coffee',
            title: 'Travel coffee',
            count: 2,
          },
        ],
        inStockCount: 2,
      },
    });
    const prices = first
      .json()
      .items.map((item: { priceMinor: string }) => BigInt(item.priceMinor));
    expect(afterDeletion.json().facets.minPriceMinor).toBe(
      prices.reduce((left: bigint, right: bigint) => (left < right ? left : right)).toString(),
    );
    expect(afterDeletion.json().facets.maxPriceMinor).toBe(
      prices.reduce((left: bigint, right: bigint) => (left > right ? left : right)).toString(),
    );
  });
});

describe('Postgres public directory query structure', () => {
  it('applies public-context keyset predicates and LIMIT plus one in SQL', async () => {
    const source = await readFile(
      new URL('./tenant/postgres-repository.ts', import.meta.url),
      'utf8',
    );

    expect(source).toContain('withPublicCatalogContext(db');
    expect(source).toContain('where ${keyset}');
    expect(source).toContain('limit ${query.limit + 1}');
    expect(source).toContain('metadata as (');
    expect(source).toContain('page as (');
    expect(source).toContain('left join lateral');
    expect(source).not.toContain('readPublicCatalogCandidateItemIds');
    expect(source).not.toContain('searchPublicCatalogSource(source, query');
    expect(source).not.toContain('.slice(query.offset');
  });
});
