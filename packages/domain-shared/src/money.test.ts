import { describe, expect, it } from 'vitest';
import { add, formatInr, money } from './money.js';

describe('money', () => {
  it('formats INR from integer paise', () => {
    expect(formatInr(money(234700))).toBe('₹2,347.00');
    expect(formatInr(money(0))).toBe('₹0.00');
    expect(formatInr(money(1))).toBe('₹0.01');
    expect(formatInr(money(10000000))).toBe('₹1,00,000.00');
    expect(formatInr(money(1000000000))).toBe('₹1,00,00,000.00');
    expect(formatInr(money(10000000n))).toBe('₹1,00,000.00');
    expect(formatInr(money(1000000000n))).toBe('₹1,00,00,000.00');
    expect(formatInr(money(99999999999999n))).toBe('₹9,99,99,99,99,999.99');
  });

  it('rejects floating amounts', () => {
    expect(() => money(10.5)).toThrow('MONEY_NOT_INTEGER');
  });

  it('adds the canonical Northstar quote', () => {
    const kit = money(234700);
    expect(add(kit, money(0)).amountMinor).toBe(234700n);
  });
});
