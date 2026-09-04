import { describe, expect, it } from 'vitest';
import {
  grantRecoveryConsent,
  isValidRecoveryEmail,
  RECOVERY_CHANNEL_EMAIL,
  RECOVERY_PURPOSE,
} from './consent.js';

describe('recovery consent', () => {
  it('requires an explicit payment_recovery email grant', () => {
    expect(() => grantRecoveryConsent({ email: 'shopper@example.com' })).toThrow(
      'CONSENT_PURPOSE_REQUIRED',
    );
    expect(() =>
      grantRecoveryConsent({
        email: 'shopper@example.com',
        purpose: RECOVERY_PURPOSE,
        channel: 'whatsapp',
      }),
    ).toThrow('CONSENT_CHANNEL_REQUIRED');
    expect(() =>
      grantRecoveryConsent({
        email: 'not-an-email',
        purpose: RECOVERY_PURPOSE,
        channel: RECOVERY_CHANNEL_EMAIL,
      }),
    ).toThrow('CONSENT_EMAIL_REQUIRED');
  });

  it('normalizes a valid grant', () => {
    const consent = grantRecoveryConsent({
      email: '  Shopper@Example.com ',
      purpose: RECOVERY_PURPOSE,
      channel: RECOVERY_CHANNEL_EMAIL,
    });
    expect(consent.email).toBe('shopper@example.com');
    expect(consent.purpose).toBe('payment_recovery');
    expect(isValidRecoveryEmail(consent.email)).toBe(true);
  });
});
