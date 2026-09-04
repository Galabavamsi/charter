import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('retired Register entrypoint', () => {
  it('links to the relative canonical merchant route without a localhost origin', () => {
    const source = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');

    expect(source).toContain('href="/merchant"');
    expect(source).not.toMatch(/https?:\/\/(?:localhost|127\.0\.0\.1)/);
  });
});
