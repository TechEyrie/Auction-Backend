import { AppError } from './errors.ts';

/** QAR has 2 minor digits. Money is always stored as integer minor units. */
export const MINOR_UNITS_PER_QAR = 100;
export const CURRENCY = 'QAR';

export function assertMinorAmount(value: number, field = 'amountMinor'): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError('VALIDATION_ERROR', `${field} must be a non-negative integer in minor units`, {
      fieldErrors: { [field]: 'must be a non-negative integer (minor units)' },
    });
  }
  return value;
}

/** Parse a whole-QAR decimal string to minor units. Rejects values it cannot represent exactly. */
export function qarToMinor(qar: string | number): number {
  const n = typeof qar === 'number' ? qar : Number(qar.replace(/,/g, '').trim());
  if (!Number.isFinite(n)) {
    throw new AppError('VALIDATION_ERROR', 'Invalid QAR amount', { fieldErrors: { amount: 'not a number' } });
  }
  const minor = Math.round(n * MINOR_UNITS_PER_QAR);
  if (!Number.isSafeInteger(minor) || minor < 0) {
    throw new AppError('VALIDATION_ERROR', 'QAR amount out of range', { fieldErrors: { amount: 'out of range' } });
  }
  return minor;
}

export function formatMinor(amountMinor: number): string {
  assertMinorAmount(amountMinor);
  const qar = amountMinor / MINOR_UNITS_PER_QAR;
  return `${qar.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${CURRENCY}`;
}
