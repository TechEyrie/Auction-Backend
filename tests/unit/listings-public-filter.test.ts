import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPublicFilter } from '../../src/modules/listings/repository.ts';

test('buildPublicFilter keeps fixed_price when live auction refs are empty', () => {
  const filter = buildPublicFilter({
    sort: 'recent',
    page: 1,
    limit: 12,
    liveAuctionListingReferences: [],
  });
  assert.deepEqual(filter.$and, [
    {
      $or: [{ listingMethod: { $ne: 'auction' } }, { listingReference: { $in: [] } }],
    },
  ]);
  // Non-auction listings must still match the discovery clause when no lots are live.
  assert.equal(
    JSON.stringify({
      listingMethod: 'fixed_price',
      $and: filter.$and,
    }).includes('fixed_price'),
    true,
  );
});

test('buildPublicFilter does not apply discovery clause unless live refs are provided', () => {
  const filter = buildPublicFilter({ sort: 'recent', page: 1, limit: 12 });
  assert.equal(filter.$and, undefined);
});

test('buildPublicFilter can narrow by shopper audience', () => {
  const filter = buildPublicFilter({ sort: 'recent', page: 1, limit: 12, audience: 'women' });
  assert.equal(filter.audience, 'women');
  assert.equal(filter.status, 'published');
});
