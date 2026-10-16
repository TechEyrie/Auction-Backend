import { ObjectId, type Collection, type Db } from 'mongodb';
import { COLLECTIONS } from '../../db/indexes.ts';
import type { SellerDoc, SellerWithId } from './models.ts';

export function sellers(db: Db): Collection<SellerDoc> {
  return db.collection<SellerDoc>(COLLECTIONS.sellers);
}

export async function insertSeller(db: Db, doc: SellerDoc): Promise<SellerWithId> {
  const result = await sellers(db).insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

export async function findSellerByReference(db: Db, reference: string): Promise<SellerWithId | null> {
  return sellers(db).findOne({ sellerReference: reference });
}

export async function findSellerById(db: Db, id: ObjectId): Promise<SellerWithId | null> {
  return sellers(db).findOne({ _id: id });
}

export type SellerListQuery = {
  status?: SellerDoc['status'];
  type?: SellerDoc['type'];
  verification?: SellerDoc['verification']['state'];
  /** Case-insensitive substring match over display and legal name. */
  search?: string;
  page: number;
  limit: number;
};

export type Paged<T> = { items: T[]; page: number; limit: number; total: number; totalPages: number };

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function listSellers(db: Db, query: SellerListQuery): Promise<Paged<SellerWithId>> {
  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = query.status;
  if (query.type) filter.type = query.type;
  if (query.verification) filter['verification.state'] = query.verification;
  if (query.search) {
    const rx = new RegExp(escapeRegex(query.search), 'i');
    filter.$or = [{ displayName: rx }, { legalName: rx }, { sellerReference: rx }];
  }

  const collection = sellers(db);
  const total = await collection.countDocuments(filter);
  const items = await collection
    .find(filter)
    // Deterministic tie-breaker so page boundaries stay stable across equal timestamps.
    .sort({ createdAt: -1, _id: -1 })
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

export async function updateSeller(
  db: Db,
  reference: string,
  patch: Partial<SellerDoc>,
): Promise<SellerWithId | null> {
  return sellers(db).findOneAndUpdate(
    { sellerReference: reference },
    { $set: patch },
    { returnDocument: 'after' },
  );
}

export async function countSellersByLinkedUser(db: Db, userId: ObjectId): Promise<number> {
  return sellers(db).countDocuments({ linkedUserId: userId });
}
