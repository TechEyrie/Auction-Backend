import { randomUUID } from 'node:crypto';
import type { ClientSession, Collection, Db } from 'mongodb';
import { COLLECTIONS } from '../../db/indexes.ts';

export type OutboxStatus = 'pending' | 'claimed' | 'published' | 'failed';

export type OutboxEventDoc = {
  eventId: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  type: string;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  createdAt: Date;
  claimedAt: Date | null;
  publishedAt: Date | null;
  runAfter: Date;
  attempts: number;
  lastError: string | null;
  leaseUntil: Date | null;
};

export type EnqueueEventInput = {
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  type: string;
  /** Safe, already-serializable payload — never secrets or PII. */
  payload: Record<string, unknown>;
  eventId?: string;
};

function collection(db: Db): Collection<OutboxEventDoc> {
  return db.collection<OutboxEventDoc>(COLLECTIONS.outboxEvents);
}

/**
 * Append an outbox event. Pass the same `session` as the business write so the
 * event commits atomically with it. `eventId` is unique: enqueueing the same id
 * again is rejected by the unique index, so a producer that needs exactly-once
 * semantics should supply a deterministic id.
 */
export async function enqueueEvent(
  db: Db,
  input: EnqueueEventInput,
  session?: ClientSession,
): Promise<string> {
  const eventId = input.eventId ?? randomUUID();
  const now = new Date();
  await collection(db).insertOne(
    {
      eventId,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      aggregateVersion: input.aggregateVersion,
      type: input.type,
      payload: input.payload,
      status: 'pending',
      createdAt: now,
      claimedAt: null,
      publishedAt: null,
      runAfter: now,
      attempts: 0,
      lastError: null,
      leaseUntil: null,
    },
    session ? { session } : {},
  );
  return eventId;
}

/**
 * Claim up to `limit` dispatchable events. Each claim is a single conditional
 * update, so concurrent dispatchers never take the same event. A lease bounds
 * how long a crashed dispatcher can hold an event; the reaper returns it later.
 */
export async function claimEvents(
  db: Db,
  options: { limit: number; leaseMs: number; now?: Date },
): Promise<OutboxEventDoc[]> {
  const now = options.now ?? new Date();
  const coll = collection(db);
  const claimed: OutboxEventDoc[] = [];
  for (let i = 0; i < options.limit; i += 1) {
    const doc = await coll.findOneAndUpdate(
      { status: 'pending', runAfter: { $lte: now } },
      {
        $set: {
          status: 'claimed',
          claimedAt: now,
          leaseUntil: new Date(now.getTime() + options.leaseMs),
        },
        $inc: { attempts: 1 },
      },
      { returnDocument: 'after', sort: { runAfter: 1 } },
    );
    if (!doc) break;
    claimed.push(doc);
  }
  return claimed;
}

export async function markPublished(db: Db, eventId: string): Promise<void> {
  await collection(db).updateOne(
    { eventId },
    { $set: { status: 'published', publishedAt: new Date(), leaseUntil: null, lastError: null } },
  );
}

/**
 * Record a dispatch failure. Retries with backoff until `maxAttempts`, then
 * parks the event as `failed` for operator attention.
 */
export async function markFailed(
  db: Db,
  eventId: string,
  error: string,
  options: { backoffMs: number; maxAttempts: number; now?: Date },
): Promise<void> {
  const now = options.now ?? new Date();
  const coll = collection(db);
  const doc = await coll.findOne({ eventId });
  if (!doc) return;
  const exhausted = doc.attempts >= options.maxAttempts;
  await coll.updateOne(
    { eventId },
    {
      $set: {
        status: exhausted ? 'failed' : 'pending',
        lastError: error.slice(0, 500),
        leaseUntil: null,
        runAfter: new Date(now.getTime() + options.backoffMs),
      },
    },
  );
}

/** Return events whose lease expired (dispatcher crashed) to the pending pool. */
export async function reclaimExpiredLeases(db: Db, options: { limit: number; now?: Date }): Promise<number> {
  const now = options.now ?? new Date();
  const coll = collection(db);
  let reclaimed = 0;
  for (let i = 0; i < options.limit; i += 1) {
    const doc = await coll.findOneAndUpdate(
      { status: 'claimed', leaseUntil: { $lt: now } },
      { $set: { status: 'pending', claimedAt: null, leaseUntil: null } },
      { returnDocument: 'after' },
    );
    if (!doc) break;
    reclaimed += 1;
  }
  return reclaimed;
}
