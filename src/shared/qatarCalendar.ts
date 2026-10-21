import { BUSINESS_TIMEZONE } from './time.ts';

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Inclusive start and exclusive end of one Qatar civil day (UTC+3, no DST). */
export function qatarDayUtcBounds(dateKey: string): { start: Date; endExclusive: Date } {
  if (!DATE_KEY_RE.test(dateKey)) {
    throw new Error(`Invalid Qatar date key: expected YYYY-MM-DD, got ${dateKey}`);
  }
  const start = new Date(`${dateKey}T00:00:00+03:00`);
  if (Number.isNaN(start.getTime())) {
    throw new Error(`Invalid Qatar date key: ${dateKey} is not a valid civil date`);
  }
  const civil = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(start);
  if (civil !== dateKey) {
    throw new Error(`Invalid Qatar date key: ${dateKey} is not a valid civil date`);
  }
  const endExclusive = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, endExclusive };
}

/** Inclusive start and exclusive end of a civil month in Qatar (UTC+3, no DST). */
export function qatarMonthUtcBounds(year: number, month: number): { start: Date; endExclusive: Date } {
  const mm = String(month).padStart(2, '0');
  const start = new Date(`${year}-${mm}-01T00:00:00+03:00`);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextMm = String(nextMonth).padStart(2, '0');
  const endExclusive = new Date(`${nextYear}-${nextMm}-01T00:00:00+03:00`);
  return { start, endExclusive };
}

/** Current civil year and month (1–12) in the business timezone. */
export function qatarNowYearMonth(): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(new Date());
  const year = Number(parts.find((p) => p.type === 'year')?.value);
  const month = Number(parts.find((p) => p.type === 'month')?.value);
  return { year, month };
}
