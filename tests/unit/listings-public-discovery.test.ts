import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterPublicDiscoveryListings, isPublicDiscoveryListing } from '../../src/modules/listings/publicDiscovery.ts';
import type { PublicListingDto } from '../../src/modules/listings/dto.ts';

const base = (overrides: Partial<PublicListingDto>): PublicListingDto =>
  ({
    listingReference: 'l_test',
    publicUrl: '/product/l_test',
    languageMode: 'en',
    title: { en: 'T', ar: null },
    description: { en: 'D', ar: null },
    listingMethod: 'auction',
    condition: 'used',
    audience: 'men',
    category: { key: 'cars', path: ['cars'] },
    attributes: {},
    location: {
      countryCode: 'QA',
      cityKey: 'doha',
      areaKey: null,
      label: 'Doha',
      publicPrecision: 'city',
    },
    media: [],
    coverAssetId: null,
    seller: { sellerReference: 's_1', displayName: 'Seller', verificationBadge: false },
    featured: false,
    publishedAt: null,
    updatedAt: new Date().toISOString(),
    liveLotReference: null,
    currentAmountMinor: null,
    startingBidMinor: null,
    bidCount: null,
    startsAt: null,
    endsAt: null,
    ...overrides,
  }) as PublicListingDto;

test('isPublicDiscoveryListing hides auction inventory until live', () => {
  assert.equal(isPublicDiscoveryListing({ listingMethod: 'fixed_price', liveLotReference: null }), true);
  assert.equal(isPublicDiscoveryListing({ listingMethod: 'enquiry', liveLotReference: null }), true);
  assert.equal(isPublicDiscoveryListing({ listingMethod: 'auction', liveLotReference: null }), false);
  assert.equal(isPublicDiscoveryListing({ listingMethod: 'auction', liveLotReference: 'lot_1' }), true);
});

test('filterPublicDiscoveryListings', () => {
  const out = filterPublicDiscoveryListings([
    base({ listingReference: 'l_a', listingMethod: 'auction', liveLotReference: null }),
    base({ listingReference: 'l_b', listingMethod: 'auction', liveLotReference: 'lot_b' }),
    base({ listingReference: 'l_c', listingMethod: 'fixed_price', liveLotReference: null }),
  ]);
  assert.deepEqual(out.map((entry) => entry.listingReference), ['l_b', 'l_c']);
});
