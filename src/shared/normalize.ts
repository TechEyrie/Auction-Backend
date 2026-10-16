import { AppError } from './errors.ts';

export const DEFAULT_DIAL_CODE = '+974';

/** Normalize a Qatari mobile number to E.164 (+974XXXXXXXX). Rejects anything else. */
export function normalizePhoneE164(input: string): string {
  const raw = String(input ?? '').trim();
  const digits = raw.replace(/[^\d]/g, '');
  let national: string;
  if (digits.startsWith('974')) national = digits.slice(3);
  else national = digits;
  if (!/^\d{8}$/.test(national)) {
    throw new AppError('VALIDATION_ERROR', 'Enter a valid Qatari mobile number', {
      fieldErrors: { phone: 'must be 8 digits (optionally with +974)' },
    });
  }
  return `${DEFAULT_DIAL_CODE}${national}`;
}

/** Normalize an email address; empty input is treated as absent. */
export function normalizeEmail(input: string | null | undefined): string | null {
  const raw = String(input ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) || raw.length > 254) {
    throw new AppError('VALIDATION_ERROR', 'Enter a valid email address', {
      fieldErrors: { email: 'invalid email' },
    });
  }
  return raw;
}
