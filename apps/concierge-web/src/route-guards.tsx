import { Navigate, Outlet, useLocation, useParams } from 'react-router';
import type { ShopRole } from './account';
import { useAccount } from './account';
import { useAuth } from './auth';
import { canManageCatalog, canOperateRecovery, canReadControl } from './capabilities';

export function RouteStatus({
  code,
  title,
  body,
  alert = false,
}: {
  code?: string;
  title: string;
  body: string;
  alert?: boolean;
}) {
  return (
    <section className="route-status" role={alert ? 'alert' : undefined}>
      {code ? <p className="status-code">{code}</p> : null}
      <h1 data-route-heading tabIndex={-1}>
        {title}
      </h1>
      <p>{body}</p>
    </section>
  );
}

export function RequireAuth() {
  const { loading, session } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <RouteStatus
        title="Checking your session"
        body="Charter is verifying this account before opening protected work."
      />
    );
  }
  if (!session) {
    const next = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate replace to={`/auth/sign-in?${new URLSearchParams({ next }).toString()}`} />;
  }
  return <Outlet />;
}

function AccountFailure() {
  const { status, error } = useAccount();
  if (status === 'loading' || status === 'idle') {
    return (
      <RouteStatus
        title="Loading account access"
        body="Reading verified shop memberships and platform roles."
      />
    );
  }
  if (status === 'unauthorized') {
    return (
      <RouteStatus
        alert
        code="401"
        title="Authentication required"
        body="This session could not be verified. Sign in again to continue."
      />
    );
  }
  if (status === 'forbidden') {
    return (
      <RouteStatus
        alert
        code="403"
        title="Account access denied"
        body="The verified account does not have access to this workspace."
      />
    );
  }
  if (status === 'error') {
    return (
      <RouteStatus
        alert
        title="Account access unavailable"
        body={error?.message ?? 'Charter could not load account access.'}
      />
    );
  }
  return null;
}

export function RequireAccount() {
  const { status } = useAccount();
  if (status !== 'ready') {
    return <AccountFailure />;
  }
  return <Outlet />;
}

export function RequireShopMembership() {
  const { status, account } = useAccount();
  const { shopId } = useParams();
  if (status !== 'ready') {
    return <AccountFailure />;
  }
  if (!shopId || !account?.shops.some((shop) => shop.tenantId === shopId)) {
    return (
      <RouteStatus
        alert
        code="403"
        title="Shop access denied"
        body="A verified shop membership is required for this merchant workspace."
      />
    );
  }
  return <Outlet />;
}

export function RequirePlatformRole() {
  const { status, account } = useAccount();
  if (status !== 'ready') {
    return <AccountFailure />;
  }
  if (!canReadControl(account?.platformRoles ?? [])) {
    return (
      <RouteStatus
        alert
        code="403"
        title="Control access denied"
        body="A verified operator or administrator role is required for Control."
      />
    );
  }
  return <Outlet />;
}

function ShopCapabilityGuard({
  allows,
  title,
  body,
}: {
  allows(role: ShopRole): boolean;
  title: string;
  body: string;
}) {
  const { status, account } = useAccount();
  const { shopId } = useParams();
  if (status !== 'ready') {
    return <AccountFailure />;
  }
  const shop = account?.shops.find((candidate) => candidate.tenantId === shopId);
  if (!shop || !allows(shop.role)) {
    return <RouteStatus alert code="403" title={title} body={body} />;
  }
  return <Outlet />;
}

export function RequireCatalogWrite() {
  return (
    <ShopCapabilityGuard
      allows={canManageCatalog}
      title="Catalog access denied"
      body="Catalog changes require an owner, admin, or catalog role."
    />
  );
}

export function RequireRecoveryOperate() {
  return (
    <ShopCapabilityGuard
      allows={canOperateRecovery}
      title="Recovery access denied"
      body="Recovery operations require an owner, admin, or support role."
    />
  );
}
