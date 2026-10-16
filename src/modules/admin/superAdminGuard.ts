import type { ClientSession, Db } from 'mongodb';
import { COLLECTIONS } from '../../db/indexes.ts';
import { AppError } from '../../shared/errors.ts';

const COUNTER_ID = 'activeSuperAdmins';

type CounterDoc = { _id: string; value: number };

function counters(db: Db) {
  return db.collection<CounterDoc>(COLLECTIONS.systemCounters);
}

export async function countActiveSuperAdmins(db: Db): Promise<number> {
  return db.collection(COLLECTIONS.users).countDocuments({ status: 'active', roles: 'super_admin' });
}

/** Recompute the counter from the source of truth. Used at bootstrap and on repair. */
export async function syncSuperAdminCounter(db: Db): Promise<number> {
  const value = await countActiveSuperAdmins(db);
  await counters(db).updateOne({ _id: COUNTER_ID }, { $set: { value } }, { upsert: true });
  return value;
}

export async function getSuperAdminCounter(db: Db): Promise<number> {
  const doc = await counters(db).findOne({ _id: COUNTER_ID });
  if (!doc) return syncSuperAdminCounter(db);
  return doc.value;
}

/**
 * Atomically reserve the right to remove one active super admin.
 *
 * This is a conditional `$inc` (`value > 1`), not a read-then-write check, so two
 * concurrent removals cannot both succeed when only one super admin remains. Run
 * inside a transaction so a failed user update rolls the reservation back.
 */
export async function reserveSuperAdminRemoval(db: Db, session?: ClientSession): Promise<void> {
  const result = await counters(db).findOneAndUpdate(
    { _id: COUNTER_ID, value: { $gt: 1 } },
    { $inc: { value: -1 } },
    { returnDocument: 'after', ...(session ? { session } : {}) },
  );
  if (!result) {
    throw new AppError('CONFLICT', 'You cannot remove or demote the last active super admin');
  }
}

export async function releaseSuperAdminSlot(db: Db, session?: ClientSession): Promise<void> {
  await counters(db).updateOne({ _id: COUNTER_ID }, { $inc: { value: 1 } }, session ? { session } : {});
}
