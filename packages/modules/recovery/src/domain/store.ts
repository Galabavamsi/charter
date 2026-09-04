import { grantRecoveryConsent, type RecoveryConsent } from './consent.js';

export type RecoveryStore = {
  grant(input: { email?: string; purpose?: string; channel?: string }): RecoveryConsent;
  hydrate(consent: RecoveryConsent): RecoveryConsent;
  bind(checkoutId: string, consentId: string): RecoveryConsent;
  consentFor(checkoutId: string): RecoveryConsent | undefined;
  get(consentId: string): RecoveryConsent | undefined;
};

export function createRecoveryStore(): RecoveryStore {
  const consents = new Map<string, RecoveryConsent>();
  const byCheckout = new Map<string, string>();

  return {
    grant(input) {
      const consent = grantRecoveryConsent(input);
      consents.set(consent.id, consent);
      return consent;
    },
    hydrate(consent) {
      const copy = { ...consent };
      consents.set(copy.id, copy);
      return copy;
    },
    bind(checkoutId, consentId) {
      const consent = consents.get(consentId);
      if (!consent) {
        throw new Error('CONSENT_NOT_FOUND');
      }
      byCheckout.set(checkoutId, consentId);
      return consent;
    },
    consentFor(checkoutId) {
      const consentId = byCheckout.get(checkoutId);
      return consentId ? consents.get(consentId) : undefined;
    },
    get(consentId) {
      return consents.get(consentId);
    },
  };
}
