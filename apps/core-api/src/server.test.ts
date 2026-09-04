import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildServer } from './server.js';
import { authHeaders, testAuthVerifier, testTenantRepository } from './testing/security.js';

describe('core-api health', () => {
  it('does not reset or consult the identity process kill-switch map at startup', async () => {
    const source = await readFile(fileURLToPath(new URL('./server.ts', import.meta.url)), 'utf8');

    expect(source).not.toContain('resetKillSwitches');
    expect(source).not.toContain("from '@charter/identity'");
  });

  it('supplies the configured Razorpay reader to recovery in production composition', async () => {
    const source = await readFile(fileURLToPath(new URL('./server.ts', import.meta.url)), 'utf8');
    expect(source).toMatch(
      /createRecoveryRuntime\(\s*config,\s*options\.fetch,\s*tenantRepository,\s*razorpay,\s*persist/,
    );
  });

  it('reports test mode without exposing secrets', async () => {
    const { app } = await buildServer(
      {
        DATABASE_URL: 'postgres://charter:charter@127.0.0.1:5432/charter',
        CHARTER_ENV: 'test',
        RAZORPAY_MODE: 'test',
        RAZORPAY_KEY_ID: 'rzp_test_x',
        RAZORPAY_KEY_SECRET: 'hidden',
      },
      { authVerifier: testAuthVerifier(), tenantRepository: testTenantRepository() },
    );
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.razorpayMode).toBe('test');
    expect(JSON.stringify(body)).not.toContain('hidden');
    expect(body.fireworksConfigured).toBe(false);
    expect(body.langfuseConfigured).toBe(false);
    expect(body.vapiConfigured).toBe(false);
    expect(body.agentmailConfigured).toBe(false);
    const turns = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: authHeaders('buyer'),
      payload: { shopSlug: 'northstar' },
    });
    expect(turns.statusCode).toBe(200);
    const created = turns.json() as { id: string };
    const fallback = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${created.id}/turns`,
      headers: authHeaders('buyer'),
      payload: { text: 'what products are available', shopSlug: 'northstar' },
    });
    expect(fallback.statusCode).toBe(200);
    expect(fallback.json().reply).toMatch(/PocketGrind|Trail|press|filter|Available items/i);
    expect(fallback.json().error).toBeUndefined();
    await app.close();
  });

  it('publishes the voice model endpoint under the API prefix', async () => {
    const { app } = await buildServer({
      DATABASE_URL: 'postgres://charter:charter@127.0.0.1:5432/charter',
      CHARTER_ENV: 'test',
      RAZORPAY_MODE: 'test',
      CHARTER_PUBLIC_URL: 'https://charter.example',
      VAPI_PUBLIC_KEY: 'vapi_public_test',
    });
    const response = await app.inject({ method: 'GET', url: '/api/v1/concierge/config' });
    expect(response.statusCode).toBe(200);
    expect(response.json().voiceModelBase).toBe('https://charter.example/api/v1/voice');
    await app.close();
  });

  it('publishes an honest agent discovery document without protocol certification claims', async () => {
    const { app } = await buildServer(
      {
        DATABASE_URL: 'postgres://charter:charter@127.0.0.1:5432/charter',
        CHARTER_ENV: 'test',
        RAZORPAY_MODE: 'test',
        CHARTER_PUBLIC_URL: 'https://charter.example',
      },
      { authVerifier: testAuthVerifier(), tenantRepository: testTenantRepository() },
    );
    const response = await app.inject({
      method: 'GET',
      url: '/.well-known/charter-commerce.json',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.protocol).toBe('charter-commerce');
    expect(body.protocolStatus).toBe('evaluator-http-contract');
    expect(body.notCertified).toEqual(
      expect.arrayContaining(['UCP', 'ACP', 'AP2', 'Gemini', 'Alexa']),
    );
    expect(body.apiPrefix).toBe('/api');
    expect(body.payment.liveSettlement).toBe(false);
    expect(body.environment.synthetic).toBe(true);
    expect(body.auth.type).toBe('bearer-jwt');
    expect(body.mcp.call).toBe('/mcp/call');
    expect(body.contracts.checkout.complete.path).toBe('/api/v1/quotes/{id}/checkout');
    expect(body.resources.checkout).toBe('/api/v1/quotes/{id}/checkout');
    expect(body.directoryQuery.path).toBe('/api/v1/shops');
    expect(body.directoryQuery.params.sort).toMatch(/rating/);
    expect(body.directoryQuery.ranking).toMatch(/rating desc/i);
    await app.close();
  });

  it('serves SPA deep links without swallowing API 404s', async () => {
    const spaRoot = await mkdtemp(join(tmpdir(), 'charter-spa-'));
    await writeFile(join(spaRoot, 'index.html'), '<!doctype html><title>Charter SPA</title>');
    const { app } = await buildServer(
      {
        DATABASE_URL: 'postgres://charter:charter@127.0.0.1:5432/charter',
        CHARTER_ENV: 'test',
        RAZORPAY_MODE: 'test',
      },
      { spaRoot },
    );

    try {
      const page = await app.inject({ method: 'GET', url: '/shops/northstar' });
      expect(page.statusCode).toBe(200);
      expect(page.headers['content-type']).toContain('text/html');
      expect(page.body).toContain('Northstar Travel Coffee');

      const missingApi = await app.inject({ method: 'GET', url: '/api/v1/does-not-exist' });
      expect(missingApi.statusCode).toBe(404);
      expect(missingApi.headers['content-type']).toContain('application/json');
      expect(missingApi.body).not.toContain('<title>Charter SPA</title>');
    } finally {
      await app.close();
      await rm(spaRoot, { recursive: true, force: true });
    }
  });

  it('serves robots and a sitemap containing only published shop URLs', async () => {
    const spaRoot = await mkdtemp(join(tmpdir(), 'charter-seo-'));
    await writeFile(
      join(spaRoot, 'index.html'),
      '<!doctype html><html><head><title>Charter</title></head><body><div id="root"></div></body></html>',
    );
    const tenantRepository = testTenantRepository();
    tenantRepository.state.shops.set('draft-private-in', {
      tenantId: 'draft-private-in',
      slug: 'draft-private',
      name: 'Draft Private',
      label: 'Members only label',
      blurb: 'Not public',
      currency: 'INR',
      status: 'draft',
      synthetic: false,
    });
    const { app } = await buildServer(
      {
        DATABASE_URL: 'postgres://charter:charter@127.0.0.1:5432/charter',
        CHARTER_ENV: 'test',
        RAZORPAY_MODE: 'test',
        CHARTER_PUBLIC_URL: 'https://charter.example',
      },
      { spaRoot, tenantRepository },
    );

    try {
      const robots = await app.inject({ method: 'GET', url: '/robots.txt' });
      const sitemap = await app.inject({ method: 'GET', url: '/sitemap.xml' });
      const directory = await app.inject({ method: 'GET', url: '/shops' });

      expect(robots.statusCode).toBe(200);
      expect(robots.headers['content-type']).toContain('text/plain');
      expect(robots.body).toContain('User-agent: *');
      expect(robots.body).toContain('Sitemap: https://charter.example/sitemap.xml');
      expect(sitemap.statusCode).toBe(200);
      expect(sitemap.headers['content-type']).toContain('application/xml');
      expect(sitemap.body).toContain('<loc>https://charter.example/agents</loc>');
      expect(sitemap.body).toContain('<loc>https://charter.example/shops/northstar</loc>');
      expect(sitemap.body).toContain('<loc>https://charter.example/shops/indigo-desk</loc>');
      expect(sitemap.body).not.toContain('draft-private');
      expect(sitemap.body).not.toContain('Members only label');
      const agents = await app.inject({ method: 'GET', url: '/agents' });
      expect(agents.statusCode).toBe(200);
      expect(agents.body).toContain(
        '<title data-charter-head="title">Agents and MCP — Charter</title>',
      );
      expect(directory.statusCode).toBe(200);
      expect(directory.body).toContain(
        '<title data-charter-head="title">Shop directory — Charter</title>',
      );
      expect(directory.body).toContain(
        '<link data-charter-head="canonical" rel="canonical" href="https://charter.example/shops">',
      );
    } finally {
      await app.close();
      await rm(spaRoot, { recursive: true, force: true });
    }
  });

  it('renders safe direct shop metadata and stock-derived Product offers', async () => {
    const spaRoot = await mkdtemp(join(tmpdir(), 'charter-shop-html-'));
    await writeFile(
      join(spaRoot, 'index.html'),
      '<!doctype html><html><head><title>Charter</title></head><body><div id="root"></div></body></html>',
    );
    const tenantRepository = testTenantRepository();
    const northstar = tenantRepository.state.shops.get('northstar-demo-in')!;
    northstar.name = 'Northstar </title><script>alert("shop")</script>';
    northstar.blurb = 'Coffee "quoted" <img src=x onerror=alert(1)>';
    const firstItem = tenantRepository.state.catalog.get('northstar-demo-in')![0]!;
    firstItem.title = '</script><script>alert("product")</script>';
    const { app } = await buildServer(
      {
        DATABASE_URL: 'postgres://charter:charter@127.0.0.1:5432/charter',
        CHARTER_ENV: 'test',
        RAZORPAY_MODE: 'test',
        CHARTER_PUBLIC_URL: 'https://charter.example',
      },
      { spaRoot, tenantRepository },
    );

    try {
      const page = await app.inject({ method: 'GET', url: '/shops/northstar?ref=shared' });

      expect(page.statusCode).toBe(200);
      expect(page.headers['content-type']).toContain('text/html');
      expect(page.headers['x-content-type-options']).toBe('nosniff');
      expect(page.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
      expect(page.body).toContain(
        '<link data-charter-head="canonical" rel="canonical" href="https://charter.example/shops/northstar">',
      );
      expect(page.body).toContain(
        '<meta data-charter-head="og:type" property="og:type" content="website">',
      );
      expect(page.body).toContain('&lt;/title&gt;&lt;script&gt;');
      expect(page.body).not.toContain('<script>alert("shop")</script>');
      expect(page.body).not.toContain('</script><script>alert("product")</script>');

      const jsonLdSource =
        /<script data-charter-head="jsonld" type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(
          page.body,
        )?.[1];
      expect(jsonLdSource).toBeDefined();
      const jsonLd = JSON.parse(jsonLdSource!) as {
        '@type': string;
        hasOfferCatalog: {
          itemListElement: Array<{
            item: {
              '@type': string;
              sku: string;
              offers: { '@type': string; availability: string; price: string };
            };
          }>;
        };
      };
      expect(jsonLd['@type']).toBe('Store');
      const grinder = jsonLd.hasOfferCatalog.itemListElement.find(
        (entry) => entry.item.sku === 'grinder.pocket-lite',
      )!.item;
      const kettle = jsonLd.hasOfferCatalog.itemListElement.find(
        (entry) => entry.item.sku === 'kettle.road-mini',
      )!.item;
      expect(grinder).toMatchObject({
        '@type': 'Product',
        offers: {
          '@type': 'Offer',
          availability: 'https://schema.org/InStock',
          price: '999.00',
        },
      });
      expect(kettle.offers.availability).toBe('https://schema.org/OutOfStock');
    } finally {
      await app.close();
      await rm(spaRoot, { recursive: true, force: true });
    }
  });
});
