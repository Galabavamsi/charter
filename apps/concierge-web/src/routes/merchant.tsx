import { useState } from 'react';
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router';
import { useAccount, useApi } from '../account';
import { useAuth } from '../auth';
import { canReadOrders, canReadRecovery, merchantSectionForRole } from '../capabilities';
import { FormNotice } from '../merchant-components';
import { merchantCommandKey, merchantErrorMessage } from '../merchant-api';
import { Onboard } from '../Onboard';
import { RouteStatus } from '../route-guards';

const merchantSections = [
  ['overview', 'Overview'],
  ['catalog', 'Catalog'],
  ['orders', 'Orders'],
  ['recovery', 'Recovery'],
  ['rules', 'Rules'],
  ['settings', 'Settings'],
] as const;

export function MerchantIndexPage() {
  const api = useApi();
  const { account, refresh } = useAccount();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [blurb, setBlurb] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shops = account?.shops ?? [];
  const firstShop = shops.length === 0;

  async function createShop() {
    setBusy(true);
    setError(null);
    try {
      const response = await api<{ shop: { tenantId: string } }>('/v1/shops', {
        method: 'POST',
        headers: { 'idempotency-key': merchantCommandKey('first-shop') },
        body: JSON.stringify({ name: name.trim(), blurb: blurb.trim() }),
      });
      await refresh();
      navigate(`/merchant/shops/${response.shop.tenantId}/overview`);
    } catch (cause) {
      setError(merchantErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const form = (
    <form
      className="merchant-onboarding-form"
      onSubmit={(event) => {
        event.preventDefault();
        void createShop();
      }}
    >
      <label>
        Shop name
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          minLength={2}
          maxLength={120}
          required
          autoComplete="organization"
        />
      </label>
      <label>
        What do you sell?
        <textarea
          value={blurb}
          onChange={(event) => setBlurb(event.target.value)}
          maxLength={500}
          rows={3}
        />
      </label>
      {error ? <FormNotice kind="error">{error}</FormNotice> : null}
      <button type="submit" disabled={busy}>
        {busy ? 'Creating shop…' : 'Create shop'}
      </button>
    </form>
  );

  return (
    <section className="merchant-index fade">
      <p className="eyebrow">Merchant workspace</p>
      <h1 data-route-heading tabIndex={-1}>
        {firstShop ? 'Create your first shop' : 'My shops'}
      </h1>
      <p>
        {firstShop
          ? 'Create the durable shop record this account will own.'
          : 'Choose only from shops where this account has an active membership.'}
      </p>
      {firstShop ? form : null}
      {!firstShop ? (
        <>
          <div className="member-shop-list">
            {shops.map((memberShop) => (
              <Link
                key={memberShop.tenantId}
                to={`/merchant/shops/${memberShop.tenantId}/overview`}
              >
                <span>
                  <strong>{memberShop.name}</strong>
                  <small>
                    {memberShop.slug} · {memberShop.status}
                  </small>
                </span>
                <span>{memberShop.role} →</span>
              </Link>
            ))}
          </div>
          <details className="merchant-create-another">
            <summary>Create another shop</summary>
            {form}
          </details>
        </>
      ) : null}
    </section>
  );
}

export function MerchantShell() {
  const { account } = useAccount();
  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { shopId = '' } = useParams();
  const [guideOpen, setGuideOpen] = useState(false);
  const [switchNotice, setSwitchNotice] = useState('');
  const memberShops = account?.shops ?? [];
  const shop = memberShops.find((candidate) => candidate.tenantId === shopId);
  if (!shop || !auth.session) {
    return (
      <RouteStatus
        alert
        code="403"
        title="Shop access denied"
        body="A verified shop membership is required for this merchant workspace."
      />
    );
  }
  const base = `/merchant/shops/${shop.tenantId}`;
  const finalSegment = location.pathname.split('/').filter(Boolean).at(-1);
  const section = merchantSections.some(([path]) => path === finalSegment)
    ? finalSegment!
    : 'overview';
  const sectionLabel = merchantSections.find(([path]) => path === section)?.[1] ?? 'Overview';
  const allowedSection = merchantSectionForRole(shop.role, section);
  if (allowedSection !== section) {
    return <Navigate to={`${base}/${allowedSection}`} replace />;
  }

  return (
    <section className="merchant-shell">
      <a
        className="skip-link skip-link-merchant"
        href="#merchant-records"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('merchant-records')?.focus();
        }}
      >
        Skip to merchant records
      </a>
      {guideOpen ? (
        <Onboard
          role="merchant"
          userId={auth.session.user.id}
          shopId={shop.tenantId}
          onClose={() => setGuideOpen(false)}
        />
      ) : null}
      <header className="merchant-mast">
        <div>
          <nav className="merchant-breadcrumbs" aria-label="Breadcrumb">
            <Link to="/merchant">My shops</Link>
            <span aria-hidden="true">/</span>
            <span>{shop.name}</span>
            <span aria-hidden="true">/</span>
            <span aria-current="page">{sectionLabel}</span>
          </nav>
          <h1 tabIndex={-1}>{shop.name}</h1>
          <p className="merchant-context-line">
            {shop.role} access · {shop.status}
            {shop.synthetic ? ' · synthetic / test shop' : ''}
          </p>
        </div>
        <label>
          Shop
          <select
            value={shop.tenantId}
            aria-label="Shop"
            onChange={(event) => {
              const nextShop = memberShops.find(
                (candidate) => candidate.tenantId === event.target.value,
              );
              if (!nextShop) {
                return;
              }
              const nextSection = merchantSectionForRole(nextShop.role, section);
              setSwitchNotice(
                nextSection === section
                  ? `Switched to ${nextShop.name} as ${nextShop.role}.`
                  : `Switched to ${nextShop.name} as ${nextShop.role}. Opened ${nextSection} because ${section} is unavailable.`,
              );
              navigate(`/merchant/shops/${nextShop.tenantId}/${nextSection}`);
            }}
          >
            {memberShops.map((memberShop) => (
              <option key={memberShop.tenantId} value={memberShop.tenantId}>
                {memberShop.name} · {memberShop.role}
              </option>
            ))}
          </select>
        </label>
        <p className="sr-only" aria-live="polite">
          {switchNotice}
        </p>
      </header>
      <div className="merchant-layout">
        <aside className="merchant-nav">
          <nav aria-label="Merchant sections">
            {merchantSections
              .filter(
                ([path]) =>
                  (path !== 'orders' || canReadOrders(shop.role)) &&
                  (path !== 'recovery' || canReadRecovery(shop.role)),
              )
              .map(([path, label]) => (
                <NavLink key={path} to={`${base}/${path}`} end>
                  {label}
                </NavLink>
              ))}
          </nav>
          <button type="button" className="sidebar-guide" onClick={() => setGuideOpen(true)}>
            Merchant guide
          </button>
        </aside>
        <div
          id="merchant-records"
          className="merchant-content"
          tabIndex={-1}
          aria-labelledby="merchant-leaf-heading"
        >
          <Outlet />
        </div>
      </div>
    </section>
  );
}

export function MerchantOverviewRedirect() {
  return <Navigate replace to="overview" />;
}
