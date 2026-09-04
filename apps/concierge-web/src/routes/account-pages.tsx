import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useAccount, useApi } from '../account';
import { ApiError } from '../api';
import { useAuth } from '../auth';
import { RecordStatus } from '../merchant-components';
import { PaperBill } from '../PaperBill';

type BuyerOrderShop = {
  tenantId: string;
  slug: string;
  name: string;
  synthetic: boolean;
};

type BuyerOrderSummary = {
  id: string;
  receipt: string;
  razorpayOrderId: string;
  status: string;
  paymentState: string;
  totalMinor: string;
  totalDisplay: string;
  createdAt: string;
  updatedAt: string;
  paid: boolean;
  fulfillmentReady: boolean;
  paymentTruth: string;
  trackingId?: string;
  fulfillmentStatus?: string;
  shop: BuyerOrderShop;
};

type BuyerOrderDetail = BuyerOrderSummary & {
  quote: {
    id: string;
    status: string;
    subtotalMinor: string;
    discountMinor: string;
    totalMinor: string;
    lines: Array<{
      sku: string;
      title: string;
      quantity: number;
      unitMinor?: string;
      lineMinor?: string;
    }>;
    deliveryBy?: string;
  };
  provider: {
    razorpayOrderId: string;
    paymentId: string | null;
    status: string | null;
  };
  shippingAddress?: {
    recipientName: string;
    street: string;
    city: string;
    state: string;
    pincode: string;
    phone: string;
  };
  timeline: Array<{
    id: string;
    at: string;
    status: string;
    label: string;
    detail: string;
  }>;
};

function paymentTone(order: Pick<BuyerOrderSummary, 'paid' | 'status'>): 'ok' | 'warning' {
  return order.paid ? 'ok' : 'warning';
}

export function OrdersPage() {
  const api = useApi();
  const [orders, setOrders] = useState<BuyerOrderSummary[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    setError(null);
    void api<{ items: BuyerOrderSummary[] }>('/v1/orders', { signal: controller.signal })
      .then((body) => {
        if (controller.signal.aborted) {
          return;
        }
        setOrders(body.items ?? []);
        setStatus('ready');
      })
      .catch((cause) => {
        if (controller.signal.aborted) {
          return;
        }
        setError(cause instanceof ApiError ? cause.code : 'ORDERS_UNAVAILABLE');
        setStatus('error');
      });
    return () => controller.abort();
  }, [api]);

  return (
    <section className="account-page fade">
      <p className="eyebrow">Buyer account</p>
      <h1 data-route-heading tabIndex={-1}>
        Buyer orders
      </h1>
      <p>
        Receipts for checkouts owned by this verified account. Payment truth matches the merchant
        record.
      </p>
      {status === 'loading' ? <p role="status">Loading orders…</p> : null}
      {status === 'error' ? (
        <p role="alert">Orders unavailable{error ? ` (${error})` : ''}.</p>
      ) : null}
      {status === 'ready' && orders.length === 0 ? (
        <p>
          No receipts yet. <Link to="/chats">Open Concierge</Link>
          {' or '}
          <Link to="/shops">browse catalogs</Link>.
        </p>
      ) : null}
      {orders.length > 0 ? (
        <div className="paper-bill-grid" aria-label="Buyer receipts">
          {orders.map((order) => (
            <article key={order.id} className="paper-bill-card">
              <PaperBill
                variant="preview"
                shopName={order.shop.name}
                shopSynthetic={order.shop.synthetic}
                issuedAt={order.createdAt}
                receipt={order.receipt}
                totalDisplay={order.totalDisplay}
                razorpayOrderId={order.razorpayOrderId || undefined}
                paymentTruth={order.paymentTruth}
                paid={order.paid}
                trackingId={order.trackingId}
                fulfillmentStatus={order.fulfillmentStatus}
              />
              <p className="paper-bill-card-meta">
                <RecordStatus label={order.paymentTruth} tone={paymentTone(order)} />
                <small>
                  {order.fulfillmentReady
                    ? 'Eligible for fulfillment'
                    : 'Await captured evidence before fulfillment'}
                </small>
                <Link to={`/orders/${order.id}`}>View receipt</Link>
              </p>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function OrderPage() {
  const api = useApi();
  const { id = '' } = useParams();
  const [order, setOrder] = useState<BuyerOrderDetail | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    setOrder(null);
    void api<BuyerOrderDetail>(`/v1/orders/${id}`, { signal: controller.signal })
      .then((body) => {
        if (controller.signal.aborted) {
          return;
        }
        setOrder(body);
        setStatus('ready');
      })
      .catch((cause) => {
        if (controller.signal.aborted) {
          return;
        }
        setStatus(cause instanceof ApiError && cause.status === 404 ? 'missing' : 'error');
      });
    return () => controller.abort();
  }, [api, id]);

  return (
    <section className="account-page fade">
      <p className="eyebrow">Buyer order</p>
      <h1 data-route-heading tabIndex={-1}>
        Receipt
      </h1>
      <p>
        <Link to="/orders">All buyer orders</Link>
      </p>
      {status === 'loading' ? <p role="status">Loading receipt…</p> : null}
      {status === 'missing' ? (
        <p role="alert">This receipt is not available for this account.</p>
      ) : null}
      {status === 'error' ? <p role="alert">Receipt unavailable.</p> : null}
      {order ? (
        <article className="order-detail paper-bill-detail" aria-label={`Receipt ${order.receipt}`}>
          <PaperBill
            shopName={order.shop.name}
            shopSynthetic={order.shop.synthetic}
            issuedAt={order.createdAt}
            receipt={order.receipt}
            lines={order.quote.lines}
            totalDisplay={order.totalDisplay}
            deliveryBy={order.quote.deliveryBy}
            razorpayOrderId={order.provider.razorpayOrderId || undefined}
            paymentId={order.provider.paymentId}
            paymentTruth={order.paymentTruth}
            paid={order.paid}
            capturedAt={order.timeline.find((event) => event.status === 'captured')?.at}
            shippingAddress={order.shippingAddress}
            trackingId={order.trackingId}
            fulfillmentStatus={order.fulfillmentStatus}
          />
          <p className="paper-bill-truth">
            <RecordStatus label={order.paymentTruth} tone={paymentTone(order)} />
          </p>
          {!order.provider.paymentId ? <p>Payment id is not assigned.</p> : null}
          <ol className="payment-timeline">
            {order.timeline.map((event) => (
              <li key={event.id}>
                <RecordStatus
                  label={event.label}
                  tone={
                    event.status === 'captured' || event.status === 'delivered' ? 'ok' : 'neutral'
                  }
                />
                <time dateTime={event.at}>{new Date(event.at).toLocaleString('en-IN')}</time>
                <p>{event.detail}</p>
              </li>
            ))}
          </ol>
        </article>
      ) : null}
    </section>
  );
}

export function AccountPage() {
  const auth = useAuth();
  const { account } = useAccount();
  return (
    <section className="account-page fade">
      <p className="eyebrow">Verified profile</p>
      <h1 data-route-heading tabIndex={-1}>
        Account
      </h1>
      <dl className="profile-list">
        <div>
          <dt>Email</dt>
          <dd>{account?.profile.email ?? auth.session?.user.email ?? 'Not provided'}</dd>
        </div>
        <div>
          <dt>User ID</dt>
          <dd>{account?.profile.userId ?? auth.session?.user.id}</dd>
        </div>
        <div>
          <dt>Shop memberships</dt>
          <dd>{account?.shops.length ?? 0}</dd>
        </div>
        <div>
          <dt>Platform roles</dt>
          <dd>{account?.platformRoles.join(', ') || 'None'}</dd>
        </div>
      </dl>
    </section>
  );
}
