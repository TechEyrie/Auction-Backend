import type { ClientSession, Db } from 'mongodb';
import type { Logger } from '../../shared/logger.ts';
import { AppError, conflict, notFound } from '../../shared/errors.ts';
import { randomToken } from '../../shared/crypto.ts';
import { recordAudit } from '../audit/repository.ts';
import { createAttributeService } from '../attributes/service.ts';
import { validateAttributeValues } from '../attributes/validate.ts';
import type { AttributeField, AttributeSchemaWithId } from '../attributes/models.ts';
import type { MediaService } from '../media/service.ts';
import { findSellerByReference } from '../sellers/repository.ts';
import type { SellerWithId } from '../sellers/models.ts';
import { createTaxonomyService } from '../taxonomy/service.ts';
import type { CategoryWithId } from '../taxonomy/models.ts';
import { COLLECTIONS } from '../../db/indexes.ts';
import { qatarDayUtcBounds } from '../../shared/qatarCalendar.ts';
import type { LocationDoc } from '../locations/service.ts';
import {
  mediaCollectionKey,
  type Condition,
  type LanguageMode,
  type Audience,
  type ListingAvailability,
  type ListingDoc,
  type ListingMediaEntry,
  type ListingMethod,
  type ListingWithId,
} from './models.ts';
import { createFixedPriceOrder, orderView, type OrderFulfillment } from '../orders/service.ts';
import {
  bumpListingVersion,
  countListingsByStatus,
  findListingByReference,
  findListingBySlug,
  insertListing,
  listAdminListings,
  listings,
  listPublicListings,
  publicVisibilityFilter,
  updateListingVersioned,
  type AdminListQuery,
  type Paged,
  type PublicListQuery,
} from './repository.ts';

export type ListingDeps = {
  db: Db;
  logger: Logger;
  withTransaction: <T>(fn: (session: ClientSession) => Promise<T>) => Promise<T>;
  /** The media module owns asset and reference semantics, so listings never touch them directly. */
  media: MediaService;
};

export type ListingWriteInput = {
  sellerReference?: string;
  categoryKey?: string;
  listingMethod?: ListingMethod;
  languageMode?: LanguageMode;
  title?: { en?: string | null; ar?: string | null };
  description?: { en?: string | null; ar?: string | null };
  condition?: Condition | null;
  audience?: Audience | null;
  locationKey?: string | null;
  attributes?: Record<string, unknown>;
  media?: Array<{ assetId: string; alt?: { en?: string | null; ar?: string | null } }>;
  coverAssetId?: string | null;
  featured?: boolean;
  featuredOrder?: number;
  moderationState?: 'ok' | 'pending_review' | 'blocked';
  moderationNote?: string | null;
  adminNotes?: string | null;
  priceMinor?: number | null;
};

export type Reconciliation = {
  schemaVersion: number | null;
  kept: string[];
  cleared: string[];
  /** Why values were dropped, so the wizard can explain rather than silently lose work. */
  reason: string | null;
};

const TITLE_MIN = 3;
const TITLE_MAX = 140;
const DESC_MIN = 10;
const DESC_MAX = 8000;
const MAX_PUBLISHED_FEATURED = 10;

async function countPublishedFeatured(db: Db): Promise<number> {
  return listings(db).countDocuments({
    ...publicVisibilityFilter(),
    'featured.featured': true,
  });
}

async function assertPublishedFeaturedCapacity(db: Db, current: ListingWithId, willBeFeatured: boolean): Promise<void> {
  if (!willBeFeatured || current.featured.featured) return;
  if (current.status !== 'published' || current.archivedAt) return;
  const count = await countPublishedFeatured(db);
  if (count >= MAX_PUBLISHED_FEATURED) {
    throw fieldError('featured', 'At most 10 published listings can be featured. Unfeature one first.');
  }
}

export type ListingLiveAuctionContext = {
  liveLotReference: string | null;
  currentAmountMinor: number | null;
  startingBidMinor: number | null;
  bidCount: number | null;
  startsAt: string | null;
  endsAt: string | null;
};

/**
 * Public while the clock is inside [startsAt, endsAt).
 * `scheduled` is included once start has arrived — otherwise a lot that was opened a few
 * seconds early stays invisible until the 5s closer promotes it to `live`.
 * Comparisons use UTC instants (Mongo Date / Date.now). Qatar is only for admin input UI.
 */
function activeLiveAuctionFilter(now = new Date()): Record<string, unknown> {
  return {
    status: { $in: ['live', 'scheduled'] },
    startsAt: { $lte: now },
    endsAt: { $gt: now },
  };
}

async function liveAuctionContextForListing(db: Db, listingReference: string): Promise<ListingLiveAuctionContext> {
  const live = await db.collection(COLLECTIONS.auctions).findOne(
    { listingReference, ...activeLiveAuctionFilter() },
    {
      projection: {
        lotReference: 1,
        currentAmountMinor: 1,
        startingBidMinor: 1,
        bidCount: 1,
        startsAt: 1,
        endsAt: 1,
      },
    },
  );
  const startsAt =
    live?.startsAt instanceof Date && !Number.isNaN(live.startsAt.getTime()) ? live.startsAt.toISOString() : null;
  const endsAt =
    live?.endsAt instanceof Date && !Number.isNaN(live.endsAt.getTime()) ? live.endsAt.toISOString() : null;
  return {
    liveLotReference: typeof live?.lotReference === 'string' ? live.lotReference : null,
    currentAmountMinor: typeof live?.currentAmountMinor === 'number' ? live.currentAmountMinor : null,
    startingBidMinor: typeof live?.startingBidMinor === 'number' ? live.startingBidMinor : null,
    bidCount: typeof live?.bidCount === 'number' && live.bidCount >= 0 ? live.bidCount : null,
    startsAt,
    endsAt,
  };
}

/**
 * Auction listings are public only while bidding is open. After the end time (or before start),
 * they disappear from catalogue and direct URLs — except the high bidder / winner, who still
 * needs the product page to pay.
 */
async function assertAuctionPubliclyVisible(
  db: Db,
  listing: ListingWithId,
  viewerReference: string | null | undefined,
): Promise<void> {
  if (listing.listingMethod !== 'auction') return;

  const now = new Date();
  const liveInWindow = await db.collection(COLLECTIONS.auctions).findOne({
    listingReference: listing.listingReference,
    ...activeLiveAuctionFilter(now),
  });
  if (liveInWindow) return;

  if (viewerReference) {
    const auction = await db.collection(COLLECTIONS.auctions).findOne(
      {
        listingReference: listing.listingReference,
        status: { $in: ['live', 'closed'] },
      },
      {
        projection: {
          status: 1,
          endsAt: 1,
          winningUserReference: 1,
          highestUserReference: 1,
        },
        sort: { updatedAt: -1 },
      },
    );
    if (auction) {
      const ended =
        auction.status === 'closed' ||
        (auction.endsAt instanceof Date && auction.endsAt.getTime() <= now.getTime());
      if (ended) {
        if (auction.winningUserReference === viewerReference || auction.highestUserReference === viewerReference) {
          return;
        }
      }
    }

    const order = await db.collection(COLLECTIONS.orders).findOne({
      listingReference: listing.listingReference,
      winnerUserReference: viewerReference,
    });
    if (order) return;
  }

  throw notFound('Listing not found');
}

function fieldError(field: string, message: string): AppError {
  return new AppError('VALIDATION_ERROR', 'Listing is not valid', { fieldErrors: { [field]: message } });
}

function fixedPriceMinorForWrite(
  method: ListingMethod,
  current: number | null | undefined,
  input: number | null | undefined,
  inputProvided: boolean,
): number | null {
  if (method !== 'fixed_price') return null;
  const value = inputProvided ? input : current ?? null;
  if (value === null || value === undefined || !Number.isInteger(value) || value <= 0) {
    throw fieldError('priceMinor', 'required for fixed-price listings (positive integer minor units)');
  }
  return value;
}

function availabilityDefault(current: ListingAvailability | undefined): ListingAvailability {
  return current === 'sold' ? 'sold' : 'available';
}

/** One shared refusal shape, so every attribute problem names the offending field. */
function assertAttributeValues(errors: Record<string, string>): void {
  if (Object.keys(errors).length === 0) return;
  throw new AppError('VALIDATION_ERROR', 'Some attributes are not valid for this category', {
    fieldErrors: Object.fromEntries(Object.entries(errors).map(([key, message]) => [`attributes.${key}`, message])),
  });
}

function assertLocalizedPair(field: 'title' | 'description', value: { en?: string | null; ar?: string | null } | undefined, mode: LanguageMode): { en: string | null; ar: string | null } {
  const en = value?.en?.trim() ? value.en.trim() : null;
  const ar = value?.ar?.trim() ? value.ar.trim() : null;
  const errors: Record<string, string> = {};
  const limits = field === 'title' ? { min: TITLE_MIN, max: TITLE_MAX } : { min: DESC_MIN, max: DESC_MAX };

  const check = (locale: 'en' | 'ar', text: string | null): void => {
    if (!text) {
      errors[`${field}.${locale}`] = 'required for the selected advertisement language';
      return;
    }
    if (text.length < limits.min) errors[`${field}.${locale}`] = `at least ${limits.min} characters`;
    else if (text.length > limits.max) errors[`${field}.${locale}`] = `at most ${limits.max} characters`;
  };

  if (mode === 'en' || mode === 'both') check('en', en);
  if (mode === 'ar' || mode === 'both') check('ar', ar);
  if (Object.keys(errors).length > 0) {
    throw new AppError('VALIDATION_ERROR', 'Listing content is incomplete for its advertisement language', {
      fieldErrors: errors,
      details: { languageMode: mode },
    });
  }
  return { en, ar };
}

/**
 * Reconcile stored attribute values against a (possibly different) schema.
 *
 * Rules: a value whose key the new schema does not define is **cleared**, a value the new schema
 * defines is **kept** and re-validated, and a required field with no value at all is reported
 * separately as `missingRequired` rather than as a value error. Nothing is coerced into a field it
 * does not belong to.
 *
 * The split matters because a draft is allowed to be incomplete: `errors` are problems with values
 * that were supplied (refused on every write), while `missingRequired` is only fatal at publication,
 * where the full validator runs again over the stored values.
 */
export function reconcileAttributes(input: {
  current: Record<string, unknown>;
  incoming?: Record<string, unknown>;
  fields: AttributeField[] | null;
}): {
  values: Record<string, unknown>;
  kept: string[];
  cleared: string[];
  errors: Record<string, string>;
  missingRequired: string[];
} {
  const incoming = input.incoming ?? {};
  const proposed: Record<string, unknown> = { ...input.current, ...incoming };
  const errors: Record<string, string> = {};
  // An underscore-prefixed key is the wizard's own local state; it is never a submitted value.
  const incomingKeys = Object.keys(incoming).filter((key) => !key.startsWith('_'));

  if (!input.fields) {
    // No published schema for the category: an empty attribute set is the only valid one, and
    // values for a schema that does not exist are refused rather than quietly dropped.
    for (const key of incomingKeys) errors[key] = 'this category has no published attribute schema';
    return {
      values: {},
      kept: [],
      cleared: Object.keys(proposed).filter((key) => !key.startsWith('_')),
      errors,
      missingRequired: [],
    };
  }

  const known = new Set(input.fields.map((field) => field.key));
  // Submitting a key the schema does not define is a mistake worth surfacing: the caller is told
  // which key is wrong instead of believing it was saved.
  for (const key of incomingKeys) {
    if (!known.has(key)) errors[key] = 'unknown attribute for this category';
  }

  const kept: string[] = [];
  const cleared: string[] = [];
  const compatible: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(proposed)) {
    if (key.startsWith('_')) continue;
    if (known.has(key)) compatible[key] = value;
    else cleared.push(key);
  }
  const result = validateAttributeValues(input.fields, compatible, 'admin');
  Object.assign(errors, result.errors);

  // "required" is the validator's word for "no value supplied at all". That is a draft in progress,
  // not a bad value, so it is lifted out of the value errors and reported on its own. Publication
  // re-runs the whole validator, so an incomplete draft still cannot go live.
  const missingRequired: string[] = [];
  for (const field of input.fields) {
    if (!field.required) continue;
    if (result.errors[field.key] !== 'required') continue;
    missingRequired.push(field.key);
    delete errors[field.key];
  }

  for (const key of Object.keys(compatible)) {
    if (missingRequired.includes(key)) continue;
    if (result.errors[key]) cleared.push(key);
    else kept.push(key);
  }
  return { values: result.values, kept, cleared, errors, missingRequired };
}

export function assertConditionApplies(method: ListingMethod, condition: Condition | null): void {
  // `not_applicable` is what a non-physical listing (a job, an enquiry) uses; the others describe
  // an item's state and are rejected for anything that is not a physical good.
  if (condition === null) return;
  if (method === 'enquiry' && condition !== 'not_applicable') {
    throw fieldError('condition', 'an enquiry listing does not carry a physical condition');
  }
}

export function createListingService(deps: ListingDeps) {
  const { db, logger, media, withTransaction } = deps;
  // No collection handle is resolved at construction time: building the app must not require a
  // reachable database, and a stubbed dependency in a unit test is not a licence to connect.
  const attributes = createAttributeService(deps);
  const taxonomy = createTaxonomyService(deps);

  /** The fields of a specific schema version, or null when the listing has no schema. */
  async function schemaFieldsFor(categoryKey: string, version: number | null): Promise<AttributeField[] | null> {
    if (version === null) return null;
    const schemas = await attributes.listForCategory(categoryKey);
    const match = schemas.find((schema: AttributeSchemaWithId) => schema.version === version);
    if (!match) throw notFound('The attribute schema version recorded on this listing no longer exists');
    return match.fields;
  }

  async function requireSeller(reference: string): Promise<SellerWithId> {
    const seller = await findSellerByReference(db, reference);
    if (!seller) {
      throw new AppError('VALIDATION_ERROR', 'Unknown seller', { fieldErrors: { sellerReference: 'unknown seller' } });
    }
    return seller;
  }

  async function requireCategory(key: string): Promise<CategoryWithId> {
    const category = await taxonomy.getByKey(key);
    if (!category) {
      throw new AppError('VALIDATION_ERROR', 'Unknown category', { fieldErrors: { categoryKey: 'unknown category' } });
    }
    return category;
  }

  async function resolveLocation(key: string | null | undefined): Promise<ListingDoc['location']> {
    if (!key) {
      return { key: null, countryCode: null, cityKey: null, areaKey: null, label: null, publicPrecision: 'hidden' };
    }
    const location = await db.collection<LocationDoc>(COLLECTIONS.locations).findOne({ key });
    if (!location) {
      throw new AppError('VALIDATION_ERROR', 'Unknown location', { fieldErrors: { locationKey: 'unknown location' } });
    }
    return {
      key: location.key,
      countryCode: location.countryCode,
      cityKey: location.cityKey,
      areaKey: location.areaKey,
      label: location.labels.en,
      publicPrecision: location.publicPrecision,
    };
  }

  /**
   * Media attachment rules.
   *
   *  - the asset must belong to this listing's own upload collection (or already be on this listing),
   *  - it must be a `ready` asset,
   *  - it must not be referenced by a different owner, which is what stops evidence or another
   *    listing's images being attached here,
   *  - no client-supplied URL is ever accepted: only asset IDs that resolve in the media store.
   */
  async function resolveMedia(
    listingReference: string,
    requested: Array<{ assetId: string; alt?: { en?: string | null; ar?: string | null } }>,
    previous: ListingMediaEntry[],
  ): Promise<{ entries: ListingMediaEntry[]; toAttach: string[]; toDetach: string[] }> {
    const ownCollection = mediaCollectionKey(listingReference);
    const previousIds = new Set(previous.map((entry) => entry.assetId));
    const seen = new Set<string>();
    const entries: ListingMediaEntry[] = [];

    for (const [index, item] of requested.entries()) {
      const assetId = String(item.assetId ?? '').trim();
      if (!assetId) throw fieldError('media', 'empty media id');
      if (seen.has(assetId)) throw fieldError('media', `asset ${assetId} is listed twice`);
      seen.add(assetId);

      let asset;
      try {
        asset = await media.getByAssetId(assetId);
      } catch {
        throw fieldError('media', `asset ${assetId} does not exist`);
      }
      if (asset.collectionKey !== ownCollection && !previousIds.has(assetId)) {
        throw fieldError('media', `asset ${assetId} belongs to another collection`);
      }
      if (asset.status !== 'ready') {
        throw fieldError('media', `asset ${assetId} is not ready (${asset.status})`);
      }
      const references = await media.listReferences(assetId);
      const foreign = references.some((reference) => reference.ownerType !== 'listing' || reference.ownerId !== listingReference);
      if (foreign) {
        throw fieldError('media', `asset ${assetId} is attached to another record and cannot be reused`);
      }
      entries.push({
        assetId,
        position: index,
        width: asset.image?.width ?? null,
        height: asset.image?.height ?? null,
        alt: { en: item.alt?.en?.trim() || null, ar: item.alt?.ar?.trim() || null },
      });
    }

    const toDetach = previous.filter((entry) => !seen.has(entry.assetId)).map((entry) => entry.assetId);
    return { entries, toAttach: entries.map((entry) => entry.assetId), toDetach };
  }

  async function applyMediaReferences(listingReference: string, actor: string, attach: string[], detach: string[]): Promise<void> {
    for (const assetId of detach) {
      await media.removeReference({ assetId, ownerType: 'listing', ownerId: listingReference });
    }
    for (const assetId of attach) {
      await media.addReference({ assetId, ownerType: 'listing', ownerId: listingReference, actor });
    }
  }

  async function sellerContext(sellerReference: string): Promise<{ sellerReference: string; displayName: string; verificationBadge: boolean }> {
    const seller = await findSellerByReference(db, sellerReference);
    return {
      sellerReference,
      displayName: seller?.displayName ?? 'Unknown seller',
      verificationBadge: seller?.verification.state === 'verified',
    };
  }

  async function mediaContext(
    entries: ListingMediaEntry[],
    options?: { publicListingReference?: string },
  ): Promise<Map<string, { status: string; width: number | null; height: number | null; url: string | null }>> {
    const map = new Map<string, { status: string; width: number | null; height: number | null; url: string | null }>();
    for (const entry of entries) {
      let asset;
      try {
        asset = await media.getByAssetId(entry.assetId);
      } catch {
        map.set(entry.assetId, { status: 'missing', width: null, height: null, url: null });
        continue;
      }
      const proxyUrl = options?.publicListingReference
        ? `/api/listings/${options.publicListingReference}/media/${entry.assetId}/file`
        : `/api/admin/media/${asset.assetId}/file`;
      map.set(entry.assetId, {
        status: asset.status,
        width: asset.image?.width ?? null,
        height: asset.image?.height ?? null,
        url: asset.status === 'ready' ? (asset.publicUrl ?? proxyUrl) : null,
      });
    }
    return map;
  }

  async function descendantKeys(categoryKey: string): Promise<string[]> {
    const all = await taxonomy.list(true);
    return [categoryKey, ...all.filter((category) => category.ancestors.includes(categoryKey)).map((category) => category.key)];
  }

  function slugBase(title: string | null | undefined): string {
    const raw = String(title ?? '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    return raw || 'listing';
  }

  async function uniqueSlug(title: string | null | undefined, keepReference?: string): Promise<string> {
    const base = slugBase(title);
    let candidate = base;
    for (let n = 2; n < 40; n += 1) {
      const found = await findListingBySlug(db, candidate);
      if (!found || found.listingReference === keepReference) return candidate;
      candidate = `${base}-${n}`;
    }
    return `${base}-${randomToken(4).toLowerCase()}`;
  }

  async function requireVisible(ref: string): Promise<ListingWithId> {
    const listing = await findListingByReference(db, ref);
    if (!listing || listing.status !== 'published' || listing.archivedAt || listing.moderation.state === 'blocked') {
      throw notFound('Listing not found');
    }
    return listing;
  }

  return {
    async create(input: ListingWriteInput, actor: { reference: string; requestId: string }): Promise<ListingWithId> {
      if (!input.sellerReference) throw fieldError('sellerReference', 'required');
      if (!input.categoryKey) throw fieldError('categoryKey', 'required');
      const seller = await requireSeller(input.sellerReference);
      const category = await requireCategory(input.categoryKey);
      // The default listing method comes from the category, never from a hard-coded guess: a
      // car category cannot silently become an enquiry listing.
      const method = input.listingMethod ?? category.listingMethods[0] ?? 'enquiry';
      if (!category.listingMethods.includes(method)) {
        throw fieldError('listingMethod', `this category does not allow ${method}`);
      }
      const languageMode = input.languageMode ?? 'en';
      const condition = input.condition ?? null;
      assertConditionApplies(method, condition);
      const priceMinor = fixedPriceMinorForWrite(method, null, input.priceMinor ?? null, input.priceMinor !== undefined);

      const currentSchema = await attributes.currentForCategory(category.key);
      const location = await resolveLocation(input.locationKey);
      const reconciliation = reconcileAttributes({
        current: {},
        incoming: input.attributes ?? {},
        fields: currentSchema?.fields ?? null,
      });
      assertAttributeValues(reconciliation.errors);

      const now = new Date();
      const listingReference = `l_${randomToken(9)}`;
      const doc: ListingDoc = {
        listingReference,
        slug: await uniqueSlug(input.title?.en),
        status: 'draft',
        moderation: { state: input.moderationState ?? 'ok', note: input.moderationNote ?? null },
        languageMode,
        title: { en: input.title?.en?.trim() || null, ar: input.title?.ar?.trim() || null },
        description: { en: input.description?.en?.trim() || null, ar: input.description?.ar?.trim() || null },
        listingMethod: method,
        condition,
        audience: input.audience ?? null,
        sellerId: seller._id,
        sellerReference: seller.sellerReference,
        categoryKey: category.key,
        categoryPath: [...category.ancestors, category.key],
        attributeSchemaVersion: currentSchema?.version ?? null,
        attributes: reconciliation.values,
        location,
        media: [],
        coverAssetId: null,
        featured: { featured: input.featured ?? false, order: input.featuredOrder ?? 0 },
        priceMinor,
        availability: 'available',
        adminNotes: input.adminNotes ?? null,
        version: 1,
        createdBy: actor.reference,
        updatedBy: null,
        publishedBy: null,
        archivedBy: null,
        createdAt: now,
        updatedAt: now,
        publishedAt: null,
        archivedAt: null,
        archivedReason: null,
      };
      const created = await insertListing(db, doc);
      await recordAudit(db, {
        actorId: actor.reference,
        action: 'listing.created',
        targetType: 'listing',
        targetId: created.listingReference,
        requestId: actor.requestId,
        changeSummary: { seller: created.sellerReference, category: created.categoryKey, method: created.listingMethod },
        reason: null,
      });
      logger.info('listing draft created', { reference: created.listingReference });
      return created;
    },

    async getAdmin(ref: string): Promise<ListingWithId> {
      const listing = await findListingByReference(db, ref);
      if (!listing) throw notFound('Listing not found');
      return listing;
    },

    async getPublic(key: string, viewerReference?: string | null): Promise<ListingWithId> {
      const listing = key.startsWith('l_')
        ? await findListingByReference(db, key)
        : await findListingBySlug(db, key);
      if (!listing) throw notFound('Listing not found');
      if (!listing.slug && listing.title.en) {
        const slug = await uniqueSlug(listing.title.en, listing.listingReference);
        await db.collection<ListingDoc>(COLLECTIONS.listings).updateOne({ listingReference: listing.listingReference }, { $set: { slug } });
        listing.slug = slug;
      }
      const visible = await requireVisible(listing.listingReference);
      await assertAuctionPubliclyVisible(db, visible, viewerReference);
      return visible;
    },

    async listPublic(query: PublicListQuery): Promise<Paged<ListingWithId>> {
      const expanded: PublicListQuery = { ...query };
      if (query.categoryKeys && query.categoryKeys.length > 0) {
        const keys = new Set<string>();
        for (const key of query.categoryKeys) {
          for (const descendant of await descendantKeys(key)) keys.add(descendant);
        }
        expanded.categoryKeys = [...keys];
      }

      if (query.endsOn) {
        if (query.method && query.method !== 'auction') {
          throw fieldError('endsOn', 'only valid with auction listings');
        }
        let bounds: { start: Date; endExclusive: Date };
        try {
          bounds = qatarDayUtcBounds(query.endsOn);
        } catch {
          throw fieldError('endsOn', 'expected YYYY-MM-DD');
        }
        const rows = await db
          .collection(COLLECTIONS.auctions)
          .find({
            status: { $in: ['live', 'scheduled'] },
            endsAt: { $gte: bounds.start, $lt: bounds.endExclusive },
          })
          .project({ listingReference: 1 })
          .toArray();
        const refs = rows
          .map((row) => row.listingReference)
          .filter((ref): ref is string => typeof ref === 'string');
        if (refs.length === 0) {
          return { items: [], page: query.page, limit: query.limit, total: 0, totalPages: 1 };
        }
        expanded.listingReferences = refs;
        expanded.method = 'auction';
        return listPublicListings(db, expanded);
      }

      if (query.endingSoonHours !== undefined) {
        const now = new Date();
        const deadline = new Date(now.getTime() + query.endingSoonHours * 60 * 60 * 1000);
        const rows = await db
          .collection(COLLECTIONS.auctions)
          .find({
            ...activeLiveAuctionFilter(now),
            endsAt: { $lte: deadline },
          })
          .sort({ endsAt: 1 })
          .limit(query.limit)
          .project({ listingReference: 1 })
          .toArray();
        const orderedRefs = rows
          .map((row) => row.listingReference)
          .filter((ref): ref is string => typeof ref === 'string');
        if (orderedRefs.length === 0) {
          return { items: [], page: query.page, limit: query.limit, total: 0, totalPages: 1 };
        }
        expanded.listingReferences = orderedRefs;
        const page = await listPublicListings(db, expanded);
        const byRef = new Map(page.items.map((item) => [item.listingReference, item]));
        const items = orderedRefs.map((ref) => byRef.get(ref)).filter((item): item is ListingWithId => item !== undefined);
        return { items, page: query.page, limit: query.limit, total: items.length, totalPages: 1 };
      }

      const liveAuctionListingReferences = await db
        .collection(COLLECTIONS.auctions)
        .distinct('listingReference', activeLiveAuctionFilter());
      expanded.liveAuctionListingReferences = liveAuctionListingReferences.filter(
        (ref): ref is string => typeof ref === 'string',
      );
      return listPublicListings(db, expanded);
    },

    async listAdmin(query: AdminListQuery): Promise<Paged<ListingWithId>> {
      return listAdminListings(db, query);
    },

    async publicDtoContext(listing: ListingWithId) {
      const fields = await schemaFieldsFor(listing.categoryKey, listing.attributeSchemaVersion);
      // ponytail: one lookup per listing; batch if catalogue size becomes a problem
      const live = await liveAuctionContextForListing(db, listing.listingReference);
      return {
        seller: await sellerContext(listing.sellerReference),
        attributeFields: fields,
        media: await mediaContext(listing.media, { publicListingReference: listing.listingReference }),
        ...live,
      };
    },

    async adminDtoContext(listing: ListingWithId) {
      const live = await liveAuctionContextForListing(db, listing.listingReference);
      return {
        seller: await sellerContext(listing.sellerReference),
        media: await mediaContext(listing.media),
        ...live,
      };
    },

    /**
     * Versioned update. A stale `expectedVersion` is a conflict, never a silent overwrite, and a
     * category change reconciles the stored attribute values against the new schema.
     */
    async update(
      ref: string,
      input: ListingWriteInput,
      expectedVersion: number,
      actor: { reference: string; requestId: string },
    ): Promise<{ listing: ListingWithId; reconciliation: Reconciliation | null }> {
      const current = await findListingByReference(db, ref);
      if (!current) throw notFound('Listing not found');
      if (current.version !== expectedVersion) {
        throw conflict('This listing changed since you loaded it', {
          expectedVersion,
          currentVersion: current.version,
          reloadRequired: true,
        });
      }

      const category = await requireCategory(input.categoryKey ?? current.categoryKey);
      const categoryChanged = input.categoryKey !== undefined && input.categoryKey !== current.categoryKey;
      const method = input.listingMethod ?? current.listingMethod;
      if (!category.listingMethods.includes(method)) {
        throw fieldError('listingMethod', `this category does not allow ${method}`);
      }
      const languageMode = input.languageMode ?? current.languageMode;
      const condition = input.condition === undefined ? current.condition : input.condition;
      assertConditionApplies(method, condition);
      const priceMinor = fixedPriceMinorForWrite(
        method,
        current.priceMinor,
        input.priceMinor,
        input.priceMinor !== undefined,
      );

      const currentSchema = await attributes.currentForCategory(category.key);
      let reconciliation: Reconciliation | null = null;
      let attributesNext = current.attributes;

      if (categoryChanged) {
        // A category change keeps only the values the *new* schema still defines, re-validates
        // the result and reports both what survived and what was dropped. Nothing is carried
        // across blindly and nothing disappears without being named.
        const newKeys = new Set((currentSchema?.fields ?? []).map((field) => field.key));
        const dropped = Object.keys(current.attributes).filter((key) => !newKeys.has(key));
        const carried = Object.fromEntries(Object.entries(current.attributes).filter(([key]) => newKeys.has(key)));
        const result = reconcileAttributes({
          current: carried,
          incoming: input.attributes ?? {},
          fields: currentSchema?.fields ?? null,
        });
        assertAttributeValues(result.errors);
        attributesNext = result.values;
        reconciliation = {
          schemaVersion: currentSchema?.version ?? null,
          kept: result.kept,
          cleared: [...new Set([...dropped, ...result.cleared])],
          reason: `Revalidated against the ${category.key} schema${currentSchema ? ` v${currentSchema.version}` : ' (no published schema)'}`,
        };
      } else if (input.attributes !== undefined) {
        const result = reconcileAttributes({
          current: current.attributes,
          incoming: input.attributes,
          fields: currentSchema?.fields ?? null,
        });
        assertAttributeValues(result.errors);
        attributesNext = result.values;
      }

      const location = input.locationKey === undefined ? current.location : await resolveLocation(input.locationKey);

      let mediaEntries = current.media;
      let toAttach: string[] = [];
      let toDetach: string[] = [];
      if (input.media !== undefined) {
        const resolved = await resolveMedia(current.listingReference, input.media, current.media);
        mediaEntries = resolved.entries;
        toAttach = resolved.toAttach;
        toDetach = resolved.toDetach;
      }

      let coverAssetId = input.coverAssetId === undefined ? current.coverAssetId : input.coverAssetId;
      if (mediaEntries.length === 0) coverAssetId = null;
      else if (!coverAssetId || !mediaEntries.some((entry) => entry.assetId === coverAssetId)) {
        // A cover must always be one of the attached assets; fall back to the first.
        coverAssetId = mediaEntries[0]?.assetId ?? null;
      }

      const now = new Date();
      // The recorded schema version advances only when the stored values were actually
      // re-validated against the current schema — a category change, or an explicit attribute
      // write. Editing just a title must not mark a listing as revalidated, or publication could
      // pass on attributes nobody has checked against the current version.
      const attributesRevalidated = categoryChanged || input.attributes !== undefined;
      const patch: Partial<ListingDoc> = {
        categoryKey: category.key,
        categoryPath: [...category.ancestors, category.key],
        attributeSchemaVersion: attributesRevalidated ? currentSchema?.version ?? null : current.attributeSchemaVersion,
        attributes: attributesNext,
        listingMethod: method,
        languageMode,
        condition,
        location,
        media: mediaEntries,
        coverAssetId,
        priceMinor,
        availability: availabilityDefault(current.availability),
        updatedBy: actor.reference,
        updatedAt: now,
      };
      if (input.title !== undefined) {
        patch.title = { en: input.title.en?.trim() || null, ar: input.title.ar?.trim() || null };
        if (current.status === 'draft') patch.slug = await uniqueSlug(patch.title.en, current.listingReference);
      }
      if (input.description !== undefined) patch.description = { en: input.description.en?.trim() || null, ar: input.description.ar?.trim() || null };
      if (input.adminNotes !== undefined) patch.adminNotes = input.adminNotes;
      if (input.moderationState !== undefined || input.moderationNote !== undefined) {
        patch.moderation = {
          state: input.moderationState ?? current.moderation.state,
          note: input.moderationNote === undefined ? current.moderation.note : input.moderationNote,
        };
      }
      if (input.featured !== undefined || input.featuredOrder !== undefined) {
        const featuredNext = input.featured ?? current.featured.featured;
        await assertPublishedFeaturedCapacity(db, current, featuredNext);
        patch.featured = {
          featured: featuredNext,
          order: input.featuredOrder ?? current.featured.order,
        };
      }
      if (input.audience !== undefined) patch.audience = input.audience;

      const updated = await updateListingVersioned(db, ref, expectedVersion, patch);
      if (!updated) {
        const latest = await findListingByReference(db, ref);
        throw conflict('This listing changed since you loaded it', {
          expectedVersion,
          currentVersion: latest?.version ?? null,
          reloadRequired: true,
        });
      }

      // References are bookkeeping for delete-protection and cross-purpose denial; public access is
      // decided by the listing document itself, so a failure here cannot expose anything.
      if (toAttach.length > 0 || toDetach.length > 0) {
        await applyMediaReferences(ref, actor.reference, toAttach, toDetach);
      }

      await recordAudit(db, {
        actorId: actor.reference,
        action: 'listing.updated',
        targetType: 'listing',
        targetId: ref,
        requestId: actor.requestId,
        changeSummary: {
          fields: Object.keys(patch),
          categoryChanged,
          clearedAttributes: reconciliation?.cleared ?? [],
        },
        reason: null,
      });
      return { listing: updated, reconciliation };
    },

    /**
     * Publication. Every reference is re-resolved and every rule re-checked here: the frontend can
     * only ever *offer* publication, never authorize it.
     */
    async publish(ref: string, expectedVersion: number, actor: { reference: string; requestId: string }): Promise<ListingWithId> {
      const current = await findListingByReference(db, ref);
      if (!current) throw notFound('Listing not found');
      if (current.status === 'published') throw conflict('This listing is already published', { status: current.status });
      if (current.version !== expectedVersion) {
        throw conflict('This listing changed since you loaded it', { expectedVersion, currentVersion: current.version, reloadRequired: true });
      }
      if (current.moderation.state === 'blocked') {
        throw conflict('A blocked listing cannot be published', { moderation: current.moderation.state });
      }

      // Localized content for the chosen advertisement language.
      assertLocalizedPair('title', current.title, current.languageMode);
      assertLocalizedPair('description', current.description, current.languageMode);

      const seller = await requireSeller(current.sellerReference);
      if (seller.status !== 'active') {
        throw fieldError('sellerReference', `seller is ${seller.status} and cannot be published against`);
      }
      const category = await requireCategory(current.categoryKey);
      if (!category.active) {
        throw fieldError('categoryKey', 'the category is archived; choose an active category');
      }
      if (!category.listingMethods.includes(current.listingMethod)) {
        throw fieldError('listingMethod', `this category no longer allows ${current.listingMethod}`);
      }
      assertConditionApplies(current.listingMethod, current.condition);

      if (!current.audience) {
        throw fieldError('audience', 'choose Men, Women or Unisex before publishing');
      }

      const currentSchema = await attributes.currentForCategory(category.key);
      if (currentSchema) {
        if (current.attributeSchemaVersion !== currentSchema.version) {
          throw conflict('The category schema changed; revalidate this listing before publishing', {
            schemaVersionOnListing: current.attributeSchemaVersion,
            currentSchemaVersion: currentSchema.version,
            revalidateRequired: true,
          });
        }
        const validation = validateAttributeValues(currentSchema.fields, current.attributes, 'admin');
        if (!validation.ok) {
          throw new AppError('VALIDATION_ERROR', 'Some attributes are not valid for this category', {
            fieldErrors: Object.fromEntries(Object.entries(validation.errors).map(([key, message]) => [`attributes.${key}`, message])),
            details: { schemaVersion: currentSchema.version },
          });
        }
      } else if (Object.keys(current.attributes).length > 0) {
        throw fieldError('attributes', 'this category has no published schema, so it cannot carry attributes');
      }

      if (current.location.key) {
        const location = await db.collection<LocationDoc>(COLLECTIONS.locations).findOne({ key: current.location.key });
        if (!location) throw fieldError('locationKey', 'the location no longer exists');
        if (!location.active) throw fieldError('locationKey', 'the location is inactive');
      }

      if (current.listingMethod === 'fixed_price') {
        fixedPriceMinorForWrite('fixed_price', current.priceMinor, current.priceMinor, true);
      }

      if (current.media.length === 0) {
        throw fieldError('media', 'a published listing needs at least one image');
      }
      if (!current.coverAssetId || !current.media.some((entry) => entry.assetId === current.coverAssetId)) {
        throw fieldError('coverAssetId', 'choose a cover image from the listing media');
      }
      for (const entry of current.media) {
        let asset;
        try {
          asset = await media.getByAssetId(entry.assetId);
        } catch {
          throw fieldError('media', `image ${entry.assetId} is missing from the media store`);
        }
        if (asset.status !== 'ready') {
          throw fieldError('media', `image ${entry.assetId} is ${asset.status}, not ready`);
        }
      }

      if (current.featured.featured) {
        const featuredCount = await countPublishedFeatured(db);
        if (featuredCount >= MAX_PUBLISHED_FEATURED) {
          throw fieldError('featured', 'At most 10 published listings can be featured. Unfeature one first.');
        }
      }

      const now = new Date();
      const published = await bumpListingVersion(db, ref, {
        status: 'published',
        publishedAt: now,
        publishedBy: actor.reference,
        updatedAt: now,
        updatedBy: actor.reference,
        archivedAt: null,
        archivedReason: null,
      });
      if (!published) throw conflict('This listing changed while publishing it');

      await recordAudit(db, {
        actorId: actor.reference,
        action: 'listing.published',
        targetType: 'listing',
        targetId: ref,
        requestId: actor.requestId,
        changeSummary: { category: published.categoryKey, media: published.media.length, method: published.listingMethod },
        reason: 'published from the admin wizard',
      });
      logger.info('listing published', { reference: ref });
      return published;
    },

    /**
     * Archive is the only way a published listing leaves public view: the record and its history
     * stay, and re-publishing remains possible.
     */
    async archive(ref: string, reason: string, actor: { reference: string; requestId: string }): Promise<ListingWithId> {
      const current = await findListingByReference(db, ref);
      if (!current) throw notFound('Listing not found');
      if (current.status === 'archived') throw conflict('This listing is already archived', { status: current.status });
      const now = new Date();
      const archived = await bumpListingVersion(db, ref, {
        status: 'archived',
        archivedAt: now,
        archivedBy: actor.reference,
        archivedReason: reason,
        updatedAt: now,
        updatedBy: actor.reference,
      });
      if (!archived) throw conflict('This listing changed while archiving it');
      await recordAudit(db, {
        actorId: actor.reference,
        action: 'listing.archived',
        targetType: 'listing',
        targetId: ref,
        requestId: actor.requestId,
        changeSummary: { previousStatus: current.status },
        reason,
      });
      return archived;
    },

    /**
     * PUBLIC MEDIA POLICY — the single place public image access is decided.
     *
     * Bytes are served only when **all** of these hold:
     *   1. the listing exists, is published, is not archived and is not blocked,
     *   2. the asset is one of that listing's own media entries,
     *   3. the asset itself is `ready` and has a stored object.
     *
     * Knowing an asset ID (or its object key) therefore proves nothing: an asset attached to a
     * draft, an unattached upload, or another owner's media — seller verification documents and
     * settlement evidence included — resolves to the same 404 as a non-existent asset, so the
     * response cannot be used to probe what exists.
     */
    async resolvePublicMedia(
      ref: string,
      assetId: string,
      viewerReference?: string | null,
    ): Promise<{ assetId: string; mime: string }> {
      const listing = await requireVisible(ref);
      await assertAuctionPubliclyVisible(db, listing, viewerReference);
      if (!listing.media.some((entry) => entry.assetId === assetId)) {
        throw notFound('Media not found');
      }
      const references = await media.listReferences(assetId);
      const ownedByThisListing = references.some((reference) => reference.ownerType === 'listing' && reference.ownerId === ref);
      if (!ownedByThisListing) {
        // Attached in the listing document but not registered as this listing's media: refuse
        // rather than serve something whose ownership is unclear.
        throw notFound('Media not found');
      }
      const asset = await media.findReadyAsset(assetId);
      if (!asset || !asset.storageKey) throw notFound('Media not found');
      return { assetId, mime: asset.mime ?? 'application/octet-stream' };
    },

    async readPublicMedia(assetId: string): Promise<Buffer> {
      const asset = await media.findReadyAsset(assetId);
      if (!asset) throw notFound('Media not found');
      return media.readBytes(asset);
    },

    /** Exposed for tests and the wizard: the schema the listing must be valid against. */
    async currentSchemaFor(categoryKey: string): Promise<AttributeSchemaWithId | null> {
      return attributes.currentForCategory(categoryKey);
    },

    async buyFixedPrice(
      ref: string,
      buyerUserReference: string,
      fulfillment: OrderFulfillment,
    ) {
      const listing = await findListingByReference(db, ref);
      if (!listing) throw notFound('Listing not found');
      if (listing.status !== 'published' || listing.archivedAt || listing.moderation.state === 'blocked') {
        throw notFound('Listing not found');
      }
      return withTransaction(async (session) => {
        const order = await createFixedPriceOrder(db, {
          listingReference: ref,
          buyerUserReference,
          fulfillment,
        }, session);
        return orderView(order);
      });
    },

    /** Exposed for the admin overview and tests: how many drafts/published/archived listings exist. */
    counts: (): Promise<Record<string, number>> => countListingsByStatus(db),
  };
}

export type ListingService = ReturnType<typeof createListingService>;
