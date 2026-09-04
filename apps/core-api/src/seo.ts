import type { PublicShop, PublicShopCatalogResult } from './tenant/repository.js';
import { buildStoreStructuredData, publicShopCanonical } from '@charter/domain-shared';

export function safePublicOrigin(configuredUrl: string, requestOrigin: string): string {
  for (const candidate of [configuredUrl, requestOrigin, 'http://localhost']) {
    try {
      const url = new URL(candidate);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        return url.origin;
      }
    } catch {
      // Continue to the next safe fallback.
    }
  }
  return 'http://localhost';
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeXml(value: string): string {
  return escapeHtml(value);
}

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

export function renderShopIndexHtml(
  indexHtml: string,
  publicOrigin: string,
  result: PublicShopCatalogResult,
): string {
  const canonical = publicShopCanonical(publicOrigin, result.shop.slug);
  const title = `${result.shop.name} — Charter`;
  const tags = [
    `<title data-charter-head="title">${escapeHtml(title)}</title>`,
    `<meta data-charter-head="description" name="description" content="${escapeHtml(result.shop.blurb)}">`,
    `<link data-charter-head="canonical" rel="canonical" href="${escapeHtml(canonical)}">`,
    '<meta data-charter-head="og:type" property="og:type" content="website">',
    `<meta data-charter-head="og:title" property="og:title" content="${escapeHtml(title)}">`,
    `<meta data-charter-head="og:description" property="og:description" content="${escapeHtml(result.shop.blurb)}">`,
    `<meta data-charter-head="og:url" property="og:url" content="${escapeHtml(canonical)}">`,
    `<script data-charter-head="jsonld" type="application/ld+json">${safeJson(
      buildStoreStructuredData({
        canonical,
        shop: {
          name: result.shop.name,
          description: result.shop.blurb,
          currency: result.shop.currency,
        },
        items: result.items.map((item) => ({
          ...item,
          category: item.category?.title ?? null,
        })),
      }),
    )}</script>`,
  ].join('\n');
  const withoutTitle = indexHtml.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, '');
  return /<\/head>/i.test(withoutTitle)
    ? withoutTitle.replace(/<\/head>/i, `${tags}\n</head>`)
    : `${withoutTitle}\n${tags}`;
}

export function renderAgentsIndexHtml(indexHtml: string, publicOrigin: string): string {
  const canonical = `${publicOrigin}/agents`;
  const title = 'Agents and MCP — Charter';
  const description =
    'Honest MCP and HTTP discovery for AI buyers. Same catalog and checkout as Concierge. Not a UCP, ACP, AP2, Gemini, or Alexa certification.';
  const tags = [
    `<title data-charter-head="title">${escapeHtml(title)}</title>`,
    `<meta data-charter-head="description" name="description" content="${escapeHtml(description)}">`,
    `<link data-charter-head="canonical" rel="canonical" href="${escapeHtml(canonical)}">`,
    '<meta data-charter-head="og:type" property="og:type" content="website">',
    `<meta data-charter-head="og:title" property="og:title" content="${escapeHtml(title)}">`,
    `<meta data-charter-head="og:description" property="og:description" content="${escapeHtml(description)}">`,
    `<meta data-charter-head="og:url" property="og:url" content="${escapeHtml(canonical)}">`,
  ].join('\n');
  const withoutTitle = indexHtml.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, '');
  return /<\/head>/i.test(withoutTitle)
    ? withoutTitle.replace(/<\/head>/i, `${tags}\n</head>`)
    : `${withoutTitle}\n${tags}`;
}

export function renderDirectoryIndexHtml(indexHtml: string, publicOrigin: string): string {
  const canonical = `${publicOrigin}/shops`;
  const title = 'Shop directory — Charter';
  const description = 'Browse published Charter shops and their current catalog facts.';
  const tags = [
    `<title data-charter-head="title">${escapeHtml(title)}</title>`,
    `<meta data-charter-head="description" name="description" content="${escapeHtml(description)}">`,
    `<link data-charter-head="canonical" rel="canonical" href="${escapeHtml(canonical)}">`,
    '<meta data-charter-head="og:type" property="og:type" content="website">',
    `<meta data-charter-head="og:title" property="og:title" content="${escapeHtml(title)}">`,
    `<meta data-charter-head="og:description" property="og:description" content="${escapeHtml(description)}">`,
    `<meta data-charter-head="og:url" property="og:url" content="${escapeHtml(canonical)}">`,
  ].join('\n');
  const withoutTitle = indexHtml.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, '');
  return /<\/head>/i.test(withoutTitle)
    ? withoutTitle.replace(/<\/head>/i, `${tags}\n</head>`)
    : `${withoutTitle}\n${tags}`;
}

export function robotsText(publicOrigin: string): string {
  return `User-agent: *\nAllow: /\nSitemap: ${publicOrigin}/sitemap.xml\n`;
}

export function sitemapXml(publicOrigin: string, shops: readonly PublicShop[]): string {
  const staticUrls = ['/', '/shops', '/agents'].map(
    (path) => `  <url><loc>${escapeXml(`${publicOrigin}${path}`)}</loc></url>`,
  );
  const shopUrls = shops.map((shop) => {
    const location = `${publicOrigin}/shops/${encodeURIComponent(shop.slug)}`;
    const lastModified = shop.publishedAt.slice(0, 10);
    return `  <url><loc>${escapeXml(location)}</loc><lastmod>${escapeXml(
      lastModified,
    )}</lastmod></url>`;
  });
  const urls = [...staticUrls, ...shopUrls].join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
