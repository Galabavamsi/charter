import { useEffect, useState } from 'react';
import { useApi } from '../account';
import { canManageSettings } from '../capabilities';
import {
  FormNotice,
  MerchantError,
  MerchantLoading,
  MerchantPageHeader,
  RecordStatus,
} from '../merchant-components';
import { useMerchantShop } from '../merchant-context';
import {
  merchantCommandKey,
  merchantErrorMessage,
  useMerchantResource,
  type MerchantSettings,
} from '../merchant-api';

function publicUrl(path: string): string {
  return new URL(path, window.location.origin).toString();
}

function whatsappUrl(name: string, path: string): string {
  const text = `Shop ${name} on Charter: ${publicUrl(path)}`;
  return `https://wa.me/?${new URLSearchParams({ text }).toString()}`;
}

export function MerchantSettingsPage() {
  const api = useApi();
  const shop = useMerchantShop();
  const canWrite = canManageSettings(shop.role);
  const resource = useMerchantResource<MerchantSettings>(
    `/v1/merchant/shops/${shop.tenantId}/settings`,
  );
  const [name, setName] = useState('');
  const [blurb, setBlurb] = useState('');
  const [gstin, setGstin] = useState('');
  const [addressLine, setAddressLine] = useState('');
  const [refundPolicy, setRefundPolicy] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  useEffect(() => {
    if (!resource.data) return;
    setName(resource.data.name);
    setBlurb(resource.data.blurb);
    setGstin(resource.data.gstin);
    setAddressLine(resource.data.addressLine);
    setRefundPolicy(resource.data.refundPolicy);
  }, [resource.data]);

  async function save() {
    if (!resource.data) return;
    setBusy(true);
    setNotice(null);
    try {
      await api(`/v1/merchant/shops/${shop.tenantId}/settings`, {
        method: 'PATCH',
        headers: { 'idempotency-key': merchantCommandKey('shop-settings') },
        body: JSON.stringify({
          expectedVersion: resource.data.version,
          name: name.trim(),
          blurb: blurb.trim(),
          gstin: gstin.trim().toUpperCase(),
          addressLine: addressLine.trim(),
          refundPolicy: refundPolicy.trim(),
          reason: 'Merchant updated the public shop record.',
        }),
      });
      setNotice({ kind: 'success', text: 'Shop settings saved' });
      await resource.reload();
    } catch (cause) {
      setNotice({ kind: 'error', text: merchantErrorMessage(cause) });
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    if (!resource.data) return;
    try {
      await navigator.clipboard.writeText(publicUrl(resource.data.publicPath));
      setNotice({ kind: 'success', text: 'Public link copied' });
    } catch {
      setNotice({ kind: 'error', text: 'Copy failed. Select the public link manually.' });
    }
  }

  return (
    <section className="merchant-page merchant-settings-page">
      <MerchantPageHeader
        eyebrow="Shop record"
        title="Settings"
        description="Public identity, mock onboarding copy, share links, and read-only team membership."
      />
      {!canWrite ? (
        <p className="merchant-read-only">
          Read-only access. Only owners and admins can change public shop copy.
        </p>
      ) : null}
      {notice ? <FormNotice kind={notice.kind}>{notice.text}</FormNotice> : null}
      {resource.loading ? <MerchantLoading label="Loading shop settings" /> : null}
      {resource.error ? <MerchantError error={resource.error} retry={resource.reload} /> : null}
      {resource.data ? (
        <>
          <form
            className="merchant-record-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="record-form-head">
              <div>
                <h3>Public shop record</h3>
                <p>Version {resource.data.version}</p>
              </div>
              <RecordStatus
                label={resource.data.synthetic ? 'Synthetic / test' : 'Merchant'}
                tone={resource.data.synthetic ? 'warning' : 'neutral'}
              />
            </div>
            <div className="merchant-form-grid">
              <label>
                Shop name
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  minLength={2}
                  maxLength={120}
                  disabled={!canWrite}
                />
              </label>
              <label>
                Public slug
                <input value={resource.data.slug} disabled aria-describedby="slug-lock-note" />
                <small id="slug-lock-note">Immutable in this release slice.</small>
              </label>
              <label className="field-wide">
                Public blurb
                <textarea
                  value={blurb}
                  onChange={(event) => setBlurb(event.target.value)}
                  maxLength={500}
                  rows={4}
                  disabled={!canWrite}
                />
              </label>
              <label>
                GSTIN
                <input
                  value={gstin}
                  onChange={(event) => setGstin(event.target.value.toUpperCase())}
                  maxLength={15}
                  disabled={!canWrite}
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby="gstin-demo-note"
                />
                <small id="gstin-demo-note">
                  {resource.data.profileVerified
                    ? 'Verified GST record.'
                    : 'Evaluator mock. Not a live GST verification.'}
                </small>
              </label>
              <label>
                Business address
                <input
                  value={addressLine}
                  onChange={(event) => setAddressLine(event.target.value)}
                  maxLength={300}
                  disabled={!canWrite}
                  aria-describedby="address-demo-note"
                />
                <small id="address-demo-note">Demo premises copy. Not a live KYC address.</small>
              </label>
              <label className="field-wide">
                Refund policy Concierge may quote
                <textarea
                  value={refundPolicy}
                  onChange={(event) => setRefundPolicy(event.target.value)}
                  maxLength={2000}
                  rows={4}
                  disabled={!canWrite}
                  aria-describedby="refund-demo-note"
                />
                <small id="refund-demo-note">
                  Empty means Concierge must not invent a refund SLA. Demo labeled unless verified.
                </small>
              </label>
            </div>
            {canWrite ? (
              <div className="record-form-actions">
                <button type="submit" disabled={busy}>
                  {busy ? 'Saving settings…' : 'Save settings'}
                </button>
              </div>
            ) : null}
          </form>
          <section className="settings-share" aria-labelledby="settings-share-title">
            <div>
              <p className="eyebrow">Public link</p>
              <h3 id="settings-share-title">Share this shop</h3>
              <a href={resource.data.publicPath}>{publicUrl(resource.data.publicPath)}</a>
            </div>
            <div className="record-actions">
              <button type="button" className="ghost" onClick={() => void copyLink()}>
                Copy public link
              </button>
              <a
                className="ghost link-btn"
                href={whatsappUrl(resource.data.name, resource.data.publicPath)}
                target="_blank"
                rel="noreferrer"
              >
                Share on WhatsApp
              </a>
            </div>
          </section>
          <aside className="payment-disclosure" aria-label="Environment and payment disclosure">
            <RecordStatus
              label={resource.data.testMode ? 'Test mode' : 'Live mode'}
              tone={resource.data.testMode ? 'warning' : 'danger'}
            />
            <p>{resource.data.paymentAccountDisclosure}</p>
            {resource.data.synthetic ? (
              <p>This shop and its visible sample records are synthetic.</p>
            ) : null}
          </aside>
          <section className="membership-records" aria-labelledby="membership-title">
            <div className="record-form-head">
              <div>
                <p className="eyebrow">Read-only in this slice</p>
                <h3 id="membership-title">Team memberships</h3>
              </div>
            </div>
            <div className="record-table-wrap">
              <table className="record-table">
                <caption>Active and invited shop memberships</caption>
                <thead>
                  <tr>
                    <th>Member</th>
                    <th>Role</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {resource.data.members.map((member) => (
                    <tr key={`${member.userId}-${member.role}`}>
                      <td data-label="Member">
                        <strong>{member.label}</strong>
                        <small>{member.userId}</small>
                      </td>
                      <td data-label="Role">{member.role}</td>
                      <td data-label="Status">
                        <RecordStatus
                          label={member.status}
                          tone={member.status === 'active' ? 'ok' : 'warning'}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </section>
  );
}
