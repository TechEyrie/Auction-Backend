import type { Collection, Db } from 'mongodb';
import { COLLECTIONS } from '../../db/indexes.ts';
import { escapeRegex } from '../sellers/repository.ts';
import type { Audience, Condition, ListingDoc, ListingMethod, ListingWithId } from './models.ts';

export type Paged<T> = { items: T[]; page: number; limit: number; total: number; totalPages: number };

export function listings(db: Db): Collection<ListingDoc> {
  return db.collection<ListingDoc>(COLLECTIONS.listings);
}

export async function insertListing(db: Db, doc: ListingDoc): Promise<ListingWithId> {
  const result = await listings(db).insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

export async function findListingByReference(db: Db, reference: string): Promise<ListingWithId | null> {
  return listings(db).findOne({ listingReference: reference });
}

export async function findListingBySlug(db: Db, slug: string): Promise<ListingWithId | null> {
  return listings(db).findOne({ slug });
}

/**
 * Conditional update: the caller must have read `expectedVersion`. A competing edit therefore
 * fails with a conflict instead of silently overwriting newer work.
 */
export async function updateListingVersioned(
  db: Db,
  reference: string,
  expectedVersion: number,
  patch: Partial<ListingDoc>,
): Promise<ListingWithId | null> {
  return listings(db).findOneAndUpdate(
    { listingReference: reference, version: expectedVersion },
    { $set: patch, $inc: { version: 1 } },
    { returnDocument: 'after' },
  );
}

export async function bumpListingVersion(
  db: Db,
  reference: string,
  patch: Partial<ListingDoc>,
): Promise<ListingWithId | null> {
  return listings(db).findOneAndUpdate(
    { listingReference: reference },
    { $set: patch, $inc: { version: 1 } },
    { returnDocument: 'after' },
  );
}

export const PUBLIC_SORTS = ['recent', 'title', 'featured'] as const;
export type PublicSort = (typeof PUBLIC_SORTS)[number];

export type PublicListQuery = {
  /** Case-insensitive substring over localised titles, descriptions and the reference. */
  search?: string;
  /** A category key, matched against the listing's own key plus its ancestor path. */
  categoryKeys?: string[];
  method?: ListingMethod;
  condition?: Condition;
  countryCode?: string;
  cityKey?: string;
  featuredOnly?: boolean;
  audience?: Audience;
  sort: PublicSort;
  page: number;
  limit: number;
  /** When set, auction listings without a live lot are excluded from discovery. */
  liveAuctionListingReferences?: string[];
};

/** Only visible, published listings are ever returned by a public query. */
export function publicVisibilityFilter(): Record<string, unknown> {
  return {
    status: 'published',
    archivedAt: null,
    // A blocked listing stays in the database and stays invisible to visitors.
    'moderation.state': { $ne: 'blocked' },
  };
}

export function buildPublicFilter(query: PublicListQuery): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    ...publicVisibilityFilter(),
    // Sold listings remain reachable by direct URL; omit them from catalogue browse.
    $or: [{ availability: { $ne: 'sold' } }, { availability: { $exists: false } }],
  };
  if (query.categoryKeys && query.categoryKeys.length > 0) {
    // The path snapshot contains the category itself, so descendants match their parent key too.
    filter.categoryPath = { $in: query.categoryKeys };
  }
  if (query.method) filter.listingMethod = query.method;
  if (query.condition) filter.condition = query.condition;
  if (query.countryCode) filter['location.countryCode'] = query.countryCode;
  if (query.cityKey) filter['location.cityKey'] = query.cityKey;
  if (query.featuredOnly) filter['featured.featured'] = true;
  if (query.audience) filter.audience = query.audience;
  if (query.search) {
    const rx = new RegExp(escapeRegex(query.search), 'i');
    filter.$or = [{ 'title.en': rx }, { 'title.ar': rx }, { 'description.en': rx }, { 'description.ar': rx }, { listingReference: rx }];
  }
  if (query.liveAuctionListingReferences !== undefined) {
    const refs = query.liveAuctionListingReferences;
    filter.$and = [
      ...(Array.isArray(filter.$and) ? filter.$and : []),
      {
        $or: [{ listingMethod: { $ne: 'auction' } }, { listingReference: { $in: refs } }],
      },
    ];
  }
  return filter;
}

/** Deterministic sort: every branch ends with the immutable reference so pages cannot overlap. */
export function publicSortSpec(sort: PublicSort): Record<string, 1 | -1> {
  switch (sort) {
    case 'title':
      return { 'title.en': 1, 'title.ar': 1, listingReference: 1 };
    case 'featured':
      return { 'featured.featured': -1, 'featured.order': 1, publishedAt: -1, listingReference: 1 };
    default:
      return { publishedAt: -1, listingReference: 1 };
  }
}

export async function listPublicListings(db: Db, query: PublicListQuery): Promise<Paged<ListingWithId>> {
  const filter = buildPublicFilter(query);
  const collection = listings(db);
  const total = await collection.countDocuments(filter);
  const items = await collection
    .find(filter)
    .sort(publicSortSpec(query.sort))
    .skip((query.page - 1) * query.limit)
    .limit(query.limit)
    .toArray();
  return {
    items,
    page: query.page,
    limit: query.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.limit)),
  };
}

export type AdminListQuery = {
  status?: ListingDoc['status'];
  search?: string;
  categoryKey?: string;
  sellerReference?: string;
  audience?: Audience;
  page: number;
  limit: number;
};

export async function listAdminListings(db: Db, query: AdminListQuery): Promise<Paged<ListingWithId>> {
  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = query.status;
  if (query.categoryKey) filter.categoryPath = query.categoryKey;
  if (query.sellerReference) filter.sellerReference = query.sellerReference;
  if (query.audience) filter.audience = query.audience;
  if (query.search) {
    const rx = new RegExp(escapeRegex(query.search), 'i');
    filter.$or = [{ 'title.en': rx }, { 'title.ar': rx }, { listingReference: rx }, { sellerReference: rx }];
  }

  const collection = listings(db);
  const total = await collection.countDocuments(filter);
  const items = await collection
    .find(filter)
    // Newest edits first; the reference keeps the order stable across equal timestamps.
    .sort({ updatedAt: -1, listingReference: 1 })
    .skip((query.page - 1) * query.limit)
    .limit(query.limit)
    .toArray();
  return {
    items,
    page: query.page,
    limit: query.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.limit)),
  };
}

/** Counts used by the admin overview; none of these reach a public response. */
export async function countListingsByStatus(db: Db): Promise<Record<string, number>> {
  const rows = await listings(db)
    .aggregate<{ _id: string; count: number }>([{ $group: { _id: '$status', count: { $sum: 1 } } }])
    .toArray();
  return Object.fromEntries(rows.map((row) => [row._id, row.count]));
}

export async function listPublishedReferences(db: Db, references: string[]): Promise<ListingWithId[]> {
  if (references.length === 0) return [];
  return listings(db)
    .find({ ...publicVisibilityFilter(), listingReference: { $in: references } })
    .toArray();
}
