export const FULFILLMENT_STATUSES = ['confirmed', 'packed', 'dispatched', 'delivered'] as const;
export type FulfillmentStatus = (typeof FULFILLMENT_STATUSES)[number];

export type ShippingAddressSource = 'sandbox_mock' | 'buyer_confirmed';

export type ShippingAddress = {
  recipientName: string;
  street: string;
  city: string;
  state: string;
  pincode: string;
  phone: string;
  source: ShippingAddressSource;
};

export type FulfillmentTimelineEvent = {
  id: string;
  at: string;
  status: FulfillmentStatus;
  label: string;
  detail: string;
};

export function isFulfillmentStatus(value: string): value is FulfillmentStatus {
  return (FULFILLMENT_STATUSES as readonly string[]).includes(value);
}

export function charterTrackingId(checkoutId: string): string {
  const compact = checkoutId
    .replace(/-/g, '')
    .toUpperCase()
    .replace(/[^0-9A-F]/g, '0')
    .padEnd(12, '0')
    .slice(0, 12);
  return `CHR-TRK-${compact}`;
}

export function mockIndianAddress(checkoutId: string): ShippingAddress {
  const n = (Number.parseInt(checkoutId.replace(/-/g, '').slice(0, 4), 16) % 80) + 10;
  return {
    recipientName: 'Charter Demo Recipient',
    street: `${n} Sandbox Lane, Demo Colony`,
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560001',
    phone: '+91 90000 00000',
    source: 'sandbox_mock',
  };
}

export function fulfillmentStatusLabel(status: FulfillmentStatus): string {
  switch (status) {
    case 'confirmed':
      return 'Confirmed';
    case 'packed':
      return 'Packed';
    case 'dispatched':
      return 'Dispatched';
    case 'delivered':
      return 'Delivered';
  }
}

export function fulfillmentStatusDetail(status: FulfillmentStatus): string {
  switch (status) {
    case 'confirmed':
      return 'Charter sandbox: payment captured. Eligible to fulfill — not shipped.';
    case 'packed':
      return 'Charter sandbox: merchant marked this order packed.';
    case 'dispatched':
      return 'Charter sandbox: merchant marked this order dispatched. Tracking is a Charter demo id, not a courier AWB.';
    case 'delivered':
      return 'Charter sandbox: merchant marked this order delivered. Not a live carrier scan.';
  }
}

export function nextFulfillmentStatus(current: FulfillmentStatus): FulfillmentStatus | null {
  const index = FULFILLMENT_STATUSES.indexOf(current);
  return FULFILLMENT_STATUSES[index + 1] ?? null;
}

export function formatShippingAddress(address: ShippingAddress): string {
  return [
    address.recipientName,
    address.street,
    `${address.city}, ${address.state} ${address.pincode}`,
    address.phone,
  ].join('\n');
}
