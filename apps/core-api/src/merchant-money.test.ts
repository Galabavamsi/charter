import { describe, expect, it } from 'vitest';
import { parseInrDecimalToPaise } from './merchant-money.js';

describe('merchant INR decimal parsing', () => {
  it.each([
    ['0', 0n],
    ['0.01', 1n],
    ['12.3', 1230n],
    ['2347.00', 234700n],
    ['999999999999.99', 99999999999999n],
  ])('parses %s exactly without passing through a float', (input, expected) => {
    expect(parseInrDecimalToPaise(input)).toBe(expected);
  });

  it.each([
    '',
    ' ',
    '.50',
    '01.00',
    '1.',
    '1.001',
    '1e3',
    '+1',
    '-1',
    'NaN',
    'Infinity',
    '1000000000000.00',
  ])('rejects ambiguous or out-of-range input %j', (input) => {
    expect(() => parseInrDecimalToPaise(input)).toThrow('MONEY_DECIMAL_INVALID');
  });
});
