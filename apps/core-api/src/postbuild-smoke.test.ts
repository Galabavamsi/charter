import { describe, expect, it } from 'vitest';
import { createSmokeEnvironment, validateSmokeResults } from './postbuild-smoke-helpers.js';

const passingResults = {
  health: {
    status: 200,
    contentType: 'application/json; charset=utf-8',
    body: '{"ok":true}',
  },
  root: {
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><div id="root"></div>',
  },
  deepLink: {
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><div id="root"></div>',
  },
  missingApi: {
    status: 404,
    contentType: 'application/json; charset=utf-8',
    body: '{"error":"NOT_FOUND"}',
  },
};

describe('post-build smoke helpers', () => {
  it('passes only required OS variables and fixed smoke configuration', () => {
    const environment = createSmokeEnvironment(
      {
        PATH: '/safe/bin',
        HOME: '/safe/home',
        RAZORPAY_KEY_SECRET: 'must-not-leak',
        DATABASE_URL: 'must-not-leak',
      },
      4321,
    );

    expect(environment).toMatchObject({
      PATH: '/safe/bin',
      HOME: '/safe/home',
      CHARTER_ENV: 'test',
      RAZORPAY_MODE: 'test',
      LOG_LEVEL: 'error',
      PORT: '4321',
    });
    expect(environment).not.toHaveProperty('RAZORPAY_KEY_SECRET');
    expect(environment).not.toHaveProperty('DATABASE_URL');
  });

  it('requires API 404s to remain JSON', () => {
    expect(() => validateSmokeResults(passingResults)).not.toThrow();
    expect(() =>
      validateSmokeResults({
        ...passingResults,
        missingApi: {
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: '<!doctype html><div id="root"></div>',
        },
      }),
    ).toThrow(/missing API/i);
  });
});
