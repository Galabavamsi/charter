import { describe, expect, it } from 'vitest';
import { loadConfig } from './index.js';

const base = {
  DATABASE_URL: 'postgres://charter:charter@127.0.0.1:5432/charter',
};

function legacySupabaseKey(role: string): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ role })}.synthetic-signature`;
}

describe('loadConfig', () => {
  it('injects stable local cursor secrets and requires one in deployed environments', () => {
    const development = loadConfig({ ...base, CHARTER_ENV: 'development' });
    const test = loadConfig({ ...base, CHARTER_ENV: 'test' });
    expect(development.CHARTER_CURSOR_SECRET).toMatch(/^charter-development-/);
    expect(development.CHARTER_CURSOR_SECRET.length).toBeGreaterThanOrEqual(32);
    expect(loadConfig({ ...base, CHARTER_ENV: 'development' }).CHARTER_CURSOR_SECRET).toBe(
      development.CHARTER_CURSOR_SECRET,
    );
    expect(test.CHARTER_CURSOR_SECRET).toMatch(/^charter-test-/);
    expect(test.CHARTER_CURSOR_SECRET.length).toBeGreaterThanOrEqual(32);
    expect(() => loadConfig({ ...base, CHARTER_ENV: 'staging' })).toThrow(
      'CHARTER_CURSOR_SECRET_REQUIRED',
    );
    expect(() => loadConfig({ ...base, CHARTER_ENV: 'production' })).toThrow(
      'CHARTER_CURSOR_SECRET_REQUIRED',
    );
    expect(
      loadConfig({
        ...base,
        CHARTER_ENV: 'production',
        CHARTER_CURSOR_SECRET: 'a-production-cursor-secret-at-least-32-characters',
      }).CHARTER_CURSOR_SECRET,
    ).toBe('a-production-cursor-secret-at-least-32-characters');
  });

  it('accepts test keys in development', () => {
    const config = loadConfig({
      ...base,
      CHARTER_ENV: 'development',
      RAZORPAY_MODE: 'test',
      RAZORPAY_KEY_ID: 'rzp_test_example',
      RAZORPAY_KEY_SECRET: 'secret',
    });
    expect(config.RAZORPAY_MODE).toBe('test');
  });

  it('rejects live keys when mode is test', () => {
    expect(() =>
      loadConfig({
        ...base,
        RAZORPAY_MODE: 'test',
        RAZORPAY_KEY_ID: 'rzp_live_example',
        RAZORPAY_KEY_SECRET: 'secret',
      }),
    ).toThrow('RAZORPAY_MODE_KEY_MISMATCH');
  });

  it('rejects live Razorpay in development', () => {
    expect(() =>
      loadConfig({
        ...base,
        CHARTER_ENV: 'development',
        RAZORPAY_MODE: 'live',
        RAZORPAY_KEY_ID: 'rzp_live_example',
        RAZORPAY_KEY_SECRET: 'secret',
      }),
    ).toThrow(/LIVE_RAZORPAY_FORBIDDEN_IN_DEVELOPMENT/);
  });

  it('accepts browser-safe Supabase and server JWT settings', () => {
    const config = loadConfig({
      ...base,
      SUPABASE_URL: 'https://synthetic-project.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic',
      SUPABASE_JWT_ISSUER: 'https://synthetic-project.supabase.co/auth/v1',
      SUPABASE_JWT_AUDIENCE: 'authenticated',
    });

    expect(config.SUPABASE_PUBLISHABLE_KEY).toBe('sb_publishable_synthetic');
    expect(config.SUPABASE_JWT_AUDIENCE).toBe('authenticated');
  });

  it('accepts only anon legacy Supabase JWT keys', () => {
    const config = loadConfig({
      ...base,
      SUPABASE_PUBLISHABLE_KEY: legacySupabaseKey('anon'),
    });

    expect(config.SUPABASE_PUBLISHABLE_KEY).toBe(legacySupabaseKey('anon'));
  });

  it('rejects a secret Supabase key in the publishable setting', () => {
    expect(() =>
      loadConfig({
        ...base,
        SUPABASE_PUBLISHABLE_KEY: 'sb_secret_must_not_reach_browser',
      }),
    ).toThrow('SUPABASE_SECRET_KEY_FORBIDDEN');
  });

  it.each([
    ['legacy service role', legacySupabaseKey('service_role')],
    ['legacy authenticated role', legacySupabaseKey('authenticated')],
    ['malformed JWT', 'not.a-valid-json.jwt'],
    ['unknown key format', 'synthetic-public-looking-key'],
    ['empty modern key', 'sb_publishable_'],
  ])('rejects %s in the publishable setting', (_label, key) => {
    expect(() =>
      loadConfig({
        ...base,
        SUPABASE_PUBLISHABLE_KEY: key,
      }),
    ).toThrow('SUPABASE_PUBLISHABLE_KEY_INVALID');
  });
});
