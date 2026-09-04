import { useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { useAccount } from './account';
import { useAuth } from './auth';
import { canReadControl } from './capabilities';

function isTransientRouteHeading(heading: HTMLElement): boolean {
  return /checking your session|loading account access/i.test(heading.textContent ?? '');
}

function RouteFocus() {
  const location = useLocation();

  useEffect(() => {
    const focusHeading = () => {
      const recordsHeading = document.querySelector<HTMLElement>(
        '#merchant-records [data-route-heading]',
      );
      if (recordsHeading) {
        recordsHeading.focus();
        return true;
      }
      const heading = document.querySelector<HTMLElement>('[data-route-heading]');
      if (!heading) {
        return false;
      }
      heading.focus();
      return !isTransientRouteHeading(heading);
    };
    if (focusHeading()) {
      return;
    }
    const observer = new MutationObserver(() => {
      if (focusHeading()) {
        observer.disconnect();
      }
    });
    const main = document.getElementById('main-content');
    if (main) {
      observer.observe(main, { childList: true, subtree: true });
    }
    return () => observer.disconnect();
  }, [location.pathname]);

  return null;
}

export function AppFrame() {
  const auth = useAuth();
  const { account, status } = useAccount();
  const location = useLocation();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLElement | null>(null);

  useEffect(() => {
    document.body.dataset.page = location.pathname === '/' ? 'landing' : 'app';
    setMenuOpen(false);
    return () => {
      delete document.body.dataset.page;
    };
  }, [location.pathname]);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    menu.current?.querySelector<HTMLElement>('a, button')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMenuOpen(false);
        menuTrigger.current?.focus();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !menu.current?.contains(target) &&
        !menuTrigger.current?.contains(target)
      ) {
        setMenuOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [menuOpen]);

  const hasControlAccess = canReadControl(account?.platformRoles ?? []);
  const identity = account?.profile.email ?? auth.session?.user.email ?? auth.session?.user.name;

  return (
    <div className="site-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <header className="global-header">
        <Link className="wordmark" to={auth.session ? '/chats' : '/'}>
          <span>Charter</span>
          <small>bounded commerce</small>
        </Link>
        <nav className="global-nav" aria-label="Primary">
          {auth.session ? <Link to="/chats">Concierge</Link> : null}
          <Link to="/shops">Shops</Link>
          {auth.session ? <Link to="/orders">Orders</Link> : null}
        </nav>
        <div className="global-account">
          {auth.loading ? <span className="header-status">Checking account…</span> : null}
          {!auth.loading && !auth.session ? (
            <div className="auth-actions">
              <Link to="/auth/sign-in">Sign in</Link>
              <Link className="header-cta" to="/auth/sign-up">
                Create account
              </Link>
            </div>
          ) : null}
          {!auth.loading && auth.session ? (
            <>
              <button
                ref={menuTrigger}
                type="button"
                className="account-trigger"
                aria-label={`${menuOpen ? 'Close' : 'Open'} account menu`}
                aria-expanded={menuOpen}
                aria-controls="account-menu"
                onClick={() => setMenuOpen((open) => !open)}
              >
                <span>{auth.session.user.name ?? 'Account'}</span>
                <span aria-hidden="true">{menuOpen ? '×' : '☰'}</span>
              </button>
              {menuOpen ? (
                <nav
                  ref={menu}
                  id="account-menu"
                  className="account-menu"
                  aria-label="Account links"
                >
                  <p className="account-identity">
                    <strong>Signed in</strong>
                    <span>{identity ?? auth.session.user.id}</span>
                    {status === 'loading' ? <small>Loading permissions…</small> : null}
                  </p>
                  <Link to="/chats">Concierge</Link>
                  <Link to="/shops">Shops</Link>
                  <Link to="/orders">Buyer orders</Link>
                  <Link to="/merchant">My shops</Link>
                  {hasControlAccess ? <Link to="/control">Control</Link> : null}
                  <Link to="/account">Profile</Link>
                  <button
                    type="button"
                    className="menu-sign-out"
                    onClick={() => {
                      void auth.signOut().then(() => {
                        setMenuOpen(false);
                        navigate('/', { replace: true });
                      });
                    }}
                  >
                    Sign out
                  </button>
                </nav>
              ) : null}
            </>
          ) : null}
        </div>
      </header>
      <main id="main-content" className="route-stage">
        <RouteFocus />
        <Outlet />
      </main>
      <footer className="site-footer">
        <span>Charter</span>
        <span>Amounts bounded. Charges explained. Failed pays recoverable.</span>
      </footer>
    </div>
  );
}
