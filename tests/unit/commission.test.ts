import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commissionOf } from '../../src/modules/orders/commission.ts';

test('commission retains 100% for the platform with no seller net', () => {
  for (const amount of [1, 10_000, 199_999, 200_000, 200_010, 2_500_000]) {
    const snap = commissionOf(amount);
    assert.equal(snap.commissionStatus, 'calculated');
    assert.equal(snap.commissionAmountMinor, amount);
    assert.equal(snap.sellerNetAmountMinor, 0);
    assert.equal(snap.sellerNetStatus, 'blocked');
  }
});
