import { useEffect, useState } from 'react';
import { NavLink } from 'react-router';
import { useAccount, useApi } from '../account';
import { useAuth } from '../auth';
import { canManageControlKills } from '../capabilities';
import { ControlBoard } from '../ControlBoard';
import { Onboard } from '../Onboard';
import { RouteStatus } from '../route-guards';
import type { PublicShop } from '../shops';

export function ControlPage() {
  const api = useApi();
  const auth = useAuth();
  const { account } = useAccount();
  const [shops, setShops] = useState<PublicShop[]>([]);
  const [tenantId, setTenantId] = useState('');
  const [guideOpen, setGuideOpen] = useState(false);

  useEffect(() => {
    let active = true;
    void api<{ items?: PublicShop[] }>('/v1/shops').then((body) => {
      if (!active) {
        return;
      }
      const items = body.items ?? [];
      setShops(items);
      setTenantId((current) => current || items[0]?.tenantId || '');
    });
    return () => {
      active = false;
    };
  }, [api]);

  if (!auth.session) {
    return null;
  }
  const canManageKills = canManageControlKills(account?.platformRoles ?? []);

  return (
    <section className="control-shell">
      {guideOpen ? (
        <Onboard
          role="operator"
          userId={auth.session.user.id}
          shopId={tenantId || 'platform'}
          onClose={() => setGuideOpen(false)}
        />
      ) : null}
      <header className="control-mast">
        <div>
          <p className="eyebrow">Platform operations</p>
          <h1 data-route-heading tabIndex={-1}>
            Control
          </h1>
        </div>
        <label>
          Checkout target
          <select value={tenantId} onChange={(event) => setTenantId(event.target.value)}>
            {shops.map((shop) => (
              <option key={shop.tenantId} value={shop.tenantId}>
                {shop.name}
              </option>
            ))}
          </select>
        </label>
      </header>
      <nav className="control-nav" aria-label="Control sections">
        <NavLink to="/control" end>
          Overview
        </NavLink>
        <NavLink to="/control/webhooks">Webhooks</NavLink>
        {canManageKills ? <NavLink to="/control/switches">Switches</NavLink> : null}
        <button type="button" onClick={() => setGuideOpen(true)}>
          Operator guide
        </button>
      </nav>
      {tenantId ? (
        <ControlBoard canManageKills={canManageKills} tenantId={tenantId} />
      ) : (
        <RouteStatus
          title="No checkout target"
          body="Control is available, but there are no published shops to inspect."
        />
      )}
    </section>
  );
}
