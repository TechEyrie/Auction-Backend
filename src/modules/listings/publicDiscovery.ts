import type { ListingMethod } from './models.ts';
import type { PublicListingDto } from './dto.ts';

/** Auction inventory is hidden from public catalogues until a live lot exists. */
export function isPublicDiscoveryListing(input: {
  listingMethod: ListingMethod;
  liveLotReference: string | null;
}): boolean {
  if (input.listingMethod !== 'auction') return true;
  return input.liveLotReference != null;
}

export function filterPublicDiscoveryListings(listings: PublicListingDto[]): PublicListingDto[] {
  return listings.filter((listing) =>
    isPublicDiscoveryListing({ listingMethod: listing.listingMethod, liveLotReference: listing.liveLotReference }),
  );
}
