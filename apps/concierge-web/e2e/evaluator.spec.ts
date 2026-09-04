import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  expectReadableHeading,
  expectReducedMotionDuration,
  expectSkipToMain,
} from './a11y';

const MCP_TOOL_NAMES = [
  'agent.capabilities',
  'catalog.search',
  'catalog.detail',
  'cart.create',
  'cart.get',
  'cart.update',
  'quote.create',
  'checkout.complete',
  'checkout.resume',
  'order.status',
] as const;

async function originServesHealth(request: APIRequestContext): Promise<boolean> {
  try {
    const health = await request.get('/health');
    return health.ok();
  } catch {
    return false;
  }
}

test.describe('Charter evaluator journeys', () => {
  test('public health, honest discovery, MCP tools, robots, sitemap, and shop HTML', async ({
    request,
  }) => {
    test.skip(
      !(await originServesHealth(request)),
      'core-api origin is not serving /health (start core-api or use test:e2e:live)',
    );

    const health = await request.get('/health');
    expect(health.ok()).toBeTruthy();
    const healthBody = (await health.json()) as { ok?: boolean; razorpayMode?: string };
    expect(healthBody.ok).toBe(true);
    expect(healthBody.razorpayMode).toBe('test');

    const discovery = await request.get('/.well-known/charter-commerce.json');
    expect(discovery.ok()).toBeTruthy();
    const body = (await discovery.json()) as {
      protocolStatus?: string;
      notCertified?: string[];
      mcp?: { tools?: string; call?: string; protocolStatus?: string };
      environment?: { liveSettlement?: boolean };
    };
    expect(body.protocolStatus).toBe('evaluator-http-contract');
    expect(body.environment?.liveSettlement).toBe(false);
    expect(body.notCertified).toEqual(
      expect.arrayContaining(['UCP', 'ACP', 'AP2', 'Gemini', 'Alexa']),
    );
    expect(body.mcp?.tools).toBe('/mcp/tools');
    expect(body.mcp?.call).toBe('/mcp/call');
    expect(body.mcp?.protocolStatus).toBe('evaluator-http-adapter');

    const alias = await request.get('/api/.well-known/agent-commerce');
    expect(alias.ok()).toBeTruthy();
    const aliasBody = (await alias.json()) as {
      protocolStatus?: string;
      discovery?: string;
      notCertified?: string[];
    };
    expect(aliasBody.protocolStatus).toBe('evaluator-http-contract');
    expect(aliasBody.discovery).toBe('/.well-known/charter-commerce.json');
    expect(aliasBody.notCertified).toEqual(
      expect.arrayContaining(['UCP', 'ACP', 'AP2', 'Gemini', 'Alexa']),
    );

    const tools = await request.get('/mcp/tools');
    expect(tools.ok()).toBeTruthy();
    const toolBody = (await tools.json()) as {
      protocolStatus?: string;
      certified?: boolean;
      tools?: { name: string }[];
    };
    expect(toolBody.protocolStatus).toBe('evaluator-http-adapter');
    expect(toolBody.certified).toBe(false);
    expect((toolBody.tools ?? []).map((tool) => tool.name)).toEqual([...MCP_TOOL_NAMES]);

    const robots = await request.get('/robots.txt');
    expect(robots.ok()).toBeTruthy();
    const robotsText = await robots.text();
    expect(robotsText).toMatch(/User-agent:\s*\*/i);
    expect(robotsText).toMatch(/Sitemap:/i);

    const sitemap = await request.get('/sitemap.xml');
    expect(sitemap.ok()).toBeTruthy();
    const sitemapText = await sitemap.text();
    expect(sitemapText).toContain('/shops/northstar');

    const shops = await request.get('/shops');
    expect(shops.ok()).toBeTruthy();
    expect(shops.headers()['content-type'] ?? '').toMatch(/text\/html/i);
    const shopsHtml = await shops.text();
    expect(shopsHtml).toMatch(/Shop directory/i);

    const northstar = await request.get('/shops/northstar');
    expect(northstar.ok()).toBeTruthy();
    expect(northstar.headers()['content-type'] ?? '').toMatch(/text\/html/i);
    const northstarHtml = await northstar.text();
    expect(northstarHtml).toMatch(/Northstar Travel Coffee/i);
  });

  test('public home, directory, and auth labels', async ({ page }) => {
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: /Tell Concierge what you want/i }),
    ).toBeVisible();

    await page.goto('/shops');
    await expect(page.getByRole('heading', { name: 'Shop directory' })).toBeVisible();
    await expect(page.getByLabel('Search shops and products')).toBeVisible();

    await page.goto('/auth/sign-in');
    await expect(page.getByRole('heading', { name: 'Sign in to Charter' })).toBeVisible();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  const publicA11ySurfaces = [
    {
      path: '/',
      heading: /Tell Concierge what you want/i,
      requiresNorthstar: false,
    },
    {
      path: '/shops',
      heading: 'Shop directory',
      requiresNorthstar: false,
    },
    {
      path: '/shops/northstar',
      heading: null,
      requiresNorthstar: true,
    },
    {
      path: '/auth/sign-in',
      heading: 'Sign in to Charter',
      requiresNorthstar: false,
    },
  ] as const;

  for (const surface of publicA11ySurfaces) {
    test(`skip-link, reduced-motion, and heading contrast on ${surface.path}`, async ({
      page,
      request,
    }) => {
      if (surface.requiresNorthstar) {
        const shop = await request.get('/api/v1/shops/northstar').catch(() => null);
        test.skip(!shop?.ok(), 'published Northstar storefront is not reachable on this origin');
      }

      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(surface.path);
      const heading = surface.heading
        ? page.getByRole('heading', { name: surface.heading })
        : page.getByRole('heading', { level: 1 });
      await expect(heading).toBeVisible();
      if (surface.requiresNorthstar) {
        await expect(page.getByRole('heading', { name: /not found/i })).toHaveCount(0);
      }
      await expectReadableHeading(heading);
      await expectReducedMotionDuration(heading);
      await expectSkipToMain(page);
    });
  }

  test('public directory opens storefront then Concierge returns to sign-in', async ({
    page,
    request,
  }) => {
    const shop = await request.get('/api/v1/shops/northstar').catch(() => null);
    test.skip(!shop?.ok(), 'published Northstar storefront is not reachable on this origin');

    await page.goto('/shops');
    await expect(page.getByRole('heading', { name: 'Shop directory' })).toBeVisible();
    const card = page.getByRole('link', { name: /Northstar Travel Coffee/i });
    if (await card.count()) {
      await card.click();
    } else {
      await page.goto('/shops/northstar');
    }
    await expect(page).toHaveURL(/\/shops\/northstar/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: /not found/i })).toHaveCount(0);
    await page.getByRole('link', { name: 'Open Concierge' }).click();
    await expect(page).toHaveURL(/\/auth\/sign-in/);
    await expect(page).toHaveURL(/next=/);
    await expect(page.getByRole('heading', { name: 'Sign in to Charter' })).toBeVisible();
  });

  test('auth return from protected and legacy login routes', async ({ page }) => {
    await page.goto('/chats');
    await expect(page).toHaveURL(/\/auth\/sign-in/);
    await expect(page).toHaveURL(/next=/);
    await expect(page.getByRole('heading', { name: 'Sign in to Charter' })).toBeVisible();

    await page.goto('/login');
    await expect(page).toHaveURL(/\/auth\/sign-in/);
    await expect(page.getByRole('heading', { name: 'Sign in to Charter' })).toBeVisible();
  });

  test('public Northstar shop deep link when the storefront API is up', async ({
    page,
    request,
  }) => {
    const shop = await request.get('/api/v1/shops/northstar').catch(() => null);
    test.skip(!shop?.ok(), 'published Northstar storefront is not reachable on this origin');

    await page.goto('/shops/northstar');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: /not found/i })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Open Concierge' })).toBeVisible();
  });

  test('HTTP catalog and MCP catalog.detail agree on Northstar pocket grinder', async ({
    request,
  }) => {
    test.skip(
      !(await originServesHealth(request)),
      'core-api origin is not serving /health (start core-api or use test:e2e:live)',
    );

    const http = await request.get('/api/v1/shops/northstar?sku=grinder.pocket-lite');
    expect(http.ok()).toBeTruthy();
    const mcp = await request.post('/mcp/call', {
      data: {
        name: 'catalog.detail',
        arguments: { slug: 'northstar', sku: 'grinder.pocket-lite' },
      },
    });
    expect(mcp.ok()).toBeTruthy();
    const httpBody = (await http.json()) as {
      items?: Array<{ sku: string; priceMinor: string; title: string }>;
      merchant?: { currency?: string };
    };
    const mcpBody = (await mcp.json()) as {
      items?: Array<{ sku: string; priceMinor: string; title: string }>;
      merchant?: { currency?: string };
    };
    const httpItem = (httpBody.items ?? []).find((item) => item.sku === 'grinder.pocket-lite');
    const mcpItem = (mcpBody.items ?? []).find((item) => item.sku === 'grinder.pocket-lite');
    expect(httpItem).toBeTruthy();
    expect(mcpItem).toEqual(httpItem);
    expect(mcpBody.merchant?.currency ?? 'INR').toBe(httpBody.merchant?.currency ?? 'INR');
  });

});
