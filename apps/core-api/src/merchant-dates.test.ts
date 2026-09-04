import { describe, expect, it } from 'vitest';
import {
  parseCalendarDate,
  resolveMerchantDateRange,
  validateDateRange,
} from './merchant-dates.js';

describe('merchant date range contract', () => {
  it('accepts a leap day and rejects an invalid calendar date', () => {
    expect(parseCalendarDate('2024-02-29').toISOString()).toBe('2024-02-29T00:00:00.000Z');
    expect(() => parseCalendarDate('2025-02-29')).toThrow('DATE_RANGE_INVALID');
    expect(() => parseCalendarDate('2026-02-31')).toThrow('DATE_RANGE_INVALID');
  });

  it('rejects reversed ranges and windows longer than 366 inclusive days', () => {
    expect(() => validateDateRange('2026-08-31', '2026-08-01')).toThrow('DATE_RANGE_INVALID');
    expect(() => validateDateRange('2024-01-01', '2025-01-01')).toThrow('DATE_RANGE_INVALID');
    expect(() => validateDateRange('2024-01-01', '2024-12-31')).not.toThrow();
  });

  it('validates each present date even for one-sided ranges', () => {
    expect(() => parseCalendarDate('2026-13-01')).toThrow('DATE_RANGE_INVALID');
    expect(() => parseCalendarDate('2026-00-10')).toThrow('DATE_RANGE_INVALID');
    expect(() =>
      resolveMerchantDateRange('2026-04-31', '2026-05-01', {
        from: '2026-01-01',
        to: '2026-01-31',
      }),
    ).toThrow('DATE_RANGE_INVALID');
    expect(() =>
      resolveMerchantDateRange('2026-05-01', '2026-04-31', {
        from: '2026-01-01',
        to: '2026-01-31',
      }),
    ).toThrow('DATE_RANGE_INVALID');
    expect(() =>
      resolveMerchantDateRange(undefined, '2026-02-30', { from: '2026-01-01', to: '2026-01-31' }),
    ).toThrow('DATE_RANGE_INVALID');
  });

  it('fills one-sided ranges to the maximum inclusive window', () => {
    expect(
      resolveMerchantDateRange('2026-01-01', undefined, { from: '2026-01-01', to: '2026-01-31' }),
    ).toEqual({
      from: '2026-01-01',
      to: '2027-01-01',
    });
    expect(
      resolveMerchantDateRange(undefined, '2026-12-31', { from: '2026-01-01', to: '2026-12-31' }),
    ).toEqual({
      from: '2025-12-31',
      to: '2026-12-31',
    });
    expect(() =>
      resolveMerchantDateRange('2026-02-31', undefined, { from: '2026-01-01', to: '2026-01-31' }),
    ).toThrow('DATE_RANGE_INVALID');
  });
});
