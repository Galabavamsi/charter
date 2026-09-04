import { describe, expect, it, vi } from 'vitest';
import { RECOVERY_CHANNEL_EMAIL, RECOVERY_PURPOSE } from '../domain/consent.js';
import { attemptFailedPayRecovery } from './dispatch.js';

describe('failed-pay recovery dispatch', () => {
  const session = {
    id: 'chk_1',
    tenantId: 'tenant-one',
    status: 'FAILED_PROVISIONAL',
    quoteId: 'quote_1',
    razorpayOrderId: 'order_1',
  };
  const consent = {
    id: 'consent_1',
    tenantId: session.tenantId,
    userId: 'user_1',
    email: 'shopper@example.com',
    purpose: RECOVERY_PURPOSE,
    channel: RECOVERY_CHANNEL_EMAIL,
    grantedAt: '2026-08-22T12:00:00.000Z',
  };
  const safeEvidence = {
    reconciledAt: '2026-08-22T12:01:00.000Z',
    quoteId: session.quoteId,
    orderId: session.razorpayOrderId,
    orderStatus: 'attempted',
    outcome: 'same_order_retry_safe' as const,
    paymentAttempts: [{ paymentId: 'pay_failed', status: 'failed' }],
  };

  it('reserves durably before sending and then marks the pending attempt sent', async () => {
    const events: string[] = [];
    const repository = {
      async reserveRecoveryAttempt(input: unknown) {
        events.push('reserved');
        expect(input).toEqual({
          tenantId: session.tenantId,
          checkoutId: session.id,
          purpose: RECOVERY_PURPOSE,
          channel: RECOVERY_CHANNEL_EMAIL,
          maxAttempts: 2,
          evidence: safeEvidence,
        });
        return { action: 'reserved' as const, attemptId: 'attempt_1', consent };
      },
      async markRecoveryAttemptSent(input: unknown) {
        events.push('marked-sent');
        expect(input).toEqual({
          tenantId: session.tenantId,
          attemptId: 'attempt_1',
          providerMessageId: 'msg_1',
        });
      },
      markRecoveryAttemptFailed: vi.fn(),
    };
    const mailer = {
      configured: true,
      async send(input: { to: string; subject: string; text: string }) {
        events.push('provider-send');
        expect(input.to).toBe(consent.email);
        return { messageId: 'msg_1' };
      },
    };

    const result = await attemptFailedPayRecovery({
      repository,
      mailer,
      reconcile: async () => safeEvidence,
      session,
      merchant: 'Northstar Travel Coffee',
      totalDisplay: '₹2,347.00',
    });

    expect(result).toEqual({ action: 'sent', messageId: 'msg_1' });
    expect(events).toEqual(['reserved', 'provider-send', 'marked-sent']);
    expect(repository.markRecoveryAttemptFailed).not.toHaveBeenCalled();
  });

  it('records a provider failure before allowing a bounded retry', async () => {
    const repository = {
      async reserveRecoveryAttempt() {
        return { action: 'reserved' as const, attemptId: 'attempt_1', consent };
      },
      markRecoveryAttemptSent: vi.fn(),
      markRecoveryAttemptFailed: vi.fn(async () => undefined),
    };
    const result = await attemptFailedPayRecovery({
      repository,
      mailer: {
        configured: true,
        async send() {
          throw new Error('AGENTMAIL_SEND_FAILED:503');
        },
      },
      reconcile: async () => safeEvidence,
      session,
      merchant: 'Northstar Travel Coffee',
      totalDisplay: '₹2,347.00',
    });

    expect(result).toEqual({ action: 'failed', reason: 'AGENTMAIL_SEND_FAILED:503' });
    expect(repository.markRecoveryAttemptFailed).toHaveBeenCalledWith({
      tenantId: session.tenantId,
      attemptId: 'attempt_1',
      failureCode: 'AGENTMAIL_SEND_FAILED:503',
    });
    expect(repository.markRecoveryAttemptSent).not.toHaveBeenCalled();
  });

  it('rejects leaking recovery copy before creating a pending reservation', async () => {
    const repository = {
      reserveRecoveryAttempt: vi.fn(async () => ({
        action: 'reserved' as const,
        attemptId: 'attempt_1',
        consent,
      })),
      markRecoveryAttemptSent: vi.fn(),
      markRecoveryAttemptFailed: vi.fn(),
    };
    const mailer = {
      configured: true,
      send: vi.fn(async () => ({ messageId: 'nope' })),
    };

    await expect(
      attemptFailedPayRecovery({
        repository,
        mailer,
        reconcile: async (recoverySession) => ({
          ...safeEvidence,
          orderId: recoverySession.razorpayOrderId,
        }),
        session: { ...session, razorpayOrderId: 'rzp_live_must_not_leak' },
        merchant: 'Northstar Travel Coffee',
        totalDisplay: '₹2,347.00',
      }),
    ).rejects.toThrow('RECOVERY_COPY_LEAK');

    expect(repository.reserveRecoveryAttempt).not.toHaveBeenCalled();
    expect(repository.markRecoveryAttemptSent).not.toHaveBeenCalled();
    expect(repository.markRecoveryAttemptFailed).not.toHaveBeenCalled();
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('does not call the provider when durable reservation is suppressed', async () => {
    const mailer = {
      configured: true,
      send: vi.fn(async () => ({ messageId: 'nope' })),
    };
    const result = await attemptFailedPayRecovery({
      repository: {
        async reserveRecoveryAttempt() {
          return { action: 'suppressed' as const, reason: 'ALREADY_PENDING' as const };
        },
        markRecoveryAttemptSent: vi.fn(),
        markRecoveryAttemptFailed: vi.fn(),
      },
      mailer,
      reconcile: async () => safeEvidence,
      session,
      merchant: 'Northstar Travel Coffee',
      totalDisplay: '₹2,347.00',
    });

    expect(result).toEqual({ action: 'skipped', reason: 'ALREADY_PENDING' });
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('does not reserve or send when the checkout is not failed', async () => {
    const repository = {
      reserveRecoveryAttempt: vi.fn(),
      markRecoveryAttemptSent: vi.fn(),
      markRecoveryAttemptFailed: vi.fn(),
    };
    const mailer = {
      configured: true,
      send: vi.fn(async () => ({ messageId: 'nope' })),
    };

    const result = await attemptFailedPayRecovery({
      repository,
      mailer,
      reconcile: async () => safeEvidence,
      session: { ...session, status: 'SETTLED' },
      merchant: 'Northstar Travel Coffee',
      totalDisplay: '₹2,347.00',
    });

    expect(result).toEqual({ action: 'skipped', reason: 'NOT_FAILED_PROVISIONAL' });
    expect(repository.reserveRecoveryAttempt).not.toHaveBeenCalled();
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('reconciles provider truth before skipping send when mail is not configured', async () => {
    const repository = {
      reserveRecoveryAttempt: vi.fn(),
      markRecoveryAttemptSent: vi.fn(),
      markRecoveryAttemptFailed: vi.fn(),
    };
    const reconcile = vi.fn(async () => safeEvidence);
    const result = await attemptFailedPayRecovery({
      repository,
      mailer: null,
      reconcile,
      session,
      merchant: 'Northstar Travel Coffee',
      totalDisplay: '₹2,347.00',
    });

    expect(reconcile).toHaveBeenCalledWith(session);
    expect(result).toEqual({ action: 'skipped', reason: 'NOT_CONFIGURED' });
    expect(repository.reserveRecoveryAttempt).not.toHaveBeenCalled();
  });

  it.each(['authorized', 'captured'] as const)(
    'stops a provisional failure after reconciliation finds a late %s attempt',
    async (status) => {
      const repository = {
        reserveRecoveryAttempt: vi.fn(),
        markRecoveryAttemptSent: vi.fn(),
        markRecoveryAttemptFailed: vi.fn(),
      };
      const mailer = {
        configured: true,
        send: vi.fn(async () => ({ messageId: 'nope' })),
      };

      const result = await attemptFailedPayRecovery({
        repository,
        mailer,
        reconcile: async () => ({
          ...safeEvidence,
          outcome: status === 'captured' ? 'captured' : 'authorized',
          paymentAttempts: [{ paymentId: 'pay_late', status }],
        }),
        session,
        merchant: 'Northstar Travel Coffee',
        totalDisplay: '₹2,347.00',
      });

      expect(result).toEqual({
        action: 'skipped',
        reason: status === 'captured' ? 'PAYMENT_CAPTURED' : 'PAYMENT_AUTHORIZED',
      });
      expect(repository.reserveRecoveryAttempt).not.toHaveBeenCalled();
      expect(mailer.send).not.toHaveBeenCalled();
    },
  );

  it('fails closed when provider reconciliation is unavailable', async () => {
    const repository = {
      reserveRecoveryAttempt: vi.fn(),
      markRecoveryAttemptSent: vi.fn(),
      markRecoveryAttemptFailed: vi.fn(),
    };
    const mailer = {
      configured: true,
      send: vi.fn(async () => ({ messageId: 'nope' })),
    };

    const result = await attemptFailedPayRecovery({
      repository,
      mailer,
      reconcile: async () => {
        throw new Error('RAZORPAY_ORDER_LOOKUP_FAILED:503');
      },
      session,
      merchant: 'Northstar Travel Coffee',
      totalDisplay: '₹2,347.00',
    });

    expect(result).toEqual({ action: 'skipped', reason: 'RECONCILIATION_REQUIRED' });
    expect(repository.reserveRecoveryAttempt).not.toHaveBeenCalled();
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('does not map persist failures to RECONCILIATION_REQUIRED', async () => {
    const repository = {
      reserveRecoveryAttempt: vi.fn(),
      markRecoveryAttemptSent: vi.fn(),
      markRecoveryAttemptFailed: vi.fn(),
    };
    const mailer = {
      configured: true,
      send: vi.fn(async () => ({ messageId: 'nope' })),
    };

    const result = await attemptFailedPayRecovery({
      repository,
      mailer,
      reconcile: async () => {
        throw new Error('WEBHOOK_TRANSITION_EVIDENCE_INVALID');
      },
      session,
      merchant: 'Northstar Travel Coffee',
      totalDisplay: '₹2,347.00',
    });

    expect(result).toEqual({
      action: 'failed',
      reason: 'WEBHOOK_TRANSITION_EVIDENCE_INVALID',
    });
    expect(repository.reserveRecoveryAttempt).not.toHaveBeenCalled();
    expect(mailer.send).not.toHaveBeenCalled();
  });
});
