import { buildFailedPayRecoveryCopy, type MailSender } from '@charter/notify';
import {
  RECOVERY_CHANNEL_EMAIL,
  RECOVERY_PURPOSE,
  type RecoveryChannel,
  type RecoveryPurpose,
  type RecoverySkipReason,
} from '../domain/index.js';

export const RECOVERY_MAX_ATTEMPTS = 2;

export type RecoveryAttempt =
  | { action: 'sent'; messageId: string }
  | { action: 'skipped'; reason: RecoverySkipReason }
  | { action: 'failed'; reason: string };

export type RecoverySession = {
  id: string;
  tenantId: string;
  status: string;
  quoteId: string;
  razorpayOrderId: string;
};

export type RecoveryDispatchConsent = {
  id: string;
  tenantId: string;
  userId: string;
  email: string;
  purpose: RecoveryPurpose;
  channel: RecoveryChannel;
  grantedAt: string;
};

export type RecoveryReconciliationEvidence = {
  reconciledAt: string;
  quoteId: string;
  orderId: string;
  orderStatus: string;
  outcome:
    | 'same_order_retry_safe'
    | 'authorized'
    | 'captured'
    | 'refunded'
    | 'provider_unavailable'
    | 'identity_mismatch'
    | 'unknown_attempts';
  paymentAttempts: Array<{ paymentId: string; status: string }>;
};

export type RecoveryAttemptReservation =
  | {
      action: 'reserved';
      attemptId: string;
      consent: RecoveryDispatchConsent;
    }
  | {
      action: 'suppressed';
      reason: RecoverySkipReason;
    };

export type RecoveryAttemptRepository = {
  reserveRecoveryAttempt(input: {
    tenantId: string;
    checkoutId: string;
    purpose: RecoveryPurpose;
    channel: RecoveryChannel;
    maxAttempts: number;
    evidence: RecoveryReconciliationEvidence;
  }): Promise<RecoveryAttemptReservation>;
  markRecoveryAttemptSent(input: {
    tenantId: string;
    attemptId: string;
    providerMessageId: string;
  }): Promise<void>;
  markRecoveryAttemptFailed(input: {
    tenantId: string;
    attemptId: string;
    failureCode: string;
  }): Promise<void>;
};

export async function attemptFailedPayRecovery(input: {
  repository: RecoveryAttemptRepository;
  mailer: MailSender | null;
  reconcile(session: RecoverySession): Promise<RecoveryReconciliationEvidence>;
  session: RecoverySession;
  merchant: string;
  totalDisplay: string;
}): Promise<RecoveryAttempt> {
  if (input.session.status !== 'FAILED_PROVISIONAL') {
    return { action: 'skipped', reason: 'NOT_FAILED_PROVISIONAL' };
  }
  let evidence: RecoveryReconciliationEvidence;
  try {
    evidence = await input.reconcile(input.session);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.startsWith('RECONCILIATION_') || message.startsWith('RAZORPAY_')) {
      return { action: 'skipped', reason: 'RECONCILIATION_REQUIRED' };
    }
    return { action: 'failed', reason: message || 'RECONCILE_FAILED' };
  }
  if (
    evidence.quoteId !== input.session.quoteId ||
    evidence.orderId !== input.session.razorpayOrderId
  ) {
    return { action: 'skipped', reason: 'QUOTE_CHANGED' };
  }
  if (evidence.outcome === 'captured') {
    return { action: 'skipped', reason: 'PAYMENT_CAPTURED' };
  }
  if (evidence.outcome === 'authorized') {
    return { action: 'skipped', reason: 'PAYMENT_AUTHORIZED' };
  }
  if (evidence.outcome === 'refunded') {
    return { action: 'skipped', reason: 'PAYMENT_REFUNDED' };
  }
  if (evidence.outcome !== 'same_order_retry_safe') {
    return { action: 'skipped', reason: 'RECONCILIATION_REQUIRED' };
  }
  if (!input.mailer?.configured) {
    return { action: 'skipped', reason: 'NOT_CONFIGURED' };
  }
  const copy = buildFailedPayRecoveryCopy({
    merchant: input.merchant,
    totalDisplay: input.totalDisplay,
    quoteId: input.session.quoteId,
    orderId: input.session.razorpayOrderId,
  });
  const reservation = await input.repository.reserveRecoveryAttempt({
    tenantId: input.session.tenantId,
    checkoutId: input.session.id,
    purpose: RECOVERY_PURPOSE,
    channel: RECOVERY_CHANNEL_EMAIL,
    maxAttempts: RECOVERY_MAX_ATTEMPTS,
    evidence,
  });
  if (reservation.action === 'suppressed') {
    return { action: 'skipped', reason: reservation.reason };
  }

  let sent: { messageId: string };
  try {
    sent = await input.mailer.send({
      to: reservation.consent.email,
      subject: copy.subject,
      text: copy.text,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'AGENTMAIL_SEND_FAILED';
    await input.repository.markRecoveryAttemptFailed({
      tenantId: input.session.tenantId,
      attemptId: reservation.attemptId,
      failureCode: reason,
    });
    return { action: 'failed', reason };
  }
  await input.repository.markRecoveryAttemptSent({
    tenantId: input.session.tenantId,
    attemptId: reservation.attemptId,
    providerMessageId: sent.messageId,
  });
  return { action: 'sent', messageId: sent.messageId };
}
