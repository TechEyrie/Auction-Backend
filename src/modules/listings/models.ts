import type { ObjectId } from 'mongodb';
import type { AttributeField } from '../attributes/models.ts';

/**
 * Listings are inventory: what exists, who it belongs to, what it is, and where it is. They are
 * deliberately **not** auctions.
 *
 * No auction field exists on this document (no starting bid, no reserve, no schedule, no bid
 * history). Those belong to the Auction aggregate in Phase 06, which references a listing rather
 * than duplicating its truth. A published listing is therefore not a live auction, and nothing in
 * this module may imply that it is.
 *
 * Fixed-price listings carry `priceMinor` (integer QAR fils). Checkout reserves inventory via
 * `availability` — see orders module and owner-approved dev Buy Now flow (docs/OPEN_QUESTIONS.md).
 */

export const LISTING_STATUSES = ['draft', 'published', 'archived'] as const;

export const LISTING_AVAILABILITIES = ['available', 'sold'] as const;
export type ListingAvailability = (typeof LISTING_AVAILABILITIES)[number];
export type ListingStatus = (typeof LISTING_STATUSES)[number];

/** Mirrors the taxonomy's allowed listing methods so a category can never be over-promised. */
export const LISTING_METHODS = ['auction', 'fixed_price', 'enquiry'] as const;
export type ListingMethod = (typeof LISTING_METHODS)[number];

/**
 * Advertisement language: which localised content the ad must carry. This is **not** interface
 * translation — a listing can be Arabic-only while the interface stays English.
 */
export const LANGUAGE_MODES = ['en', 'ar', 'both'] as const;
export type LanguageMode = (typeof LANGUAGE_MODES)[number];

/**
 * Moderation/visibility. `ok` is the normal state; `blocked` keeps a listing out of public
 * discovery without destroying it, and `pending_review` is recorded work for a later phase.
 */
export const MODERATION_STATES = ['ok', 'pending_review', 'blocked'] as const;
export type ModerationState = (typeof MODERATION_STATES)[number];

/** Conditions where a condition applies. Deliberately a small, closed list. */
export const CONDITIONS = ['new', 'like_new', 'used', 'refurbished', 'not_applicable'] as const;
export type Condition = (typeof CONDITIONS)[number];

/** Primary shopper segment for discovery (not a category duplicate). */
export const AUDIENCES = ['men', 'women', 'unisex'] as const;
export type Audience = (typeof AUDIENCES)[number];

export type LocalizedText = { en: string | null; ar: string | null };

/** One entry of the listing's own ordered media list. */
export type ListingMediaEntry = {
  assetId: string;
  position: number;
  width: number | null;
  height: number | null;
  /** Alt text is admin-authored and localized, because an image's meaning is not automatic. */
  alt: LocalizedText;
};

/**
 * Location as copied onto the listing at write time. The precision policy of the referenced
 * location decides what may be published; a snapshot avoids re-reading the location on every
 * public request and keeps historical listings interpretable if the location is later edited.
 */
export type ListingLocation = {
  key: string | null;
  countryCode: string | null;
  cityKey: string | null;
  areaKey: string | null;
  label: string | null;
  publicPrecision: 'city' | 'area' | 'exact' | 'hidden';
};

export type ListingDoc = {
  /** Stable internal id. Admin routes and media collections use this. */
  listingReference: string;
  /** Public path segment, derived from the English title. */
  slug: string;
  status: ListingStatus;
  moderation: { state: ModerationState; note: string | null };
  languageMode: LanguageMode;
  title: LocalizedText;
  description: LocalizedText;
  listingMethod: ListingMethod;
  condition: Condition | null;
  /** Men/women shopper filter. Null only on legacy drafts until staff set it. */
  audience: Audience | null;

  /** Seller association: offline seller records, never a fabricated account. */
  sellerId: ObjectId;
  sellerReference: string;

  /** Category is a reference plus the path snapshot used for display and public filtering. */
  categoryKey: string;
  categoryPath: string[];

  /** The schema version the attributes were validated against, kept for interpretability. */
  attributeSchemaVersion: number | null;
  attributes: Record<string, unknown>;

  location: ListingLocation;

  /** Ordered media list; `coverAssetId` must always be one of these assets. */
  media: ListingMediaEntry[];
  coverAssetId: string | null;

  featured: { featured: boolean; order: number };

  /** Whole-QAR fils. Required when `listingMethod` is `fixed_price`. */
  priceMinor: number | null;
  /** Commerce state for fixed-price (and sold auction inventory). */
  availability: ListingAvailability;

  /** Private staff notes. Never leaves the admin DTO. */
  adminNotes: string | null;

  /** Optimistic concurrency: every write is conditional on the version the editor read. */
  version: number;

  createdBy: string;
  updatedBy: string | null;
  publishedBy: string | null;
  archivedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  publishedAt: Date | null;
  archivedAt: Date | null;
  archivedReason: string | null;
};

export type ListingWithId = ListingDoc & { _id: ObjectId };

/** The media collection a listing's uploads land in. Stable for the listing's whole life. */
export function mediaCollectionKey(listingReference: string): string {
  return `listing_${listingReference}`;
}

/** Attributes whose keys the given schema accepts (used to reconcile a category change). */
export function schemaAttributeKeys(fields: AttributeField[]): Set<string> {
  return new Set(fields.map((field) => field.key));
}
