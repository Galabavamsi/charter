const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_INCLUSIVE_DAYS = 366;

export function parseCalendarDate(value: string): Date {
  const match = DATE_ONLY.exec(value);
  if (!match) {
    throw new Error('DATE_RANGE_INVALID');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error('DATE_RANGE_INVALID');
  }
  return date;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function validateDateRange(from: string, to: string): void {
  const fromDate = parseCalendarDate(from);
  const toDate = parseCalendarDate(to);
  if (fromDate > toDate) {
    throw new Error('DATE_RANGE_INVALID');
  }
  const days = Math.floor((toDate.getTime() - fromDate.getTime()) / 86_400_000) + 1;
  if (days > MAX_INCLUSIVE_DAYS) {
    throw new Error('DATE_RANGE_INVALID');
  }
}

export function resolveMerchantDateRange(
  from: string | undefined,
  to: string | undefined,
  defaults: { from: string; to: string },
): { from: string; to: string } {
  if (from && to) {
    validateDateRange(from, to);
    return { from, to };
  }
  if (from && !to) {
    const fromDate = parseCalendarDate(from);
    const resolvedTo = formatDate(addUtcDays(fromDate, MAX_INCLUSIVE_DAYS - 1));
    validateDateRange(from, resolvedTo);
    return { from, to: resolvedTo };
  }
  if (to && !from) {
    const toDate = parseCalendarDate(to);
    const resolvedFrom = formatDate(addUtcDays(toDate, -(MAX_INCLUSIVE_DAYS - 1)));
    validateDateRange(resolvedFrom, to);
    return { from: resolvedFrom, to };
  }
  validateDateRange(defaults.from, defaults.to);
  return defaults;
}
