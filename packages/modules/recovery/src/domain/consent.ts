import { randomUUID } from 'node:crypto';

export const RECOVERY_PURPOSE = 'payment_recovery' as const;
export const RECOVERY_CHANNEL_EMAIL = 'email' as const;

export type RecoveryPurpose = typeof RECOVERY_PURPOSE;
export type RecoveryChannel = typeof RECOVERY_CHANNEL_EMAIL;

export type RecoveryConsent = {
  id: string;
  email: string;
  purpose: RecoveryPurpose;
  channel: RecoveryChannel;
  grantedAt: string;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeRecoveryEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidRecoveryEmail(email: string): boolean {
  return EMAIL.test(normalizeRecoveryEmail(email));
}

export function grantRecoveryConsent(input: {
  email?: string;
  purpose?: string;
  channel?: string;
}): RecoveryConsent {
  if (input.purpose !== RECOVERY_PURPOSE) {
    throw new Error('CONSENT_PURPOSE_REQUIRED');
  }
  if (input.channel !== RECOVERY_CHANNEL_EMAIL) {
    throw new Error('CONSENT_CHANNEL_REQUIRED');
  }
  if (!input.email || !isValidRecoveryEmail(input.email)) {
    throw new Error('CONSENT_EMAIL_REQUIRED');
  }
  return {
    id: randomUUID(),
    email: normalizeRecoveryEmail(input.email),
    purpose: RECOVERY_PURPOSE,
    channel: RECOVERY_CHANNEL_EMAIL,
    grantedAt: new Date().toISOString(),
  };
}
