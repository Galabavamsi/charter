import { useMemo, useState } from 'react';
import { useApi } from '../account';
import {
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
  useMerchantPagedResource,
  useMerchantResource,
  type MerchantOrderDetail,
  type MerchantOrderSummary,
} from '../merchant-api';

type OrderFilters = {
  query: string;
  status: string;
  from: string;
  to: string;
};

const EMPTY_FILTERS: OrderFilters = { query: '', status: '', from: '', to: '' };

function orderQuery(filters: OrderFilters): string {
  const query = new URLSearchParams();
  if (filters.query.trim()) query.set('q', filters.query.trim());
  if (filters.status) query.set('status', filters.status);
  if (filters.from) query.set('from', filters.from);
  if (filters.to) query.set('to', filters.to);
  query.set('limit', '50');
  return query.toString();
}

export function MerchantOrdersPage() {
  const api = useApi();
  const shop = useMerchantShop();
  const [filters, setFilters] = useState<OrderFilters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<OrderFilters>(EMPTY_FILTERS);
  const [selectedOrder, setSelectedOrder] = useState<string | null>(null);
  const [advancing, setAdvancing] = useState(false);
  const [advanceError, setAdvanceError] = useState<string | null>(null);
  const listPath = useMemo(
    () => `/v1/merchant/shops/${shop.tenantId}/orders?${orderQuery(applied)}`,
    [applied, shop.tenantId],
  );
  const orders = useMerchantPagedResource<MerchantOrderSummary>(listPath, (order) => order.id);
  const detail = useMerchantResource<MerchantOrderDetail>(
    selectedOrder ? `/v1/merchant/shops/${shop.tenantId}/orders/${selectedOrder}` : null,
  );

  return (
    <section className="merchant-page merchant-orders-page">
      <MerchantPageHeader
        eyebrow="Payment record"
        title="Orders"
        description="Search provider orders and inspect the exact quote, payment state, recovery, and capture timeline."
      />
      <form
        className="merchant-filter-bar"
        aria-label="Order filters"
        onSubmit={(event) => {
          event.preventDefault();
          setApplied({ ...filters });
          setSelectedOrder(null);
        }}
      >
        <label className="filter-search">
          Search orders
          <input
            value={filters.query}
            onChange={(event) => setFilters({ ...filters, query: event.target.value })}
            placeholder="Receipt, Razorpay Order, payment ID"
          />
        </label>
        <label>
          Payment status
          <select
            value={filters.status}
            onChange={(event) => setFilters({ ...filters, status: event.target.value })}
          >
            <option value="">All statuses</option>
            <option value="SETTLED">Captured</option>
            <option value="FAILED_PROVISIONAL">Failed / unresolved</option>
            <option value="RECONCILING">Reconciling</option>
            <option value="CAPTURE_PENDING">Authorized</option>
            <option value="VERIFYING">Verifying</option>
            <option value="CREATED">Created</option>
          </select>
        </label>
        <label>
          From
          <input
            type="date"
            value={filters.from}
            onChange={(event) => setFilters({ ...filters, from: event.target.value })}
          />
        </label>
        <label>
          To
          <input
            type="date"
            value={filters.to}
            onChange={(event) => setFilters({ ...filters, to: event.target.value })}
          />
        </label>
        <button type="submit">Apply filters</button>
        <button
          type="button"
          className="ghost"
          onClick={() => {
            setFilters(EMPTY_FILTERS);
            setApplied(EMPTY_FILTERS);
            setSelectedOrder(null);
          }}
        >
          Clear
        </button>
      </form>
      {orders.loading ? <MerchantLoading label="Loading order records" /> : null}
      {orders.error ? <MerchantError error={orders.error} retry={orders.reload} /> : null}
      {orders.loadMoreError ? (
        <MerchantError error={orders.loadMoreError} retry={orders.loadMore} />
      ) : null}
      {!orders.loading && !orders.error && orders.items.length === 0 ? (
        <MerchantEmpty
          title="No matching orders"
          body="Try a wider date range or clear the payment-status filter."
        />
      ) : null}
      {orders.items.length > 0 ? (
        <div className="record-table-wrap">
          <table className="record-table">
            <caption>Merchant order records</caption>
            <thead>
              <tr>
                <th>Receipt</th>
                <th>Payment truth</th>
                <th>Total</th>
                <th>Updated</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {orders.items.map((order) => (
                <tr key={order.id}>
                  <td data-label="Receipt">
                    <strong>{order.receipt}</strong>
                    <small>{order.razorpayOrderId}</small>
                  </td>
                  <td data-label="Payment truth">
                    <RecordStatus
                      label={order.paymentTruth}
                      tone={
                        order.paid
                          ? 'ok'
                          : order.status === 'CAPTURE_PENDING'
                            ? 'warning'
                            : 'warning'
                      }
                    />
                    <small>
                      {order.fulfillmentReady
                        ? order.fulfillmentStatus
                          ? `Sandbox ${order.fulfillmentStatus}`
                          : 'Eligible for fulfillment'
                        : 'Await captured evidence before fulfillment'}
                    </small>
                  </td>
                  <td data-label="Total">{order.totalDisplay}</td>
                  <td data-label="Updated">
                    <time dateTime={order.updatedAt}>
                      {new Date(order.updatedAt).toLocaleString('en-IN')}
                    </time>
                  </td>
                  <td data-label="Actions">
                    <button
                      type="button"
                      className="ghost"
                      aria-label={`Open order ${order.receipt}`}
                      onClick={() => setSelectedOrder(order.id)}
                    >
                      Open timeline
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {orders.nextCursor ? (
        <button type="button" onClick={() => void orders.loadMore()} disabled={orders.loadingMore}>
          {orders.loadingMore ? 'Loading more orders…' : 'Load more orders'}
        </button>
      ) : null}
      {selectedOrder ? (
        <aside className="order-detail" aria-live="polite">
          <div className="record-form-head">
            <h3>Order timeline</h3>
            <button type="button" className="ghost" onClick={() => setSelectedOrder(null)}>
              Close
            </button>
          </div>
          {detail.loading ? <MerchantLoading label="Loading order timeline" /> : null}
          {detail.error ? <MerchantError error={detail.error} retry={detail.reload} /> : null}
          {detail.data ? (
            <>
              <dl className="order-detail-facts">
                <div>
                  <dt>Quote</dt>
                  <dd>{detail.data.quote.id}</dd>
                </div>
                <div>
                  <dt>Razorpay Order</dt>
                  <dd>{detail.data.provider.razorpayOrderId}</dd>
                </div>
                <div>
                  <dt>Payment</dt>
                  <dd>{detail.data.provider.status ?? 'Unknown'}</dd>
                </div>
                <div>
                  <dt>Fulfillment</dt>
                  <dd>
                    {detail.data.fulfillmentReady
                      ? detail.data.fulfillmentStatus
                        ? `Sandbox ${detail.data.fulfillmentStatus}`
                        : 'Ready'
                      : 'Blocked until capture'}
                  </dd>
                </div>
                {detail.data.trackingId ? (
                  <div>
                    <dt>Charter tracking</dt>
                    <dd>{detail.data.trackingId}</dd>
                  </div>
                ) : null}
              </dl>
              {detail.data.shippingAddress ? (
                <p>
                  Ship to {detail.data.shippingAddress.recipientName},{' '}
                  {detail.data.shippingAddress.street}, {detail.data.shippingAddress.city}{' '}
                  {detail.data.shippingAddress.pincode}. Charter sandbox address.
                </p>
              ) : null}
              {detail.data.nextFulfillmentStatus ? (
                <p>
                  <button
                    type="button"
                    disabled={advancing}
                    onClick={() => {
                      const next = detail.data?.nextFulfillmentStatus;
                      if (!next || !selectedOrder) {
                        return;
                      }
                      setAdvancing(true);
                      setAdvanceError(null);
                      void api<MerchantOrderDetail>(
                        `/v1/merchant/shops/${shop.tenantId}/orders/${selectedOrder}/fulfillment`,
                        {
                          method: 'POST',
                          headers: { 'idempotency-key': merchantCommandKey('sandbox-fulfillment') },
                          body: JSON.stringify({ status: next }),
                        },
                      )
                        .then(() => {
                          void detail.reload();
                          void orders.reload();
                        })
                        .catch((cause) => {
                          setAdvanceError(merchantErrorMessage(cause));
                        })
                        .finally(() => {
                          setAdvancing(false);
                        });
                    }}
                  >
                    {advancing
                      ? 'Updating sandbox status…'
                      : `Sandbox: mark ${detail.data.nextFulfillmentStatus}`}
                  </button>
                </p>
              ) : null}
              {advanceError ? <p role="alert">{advanceError}</p> : null}
              <section className="quote-itemization" aria-labelledby="quote-itemization-title">
                <h4 id="quote-itemization-title">Frozen quote itemization</h4>
                {detail.data.quote.lines.length ? (
                  <ul>
                    {detail.data.quote.lines.map((line) => (
                      <li key={line.sku}>
                        <span>
                          {line.title} × {line.quantity}
                        </span>
                        <code>{line.sku}</code>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>No line itemization is available for this historical record.</p>
                )}
              </section>
              <ol className="payment-timeline">
                {detail.data.timeline.map((event) => (
                  <li key={event.id}>
                    <RecordStatus
                      label={event.label}
                      tone={
                        event.status === 'captured' || event.status === 'delivered'
                          ? 'ok'
                          : 'neutral'
                      }
                    />
                    <time dateTime={event.at}>{new Date(event.at).toLocaleString('en-IN')}</time>
                    <p>{event.detail}</p>
                  </li>
                ))}
              </ol>
            </>
          ) : null}
        </aside>
      ) : null}
    </section>
  );
}
