/** Timestamps are stored and transported as UTC. Business display uses this zone. */
export const BUSINESS_TIMEZONE = 'Asia/Qatar';

export function nowUtc(): Date {
  return new Date();
}

export function toIsoUtc(date: Date): string {
  return date.toISOString();
}

/** True only for a valid, explicitly-UTC-ish ISO-8601 instant. */
export function isValidIsoTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}
