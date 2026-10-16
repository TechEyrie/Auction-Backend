import type { Collection, Db } from 'mongodb';
import { isDuplicateKeyError } from '../../db/connection.ts';
import { COLLECTIONS } from '../../db/indexes.ts';
import { conflict } from '../../shared/errors.ts';

export type IdempotencyState = 'in_progress' | 'completed' | 'failed';

export type IdempotencyRecordDoc = {
  scope: string;
  actorId: string;
  key: string;
  fingerprint: string;
  state: IdempotencyState;
  resultRef: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
};

export type IdempotencyKey = { scope: string; actorId: string; key: string };
export type IdempotencyInput = IdempotencyKey & { fingerprint: string };

export type IdempotencyOutcome =
  | { kind: 'proceed' }
  | { kind: 'in_progress' }
  | { kind: 'replay'; resultRef: Record<string, unknown> | null };

function collection(db: Db): Collection<IdempotencyRecordDoc> {
  return db.collection<IdempotencyRecordDoc>(COLLECTIONS.idempotencyRecords);
}

/**
 * Reserve an idempotency key, or report what a previous identical request did.
 * - same key + same fingerprint, still running  -> `in_progress` (caller must not re-execute)
 * - same key + same fingerprint, completed      -> `replay` with the stored result reference
 * - same key + different fingerprint            -> 409 Conflict
 *
 * NOTE: these records expire (TTL). Expiry is a convenience for retries only;
 * authoritative financial uniqueness must be enforced by a non-expiring unique
 * key on the financial document itself, which later phases add.
 */
export async function resolveIdempotency(
  db: Db,
  input: IdempotencyInput,
  ttlHours: number,
): Promise<IdempotencyOutcome> {
  const coll = collection(db);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlHours * 3_600_000);

  try {
    await coll.insertOne({
      scope: input.scope,
      actorId: input.actorId,
      key: input.key,
      fingerprint: input.fingerprint,
      state: 'in_progress',
      resultRef: null,
      createdAt: now,
      updatedAt: now,
      expiresAt,
    });
    return { kind: 'proceed' };
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
  }

  const existing = await coll.findOne({ scope: input.scope, actorId: input.actorId, key: input.key });
  if (!existing) return { kind: 'proceed' };

  if (existing.fingerprint !== input.fingerprint) {
    throw conflict('Idempotency key was reused with a different request payload', {
      scope: input.scope,
      key: input.key,
    });
  }
  if (existing.state === 'completed') {
    return { kind: 'replay', resultRef: existing.resultRef };
  }
  if (existing.state === 'failed') {
    const reset = await coll.updateOne(
      { scope: input.scope, actorId: input.actorId, key: input.key, state: 'failed' },
      { $set: { state: 'in_progress', updatedAt: new Date(), expiresAt } },
    );
    return reset.modifiedCount === 1 ? { kind: 'proceed' } : { kind: 'in_progress' };
  }
  return { kind: 'in_progress' };
}

export async function completeIdempotency(
  db: Db,
  key: IdempotencyKey,
  resultRef: Record<string, unknown> | null,
): Promise<void> {
  await collection(db).updateOne(
    key,
    { $set: { state: 'completed', resultRef, updatedAt: new Date() } },
  );
}

export async function failIdempotency(db: Db, key: IdempotencyKey): Promise<void> {
  await collection(db).updateOne(key, { $set: { state: 'failed', updatedAt: new Date() } });
}
