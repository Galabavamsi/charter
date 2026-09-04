// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../account';
import type { ApiClient } from '../api';
import { OrderPage, OrdersPage } from './account-pages';

const ORDER_ID = '62000000-0000-4000-8000-000000000001';

const order = {
  id: ORDER_ID,
  receipt: 'cht_account_receipt',
  razorpayOrderId: 'order_account_same',
  status: 'SETTLED',
  paymentState: 'captured',
  totalMinor: '234700',
  totalDisplay: '₹2,347.00',
  createdAt: '2026-08-23T10:00:00.000Z',
  updatedAt: '2026-08-23T10:02:00.000Z',
  paid: true,
  fulfillmentReady: true,
  paymentTruth: 'Captured',
  trackingId: 'CHR-TRK-620000000000',
  fulfillmentStatus: 'confirmed',
  shop: {
    tenantId: 'northstar-demo-in',
    slug: 'northstar',
    name: 'Northstar Travel Coffee',
    synthetic: true,
  },
  quote: {
    id: 'q-account',
    status: 'BOUND',
    subtotalMinor: '234700',
    discountMinor: '0',
    totalMinor: '234700',
    deliveryBy: '2026-09-06',
    lines: [
      {
        sku: 'grinder.pocket-lite',
        title: 'PocketGrind Lite',
        quantity: 1,
        unitMinor: '234700',
        lineMinor: '234700',
      },
    ],
  },
  provider: {
    razorpayOrderId: 'order_account_same',
    paymentId: 'pay_account',
    status: 'captured',
  },
  shippingAddress: {
    recipientName: 'Charter Demo Recipient',
    street: '42 Sandbox Lane, Demo Colony',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560001',
    phone: '+91 90000 00000',
  },
  timeline: [
    {
      id: 'quote:q-account',
      at: '2026-08-23T10:00:00.000Z',
      status: 'quote_frozen',
      label: 'Quote frozen',
      detail: 'Line prices and totals were frozen for this checkout.',
    },
    {
      id: 'capture:order',
      at: '2026-08-23T10:02:00.000Z',
      status: 'captured',
      label: 'Payment captured',
      detail: 'Captured ledger evidence. Eligible for fulfillment.',
    },
  ],
};

afterEach(cleanup);

describe('buyer order pages', () => {
  it('renders account-scoped receipts with shop, total, and payment truth', async () => {
    const api = vi.fn(async (path: string) => {
      if (path === '/v1/orders') {
        return { items: [order], nextCursor: null };
      }
      throw new Error(path);
    }) as ApiClient;

    render(
      <MemoryRouter>
        <ApiProvider client={api}>
          <OrdersPage />
        </ApiProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Buyer orders' })).toBeVisible();
    expect(screen.getByText('cht_account_receipt')).toBeVisible();
    expect(screen.getByText('Northstar Travel Coffee')).toBeVisible();
    expect(screen.getByText('Synthetic / test shop')).toBeVisible();
    expect(screen.getByText('₹2,347.00')).toBeVisible();
    expect(screen.getAllByText('Captured').length).toBeGreaterThan(0);
    expect(document.querySelector('[data-paper-bill="preview"]')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View receipt' })).toHaveAttribute(
      'href',
      `/orders/${ORDER_ID}`,
    );
  });

  it('renders receipt detail with quote lines, provider refs, and timeline labels', async () => {
    const api = vi.fn(async (path: string) => {
      if (path === `/v1/orders/${ORDER_ID}`) {
        return order;
      }
      throw new Error(path);
    }) as ApiClient;

    render(
      <MemoryRouter initialEntries={[`/orders/${ORDER_ID}`]}>
        <ApiProvider client={api}>
          <Routes>
            <Route path="/orders/:id" element={<OrderPage />} />
          </Routes>
        </ApiProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Receipt' })).toBeVisible();
    expect(screen.getByText('cht_account_receipt')).toBeVisible();
    expect(screen.getByText('order_account_same')).toBeVisible();
    expect(screen.getByText('pay_account')).toBeVisible();
    expect(screen.getByText('PocketGrind Lite × 1')).toBeVisible();
    expect(screen.getByText('Shop window')).toBeVisible();
    expect(screen.getByText('Ship to')).toBeVisible();
    expect(screen.getByText('CHR-TRK-620000000000')).toBeVisible();
    expect(screen.getByText('Quote frozen')).toBeVisible();
    expect(screen.getByText('Payment captured')).toBeVisible();
    expect(document.querySelector('[data-paper-bill="full"]')).toBeTruthy();
  });
});
