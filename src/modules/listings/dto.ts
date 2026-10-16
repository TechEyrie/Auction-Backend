import type { AttributeField } from '../attributes/models.ts';
import { publicSchemaFields } from '../attributes/validate.ts';
import { mediaCollectionKey, type ListingDoc, type ListingMediaEntry } from './models.ts';

/**
 * Listing DTO boundaries.
 *
 *  - `PublicListingDto`  — what any visitor (signed in or not) may see.
 *  - `CustomerListingDto` — the customer projection. Today it is exactly the public projection;
 *    it exists as a named boundary because customer-owned aggregates (a customer's own bids,
 *    wins and watchlist) belong to later phases and must never arrive by widening the public
 *    mapper. A test asserts the two projections stay identical until such a field is approved.
 *  - `AdminListingDto`   — the working staff view, including private notes, moderation and actors.
 *
 * The seller's contact details, settlement instructions, verification evidence and internal notes
 * live on the seller record and are reached only through the seller module's own capability-gated
 * DTOs. A listing never carries them, so publishing a listing cannot leak them.
 */

export type PublicListingMediaDto = {
  assetId: string;
  position: number;
  isCover: boolean;
  width: number | null;
  height: number | null;
  alt: ListingMediaEntry['alt'];
  /** Derived access URL. Never identity: the asset ID is. */
  url: string;
};

export type PublicListingDto = {
  listingReference: string;
  publicUrl: string;
  languageMode: ListingDoc['languageMode'];
  title: ListingDoc['title'];
  description: ListingDoc['description'];
  listingMethod: ListingDoc['listingMethod'];
  /** Only the condition defined for this listing method; otherwise null. */
  condition: ListingDoc['condition'];
  audience: ListingDoc['audience'];
  category: { key: string; path: string[] };
  /** Public-display attribute values only: admin-only fields never leave the server. */
  attributes: Record<string, unknown>;
  location: {
    countryCode: string | null;
    cityKey: string | null;
    /** Present only when the location's precision policy allows it. */
    areaKey: string | null;
    label: string | null;
    publicPrecision: ListingDoc['location']['publicPrecision'];
  };
  media: PublicListingMediaDto[];
  coverAssetId: string | null;
  seller: { sellerReference: string; displayName: string; verificationBadge: boolean };
  featured: boolean;
  /** Set when `listingMethod` is `fixed_price`. */
  priceMinor: number | null;
  availability: ListingDoc['availability'];
  publishedAt: string | null;
  updatedAt: string;
  /** Present when a live auction exists for this listing. Null otherwise. */
  liveLotReference: string | null;
  /** Populated when `liveLotReference` is set. */
  currentAmountMinor: number | null;
  startingBidMinor: number | null;
  /** Populated when `liveLotReference` is set. */
  bidCount: number | null;
  startsAt: string | null;
  endsAt: string | null;
};

export type CustomerListingDto = PublicListingDto;

export type AdminListingDto = Omit<PublicListingDto, 'media'> & {
  status: ListingDoc['status'];
  moderation: ListingDoc['moderation'];
  version: number;
  attributeSchemaVersion: number | null;
  mediaCollectionKey: string;
  media: Array<
    ListingMediaEntry & {
      url: string | null;
      /** Upload/validation state, so the wizard can explain a missing preview honestly. */
      mediaStatus: string;
    }
  >;
  locationKey: string | null;
  adminNotes: string | null;
  createdBy: string;
  updatedBy: string | null;
  publishedBy: string | null;
  archivedBy: string | null;
  createdAt: string;
  archivedAt: string | null;
  archivedReason: string | null;
};

export type ListingSellerContext = {
  sellerReference: string;
  displayName: string;
  verificationBadge: boolean;
};

export type ListingMediaContext = Map<string, { status: string; width: number | null; height: number | null; url: string | null }>;

const PUBLIC_URL = (listing: ListingDoc) => `/product/${listing.slug || listing.listingReference}`;

/** Admin-only attribute values are stripped here, not in the template. */
export function publicAttributeValues(attributes: Record<string, unknown>, fields: AttributeField[] | null): Record<string, unknown> {
  if (!fields) return { ...attributes };
  const publicKeys = new Set(publicSchemaFields(fields).map((field) => field.key));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (publicKeys.has(key)) out[key] = value;
  }
  return out;
}

export function toPublicListingDto(
  listing: ListingDoc,
  context: {
    seller: ListingSellerContext;
    attributeFields: AttributeField[] | null;
    media: ListingMediaContext;
    liveLotReference?: string | null;
    currentAmountMinor?: number | null;
    startingBidMinor?: number | null;
    bidCount?: number | null;
    startsAt?: string | null;
    endsAt?: string | null;
  },
): PublicListingDto {
  const liveLotReference = context.liveLotReference ?? null;
  return {
    listingReference: listing.listingReference,
    publicUrl: PUBLIC_URL(listing),
    languageMode: listing.languageMode,
    title: listing.title,
    description: listing.description,
    listingMethod: listing.listingMethod,
    condition: listing.condition,
    audience: listing.audience ?? null,
    category: { key: listing.categoryKey, path: [...listing.categoryPath] },
    attributes: publicAttributeValues(listing.attributes, context.attributeFields),
    location: {
      countryCode: listing.location.countryCode,
      cityKey: listing.location.cityKey,
      // The precision policy is applied here so no caller can opt into a more precise view.
      areaKey: listing.location.publicPrecision === 'area' || listing.location.publicPrecision === 'exact' ? listing.location.areaKey : null,
      label: listing.location.publicPrecision === 'hidden' ? null : listing.location.label,
      publicPrecision: listing.location.publicPrecision,
    },
    media: (listing.media ?? []).map((entry) => ({
      assetId: entry.assetId,
      position: entry.position,
      isCover: entry.assetId === listing.coverAssetId,
      width: entry.width,
      height: entry.height,
      alt: entry.alt,
      url: context.media.get(entry.assetId)?.url ?? `/api/listings/${listing.listingReference}/media/${entry.assetId}/file`,
    })),
    coverAssetId: listing.coverAssetId,
    seller: context.seller,
    featured: listing.featured.featured,
    priceMinor: listing.listingMethod === 'fixed_price' ? listing.priceMinor ?? null : null,
    availability: listing.availability ?? 'available',
    publishedAt: listing.publishedAt ? listing.publishedAt.toISOString() : null,
    updatedAt:
      listing.updatedAt instanceof Date && !Number.isNaN(listing.updatedAt.getTime())
        ? listing.updatedAt.toISOString()
        : new Date(0).toISOString(),
    liveLotReference,
    currentAmountMinor: liveLotReference ? (context.currentAmountMinor ?? null) : null,
    startingBidMinor: liveLotReference ? (context.startingBidMinor ?? null) : null,
    bidCount: liveLotReference ? (context.bidCount ?? null) : null,
    startsAt: liveLotReference ? (context.startsAt ?? null) : null,
    endsAt: liveLotReference ? (context.endsAt ?? null) : null,
  };
}

/**
 * The customer view. Kept as an explicit function (rather than an alias used inline) so that when
 * customer-owned fields are approved they are added here deliberately — and a test can keep
 * asserting that the customer projection exposes nothing the public one does not.
 */
export function toCustomerListingDto(
  listing: ListingDoc,
  context: {
    seller: ListingSellerContext;
    attributeFields: AttributeField[] | null;
    media: ListingMediaContext;
    liveLotReference?: string | null;
    currentAmountMinor?: number | null;
    startingBidMinor?: number | null;
    bidCount?: number | null;
    startsAt?: string | null;
    endsAt?: string | null;
  },
): CustomerListingDto {
  return toPublicListingDto(listing, context);
}

export type ListingLiveAuctionDtoContext = {
  liveLotReference?: string | null;
  currentAmountMinor?: number | null;
  startingBidMinor?: number | null;
  bidCount?: number | null;
  startsAt?: string | null;
  endsAt?: string | null;
};

/** Staff view. Private notes, moderation and actor history are only reachable through this. */
export function toAdminListingDto(
  listing: ListingDoc,
  context: { seller: ListingSellerContext; media: ListingMediaContext } & ListingLiveAuctionDtoContext,
): AdminListingDto {
  const liveLotReference = context.liveLotReference ?? null;
  return {
    listingReference: listing.listingReference,
    publicUrl: PUBLIC_URL(listing),
    languageMode: listing.languageMode,
    title: listing.title,
    description: listing.description,
    listingMethod: listing.listingMethod,
    condition: listing.condition,
    audience: listing.audience ?? null,
    category: { key: listing.categoryKey, path: [...listing.categoryPath] },
    // Staff may see every validated value, including admin-only fields.
    attributes: { ...listing.attributes },
    location: {
      countryCode: listing.location.countryCode,
      cityKey: listing.location.cityKey,
      areaKey: listing.location.areaKey,
      label: listing.location.label,
      publicPrecision: listing.location.publicPrecision,
    },
    media: listing.media.map((entry) => ({
      ...entry,
      alt: { ...entry.alt },
      url: context.media.get(entry.assetId)?.url ?? null,
      mediaStatus: context.media.get(entry.assetId)?.status ?? 'unknown',
    })),
    mediaCollectionKey: mediaCollectionKey(listing.listingReference),
    coverAssetId: listing.coverAssetId,
    status: listing.status,
    moderation: listing.moderation,
    version: listing.version,
    attributeSchemaVersion: listing.attributeSchemaVersion,
    locationKey: listing.location.key,
    adminNotes: listing.adminNotes,
    createdBy: listing.createdBy,
    updatedBy: listing.updatedBy,
    publishedBy: listing.publishedBy,
    archivedBy: listing.archivedBy,
    createdAt: listing.createdAt.toISOString(),
    archivedAt: listing.archivedAt ? listing.archivedAt.toISOString() : null,
    archivedReason: listing.archivedReason,
    seller: context.seller,
    featured: listing.featured.featured,
    priceMinor: listing.listingMethod === 'fixed_price' ? listing.priceMinor ?? null : null,
    availability: listing.availability ?? 'available',
    publishedAt: listing.publishedAt ? listing.publishedAt.toISOString() : null,
    updatedAt: listing.updatedAt.toISOString(),
    liveLotReference,
    currentAmountMinor: liveLotReference ? (context.currentAmountMinor ?? null) : null,
    startingBidMinor: liveLotReference ? (context.startingBidMinor ?? null) : null,
    bidCount: liveLotReference ? (context.bidCount ?? null) : null,
    startsAt: liveLotReference ? (context.startsAt ?? null) : null,
    endsAt: liveLotReference ? (context.endsAt ?? null) : null,
  };
}
