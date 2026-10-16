/** QAR minor units. 100 dirhams = 10_000. Threshold QAR 2,000 = 200_000. */
const THRESHOLD_MINOR = 200_000;
const FLAT_FEE_MINOR = 10_000;
export const COMMISSION_VERSION = '2026-10-15';

export type CommissionSnapshot = {
  policyVersion: string;
  commissionStatus: 'calculated' | 'unresolved';
  commissionAmountMinor: number | null;
  sellerNetAmountMinor: number | null;
  sellerNetStatus: 'ready' | 'blocked';
};

/**
 * Below QAR 2,000: QAR 100. Above: 5%, half-up to the minor unit.
 * Exactly QAR 2,000 is unresolved: no seller net is invented.
 */
export function commissionOf(amountMinor: number): CommissionSnapshot {
  if (amountMinor === THRESHOLD_MINOR) {
    return {
      policyVersion: COMMISSION_VERSION,
      commissionStatus: 'unresolved',
      commissionAmountMinor: null,
      sellerNetAmountMinor: null,
      sellerNetStatus: 'blocked',
    };
  }
  const commissionAmountMinor = amountMinor < THRESHOLD_MINOR
    ? FLAT_FEE_MINOR
    : Math.round((amountMinor * 5) / 100);
  return {
    policyVersion: COMMISSION_VERSION,
    commissionStatus: 'calculated',
    commissionAmountMinor,
    sellerNetAmountMinor: amountMinor - commissionAmountMinor,
    sellerNetStatus: 'ready',
  };
}
