import { describe, expect, it } from 'vitest';
import { safeNextPath } from './navigation';

describe('safe auth return paths', () => {
  it('keeps internal paths with their query and hash', () => {
    expect(
      safeNextPath('/buyer/northstar/chat/thread-7?from=voice#latest', 'https://charter.test'),
    ).toBe('/buyer/northstar/chat/thread-7?from=voice#latest');
  });

  it('normalizes same-origin absolute URLs to internal paths', () => {
    expect(safeNextPath('https://charter.test/merchant?tab=orders', 'https://charter.test')).toBe(
      '/merchant?tab=orders',
    );
  });

  it.each([
    'https://attacker.example/control',
    '//attacker.example/control',
    '\\\\attacker.example\\control',
    'javascript:alert(1)',
    '/auth/sign-in?next=/control',
    '/auth/sign-up',
    '',
  ])('rejects an unsafe next value: %s', (candidate) => {
    expect(safeNextPath(candidate, 'https://charter.test')).toBeNull();
  });
});
