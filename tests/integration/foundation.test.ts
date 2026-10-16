import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createReplSet } from '../helpers/mongo.ts';
import { connectDb, isDuplicateKeyError, type DbHandle } from '../../src/db/connection.ts';
import { COLLECTIONS, ensureIndexes } from '../../src/db/indexes.ts';
import { AppError } from '../../src/shared/errors.ts';
import { completeIdempotency, resolveIdempotency } from '../../src/modules/idempotency/repository.ts';
import {
  claimEvents,
  enqueueEvent,
  markFailed,
  markPublished,
  reclaimExpiredLeases,
} from '../../src/modules/outbox/repository.ts';
import {
  claimJobs,
  completeJob,
  enqueueJob,
  failJob,
  reclaimExpiredJobs,
  renewLease,
} from '../../src/modules/jobs/repository.ts';
import { startServer } from '../../src/server.ts';
import { silentLogger, testConfig } from '../helpers/context.ts';

let replSet: MongoMemoryReplSet;
let handle: DbHandle;

before(async () => {
  replSet = await createReplSet();
  handle = await connectDb({ mongodbUri: replSet.getUri(), mongodbDb: 'foundation_test' });
  await ensureIndexes(handle.db);
});

after(async () => {
  if (handle) await handle.close();
  if (replSet) await replSet.stop();
});

test('commits a multi-collection write atomically', async () => {
  const coll = handle.db.collection<{ label: string }>('tx_commit');
  await handle.withTransaction(async (session) => {
    await coll.insertOne({ label: 'a' }, { session });
    await coll.insertOne({ label: 'b' }, { session });
  });
  assert.equal(await coll.countDocuments(), 2);
});

test('rolls back a transaction when the callback throws', async () => {
  const coll = handle.db.collection<{ label: string }>('tx_rollback');
  await assert.rejects(
    handle.withTransaction(async (session) => {
      await coll.insertOne({ label: 'x' }, { session });
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(await coll.countDocuments(), 0);
});

test('enforces the unique idempotency index', async () => {
  const coll = handle.db.collection(COLLECTIONS.idempotencyRecords);
  const doc = {
    scope: 's',
    actorId: 'a',
    key: 'unique-check',
    fingerprint: 'f',
    state: 'in_progress',
    resultRef: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: new Date(Date.now() + 3_600_000),
  };
  await coll.insertOne(doc);
  await assert.rejects(coll.insertOne(doc), isDuplicateKeyError);
});

test('idempotency: proceed, in_progress, replay, and conflict on a changed payload', async () => {
  const key = { scope: 'orders', actorId: 'u1', key: 'k1' };
  assert.equal((await resolveIdempotency(handle.db, { ...key, fingerprint: 'f1' }, 24)).kind, 'proceed');
  assert.equal((await resolveIdempotency(handle.db, { ...key, fingerprint: 'f1' }, 24)).kind, 'in_progress');
  await completeIdempotency(handle.db, key, { orderId: 'o1' });
  const replay = await resolveIdempotency(handle.db, { ...key, fingerprint: 'f1' }, 24);
  assert.equal(replay.kind, 'replay');
  assert.deepEqual(replay.kind === 'replay' ? replay.resultRef : null, { orderId: 'o1' });
  await assert.rejects(
    () => resolveIdempotency(handle.db, { ...key, fingerprint: 'f2' }, 24),
    (err: unknown) => err instanceof AppError && err.status === 409,
  );
});

test('outbox: unique identity, claim, publish, retry, and lease recovery', async () => {
  const base = { aggregateType: 'lot', aggregateId: 'l1', aggregateVersion: 1, type: 'bid.placed', payload: { amountMinor: 100 } };
  await enqueueEvent(handle.db, { ...base, eventId: 'evt-1' });
  await assert.rejects(() => enqueueEvent(handle.db, { ...base, eventId: 'evt-1' }), isDuplicateKeyError);

  const claimed = await claimEvents(handle.db, { limit: 5, leaseMs: 1000 });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0]?.status, 'claimed');
  assert.equal(claimed[0]?.attempts, 1);

  await markPublished(handle.db, 'evt-1');
  const published = await handle.db.collection(COLLECTIONS.outboxEvents).findOne({ eventId: 'evt-1' });
  assert.equal(published?.status, 'published');

  await enqueueEvent(handle.db, { ...base, aggregateId: 'l2', eventId: 'evt-2' });
  await markFailed(handle.db, 'evt-2', 'dispatch error with secret token', { backoffMs: 0, maxAttempts: 3, now: new Date(Date.now() - 1000) });
  const retried = await handle.db.collection(COLLECTIONS.outboxEvents).findOne({ eventId: 'evt-2' });
  assert.equal(retried?.status, 'pending');
  assert.equal(retried?.lastError, 'dispatch error with secret token');

  const secondClaim = await claimEvents(handle.db, { limit: 5, leaseMs: 10 });
  assert.equal(secondClaim.length, 1);
  const reclaimed = await reclaimExpiredLeases(handle.db, { limit: 5, now: new Date(Date.now() + 1000) });
  assert.equal(reclaimed, 1);
});

test('jobs: idempotent enqueue, claim, renew, and complete', async () => {
  const jobId = await enqueueJob(handle.db, { type: 'lot.close', key: 'l1' });
  assert.equal(await enqueueJob(handle.db, { type: 'lot.close', key: 'l1' }), jobId);

  const claimed = await claimJobs(handle.db, { owner: 'w1', limit: 5, leaseMs: 1000 });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0]?.jobId, jobId);
  assert.equal(claimed[0]?.state, 'running');

  assert.equal(await renewLease(handle.db, { jobId, owner: 'w1', leaseMs: 1000 }), true);
  assert.equal(await renewLease(handle.db, { jobId, owner: 'other', leaseMs: 1000 }), false);
  assert.equal(await completeJob(handle.db, { jobId, owner: 'w1' }), true);
});

test('jobs: retry with backoff and reclaim of an expired lease (crash recovery)', async () => {
  const jobId = await enqueueJob(handle.db, { type: 'lot.close', key: 'l2', maxAttempts: 2 });
  const [claimed] = await claimJobs(handle.db, { owner: 'w1', limit: 1, leaseMs: 1000 });
  assert.equal(claimed?.jobId, jobId);

  await failJob(handle.db, { jobId, owner: 'w1', error: 'transient', backoffMs: 0 });
  const retried = await handle.db.collection(COLLECTIONS.durableJobs).findOne({ jobId });
  assert.equal(retried?.state, 'pending');

  // Simulate a worker dying mid-run: a running job whose lease has expired.
  await handle.db.collection(COLLECTIONS.durableJobs).updateOne(
    { jobId },
    { $set: { state: 'running', leaseOwner: 'dead', leaseUntil: new Date(Date.now() - 1000) } },
  );
  assert.ok((await reclaimExpiredJobs(handle.db, { limit: 10 })) >= 1);
  const recovered = await handle.db.collection(COLLECTIONS.durableJobs).findOne({ jobId });
  assert.equal(recovered?.state, 'pending');
});

test('unknown routes return the standard envelope over a live server', async () => {
  const running = await startServer({ config: testConfig(), logger: silentLogger(), db: handle });
  try {
    const res = await fetch(`http://127.0.0.1:${running.port}/does-not-exist`, {
      headers: { 'x-request-id': 'req-live-1' },
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { code: string; requestId: string } };
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.equal(body.error.requestId, 'req-live-1');
  } finally {
    await running.stop();
  }
});

test('liveness stays 200 while readiness is 503 during a real database failure', async () => {
  const failing = await connectDb({ mongodbUri: replSet.getUri(), mongodbDb: 'readiness_test' });
  const running = await startServer({ config: testConfig(), logger: silentLogger(), db: failing });
  const base = `http://127.0.0.1:${running.port}`;
  try {
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
    await failing.close();
    assert.equal((await fetch(`${base}/readyz`)).status, 503);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  } finally {
    await running.stop();
  }
});

test('graceful shutdown stops accepting connections and closes resources', async () => {
  const db = await connectDb({ mongodbUri: replSet.getUri(), mongodbDb: 'shutdown_test' });
  const running = await startServer({ config: testConfig(), logger: silentLogger(), db });
  const url = `http://127.0.0.1:${running.port}/healthz`;
  assert.equal((await fetch(url)).status, 200);

  await running.stop();
  await assert.rejects(fetch(url));
  await assert.rejects(db.ping());
});
