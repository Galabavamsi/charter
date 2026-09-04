import { useEffect, useState } from 'react';
import { useApi } from './account';
import { ProcessOrb } from './ProcessOrb';

type ControlSnapshot = {
  kill: { global: boolean; tenants: Record<string, boolean> };
  flags: Record<string, boolean>;
  inbox: Array<{ provider: string; eventId: string; eventType: string; receivedAt: string }>;
};

export function ControlBoard({
  tenantId,
  canManageKills,
}: {
  tenantId: string;
  canManageKills: boolean;
}) {
  const api = useApi();
  const [data, setData] = useState<ControlSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);

  async function load() {
    setBusy(true);
    const body = await api<ControlSnapshot>('/v1/control');
    setData(body);
    setError(null);
    setBusy(false);
  }

  async function setKill(scope: 'global' | 'tenant', on: boolean) {
    setBusy(true);
    await api('/v1/control/kill', {
      method: 'POST',
      body: JSON.stringify({ scope, tenantId, on }),
    });
    await load();
  }

  useEffect(() => {
    void load().catch((err: Error) => {
      setBusy(false);
      setError(err.message);
    });
    const timer = window.setInterval(() => {
      void load().catch(() => undefined);
    }, 8000);
    return () => window.clearInterval(timer);
  }, [tenantId]);

  const tenantKilled = Boolean(data?.kill.tenants[tenantId] || data?.kill.global);

  return (
    <section className="board">
      <header className="board-head">
        <div>
          <p className="eyebrow">Control</p>
          <h1>Health & switches</h1>
          <p>{data ? `Checkout target · ${tenantId}` : 'Loading control plane…'}</p>
        </div>
        <button
          type="button"
          className="ghost"
          onClick={() => void load().catch((err: Error) => setError(err.message))}
        >
          Refresh
        </button>
      </header>
      {busy ? <ProcessOrb state="searching" label="Reading Control…" /> : null}
      {error ? <p>{error}</p> : null}
      {data ? (
        <>
          <div className="metrics">
            <div className="metric">
              Checkout
              <strong>{tenantKilled ? 'Held' : 'Open'}</strong>
            </div>
            <div className="metric">
              Global kill
              <strong>{data.kill.global ? 'On' : 'Off'}</strong>
            </div>
            <div className="metric">
              Inbox
              <strong>{data.inbox.length}</strong>
            </div>
          </div>
          <div className="board-block">
            <h2>Kill switches</h2>
            <p>Persisted control state. Changes survive process restarts.</p>
            {canManageKills ? (
              <div className="row-actions">
                <button
                  type="button"
                  onClick={() => void setKill('tenant', !data.kill.tenants[tenantId])}
                >
                  {data.kill.tenants[tenantId]
                    ? 'Open this shop’s checkout'
                    : 'Stop this shop’s checkout'}
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void setKill('global', !data.kill.global)}
                >
                  {data.kill.global ? 'Clear global kill' : 'Global kill'}
                </button>
              </div>
            ) : (
              <p>Only platform administrators can change kill switches.</p>
            )}
          </div>
          <div className="board-block">
            <h2>Connections</h2>
            <div className="health-grid">
              {Object.entries(data.flags).map(([name, on]) => (
                <button
                  key={name}
                  type="button"
                  data-on={picked === name}
                  onClick={() => setPicked(name)}
                >
                  {{
                    paymentsConfigured: 'Payments',
                    webhookConfigured: 'Webhooks',
                    fireworksConfigured: 'Concierge',
                    langfuseConfigured: 'Traces',
                    vapiConfigured: 'Voice',
                    voicePublicUrl: 'Voice URL',
                    agentmailConfigured: 'Mail',
                    persistence: 'Database',
                  }[name] ?? name}
                  <strong>{on ? 'Live' : 'Off'}</strong>
                </button>
              ))}
            </div>
            {picked ? (
              <p>
                {picked} is {data.flags[picked] ? 'connected' : 'not connected'}. This does not
                change a buyer’s cart.
              </p>
            ) : (
              <p>Tap a connection to see what it is for.</p>
            )}
          </div>
          <div className="board-block">
            <h2>Webhook inbox</h2>
            {data.inbox.length === 0 ? <p>No signed webhook events stored yet.</p> : null}
            {data.inbox.length > 0 ? (
              <table className="table">
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Id</th>
                    <th>Received</th>
                  </tr>
                </thead>
                <tbody>
                  {data.inbox.map((row) => (
                    <tr key={`${row.provider}-${row.eventId}`}>
                      <td>{row.eventType}</td>
                      <td>
                        <code>{row.eventId}</code>
                      </td>
                      <td>{row.receivedAt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}
