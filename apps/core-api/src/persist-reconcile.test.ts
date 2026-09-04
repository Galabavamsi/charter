import { describe, expect, it, vi } from 'vitest';
import type { CheckoutSession } from '@charter/payments';
import { persistReconciledCheckout } from './persist.js';

function session(overrides: Partial<CheckoutSession> = {}): CheckoutSession {
  return {
    id: '92000000-0000-4000-8000-000000000001',
    tenantId: 'northstar-demo-in',
    quoteId: '92000000-0000-4000-8000-000000000002',
    receipt: 'rcpt',
    razorpayOrderId: 'order_x',
    amountMinor: 234700,
    currency: 'INR',
    status: 'RECONCILING',
    paymentId: 'pay_refunded',
    providerStatus: 'refunded',
    copy: 'Payment not confirmed. Reconciling provider state.',
    ...overrides,
  };
}

describe('persistReconciledCheckout', () => {
  it('saves identity and writes a provider transition when refunded paymentId is present', async () => {
    const saveCheckout = vi.fn(async () => undefined);
    const persistWebhookTransition = vi.fn(async (row: CheckoutSession) => row);
    await persistReconciledCheckout({ saveCheckout, persistWebhookTransition }, session());
    expect(saveCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: 'pay_refunded' }),
    );
    expect(persistWebhookTransition).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: 'pay_refunded', providerStatus: 'refunded' }),
    );
  });

  it('does not call persistWebhookTransition when paymentId is still null', async () => {
    const saveCheckout = vi.fn(async () => undefined);
    const persistWebhookTransition = vi.fn(async (row: CheckoutSession) => row);
    await persistReconciledCheckout(
      { saveCheckout, persistWebhookTransition },
      session({ paymentId: null }),
    );
    expect(saveCheckout).toHaveBeenCalled();
    expect(persistWebhookTransition).not.toHaveBeenCalled();
  });

  it('still persists the checkout row if the transition write fails', async () => {
    const saveCheckout = vi.fn(async () => undefined);
    const persistWebhookTransition = vi.fn(async () => {
      throw new Error('WEBHOOK_TRANSITION_EVIDENCE_INVALID');
    });
    await expect(
      persistReconciledCheckout({ saveCheckout, persistWebhookTransition }, session()),
    ).resolves.toBeUndefined();
    expect(saveCheckout).toHaveBeenCalled();
  });
});
