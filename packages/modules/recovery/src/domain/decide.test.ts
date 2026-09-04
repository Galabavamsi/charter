import { describe, expect, it } from 'vitest';
import { decideFailedPayRecovery } from './decide.js';

describe('failed-pay recovery decision', () => {
  it('sends only on FAILED_PROVISIONAL with consent, once', () => {
    expect(
      decideFailedPayRecovery({
        status: 'FAILED_PROVISIONAL',
        hasConsent: true,
        configured: true,
      }),
    ).toEqual({ action: 'send' });
  });

  it('never mails a captured payment', () => {
    expect(
      decideFailedPayRecovery({
        status: 'SETTLED',
        hasConsent: true,
        configured: true,
      }),
    ).toEqual({ action: 'skip', reason: 'NOT_FAILED_PROVISIONAL' });
  });

  it('stays silent without consent', () => {
    expect(
      decideFailedPayRecovery({
        status: 'FAILED_PROVISIONAL',
        hasConsent: false,
        configured: true,
      }),
    ).toEqual({ action: 'skip', reason: 'NO_CONSENT' });
  });

  it('stays silent when the provider is not configured', () => {
    expect(
      decideFailedPayRecovery({
        status: 'FAILED_PROVISIONAL',
        hasConsent: true,
        configured: false,
      }),
    ).toEqual({ action: 'skip', reason: 'NOT_CONFIGURED' });
  });
});
