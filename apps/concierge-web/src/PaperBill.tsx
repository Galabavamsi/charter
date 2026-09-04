import { useId } from 'react';
import { formatInr, money } from '@charter/domain-shared';

export type PaperBillLine = {
  sku: string;
  title: string;
  quantity: number;
  unitMinor?: string;
  lineMinor?: string;
};

export type PaperBillAddress = {
  recipientName: string;
  street: string;
  city: string;
  state: string;
  pincode: string;
  phone: string;
};

export type PaperBillProps = {
  variant?: 'full' | 'preview';
  shopName: string;
  shopSynthetic?: boolean;
  issuedAt?: string;
  receipt?: string;
  lines?: PaperBillLine[];
  totalDisplay: string;
  deliveryBy?: string | null;
  razorpayOrderId?: string | null;
  paymentId?: string | null;
  paymentTruth?: string;
  paid?: boolean;
  capturedAt?: string | null;
  shippingAddress?: PaperBillAddress | null;
  trackingId?: string | null;
  fulfillmentStatus?: string | null;
};

function formatMinorDisplay(minor?: string): string | undefined {
  if (!minor) {
    return undefined;
  }
  try {
    return formatInr(money(BigInt(minor)));
  } catch {
    return undefined;
  }
}

function formatIssuedAt(iso?: string): string | undefined {
  if (!iso) {
    return undefined;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDateOnly(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) {
    return value;
  }
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function dash(value?: string | null): string {
  return value && value.trim() ? value : '—';
}

function fulfillmentDisplay(status: string): string {
  if (status === 'confirmed') return 'Confirmed';
  if (status === 'packed') return 'Packed';
  if (status === 'dispatched') return 'Dispatched';
  if (status === 'delivered') return 'Delivered';
  return status;
}

export function PaperBill({
  variant = 'full',
  shopName,
  shopSynthetic = false,
  issuedAt,
  receipt,
  lines = [],
  totalDisplay,
  deliveryBy,
  razorpayOrderId,
  paymentId,
  paymentTruth,
  paid = false,
  capturedAt,
  shippingAddress,
  trackingId,
  fulfillmentStatus,
}: PaperBillProps) {
  const rawId = useId().replace(/[^a-zA-Z0-9]/g, '');
  const grainId = `paperGrain${rawId}`;
  const issued = formatIssuedAt(issuedAt);
  const captured = formatIssuedAt(capturedAt ?? undefined);
  const preview = variant === 'preview';

  return (
    <figure
      className={preview ? 'paper-bill paper-bill--preview' : 'paper-bill paper-bill--full'}
      data-paper-bill={variant}
    >
      <svg className="paper-bill-sheet" viewBox="0 0 360 520" aria-hidden="true">
        <defs>
          <filter id={grainId} x="0" y="0" width="100%" height="100%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.85"
              numOctaves="3"
              stitchTiles="stitch"
            />
            <feColorMatrix type="saturate" values="0" />
          </filter>
        </defs>
        <rect width="360" height="520" fill="#f3e6cf" />
        <rect width="360" height="520" filter={`url(#${grainId})`} opacity="0.16" />
        <rect
          x="14"
          y="18"
          width="332"
          height="484"
          fill="none"
          stroke="#c4a574"
          strokeWidth="1.1"
        />
        <rect
          x="18"
          y="22"
          width="324"
          height="476"
          fill="none"
          stroke="#d7c19a"
          strokeWidth="0.6"
        />
        {Array.from({ length: 18 }, (_, index) => (
          <circle key={index} cx={20 + index * 18.8} cy="10" r="5.2" fill="#d7e8f6" />
        ))}
        <line
          x1="28"
          y1="78"
          x2="332"
          y2="78"
          stroke="#6a4a2b"
          strokeWidth="1"
          strokeDasharray="3 4"
        />
        <line x1="28" y1="408" x2="332" y2="408" stroke="#6a4a2b" strokeWidth="1.4" />
        <line x1="28" y1="412" x2="332" y2="412" stroke="#6a4a2b" strokeWidth="0.6" />
        {paid ? (
          <g transform="translate(248 348)" opacity="0.55">
            <circle cx="40" cy="40" r="36" fill="none" stroke="#b42318" strokeWidth="3" />
            <circle cx="40" cy="40" r="30" fill="none" stroke="#b42318" strokeWidth="1" />
            <text
              x="40"
              y="46"
              textAnchor="middle"
              fill="#b42318"
              fontFamily="Georgia, serif"
              fontSize="14"
              fontWeight="700"
              letterSpacing="2"
            >
              PAID
            </text>
          </g>
        ) : null}
      </svg>
      <div className="paper-bill-ink">
        <header className="paper-bill-head">
          <p className="paper-bill-kicker">Retail invoice</p>
          <h2 className="paper-bill-shop">{shopName}</h2>
          {shopSynthetic ? <p className="paper-bill-note">Synthetic / test shop</p> : null}
          <dl className="paper-bill-meta">
            <div>
              <dt>Bill no.</dt>
              <dd>{dash(receipt)}</dd>
            </div>
            <div>
              <dt>Date</dt>
              <dd>{dash(issued)}</dd>
            </div>
          </dl>
        </header>
        {lines.length || !preview ? (
          <table className="paper-bill-lines">
            <caption className="sr-only">Itemized bill</caption>
            <thead>
              <tr>
                <th scope="col">Particulars</th>
                <th scope="col">Qty</th>
                <th scope="col">Amount</th>
              </tr>
            </thead>
            <tbody>
              {lines.length ? (
                lines.map((line) => (
                  <tr key={line.sku}>
                    <td>
                      <span>
                        {line.title} × {line.quantity}
                      </span>
                      <small>{line.sku}</small>
                    </td>
                    <td>{line.quantity}</td>
                    <td>{formatMinorDisplay(line.lineMinor) ?? '—'}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={3}>No line itemization is available for this historical record.</td>
                </tr>
              )}
            </tbody>
          </table>
        ) : (
          <p className="paper-bill-lines-placeholder" aria-hidden="true">
            <span />
            <span />
          </p>
        )}
        <p className="paper-bill-total">
          <span>Total</span>
          <strong>{totalDisplay}</strong>
        </p>
        <dl className="paper-bill-foot">
          {shippingAddress && !preview ? (
            <div className="paper-bill-ship">
              <dt>Ship to</dt>
              <dd>
                <span>{shippingAddress.recipientName}</span>
                <span>{shippingAddress.street}</span>
                <span>
                  {shippingAddress.city}, {shippingAddress.state} {shippingAddress.pincode}
                </span>
                <span>{shippingAddress.phone}</span>
                <small>Charter sandbox address</small>
              </dd>
            </div>
          ) : null}
          {trackingId ? (
            <div>
              <dt>Charter tracking</dt>
              <dd>{trackingId}</dd>
            </div>
          ) : null}
          {fulfillmentStatus ? (
            <div>
              <dt>Fulfillment</dt>
              <dd>{fulfillmentDisplay(fulfillmentStatus)}</dd>
            </div>
          ) : null}
          {deliveryBy ? (
            <div>
              <dt>Shop window</dt>
              <dd>
                <time dateTime={deliveryBy}>{formatDateOnly(deliveryBy)}</time>
              </dd>
            </div>
          ) : null}
          {captured ? (
            <div>
              <dt>Captured</dt>
              <dd>
                <time dateTime={capturedAt ?? undefined}>{captured}</time>
              </dd>
            </div>
          ) : null}
          {paymentTruth ? (
            <div>
              <dt>Payment</dt>
              <dd>{paymentTruth}</dd>
            </div>
          ) : null}
          {razorpayOrderId ? (
            <div>
              <dt>Razorpay order</dt>
              <dd>{razorpayOrderId}</dd>
            </div>
          ) : null}
          {paymentId ? (
            <div>
              <dt>Payment id</dt>
              <dd>{paymentId}</dd>
            </div>
          ) : null}
        </dl>
        <p className="paper-bill-thanks">Thank you. Keep this bill for your records.</p>
      </div>
    </figure>
  );
}
