import type { ObjectId } from 'mongodb';

export const LISTING_METHODS = ['auction', 'fixed_price', 'enquiry'] as const;
export type ListingMethod = (typeof LISTING_METHODS)[number];

export type LocalizedText = { name: string; description: string | null };

export type CategoryDoc = {
  /** Stable machine key. Unique across the whole tree, so sibling duplication is impossible. */
  key: string;
  parentId: ObjectId | null;
  /** Denormalized parent key for indexed reads; kept in step with `parentId`. */
  parentKey: string | null;
  /** Materialized ancestor keys from root to direct parent. Makes cycle checks O(depth). */
  ancestors: string[];
  /** Depth from the root (0 for a top-level category); bounds the tree. */
  depth: number;
  labels: { en: LocalizedText; ar?: LocalizedText | null };
  icon: string | null;
  order: number;
  active: boolean;
  listingMethods: ListingMethod[];
  /** Version pointer of the published attribute schema; owned by the attributes module. */
  currentAttributeSchemaVersion: number | null;
  /**
   * Bumped on every write to this document. Updates are conditional on the value the
   * caller read, so two competing hierarchy edits cannot both commit.
   */
  hierarchyVersion: number;
  createdBy: string;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
};

export type CategoryWithId = CategoryDoc & { _id: ObjectId };

export const MAX_CATEGORY_DEPTH = 4;

export const CATALOGUE_ROOTS = [
  'glasses',
  'tea-coffee',
  'abaya',
  'natural-leather',
  'perfume',
  'supplements',
  'misbah',
  'watches',
  'clothes-thobes',
  'cufflinks',
] as const;

/** @deprecated Legacy calendar/listing guard; prefer {@link CATALOGUE_ROOTS} and {@link isCatalogueCategory}. */
export const SUSPENDED_CATEGORY_ROOTS = ['jobs', 'property'] as const;

export function isCatalogueCategory(key: string, ancestors: readonly string[]): boolean {
  return (CATALOGUE_ROOTS as readonly string[]).includes(key)
    || ancestors.some((a) => (CATALOGUE_ROOTS as readonly string[]).includes(a));
}

export function isSuspendedCategory(key: string, ancestors: readonly string[]): boolean {
  return !isCatalogueCategory(key, ancestors);
}
