import { useEffect, useState } from 'react';
import { useApi } from '../account';
import { canManageRules } from '../capabilities';
import {
  FormNotice,
  MerchantEmpty,
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
  type MerchantRules,
  type MerchantRulesPreview,
} from '../merchant-api';

type OfferDraft = {
  id: string;
  discount: string;
  groups: string;
  stackable: boolean;
  marginFloor: string;
  budgetRemaining: string;
  maxRedemptions: string;
  expiresAt: string;
  redemptions?: number | null;
};

const DECIMAL_INR = /^(0|[1-9]\d{0,11})(?:\.\d{1,2})?$/;
const MAX_REDEMPTIONS = /^(0|[1-9]\d{0,6})$/;

function decimalFromMinor(value: string): string {
  const minor = BigInt(value);
  return `${minor / 100n}.${(minor % 100n).toString().padStart(2, '0')}`;
}

function minorFromDecimal(value: string): string {
  const [rupees, fraction = ''] = value.split('.');
  return (BigInt(rupees) * 100n + BigInt((fraction ?? '').padEnd(2, '0') || '0')).toString();
}

function optionalMinor(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? minorFromDecimal(trimmed) : null;
}

function optionalInt(value: string): number | null {
  const trimmed = value.trim();
  return trimmed ? Number(trimmed) : null;
}

function emptyOffer(): OfferDraft {
  return {
    id: '',
    discount: '',
    groups: '',
    stackable: true,
    marginFloor: '',
    budgetRemaining: '',
    maxRedemptions: '',
    expiresAt: '',
    redemptions: null,
  };
}

function offerGroups(value: string): string[][] {
  return value
    .split('\n')
    .map((line) =>
      line
        .split(',')
        .map((sku) => sku.trim())
        .filter(Boolean),
    )
    .filter((group) => group.length > 0);
}

export function MerchantRulesPage() {
  const api = useApi();
  const shop = useMerchantShop();
  const canWrite = canManageRules(shop.role);
  const rules = useMerchantResource<MerchantRules>(`/v1/merchant/shops/${shop.tenantId}/rules`);
  const preview = useMerchantResource<MerchantRulesPreview>(
    `/v1/merchant/shops/${shop.tenantId}/rules/preview`,
  );
  const [hardCap, setHardCap] = useState('');
  const [autonomousCap, setAutonomousCap] = useState('');
  const [forbidden, setForbidden] = useState('');
  const [offers, setOffers] = useState<OfferDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  useEffect(() => {
    if (!rules.data) return;
    setHardCap(decimalFromMinor(rules.data.hardCapMinor));
    setAutonomousCap(decimalFromMinor(rules.data.autonomousCapMinor));
    setForbidden(rules.data.forbiddenMaterials.join(', '));
    setOffers(
      rules.data.offers.map((offer) => ({
        id: offer.id,
        discount: decimalFromMinor(offer.discountMinor),
        groups: offer.requiredSkuGroups.map((group) => group.join(', ')).join('\n'),
        stackable: offer.stackable !== false,
        marginFloor: offer.marginFloorMinor ? decimalFromMinor(offer.marginFloorMinor) : '',
        budgetRemaining: offer.budgetRemainingMinor
          ? decimalFromMinor(offer.budgetRemainingMinor)
          : '',
        maxRedemptions: offer.maxRedemptions != null ? String(offer.maxRedemptions) : '',
        expiresAt: offer.expiresAt ?? '',
        redemptions: offer.redemptions ?? null,
      })),
    );
  }, [rules.data]);

  async function publishRules() {
    if (!rules.data) return;
    const decimal = DECIMAL_INR;
    if (!decimal.test(hardCap) || !decimal.test(autonomousCap)) {
      setNotice({ kind: 'error', text: 'Caps must use INR with no more than 2 decimal places.' });
      return;
    }
    if (
      offers.some(
        (offer) =>
          !offer.id.trim() ||
          !decimal.test(offer.discount) ||
          offerGroups(offer.groups).length === 0,
      )
    ) {
      setNotice({
        kind: 'error',
        text: 'Each offer needs an ID, exact discount, and at least one required SKU group.',
      });
      return;
    }
    if (
      offers.some(
        (offer) =>
          (offer.marginFloor.trim() && !decimal.test(offer.marginFloor)) ||
          (offer.budgetRemaining.trim() && !decimal.test(offer.budgetRemaining)) ||
          (offer.maxRedemptions.trim() && !MAX_REDEMPTIONS.test(offer.maxRedemptions)),
      )
    ) {
      setNotice({
        kind: 'error',
        text: 'Offer margin, budget, and max redemptions must use exact INR or whole counts.',
      });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await api(`/v1/merchant/shops/${shop.tenantId}/rules`, {
        method: 'PUT',
        headers: { 'idempotency-key': merchantCommandKey('rules-publish') },
        body: JSON.stringify({
          expectedVersion: rules.data.version,
          hardCap,
          autonomousCap,
          forbiddenMaterials: forbidden
            .split(',')
            .map((value) => value.trim().toLowerCase())
            .filter(Boolean),
          offers: offers.map((offer) => ({
            id: offer.id.trim(),
            discount: offer.discount,
            requiredSkuGroups: offerGroups(offer.groups),
            stackable: offer.stackable,
            marginFloorMinor: optionalMinor(offer.marginFloor),
            budgetRemainingMinor: optionalMinor(offer.budgetRemaining),
            maxRedemptions: optionalInt(offer.maxRedemptions),
            redemptions: offer.redemptions,
            expiresAt: offer.expiresAt.trim() ? offer.expiresAt.trim() : null,
          })),
          reason: 'Merchant published reviewed policy limits and current offers.',
        }),
      });
      setNotice({ kind: 'success', text: 'Rules published as a new version' });
      await Promise.all([rules.reload(), preview.reload()]);
    } catch (cause) {
      setNotice({ kind: 'error', text: merchantErrorMessage(cause) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="merchant-page merchant-rules-page">
      <MerchantPageHeader
        eyebrow="Deterministic policy"
        title="Rules"
        description="Published caps, forbidden materials, and merchant-created offers. Models cannot create or expand discounts."
      />
      {!canWrite ? (
        <p className="merchant-read-only">
          Read-only access. Only owners and admins can publish a new rules version.
        </p>
      ) : null}
      {notice ? <FormNotice kind={notice.kind}>{notice.text}</FormNotice> : null}
      {rules.loading ? <MerchantLoading label="Loading rules" /> : null}
      {rules.error ? <MerchantError error={rules.error} retry={rules.reload} /> : null}
      {rules.data ? (
        <form
          className="merchant-record-form"
          onSubmit={(event) => {
            event.preventDefault();
            void publishRules();
          }}
        >
          <div className="record-form-head">
            <div>
              <h3>Published policy</h3>
              <p>Version {rules.data.version}</p>
            </div>
            <RecordStatus label={`Version ${rules.data.version}`} tone="neutral" />
          </div>
          <div className="merchant-form-grid">
            <label>
              Hard cap in INR
              <input
                value={hardCap}
                onChange={(event) => setHardCap(event.target.value)}
                inputMode="decimal"
                disabled={!canWrite}
              />
            </label>
            <label>
              Autonomous cap in INR
              <input
                value={autonomousCap}
                onChange={(event) => setAutonomousCap(event.target.value)}
                inputMode="decimal"
                disabled={!canWrite}
              />
            </label>
            <label className="field-wide">
              Forbidden materials
              <input
                value={forbidden}
                onChange={(event) => setForbidden(event.target.value)}
                placeholder="glass, restricted-material"
                disabled={!canWrite}
              />
            </label>
          </div>
          <fieldset className="offers-editor" disabled={!canWrite}>
            <legend>Current offers</legend>
            {offers.length === 0 ? (
              <p>No governed offers are published.</p>
            ) : (
              offers.map((offer, index) => (
                <div className="offer-record" key={`${offer.id}-${index}`}>
                  <label>
                    Offer ID
                    <input
                      value={offer.id}
                      onChange={(event) =>
                        setOffers((current) =>
                          current.map((entry, currentIndex) =>
                            currentIndex === index ? { ...entry, id: event.target.value } : entry,
                          ),
                        )
                      }
                    />
                  </label>
                  <label>
                    Discount in INR
                    <input
                      value={offer.discount}
                      inputMode="decimal"
                      onChange={(event) =>
                        setOffers((current) =>
                          current.map((entry, currentIndex) =>
                            currentIndex === index
                              ? { ...entry, discount: event.target.value }
                              : entry,
                          ),
                        )
                      }
                    />
                  </label>
                  <label className="field-wide">
                    Required SKU groups
                    <textarea
                      value={offer.groups}
                      rows={3}
                      aria-describedby={`offer-groups-help-${index}`}
                      onChange={(event) =>
                        setOffers((current) =>
                          current.map((entry, currentIndex) =>
                            currentIndex === index
                              ? { ...entry, groups: event.target.value }
                              : entry,
                          ),
                        )
                      }
                    />
                    <small id={`offer-groups-help-${index}`}>
                      One required group per line; comma separates alternatives.
                    </small>
                  </label>
                  <label className="offer-flag">
                    <input
                      type="checkbox"
                      checked={offer.stackable}
                      onChange={(event) =>
                        setOffers((current) =>
                          current.map((entry, currentIndex) =>
                            currentIndex === index
                              ? { ...entry, stackable: event.target.checked }
                              : entry,
                          ),
                        )
                      }
                    />
                    Stackable
                  </label>
                  <label>
                    Margin floor in INR
                    <input
                      value={offer.marginFloor}
                      inputMode="decimal"
                      onChange={(event) =>
                        setOffers((current) =>
                          current.map((entry, currentIndex) =>
                            currentIndex === index
                              ? { ...entry, marginFloor: event.target.value }
                              : entry,
                          ),
                        )
                      }
                    />
                  </label>
                  <label>
                    Budget remaining in INR
                    <input
                      value={offer.budgetRemaining}
                      inputMode="decimal"
                      onChange={(event) =>
                        setOffers((current) =>
                          current.map((entry, currentIndex) =>
                            currentIndex === index
                              ? { ...entry, budgetRemaining: event.target.value }
                              : entry,
                          ),
                        )
                      }
                    />
                  </label>
                  <label>
                    Max redemptions
                    <input
                      type="number"
                      min={0}
                      step={1}
                      inputMode="numeric"
                      value={offer.maxRedemptions}
                      onChange={(event) =>
                        setOffers((current) =>
                          current.map((entry, currentIndex) =>
                            currentIndex === index
                              ? { ...entry, maxRedemptions: event.target.value }
                              : entry,
                          ),
                        )
                      }
                    />
                  </label>
                  <label className="field-wide">
                    Expires at
                    <input
                      value={offer.expiresAt}
                      placeholder="2099-12-31T00:00:00.000Z"
                      onChange={(event) =>
                        setOffers((current) =>
                          current.map((entry, currentIndex) =>
                            currentIndex === index
                              ? { ...entry, expiresAt: event.target.value }
                              : entry,
                          ),
                        )
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() =>
                      setOffers((current) =>
                        current.filter((_, currentIndex) => currentIndex !== index),
                      )
                    }
                  >
                    Remove offer
                  </button>
                </div>
              ))
            )}
            {canWrite ? (
              <button
                type="button"
                className="ghost"
                onClick={() => setOffers((current) => [...current, emptyOffer()])}
              >
                Add governed offer
              </button>
            ) : null}
          </fieldset>
          {canWrite ? (
            <div className="record-form-actions">
              <button type="submit" disabled={busy}>
                {busy ? 'Publishing rules…' : 'Publish rules'}
              </button>
            </div>
          ) : null}
        </form>
      ) : null}
      <section className="policy-preview" aria-labelledby="policy-preview-title">
        <div className="record-form-head">
          <div>
            <p className="eyebrow">Current catalog</p>
            <h3 id="policy-preview-title">Policy preview</h3>
          </div>
        </div>
        {preview.loading ? <MerchantLoading label="Loading policy preview" /> : null}
        {preview.error ? <MerchantError error={preview.error} retry={preview.reload} /> : null}
        {preview.data && preview.data.items.length === 0 ? (
          <MerchantEmpty
            title="Nothing to preview"
            body="Add catalog records before evaluating the published rules."
          />
        ) : null}
        {preview.data && preview.data.items.length > 0 ? (
          <ul className="policy-preview-list">
            {preview.data.items.map((item) => (
              <li key={item.sku}>
                <code>{item.sku}</code>
                <RecordStatus
                  label={`${item.outcome} · ${item.reason}`}
                  tone={item.outcome === 'allow' ? 'ok' : 'danger'}
                />
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </section>
  );
}
