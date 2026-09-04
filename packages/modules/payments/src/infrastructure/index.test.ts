import { describe, expect, it } from 'vitest';
import { paymentAmountMinor, shouldApplyProviderTransition } from './index.js';

describe('payment amount hydration', () => {
  it('accepts only nonnegative safe integers', () => {
    expect(paymentAmountMinor('234700')).toBe(234700);
    expect(paymentAmountMinor(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => paymentAmountMinor('9007199254740992')).toThrow('PAYMENT_AMOUNT_MINOR_UNSAFE');
    expect(() => paymentAmountMinor(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      'PAYMENT_AMOUNT_MINOR_UNSAFE',
    );
    expect(() => paymentAmountMinor('12.5')).toThrow('PAYMENT_AMOUNT_MINOR_INVALID');
    expect(() => paymentAmountMinor('-1')).toThrow('PAYMENT_AMOUNT_MINOR_UNSAFE');
  });
});

describe('provider transition precedence', () => {
  it('allows failed to advance through authorized or directly to captured', () => {
    expect(shouldApplyProviderTransition('failed', 'authorized')).toBe(true);
    expect(shouldApplyProviderTransition('failed', 'captured')).toBe(true);
  });

  it('never regresses authorized or captured evidence', () => {
    expect(shouldApplyProviderTransition('authorized', 'failed')).toBe(false);
    expect(shouldApplyProviderTransition('captured', 'authorized')).toBe(false);
    expect(shouldApplyProviderTransition('captured', 'failed')).toBe(false);
  });

  it('allows idempotent evidence and direct capture', () => {
    expect(shouldApplyProviderTransition('failed', 'failed')).toBe(true);
    expect(shouldApplyProviderTransition('authorized', 'authorized')).toBe(true);
    expect(shouldApplyProviderTransition('captured', 'captured')).toBe(true);
    expect(shouldApplyProviderTransition('created', 'captured')).toBe(true);
  });

  it('allows captured evidence to advance to refunded', () => {
    expect(shouldApplyProviderTransition('captured', 'refunded')).toBe(true);
    expect(shouldApplyProviderTransition('authorized', 'refunded')).toBe(true);
    expect(shouldApplyProviderTransition('failed', 'refunded')).toBe(true);
    expect(shouldApplyProviderTransition('refunded', 'captured')).toBe(false);
  });
});
