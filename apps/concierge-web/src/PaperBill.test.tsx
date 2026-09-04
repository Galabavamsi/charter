// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { formatDateOnly, PaperBill } from './PaperBill';

afterEach(cleanup);

const bill = {
  shopName: 'Northstar Travel Coffee',
  receipt: 'cht_account_receipt',
  issuedAt: '2026-08-23T10:00:00.000Z',
  totalDisplay: '₹2,347.00',
  deliveryBy: '2026-09-06',
  razorpayOrderId: 'order_account_same',
  paymentId: 'pay_account',
  paymentTruth: 'Captured',
  paid: true,
  lines: [
    {
      sku: 'grinder.pocket-lite',
      title: 'PocketGrind Lite',
      quantity: 1,
      unitMinor: '234700',
      lineMinor: '234700',
    },
  ],
};

describe('PaperBill', () => {
  it('renders an IRL invoice with shop, total, line item, and delivery', () => {
    render(<PaperBill {...bill} />);

    expect(screen.getByRole('heading', { name: 'Northstar Travel Coffee' })).toBeVisible();
    expect(screen.getAllByText('₹2,347.00').length).toBeGreaterThan(0);
    expect(screen.getByText('PocketGrind Lite × 1')).toBeVisible();
    expect(screen.getByText(formatDateOnly('2026-09-06'))).toBeVisible();
    expect(screen.getByText('Shop window')).toBeVisible();
    expect(screen.getByText('cht_account_receipt')).toBeVisible();
    expect(screen.getByText('order_account_same')).toBeVisible();
    expect(screen.getByText('pay_account')).toBeVisible();
    expect(screen.queryByText(/GSTIN/i)).toBeNull();
  });

  it('keeps synthetic disclosure and bigint-safe INR line totals', () => {
    render(
      <PaperBill
        shopName="Northstar Field Coffee"
        shopSynthetic
        totalDisplay="₹1,00,000.00"
        receipt="cht_synthetic"
        lines={[
          {
            sku: 'kit.lakh',
            title: 'Lakh kit',
            quantity: 1,
            unitMinor: '10000000',
            lineMinor: '10000000',
          },
        ]}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Northstar Field Coffee' })).toBeVisible();
    expect(screen.getByText('Synthetic / test shop')).toBeVisible();
    expect(screen.getAllByText('₹1,00,000.00').length).toBeGreaterThan(0);
  });

  it('omits missing payment references instead of fabricating them', () => {
    render(
      <PaperBill
        shopName="Harbor Spice"
        totalDisplay="₹899.00"
        receipt="cht_open"
        lines={[{ sku: 'mill.cast-iron', title: 'Cast iron mill', quantity: 2 }]}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Harbor Spice' })).toBeVisible();
    expect(screen.getByText('₹899.00')).toBeVisible();
    expect(screen.getByText('Cast iron mill × 2')).toBeVisible();
    expect(screen.queryByText('Shop window')).toBeNull();
    expect(screen.queryByText(/Razorpay order/i)).toBeNull();
    expect(screen.queryByText(/Payment id/i)).toBeNull();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('keeps the same layout in the history preview', () => {
    render(<PaperBill {...bill} variant="preview" />);

    expect(screen.getByRole('heading', { name: 'Northstar Travel Coffee' })).toBeVisible();
    expect(screen.getAllByText('₹2,347.00').length).toBeGreaterThan(0);
    expect(screen.getByText('PocketGrind Lite × 1')).toBeVisible();
    expect(document.querySelector('[data-paper-bill="preview"]')).toBeTruthy();
  });

  it('prints sandbox ship-to, Charter tracking, and fulfillment status', () => {
    render(
      <PaperBill
        {...bill}
        shippingAddress={{
          recipientName: 'Charter Demo Recipient',
          street: '42 Sandbox Lane, Demo Colony',
          city: 'Bengaluru',
          state: 'Karnataka',
          pincode: '560001',
          phone: '+91 90000 00000',
        }}
        trackingId="CHR-TRK-620000000000"
        fulfillmentStatus="confirmed"
      />,
    );

    expect(screen.getByText('Ship to')).toBeVisible();
    expect(screen.getByText('Charter Demo Recipient')).toBeVisible();
    expect(screen.getByText('42 Sandbox Lane, Demo Colony')).toBeVisible();
    expect(screen.getByText('CHR-TRK-620000000000')).toBeVisible();
    expect(screen.getByText('Confirmed')).toBeVisible();
    expect(screen.queryByText(/GSTIN/i)).toBeNull();
  });
});
