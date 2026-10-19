import { BUSINESS_TIMEZONE } from './time.ts';

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
