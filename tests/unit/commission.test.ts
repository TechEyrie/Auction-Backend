import test from 'node:test';
import assert from 'node:assert/strict';
import { commissionOf } from '../../src/modules/orders/commission.ts';

test('commission boundaries', () => {
  const below = commissionOf(199_999);
  assert.equal(below.commissionAmountMinor, 10_000);
  assert.equal(below.sellerNetAmountMinor, 189_999);
  const exact = commissionOf(200_000);
  assert.equal(exact.commissionStatus, 'unresolved');
  assert.equal(exact.sellerNetAmountMinor, null);
  const above = commissionOf(200_010);
  assert.equal(above.commissionAmountMinor, 10_001);
  assert.equal(above.sellerNetAmountMinor, 190_009);
  assert.equal('buyerPremium' in above, false);
});
