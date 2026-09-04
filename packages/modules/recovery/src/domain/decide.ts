export type RecoverySkipReason =
  | 'NO_CONSENT'
  | 'NOT_FAILED_PROVISIONAL'
  | 'RECONCILIATION_REQUIRED'
  | 'PAYMENT_AUTHORIZED'
  | 'PAYMENT_CAPTURED'
  | 'PAYMENT_REFUNDED'
  | 'QUOTE_CHANGED'
  | 'CHECKOUT_KILLED'
  | 'SUPPRESSED'
  | 'ALREADY_PENDING'
  | 'ALREADY_SENT'
  | 'RETRY_LIMIT_REACHED'
  | 'NOT_CONFIGURED';

export type RecoveryDecision = { action: 'send' } | { action: 'skip'; reason: RecoverySkipReason };

export function decideFailedPayRecovery(input: {
  status: string;
  hasConsent: boolean;
  configured: boolean;
}): RecoveryDecision {
  if (input.status !== 'FAILED_PROVISIONAL') {
    return { action: 'skip', reason: 'NOT_FAILED_PROVISIONAL' };
  }
  if (!input.hasConsent) {
    return { action: 'skip', reason: 'NO_CONSENT' };
  }
  if (!input.configured) {
    return { action: 'skip', reason: 'NOT_CONFIGURED' };
  }
  return { action: 'send' };
}
