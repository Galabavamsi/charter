import {
  CHARTER_COMMERCE_NOT_CERTIFIED,
  CHARTER_COMMERCE_TOOLS,
  buildStoreStructuredData,
  publicShopCanonical,
} from '@charter/domain-shared';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router';
import { useApi } from '../account';
import { ApiError } from '../api';
import { useAuth } from '../auth';
import { DEFAULT_SIGNED_IN_PATH } from '../buyer-session';
import { CatalogThumb } from '../CatalogThumb';
import {
  buyerIntentPath,
  filterUrlSearch,
  inrToMinor,
  publicCatalogSearch,
  shopFilters,
  type PublicDirectoryResponse,
  type PublicFacets,
  type PublicShop,
  type PublicShopResponse,
  type ShopFilterParams,
} from '../shops';
import { RouteStatus } from '../route-guards';

export function HomePage() {
  const auth = useAuth();
  if (auth.loading) {
    return (
      <RouteStatus
        title="Opening Charter"
        body="Checking whether this browser is already signed in."
      />
    );
  }
  if (auth.session) {
    return <Navigate replace to={DEFAULT_SIGNED_IN_PATH} />;
  }
  return (
    <section className="home-page home-hero">
      <div className="home-copy fade">
        <p className="eyebrow">Bounded commerce</p>
        <h1 data-route-heading tabIndex={-1}>
          Shop by talking.
        </h1>
        <p className="home-lede">One conversation. A frozen total. Pay on Razorpay.</p>
        <div className="editorial-actions">
          <Link className="primary-link" to="/auth/sign-in">
            Start shopping
          </Link>
          <Link className="quiet-link" to="/shops">
            Browse shops
          </Link>
        </div>
      </div>
    </section>
  );
}

function useAgentsSeo() {
  useEffect(() => {
    replaceManagedHead(
      managedHeadValues({
        title: 'Agents and MCP — Charter',
        description:
          'Honest MCP and HTTP discovery for AI buyers. Same catalog and checkout as Concierge. Not a UCP, ACP, AP2, Gemini, or Alexa certification.',
        canonical: `${window.location.origin}/agents`,
        type: 'website',
      }),
    );
    return clearManagedHead;
  }, []);
}

export function AgentsPage() {
  useAgentsSeo();
  return (
    <section className="directory-page agents-page">
      <header className="editorial-head fade">
        <div>
          <p className="eyebrow">Agent door · MCP</p>
          <h1 data-route-heading tabIndex={-1}>
            Same catalog. Same checkout. For agents.
          </h1>
        </div>
        <p>
          An external agent uses the same first-party tools as Concierge. Discovery is honest:
          Razorpay test mode, no live settlement, not certified for UCP, ACP, AP2, Gemini, or
          Alexa.
        </p>
      </header>

      <dl className="agent-endpoints">
        <div>
          <dt>Discovery</dt>
          <dd>
            <a href="/.well-known/charter-commerce.json">/.well-known/charter-commerce.json</a>
          </dd>
        </div>
        <div>
          <dt>Alias</dt>
          <dd>
            <a href="/api/.well-known/agent-commerce">/api/.well-known/agent-commerce</a>
          </dd>
        </div>
        <div>
          <dt>MCP tools</dt>
          <dd>
            <a href="/mcp/tools">GET /mcp/tools</a>
          </dd>
        </div>
        <div>
          <dt>MCP call</dt>
          <dd>
            <code>POST /mcp/call</code>
          </dd>
        </div>
      </dl>

      <div className="agent-split">
        <article>
          <h2>How an agent transacts</h2>
          <ol className="agent-steps">
            <li>Read discovery. Check <code>liveSettlement: false</code> and <code>notCertified</code>.</li>
            <li>
              Search a published shop with <code>catalog.search</code> (no login). Example slug:{' '}
              <code>northstar</code>.
            </li>
            <li>Sign in as a buyer. Send that JWT on mutating tools.</li>
            <li>
              Create a cart, freeze a quote, then <code>checkout.complete</code>. Card data never
              enters Charter — hosted Razorpay Checkout is the credential boundary.
            </li>
            <li>
              After a failed pay, <code>checkout.resume</code> reconciles the Order. An unchanged
              quote retries the same Razorpay Order.
            </li>
          </ol>
        </article>
        <aside className="agent-limits" aria-label="What this door is not">
          <p>THE CONTRACT</p>
          <ul>
            <li>Adapter holds no database or Razorpay keys.</li>
            <li>
              Caller-supplied <code>path</code> is ignored. Tools resolve only first-party{' '}
              <code>/api</code>.
            </li>
            <li>
              Not certified: {CHARTER_COMMERCE_NOT_CERTIFIED.join(', ')}.
            </li>
            <li>
              Voice Talk is the spoken human door. MCP is the machine door. Both use the same
              commerce core.
            </li>
          </ul>
        </aside>
      </div>

      <h2>Tools</h2>
      <div className="agent-tools-wrap">
        <table className="agent-tools">
          <caption>MCP tools map to first-party HTTP. Mutations require a buyer JWT.</caption>
          <thead>
            <tr>
              <th scope="col">Tool</th>
              <th scope="col">Auth</th>
              <th scope="col">What it does</th>
            </tr>
          </thead>
          <tbody>
            {CHARTER_COMMERCE_TOOLS.map((tool) => (
              <tr key={tool.name}>
                <th scope="row">
                  <code>{tool.name}</code>
                </th>
                <td>{tool.auth === 'bearer' ? 'Buyer JWT' : 'Public'}</td>
                <td>{tool.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="editorial-actions">
        <Link className="primary-link" to="/shops">
          Browse shops an agent can bind
        </Link>
        <Link className="quiet-link" to="/auth/sign-in">
          Sign in to get a buyer JWT
        </Link>
      </div>
    </section>
  );
}

type FilterFormProps = {
  filters: ShopFilterParams;
  facets: PublicFacets | null;
  searchLabel: string;
  sortLabel: string;
  onApply: (filters: ShopFilterParams) => void;
  onReset: () => void;
};

function validatePriceRange(filters: ShopFilterParams): string | null {
  try {
    const min = inrToMinor(filters.min);
    const max = inrToMinor(filters.max);
    return min !== null && max !== null && BigInt(min) > BigInt(max)
      ? 'Minimum price must not exceed maximum price.'
      : null;
  } catch {
    return 'Enter INR prices with no more than two decimal places.';
  }
}

function CatalogFilters({
  filters,
  facets,
  searchLabel,
  sortLabel,
  onApply,
  onReset,
}: FilterFormProps) {
  const [draft, setDraft] = useState(filters);
  const [validation, setValidation] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(
    () =>
      typeof window === 'undefined' ||
      typeof window.matchMedia !== 'function' ||
      !window.matchMedia('(max-width: 680px)').matches,
  );

  useEffect(() => {
    setDraft(filters);
    setValidation(null);
  }, [filters]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      return;
    }
    const narrow = window.matchMedia('(max-width: 680px)');
    const sync = () => setFiltersOpen(!narrow.matches);
    narrow.addEventListener('change', sync);
    return () => narrow.removeEventListener('change', sync);
  }, []);

  const apply = (next: ShopFilterParams) => {
    const error = validatePriceRange(next);
    setValidation(error);
    if (!error) {
      onApply(next);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    apply(draft);
  };

  return (
    <form className="catalog-filters" onSubmit={submit}>
      <div className="directory-search">
        <label htmlFor="catalog-search">{searchLabel}</label>
        <div>
          <input
            id="catalog-search"
            name="q"
            type="search"
            value={draft.q}
            onChange={(event) => setDraft((current) => ({ ...current, q: event.target.value }))}
          />
          <button type="submit">Search</button>
        </div>
      </div>
      <div className="category-chips" aria-label="Categories">
        <button
          type="button"
          aria-pressed={!filters.category}
          onClick={() => apply({ ...draft, category: '' })}
        >
          All
        </button>
        {(facets?.categories ?? []).map((category) => (
          <button
            key={category.slug}
            type="button"
            aria-pressed={filters.category === category.slug}
            onClick={() => apply({ ...draft, category: category.slug })}
          >
            {category.title}
            <span aria-hidden="true">{category.count}</span>
          </button>
        ))}
      </div>
      <details
        className="filter-disclosure"
        open={filtersOpen}
        onToggle={(event) => setFiltersOpen(event.currentTarget.open)}
      >
        <summary
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              setFiltersOpen((open) => !open);
            }
          }}
        >
          Filters
        </summary>
        <div className="filter-grid">
          <label className="stock-filter">
            <input
              type="checkbox"
              checked={draft.inStock}
              onChange={(event) => {
                const next = { ...draft, inStock: event.target.checked };
                setDraft(next);
                apply(next);
              }}
            />
            In stock only
          </label>
          <label>
            Minimum price in INR
            <input
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              value={draft.min}
              onChange={(event) => setDraft((current) => ({ ...current, min: event.target.value }))}
            />
          </label>
          <label>
            Maximum price in INR
            <input
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              value={draft.max}
              onChange={(event) => setDraft((current) => ({ ...current, max: event.target.value }))}
            />
          </label>
          <label>
            {sortLabel}
            <select
              value={draft.sort}
              onChange={(event) => {
                const next = {
                  ...draft,
                  sort: event.target.value as ShopFilterParams['sort'],
                };
                setDraft(next);
                apply(next);
              }}
            >
              <option value="relevance">Relevance</option>
              <option value="newest">Newest</option>
              <option value="name">Name</option>
            </select>
          </label>
          <button className="apply-filters" type="submit">
            Apply filters
          </button>
          <button className="clear-filters" type="button" onClick={onReset}>
            Clear filters
          </button>
        </div>
      </details>
      {validation ? (
        <p className="filter-error" role="alert">
          {validation}
        </p>
      ) : null}
    </form>
  );
}

function apiPath(base: string, query: URLSearchParams): string {
  const search = query.toString();
  return search ? `${base}?${search}` : base;
}

function LoadingGrid({ label }: { label: string }) {
  return (
    <div className="directory-skeleton" role="status" aria-label={label}>
      {[0, 1, 2].map((item) => (
        <div className="skeleton-card" aria-hidden="true" key={item}>
          <span />
          <span />
          <span />
        </div>
      ))}
    </div>
  );
}

function ShopCard({ shop }: { shop: PublicShop }) {
  return (
    <Link className="shop-card" to={`/shops/${shop.slug}`}>
      <CatalogThumb className="shop-card-thumb" label={shop.name} seed={shop.slug} />
      <span className="shop-card-kicker">Shop</span>
      <h2>{shop.name}</h2>
      <p>{shop.blurb}</p>
      <div className="shop-categories">
        {(shop.categories ?? []).slice(0, 2).map((category) => (
          <span key={category.slug}>{category.title}</span>
        ))}
      </div>
      <dl className="shop-card-facts">
        <div>
          <dt>Catalog</dt>
          <dd>{shop.itemCount} variants</dd>
        </div>
        <div>
          <dt>Stock</dt>
          <dd>{shop.inStockCount > 0 ? `${shop.inStockCount} available` : 'Out of stock'}</dd>
        </div>
      </dl>
      {shop.startingPriceDisplay ? (
        <span className="shop-starting-price">From {shop.startingPriceDisplay}</span>
      ) : null}
      <span className="card-action">View shop</span>
    </Link>
  );
}

type HeadValue = {
  key: string;
  selector: string;
  tag: 'link' | 'meta' | 'title';
  attributes: Record<string, string>;
  text?: string;
};

function replaceManagedHead(values: HeadValue[], jsonLd?: unknown) {
  const activeKeys = new Set(values.map((value) => value.key));
  document.head.querySelectorAll<HTMLElement>('[data-charter-head]').forEach((node) => {
    const key = node.dataset.charterHead ?? '';
    if (!activeKeys.has(key) && key !== 'jsonld') {
      node.remove();
    }
  });
  for (const value of values) {
    const existing =
      document.head.querySelector<HTMLElement>(`[data-charter-head="${value.key}"]`) ??
      document.head.querySelector<HTMLElement>(value.selector);
    const node = existing ?? document.createElement(value.tag);
    for (const [name, content] of Object.entries(value.attributes)) {
      node.setAttribute(name, content);
    }
    if (value.text !== undefined) {
      node.textContent = value.text;
    }
    node.dataset.charterHead = value.key;
    if (!node.isConnected) {
      document.head.append(node);
    }
  }
  const scripts = document.head.querySelectorAll<HTMLScriptElement>(
    '[data-charter-head="jsonld"], script[type="application/ld+json"]',
  );
  scripts.forEach((script, index) => {
    if (index > 0 || jsonLd === undefined) {
      script.remove();
    }
  });
  if (jsonLd !== undefined) {
    const script = scripts[0] ?? document.createElement('script');
    script.type = 'application/ld+json';
    script.dataset.charterHead = 'jsonld';
    script.textContent = JSON.stringify(jsonLd).replace(/</g, '\\u003c');
    if (!script.isConnected) {
      document.head.append(script);
    }
  }
}

function clearManagedHead() {
  document.head.querySelectorAll('[data-charter-head]').forEach((node) => node.remove());
  document.title = 'Charter';
}

function managedHeadValues(input: {
  title: string;
  description: string;
  canonical: string;
  type: string;
}): HeadValue[] {
  return [
    {
      key: 'title',
      selector: 'title',
      tag: 'title',
      attributes: {},
      text: input.title,
    },
    {
      key: 'description',
      selector: 'meta[name="description"]',
      tag: 'meta',
      attributes: { name: 'description', content: input.description },
    },
    {
      key: 'canonical',
      selector: 'link[rel="canonical"]',
      tag: 'link',
      attributes: { rel: 'canonical', href: input.canonical },
    },
    {
      key: 'og:title',
      selector: 'meta[property="og:title"]',
      tag: 'meta',
      attributes: { property: 'og:title', content: input.title },
    },
    {
      key: 'og:description',
      selector: 'meta[property="og:description"]',
      tag: 'meta',
      attributes: { property: 'og:description', content: input.description },
    },
    {
      key: 'og:url',
      selector: 'meta[property="og:url"]',
      tag: 'meta',
      attributes: { property: 'og:url', content: input.canonical },
    },
    {
      key: 'og:type',
      selector: 'meta[property="og:type"]',
      tag: 'meta',
      attributes: { property: 'og:type', content: input.type },
    },
  ];
}

function useDirectorySeo() {
  useEffect(() => {
    const title = 'Shop directory — Charter';
    const description = 'Browse published Charter shops and their current catalog facts.';
    replaceManagedHead(
      managedHeadValues({
        title,
        description,
        canonical: `${window.location.origin}/shops`,
        type: 'website',
      }),
    );
    return clearManagedHead;
  }, []);
}

export function ShopsPage() {
  const api = useApi();
  useDirectorySeo();
  const [searchParams, setSearchParams] = useSearchParams();
  const filterKey = searchParams.toString();
  const filters = useMemo(() => shopFilters(new URLSearchParams(filterKey)), [filterKey]);
  const [result, setResult] = useState<PublicDirectoryResponse | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const loadMoreController = useRef<AbortController | null>(null);

  useEffect(() => {
    const requestGeneration = ++generation.current;
    const controller = new AbortController();
    loadMoreController.current?.abort();
    loadMoreController.current = null;
    setResult(null);
    setState('loading');
    setLoadingMore(false);
    setLoadMoreError(false);
    try {
      const path = apiPath('/v1/shops', publicCatalogSearch(filters));
      void api<PublicDirectoryResponse>(path, { signal: controller.signal })
        .then((body) => {
          if (!controller.signal.aborted && generation.current === requestGeneration) {
            setResult(body);
            setState('ready');
          }
        })
        .catch(() => {
          if (!controller.signal.aborted && generation.current === requestGeneration) {
            setState('error');
          }
        });
    } catch {
      setState('error');
    }
    return () => {
      controller.abort();
    };
  }, [api, filterKey, retry]);

  const apply = (next: ShopFilterParams) => setSearchParams(filterUrlSearch(next));
  const reset = () => setSearchParams(new URLSearchParams());
  const loadMore = async () => {
    if (!result?.nextCursor || loadingMore) {
      return;
    }
    const requestGeneration = generation.current;
    const cursor = result.nextCursor;
    const controller = new AbortController();
    loadMoreController.current?.abort();
    loadMoreController.current = controller;
    setLoadingMore(true);
    setLoadMoreError(false);
    try {
      const next = await api<PublicDirectoryResponse>(
        apiPath('/v1/shops', publicCatalogSearch(filters, cursor)),
        { signal: controller.signal },
      );
      if (!controller.signal.aborted && generation.current === requestGeneration) {
        setResult((current) =>
          current?.nextCursor === cursor
            ? { ...next, items: [...current.items, ...next.items] }
            : current,
        );
      }
    } catch {
      if (!controller.signal.aborted && generation.current === requestGeneration) {
        setLoadMoreError(true);
      }
    } finally {
      if (generation.current === requestGeneration) {
        setLoadingMore(false);
      }
    }
  };

  return (
    <section className="directory-page">
      <header className="directory-mast fade">
        <div>
          <p className="eyebrow">Independent catalogs · public to browse</p>
          <h1 data-route-heading tabIndex={-1}>
            Shop directory
          </h1>
        </div>
        <p>
          Search published shops. Sign in to talk, add lines, lock the total, and pay in Concierge.
        </p>
      </header>
      <CatalogFilters
        filters={filters}
        facets={result?.facets ?? null}
        searchLabel="Search shops and products"
        sortLabel="Sort shops"
        onApply={apply}
        onReset={reset}
      />
      {state === 'loading' ? <LoadingGrid label="Loading shops" /> : null}
      {state === 'error' ? (
        <div className="directory-message" role="alert">
          <h2>We couldn’t load the directory</h2>
          <p>Check your connection and try the published catalog again.</p>
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            Try again
          </button>
        </div>
      ) : null}
      {state === 'ready' && result ? (
        <>
          <p className="result-count" role="status" aria-live="polite">
            {result.total} {result.total === 1 ? 'shop' : 'shops'}
          </p>
          {result.total === 0 ? (
            <div className="directory-message directory-empty">
              <p className="eyebrow">No results</p>
              <h2>No matching shops</h2>
              <p>Remove the current filters to see every published shop.</p>
              <button type="button" onClick={reset}>
                Reset filters
              </button>
            </div>
          ) : (
            <div className="shop-grid">
              {result.items.map((shop) => (
                <ShopCard key={shop.tenantId} shop={shop} />
              ))}
            </div>
          )}
          {result.nextCursor ? (
            <div className="load-more" aria-live="polite">
              <button type="button" disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? 'Loading more shops…' : 'Load more shops'}
              </button>
            </div>
          ) : null}
          {loadMoreError ? (
            <p className="load-more-error" role="alert">
              More shops could not be loaded.{' '}
              <button type="button" onClick={() => void loadMore()}>
                Retry loading more shops
              </button>
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function useShopSeo(result: PublicShopResponse | null) {
  useEffect(() => {
    if (!result) {
      return;
    }
    const title = `${result.shop.name} — Charter`;
    const canonical = publicShopCanonical(window.location.origin, result.shop.slug);
    replaceManagedHead(
      managedHeadValues({
        title,
        description: result.shop.blurb,
        canonical,
        type: 'website',
      }),
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
    );
    return clearManagedHead;
  }, [result]);
}

export function ShopPage() {
  const api = useApi();
  const { slug = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const filterKey = searchParams.toString();
  const filters = useMemo(() => shopFilters(new URLSearchParams(filterKey)), [filterKey]);
  const [result, setResult] = useState<PublicShopResponse | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const loadMoreController = useRef<AbortController | null>(null);
  useShopSeo(result);

  useEffect(() => {
    const requestGeneration = ++generation.current;
    const controller = new AbortController();
    loadMoreController.current?.abort();
    loadMoreController.current = null;
    setResult(null);
    setState('loading');
    setLoadingMore(false);
    setLoadMoreError(false);
    try {
      const path = apiPath(`/v1/shops/${encodeURIComponent(slug)}`, publicCatalogSearch(filters));
      void api<PublicShopResponse>(path, { signal: controller.signal })
        .then((body) => {
          if (!controller.signal.aborted && generation.current === requestGeneration) {
            setResult(body);
            setState('ready');
          }
        })
        .catch((error) => {
          if (!controller.signal.aborted && generation.current === requestGeneration) {
            setState(error instanceof ApiError && error.status === 404 ? 'missing' : 'error');
          }
        });
    } catch {
      setState('error');
    }
    return () => {
      controller.abort();
    };
  }, [api, slug, filterKey, retry]);

  if (state === 'missing') {
    return (
      <RouteStatus code="404" title="Shop not found" body="This public shop link is unavailable." />
    );
  }
  if (state === 'loading' && !result) {
    return (
      <section className="storefront-page">
        <LoadingGrid label="Loading shop catalog" />
      </section>
    );
  }
  if (state === 'error' && !result) {
    return (
      <div className="directory-message storefront-error" role="alert">
        <h1 data-route-heading tabIndex={-1}>
          We couldn’t open this shop
        </h1>
        <button type="button" onClick={() => setRetry((value) => value + 1)}>
          Try again
        </button>
      </div>
    );
  }
  if (!result) {
    return null;
  }

  const apply = (next: ShopFilterParams) => setSearchParams(filterUrlSearch(next));
  const reset = () => setSearchParams(new URLSearchParams());
  const loadMore = async () => {
    if (!result.nextCursor || loadingMore) {
      return;
    }
    const requestGeneration = generation.current;
    const cursor = result.nextCursor;
    const controller = new AbortController();
    loadMoreController.current?.abort();
    loadMoreController.current = controller;
    setLoadingMore(true);
    setLoadMoreError(false);
    try {
      const next = await api<PublicShopResponse>(
        apiPath(`/v1/shops/${encodeURIComponent(slug)}`, publicCatalogSearch(filters, cursor)),
        { signal: controller.signal },
      );
      if (!controller.signal.aborted && generation.current === requestGeneration) {
        setResult((current) =>
          current?.nextCursor === cursor
            ? { ...next, items: [...current.items, ...next.items] }
            : current,
        );
      }
    } catch {
      if (!controller.signal.aborted && generation.current === requestGeneration) {
        setLoadMoreError(true);
      }
    } finally {
      if (generation.current === requestGeneration) {
        setLoadingMore(false);
      }
    }
  };

  return (
    <article className="storefront-page">
      <Link className="back-link" to="/shops">
        Back to shops
      </Link>
      <header className="storefront-mast">
        <div>
          <p className="eyebrow">Public storefront · INR</p>
          <h1 data-route-heading tabIndex={-1}>
            {result.shop.name}
          </h1>
        </div>
        <p>{result.shop.blurb}</p>
        {result.shop.refundPolicy ? (
          <p className="storefront-refund">
            <strong>Refund copy</strong> {result.shop.refundPolicy}
          </p>
        ) : (
          <p className="storefront-refund">This shop has not published a refund policy.</p>
        )}
        <div className="storefront-actions">
          <Link className="primary-link" to={`/buyer/${result.shop.slug}`}>
            Open Concierge
          </Link>
          <p>Catalog below is optional browse. Buy opens Concierge already in context.</p>
        </div>
      </header>
      <CatalogFilters
        filters={filters}
        facets={result.facets}
        searchLabel="Search this shop"
        sortLabel="Sort products"
        onApply={apply}
        onReset={reset}
      />
      <p className="result-count" role="status" aria-live="polite">
        {result.total} {result.total === 1 ? 'product' : 'products'}
      </p>
      {result.total === 0 ? (
        <div className="directory-message directory-empty">
          <h2>No matching products</h2>
          <p>Try a different search or reset the catalog filters.</p>
          <button type="button" onClick={reset}>
            Reset filters
          </button>
        </div>
      ) : (
        <div className="product-grid">
          {result.items.map((item) => {
            const inStock = item.availableStock > 0;
            return (
              <article className="catalog-card" aria-label={item.title} key={item.id}>
                <div className="catalog-card-head">
                  <span>{item.category?.title ?? 'Uncategorized'}</span>
                  <span>{item.material.charAt(0).toUpperCase() + item.material.slice(1)}</span>
                </div>
                <h2>{item.title}</h2>
                <p className="catalog-price">{item.priceDisplay}</p>
                <p className={inStock ? 'stock-copy' : 'stock-copy out'}>
                  {inStock ? `${item.availableStock} available` : 'Out of stock'}
                </p>
                <div className="catalog-actions">
                  {inStock ? (
                    <Link
                      className="buy-link"
                      to={buyerIntentPath(result.shop.slug, 'buy', item.sku)}
                    >
                      Buy
                    </Link>
                  ) : (
                    <button type="button" disabled>
                      Buy
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
      {result.nextCursor ? (
        <div className="load-more" aria-live="polite">
          <button type="button" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? 'Loading more products…' : 'Load more products'}
          </button>
        </div>
      ) : null}
      {loadMoreError ? (
        <p className="load-more-error" role="alert">
          More products could not be loaded.{' '}
          <button type="button" onClick={() => void loadMore()}>
            Retry loading more products
          </button>
        </p>
      ) : null}
    </article>
  );
}

export function CanonicalShopRedirect() {
  const { slug = '' } = useParams();
  return <Navigate replace to={`/shops/${slug}`} />;
}

export function NotFoundPage() {
  return (
    <RouteStatus
      code="404"
      title="Page not found"
      body="That Charter route does not exist. The shop directory is still available."
    />
  );
}
