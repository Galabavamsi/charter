export type Iso4217 = 'INR';

export type Money = {
  readonly amountMinor: bigint;
  readonly currency: Iso4217;
};

const MINOR_SCALE: Record<Iso4217, number> = {
  INR: 100,
};

export function money(amountMinor: bigint | number, currency: Iso4217 = 'INR'): Money {
  if (typeof amountMinor === 'number') {
    if (!Number.isInteger(amountMinor)) {
      throw new Error('MONEY_NOT_INTEGER');
    }
    return { amountMinor: BigInt(amountMinor), currency };
  }
  return { amountMinor, currency };
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amountMinor: a.amountMinor - b.amountMinor, currency: a.currency };
}

export function formatInr(value: Money): string {
  if (value.currency !== 'INR') {
    throw new Error('UNSUPPORTED_CURRENCY');
  }
  const scale = MINOR_SCALE.INR;
  const negative = value.amountMinor < 0n;
  const abs = negative ? -value.amountMinor : value.amountMinor;
  const rupees = abs / BigInt(scale);
  const paise = abs % BigInt(scale);
  const paiseText = paise.toString().padStart(2, '0');
  return `${negative ? '-' : ''}₹${groupIndianRupees(rupees)}.${paiseText}`;
}

function groupIndianRupees(rupees: bigint): string {
  const digits = rupees.toString();
  if (digits.length <= 3) {
    return digits;
  }
  const lastThree = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const groupedRest = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${groupedRest},${lastThree}`;
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error('CURRENCY_MISMATCH');
  }
}
