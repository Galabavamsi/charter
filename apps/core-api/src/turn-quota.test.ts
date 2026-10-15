import { describe, expect, it } from 'vitest';
import { loadConfig } from '@charter/config';
import { createTurnQuota, turnQuotaFor } from './turn-quota.js';

describe('daily demo turn quota', () => {
  it('caps each buyer per UTC day and resets at midnight', () => {
    const quota = createTurnQuota({ perUser: 2, global: 10 });
    const morning = new Date('2026-10-15T01:00:00Z');
    expect(quota.take('buyer-a', morning)).toBe(true);
    expect(quota.take('BUYER-A', morning)).toBe(true);
    expect(quota.take('buyer-a', morning)).toBe(false);
    expect(quota.take('buyer-b', morning)).toBe(true);
    expect(quota.take('buyer-a', new Date('2026-10-15T23:59:59Z'))).toBe(false);
    expect(quota.take('buyer-a', new Date('2026-10-16T00:00:00Z'))).toBe(true);
  });

  it('stops every buyer once the deployment-wide cap is spent', () => {
    const quota = createTurnQuota({ perUser: 5, global: 3 });
    const now = new Date('2026-10-15T12:00:00Z');
    expect(quota.take('a', now)).toBe(true);
    expect(quota.take('b', now)).toBe(true);
    expect(quota.take('c', now)).toBe(true);
    expect(quota.take('d', now)).toBe(false);
    expect(quota.take('a', now)).toBe(false);
  });

  it('shares one quota per app config between text and voice', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://unused',
      CHARTER_ENV: 'test',
      CHARTER_DAILY_TURNS_PER_USER: '1',
    });
    expect(turnQuotaFor(config)).toBe(turnQuotaFor(config));
    expect(turnQuotaFor(config).take('buyer')).toBe(true);
    expect(turnQuotaFor(config).take('buyer')).toBe(false);
  });
});
