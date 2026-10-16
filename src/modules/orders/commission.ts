/**
 * Platform revenue snapshot stored on every order.
 *
 * Interim owner policy (no public seller self-service / no seller payouts yet):
 * the platform retains 100% of the customer-paid winning price. Seller net is
 * always zero and blocked so settlement tooling cannot invent a payable.
 *
 * Field names stay for stored order documents; do not surface seller-net UX.
 */
export const COMMISSION_VERSION = '2026-10-16-platform-100';

export type CommissionSnapshot = {
  policyVersion: string;
  commissionStatus: 'calculated' | 'unresolved';
  commissionAmountMinor: number | null;
  sellerNetAmountMinor: number | null;
  sellerNetStatus: 'ready' | 'blocked';
};

/** Customer-paid amount is platform revenue. No seller split. */
export function commissionOf(amountMinor: number): CommissionSnapshot {
  return {
    policyVersion: COMMISSION_VERSION,
    commissionStatus: 'calculated',
    commissionAmountMinor: amountMinor,
    sellerNetAmountMinor: 0,
    sellerNetStatus: 'blocked',
  };
}
