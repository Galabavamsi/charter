import { useMemo, useState } from 'react';
import { useParams } from 'react-router';
import {
  MerchantError,
  MerchantLoading,
  MerchantPageHeader,
  RecordStatus,
} from '../merchant-components';
import { useMerchantResource, type MerchantOverview } from '../merchant-api';

function rangeQuery(days: number): string {
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - (days - 1));
  return new URLSearchParams({
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  }).toString();
}

function PlotBars({
  title,
  empty,
  rows,
}: {
  title: string;
  empty: string;
  rows: Array<{ label: string; value: number }>;
}) {
  const peak = Math.max(1, ...rows.map((row) => row.value));
  return (
    <article className="overview-plot">
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <p className="overview-plot-empty">{empty}</p>
      ) : (
        <ul>
          {rows.map((row) => (
            <li key={row.label}>
              <span>{row.label}</span>
              <span
                className="overview-bar"
                style={{ width: `${Math.max(6, (row.value / peak) * 100)}%` }}
              />
              <strong>{row.value}</strong>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

export function MerchantOverviewPage() {
  const { shopId = '' } = useParams();
  const [days, setDays] = useState(30);
  const path = useMemo(
    () => `/v1/merchant/shops/${shopId}/overview?${rangeQuery(days)}`,
    [days, shopId],
  );
  const resource = useMerchantResource<MerchantOverview>(path);

  return (
    <section className="merchant-page merchant-overview-page">
      <MerchantPageHeader
        eyebrow="Operational record"
        title="Overview"
        description="Captured money, quote conversion, Concierge/directory search, and which SKUs were shown."
        actions={
          <label className="merchant-compact-field">
            Date range
            <select value={days} onChange={(event) => setDays(Number(event.target.value))}>
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </select>
          </label>
        }
      />
      {resource.loading ? <MerchantLoading label="Loading overview metrics" /> : null}
      {resource.error ? <MerchantError error={resource.error} retry={resource.reload} /> : null}
      {resource.data ? (
        <>
          <div className="overview-ledger">
            <article className="overview-primary">
              <p>Captured GMV</p>
              <strong>{resource.data.capturedGmvDisplay}</strong>
              <span>
                {resource.data.capturedOrders}{' '}
                {resource.data.capturedOrders === 1 ? 'captured order' : 'captured orders'}
              </span>
            </article>
            <article className="overview-funnel">
              <div>
                <p>Quote → capture</p>
                <strong>
                  {resource.data.conversion.numerator} / {resource.data.conversion.denominator}
                </strong>
              </div>
              <div
                className="funnel-track"
                role="img"
                aria-label={`${resource.data.conversion.numerator} of ${resource.data.conversion.denominator} quotes created in this window captured`}
              >
                <span
                  style={{
                    width: `${Math.max(
                      0,
                      Math.min(100, (resource.data.conversion.rate ?? 0) * 100),
                    )}%`,
                  }}
                />
              </div>
              <p>
                {resource.data.conversion.denominator}{' '}
                {resource.data.conversion.denominator === 1 ? 'quote' : 'quotes'} created in this
                window
              </p>
            </article>
          </div>
          <dl className="overview-records">
            <div>
              <dt>Failed / unresolved pays</dt>
              <dd>{resource.data.failedUnresolvedPays}</dd>
              <small>
                Refunded captures are excluded. Remaining counts are not terminal financial truth.
              </small>
            </div>
            <div>
              <dt>Observed recovered amount</dt>
              <dd>{resource.data.recoveredAmountDisplay}</dd>
              <small>Capture after a recorded recovery attempt.</small>
            </div>
            <div>
              <dt>Inventory units</dt>
              <dd>{resource.data.inventoryUnits}</dd>
              <small>{resource.data.lowStockVariants} low-stock variants.</small>
            </div>
          </dl>
          <div className="overview-plots" aria-label="Merchant plots">
            <PlotBars
              title="Captured GMV vs quotes"
              empty="No quotes in this window."
              rows={[
                { label: 'Captured orders', value: resource.data.capturedOrders },
                { label: 'Quotes created', value: resource.data.validFrozenQuotes },
              ].filter((row) => row.value > 0)}
            />
            <PlotBars
              title="Searches"
              empty="No directory or Concierge searches hit this shop in this window."
              rows={
                resource.data.searches > 0
                  ? [{ label: 'Search events', value: resource.data.searches }]
                  : []
              }
            />
            <PlotBars
              title="Recommended SKUs"
              empty="No catalog impressions yet. Concierge search and the public catalog write these."
              rows={(resource.data.recommendationsBySku ?? []).map((row) => ({
                label: row.title,
                value: row.count,
              }))}
            />
            <PlotBars
              title="Recommendations by source"
              empty="No recommendation source mix in this window."
              rows={(resource.data.recommendationsBySource ?? []).map((row) => ({
                label: row.source.replaceAll('_', ' '),
                value: row.count,
              }))}
            />
          </div>
          <aside className="metric-context" aria-label="Metric context">
            <RecordStatus
              label={resource.data.synthetic ? 'Synthetic / test data' : 'Merchant data'}
              tone={resource.data.synthetic ? 'warning' : 'neutral'}
            />
            <p>{resource.data.attributionNote}</p>
            <p>
              Period {resource.data.range.from} through {resource.data.range.to}. Only captured
              ledger entries count as paid.
            </p>
          </aside>
        </>
      ) : null}
    </section>
  );
}
