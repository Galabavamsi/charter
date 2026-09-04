const INVALID_MONEY = 'MONEY_DECIMAL_INVALID';
const DECIMAL_INR = /^(0|[1-9]\d{0,11})(?:\.(\d{1,2}))?$/;
const MAX_PAISE = 99_999_999_999_999n;

export function parseInrDecimalToPaise(value: string): bigint {
  const match = DECIMAL_INR.exec(value);
  if (!match) {
    throw new Error(INVALID_MONEY);
  }
  const rupees = BigInt(match[1]!);
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const paise = rupees * 100n + BigInt(fraction || '0');
  if (paise > MAX_PAISE) {
    throw new Error(INVALID_MONEY);
  }
  return paise;
}
