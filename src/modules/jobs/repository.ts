import { randomUUID } from 'node:crypto';
import type { ClientSession, Collection, Db } from 'mongodb';
import { COLLECTIONS } from '../../db/indexes.ts';

export type JobState = 'pending' | 'running' | 'succeeded' | 'failed';

export type DurableJobDoc = {
  jobId: string;
  type: string;
  key: string;
  state: JobState;
  payload: Record<string, unknown>;
  runAfter: Date;
  attempts: number;
  maxAttempts: number;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  lastError: string | null;
};

export type EnqueueJobInput = {
  type: string;
  key: string;
  payload?: Record<string, unknown>;
  runAfter?: Date;
  maxAttempts?: number;
  /** When the `(type, key)` job already exists, update `runAfter` (and payload when supplied). */
  reschedule?: boolean;
};

function collection(db: Db): Collection<DurableJobDoc> {
  return db.collection<DurableJobDoc>(COLLECTIONS.durableJobs);
}

/**
 * Idempotent enqueue: `(type, key)` is unique, so re-enqueueing the same logical
 * job returns the existing job instead of creating a duplicate.
 */
export async function enqueueJob(db: Db, input: EnqueueJobInput, session?: ClientSession): Promise<string> {
  const now = new Date();
  const jobId = randomUUID();
  const update: Record<string, unknown> = {
    $setOnInsert: {
      jobId,
      type: input.type,
      key: input.key,
      state: 'pending' as JobState,
      payload: input.payload ?? {},
      runAfter: input.runAfter ?? now,
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 5,
      leaseOwner: null,
      leaseUntil: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    },
  };
  if (input.reschedule) {
    const set: Record<string, unknown> = { updatedAt: now };
    if (input.runAfter) set.runAfter = input.runAfter;
    if (input.payload) set.payload = input.payload;
    if (Object.keys(set).length > 1) update.$set = set;
  }
  const doc = await collection(db).findOneAndUpdate(
    { type: input.type, key: input.key },
    update,
    { upsert: true, returnDocument: 'after', ...(session ? { session } : {}) },
  );
  return doc?.jobId ?? jobId;
}

/**
 * Claim up to `limit` runnable jobs for `owner`. Each claim is a conditional
 * update that sets a bounded lease, so two workers never run the same job and a
 * crashed worker's job becomes reclaimable when the lease expires.
 */
export async function claimJobs(
  db: Db,
  options: {
    owner: string;
    limit: number;
    leaseMs: number;
    type?: string;
    typePrefix?: string;
    now?: Date;
  },
): Promise<DurableJobDoc[]> {
  const now = options.now ?? new Date();
  const coll = collection(db);
  const filter: Record<string, unknown> = { state: 'pending', runAfter: { $lte: now } };
  if (options.type) {
    filter.type = options.type;
  } else if (options.typePrefix) {
    const escaped = options.typePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.type = { $regex: `^${escaped}` };
  }

  const claimed: DurableJobDoc[] = [];
  for (let i = 0; i < options.limit; i += 1) {
    const doc = await coll.findOneAndUpdate(
      filter,
      {
        $set: {
          state: 'running',
          leaseOwner: options.owner,
          leaseUntil: new Date(now.getTime() + options.leaseMs),
          updatedAt: now,
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

/** Extend a lease mid-run. Returns false if the lease was lost (another worker owns it). */
export async function renewLease(
  db: Db,
  options: { jobId: string; owner: string; leaseMs: number; now?: Date },
): Promise<boolean> {
  const now = options.now ?? new Date();
  const result = await collection(db).updateOne(
    { jobId: options.jobId, state: 'running', leaseOwner: options.owner },
    { $set: { leaseUntil: new Date(now.getTime() + options.leaseMs), updatedAt: now } },
  );
  return result.matchedCount === 1;
}

export async function completeJob(db: Db, options: { jobId: string; owner: string }): Promise<boolean> {
  const result = await collection(db).updateOne(
    { jobId: options.jobId, state: 'running', leaseOwner: options.owner },
    { $set: { state: 'succeeded', completedAt: new Date(), updatedAt: new Date(), leaseOwner: null, leaseUntil: null } },
  );
  return result.matchedCount === 1;
}

/** Retry with backoff until `maxAttempts`, then mark `failed` for operators. */
export async function failJob(
  db: Db,
  options: { jobId: string; owner: string; error: string; backoffMs: number; now?: Date },
): Promise<void> {
  const now = options.now ?? new Date();
  const coll = collection(db);
  const job = await coll.findOne({ jobId: options.jobId });
  if (!job) return;
  const exhausted = job.attempts >= job.maxAttempts;
  await coll.updateOne(
    { jobId: options.jobId },
    {
      $set: {
        state: exhausted ? 'failed' : 'pending',
        lastError: options.error.slice(0, 500),
        leaseOwner: null,
        leaseUntil: null,
        runAfter: new Date(now.getTime() + options.backoffMs),
        updatedAt: now,
      },
    },
  );
}

/**
 * Crash recovery: return jobs whose lease expired to the pending pool so another
 * worker can pick them up. There is no permanent lock — leases always expire.
 */
export async function reclaimExpiredJobs(db: Db, options: { limit: number; now?: Date }): Promise<number> {
  const now = options.now ?? new Date();
  const coll = collection(db);
  let reclaimed = 0;
  for (let i = 0; i < options.limit; i += 1) {
    const doc = await coll.findOneAndUpdate(
      { state: 'running', leaseUntil: { $lt: now } },
      { $set: { state: 'pending', leaseOwner: null, leaseUntil: null, updatedAt: now } },
      { returnDocument: 'after' },
    );
    if (!doc) break;
    reclaimed += 1;
  }
  return reclaimed;
}
