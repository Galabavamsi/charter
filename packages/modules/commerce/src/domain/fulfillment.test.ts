import { describe, expect, it } from 'vitest';
import {
  charterTrackingId,
  fulfillmentStatusLabel,
  isFulfillmentStatus,
  mockIndianAddress,
  nextFulfillmentStatus,
} from './fulfillment.js';

const CHECKOUT_ID = '62000000-0000-4000-8000-000000000001';

describe('sandbox fulfillment helpers', () => {
  it('issues a stable Charter tracking id, not a courier AWB', () => {
    expect(charterTrackingId(CHECKOUT_ID)).toBe('CHR-TRK-620000000000');
    expect(charterTrackingId(CHECKOUT_ID)).toBe(charterTrackingId(CHECKOUT_ID));
    expect(charterTrackingId(CHECKOUT_ID)).toMatch(/^CHR-TRK-[0-9A-F]{12}$/);
  });

  it('builds a deterministic demo Indian address', () => {
    const first = mockIndianAddress(CHECKOUT_ID);
    const second = mockIndianAddress(CHECKOUT_ID);
    expect(first).toEqual(second);
    expect(first.recipientName).toBe('Charter Demo Recipient');
    expect(first.city).toBe('Bengaluru');
    expect(first.state).toBe('Karnataka');
    expect(first.pincode).toBe('560001');
    expect(first.source).toBe('sandbox_mock');
    expect(first.street).toMatch(/Sandbox Lane/);
  });

  it('advances confirmed → packed → dispatched → delivered', () => {
    expect(nextFulfillmentStatus('confirmed')).toBe('packed');
    expect(nextFulfillmentStatus('packed')).toBe('dispatched');
    expect(nextFulfillmentStatus('dispatched')).toBe('delivered');
    expect(nextFulfillmentStatus('delivered')).toBeNull();
    expect(isFulfillmentStatus('packed')).toBe(true);
    expect(isFulfillmentStatus('in_transit')).toBe(false);
    expect(fulfillmentStatusLabel('confirmed')).toBe('Confirmed');
  });
});
