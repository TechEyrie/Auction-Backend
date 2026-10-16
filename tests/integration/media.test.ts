import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createReplSet } from '../helpers/mongo.ts';
import { loadConfig, type AppConfig } from '../../src/config/index.ts';
import { connectDb, type DbHandle } from '../../src/db/connection.ts';
import { COLLECTIONS, ensureIndexes } from '../../src/db/indexes.ts';
import { startServer, type RunningServer } from '../../src/server.ts';
import { silentLogger } from '../helpers/context.ts';
import { TestClient } from '../helpers/client.ts';
import { createAdminFixture, createCustomerFixture } from '../helpers/authFixture.ts';
import { html, jpeg, png, svg, webp } from '../helpers/images.ts';
import { createLocalStorage, type MediaStorage } from '../../src/modules/media/storage.ts';
import { createMediaService } from '../../src/modules/media/service.ts';

let replSet: MongoMemoryReplSet;
let handle: DbHandle;
let running: RunningServer;
let config: AppConfig;
let baseUrl: string;
let admin: TestClient;
let adminRef: string;
let customer: TestClient;
let storageRoot: string;
let storage: MediaStorage;

const ADMIN_PHONE = '55555000';
const ADMIN_PW = 'media admin pw 1';
const BOOTSTRAP_TOKEN = 'media-integration-token';
const CUSTOMER_PHONE = '55555001';
const CUSTOMER_PW = 'media customer pw 1';

before(async () => {
  replSet = await createReplSet();
  storageRoot = mkdtempSync(path.join(tmpdir(), 'araq-media-'));
  config = loadConfig({
    NODE_ENV: 'test',
    PORT: '0',
    MONGODB_URI: replSet.getUri(),
    MONGODB_DB: 'media_test',
    CORS_ORIGINS: 'http://localhost:3000',
    LOG_LEVEL: 'error',
    MFA_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64'),
    ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
    MEDIA_STORAGE_ROOT: storageRoot,
    MEDIA_MAX_BYTES: '200000',
    MEDIA_MAX_DIMENSION: '1200',
    MEDIA_MAX_FILES_PER_COLLECTION: '3',
  });
  handle = await connectDb(config);
  await ensureIndexes(handle.db);
  storage = createLocalStorage({ root: storageRoot, nodeEnv: 'test', allowInProduction: false });
  running = await startServer({ config, logger: silentLogger(), db: handle, mediaStorage: storage });
  baseUrl = `http://127.0.0.1:${running.port}`;

  const fixture = await createAdminFixture({
    db: handle.db,
    baseUrl,
    phone: ADMIN_PHONE,
    password: ADMIN_PW,
    bootstrapToken: BOOTSTRAP_TOKEN,
  });
  admin = fixture.client;
  adminRef = fixture.publicReference;
  customer = await createCustomerFixture({ baseUrl, phone: CUSTOMER_PHONE, password: CUSTOMER_PW });
});

after(async () => {
  if (running) await running.stop();
  else if (handle) await handle.close();
  if (replSet) await replSet.stop();
  rmSync(storageRoot, { recursive: true, force: true });
});

/** Raw-body upload, exactly how the admin UI sends a file. */
async function upload(
  client: TestClient,
  bytes: Buffer,
  contentType: string,
  collectionKey: string,
): Promise<{ status: number; body: { asset?: Record<string, unknown>; error?: { message: string; code: string } } }> {
  const res = await fetch(`${baseUrl}/api/admin/media/upload`, {
    method: 'POST',
    headers: {
      'content-type': contentType,
      'x-collection-key': collectionKey,
      'x-csrf-token': client.csrfToken() ?? '',
      cookie: `sid=${client.cookie('sid')}; csrf=${client.csrfToken()}`,
    },
    body: new Uint8Array(bytes),
  });
  return { status: res.status, body: (await res.json()) as never };
}

test('D08 uploads require an authorized, CSRF-protected staff session', async () => {
  // A visitor with a CSRF token but no session still gets 401 (not a CSRF 403).
  const visitor = new TestClient(baseUrl);
  await visitor.bootstrap();
  const anonymous = await visitor.request('POST', '/api/admin/media/upload', undefined, {
    headers: { 'content-type': 'image/png', 'x-collection-key': 'anon' },
  });
  assert.equal(anonymous.status, 401);

  // No session and no CSRF token is refused earlier, by the CSRF guard.
  const raw = await fetch(`${baseUrl}/api/admin/media/upload`, {
    method: 'POST',
    headers: { 'content-type': 'image/png', 'x-collection-key': 'anon' },
    body: new Uint8Array(png(20, 20)),
  });
  assert.equal(raw.status, 403);

  const asCustomer = await fetch(`${baseUrl}/api/admin/media/upload`, {
    method: 'POST',
    headers: {
      'content-type': 'image/png',
      'x-collection-key': 'customer',
      'x-csrf-token': customer.csrfToken() ?? '',
      cookie: `sid=${customer.cookie('sid')}; csrf=${customer.csrfToken()}`,
    },
    body: new Uint8Array(png(20, 20)),
  });
  assert.equal(asCustomer.status, 403, 'a signed-in customer must not be able to upload media');

  // No CSRF token at all.
  const noCsrf = await fetch(`${baseUrl}/api/admin/media/upload`, {
    method: 'POST',
    headers: { 'content-type': 'image/png', 'x-collection-key': 'csrf', cookie: `sid=${admin.cookie('sid')}` },
    body: new Uint8Array(png(20, 20)),
  });
  assert.equal(noCsrf.status, 403);

  const stored = await handle.db.collection(COLLECTIONS.mediaAssets).countDocuments({});
  assert.equal(stored, 0, 'nothing may be stored for rejected callers');
});

test('D08 forged, dangerous and oversized uploads are refused', async () => {
  const collection = 'rejection-list';

  // Content is a PNG but the request claims JPEG.
  const mismatch = await upload(admin, png(30, 30), 'image/jpeg', collection);
  assert.equal(mismatch.status, 422);
  assert.match(String(mismatch.body.error?.message), /does not match|declared/i);

  // SVG and HTML masquerading as images.
  const svgAttempt = await upload(admin, svg(), 'image/png', collection);
  assert.equal(svgAttempt.status, 422);
  assert.match(String(svgAttempt.body.error?.message), /SVG/i);
  const htmlAttempt = await upload(admin, html(), 'image/png', collection);
  assert.equal(htmlAttempt.status, 422);
  assert.match(String(htmlAttempt.body.error?.message), /HTML/i);

  // Video is not an enabled capability.
  const videoAttempt = await upload(admin, Buffer.from('fake video bytes'), 'video/mp4', collection);
  assert.equal(videoAttempt.status, 422);
  assert.match(String(videoAttempt.body.error?.message), /Video uploads are not enabled/i);

  // Unknown type.
  const textAttempt = await upload(admin, Buffer.from('hello'), 'text/plain', collection);
  assert.equal(textAttempt.status, 422);

  // Oversized (limit is 200 KB in this configuration). The PNG fixtures compress to a few
  // KB, so the payload is padded past the limit explicitly.
  const oversized = await upload(admin, Buffer.concat([png(600, 400), Buffer.alloc(300_000)]), 'image/png', collection);
  assert.equal(oversized.status, 413, 'a body over the configured limit must be rejected by the server');

  // Dimensions over the limit are refused: a fully encoded, structurally valid file that is
  // simply too wide is rejected because of its size, not because of its structure.
  const huge = await upload(admin, png(2000, 10), 'image/png', collection);
  assert.equal(huge.status, 422);
  assert.match(String(huge.body.error?.message), /limit is 1200px/i);

  // Each rejection is recorded with a reason, and no blob was kept.
  const rejected = await handle.db
    .collection(COLLECTIONS.mediaAssets)
    .find({ collectionKey: collection })
    .toArray();
  assert.ok(rejected.length >= 5);
  assert.ok(rejected.every((asset) => asset.status === 'rejected' && asset.statusReason));
  assert.ok(rejected.every((asset) => asset.storageKey === null && asset.stagingKey === null));
});

test('D09 a valid upload persists, strips metadata, and survives a reload', async () => {
  const collection = 'listing-draft-1';

  const first = await upload(admin, png(320, 240, { text: 'GPS 25.2854,51.5310' }), 'image/png', collection);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const asset = first.body.asset as { assetId: string; status: string; position: number; isCover: boolean; image: { width: number; height: number } };
  assert.equal(asset.status, 'ready');
  assert.equal(asset.position, 0);
  assert.equal(asset.isCover, true, 'the first asset in a collection becomes the cover');
  assert.deepEqual(asset.image, { width: 320, height: 240 });

  // The stored bytes are real: the preview serves them, and the text chunk is gone.
  const preview = await admin.get(`/api/admin/media/${asset.assetId}/file`);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('content-type'), 'image/png');
  assert.equal(preview.headers.get('x-content-type-options'), 'nosniff');
  assert.match(String(preview.headers.get('content-security-policy')), /default-src 'none'/);
  const servedBytes = await fetch(`${baseUrl}/api/admin/media/${asset.assetId}/file`, {
    headers: { cookie: `sid=${admin.cookie('sid')}` },
  });
  const served = Buffer.from(await servedBytes.arrayBuffer());
  assert.ok(!served.includes(Buffer.from('GPS 25.2854', 'latin1')), 'metadata must not be served');
  assert.equal(served.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');

  const second = await upload(admin, jpeg(400, 300, { exif: true }), 'image/jpeg', collection);
  const third = await upload(admin, webp(200, 150, { exif: true }), 'image/webp', collection);
  assert.equal(second.status, 201);
  assert.equal(third.status, 201);
  assert.equal((second.body.asset as { position: number }).position, 1);
  assert.equal((third.body.asset as { position: number }).position, 2);
  assert.equal((third.body.asset as { isCover: boolean }).isCover, false);

  // Reload from the API: order and cover are persisted state, not client state.
  const listed = await admin.get(`/api/admin/media?collectionKey=${collection}`);
  assert.equal(listed.status, 200);
  const listedAssets = (listed.body as { assets: Array<{ assetId: string; position: number; isCover: boolean; status: string }> }).assets;
  assert.deepEqual(
    listedAssets.map((a) => a.position),
    [0, 1, 2],
  );
  assert.deepEqual(listedAssets.map((a) => a.isCover), [true, false, false]);
  const limits = (listed.body as { limit: { maxFiles: number; videoEnabled: boolean; allowedTypes: string[] } }).limit;
  assert.equal(limits.maxFiles, 3);
  assert.equal(limits.videoEnabled, false, 'video is explicitly unavailable');
  assert.deepEqual(limits.allowedTypes, ['image/jpeg', 'image/png', 'image/webp']);

  // Reorder and choose a new cover.
  const reordered = await admin.patch(`/api/admin/media/collection/${collection}/order`, {
    assetIds: [listedAssets[2]!.assetId, listedAssets[0]!.assetId, listedAssets[1]!.assetId],
  });
  assert.equal(reordered.status, 200, JSON.stringify(reordered.body));
  const cover = await admin.patch(`/api/admin/media/collection/${collection}/cover`, { assetId: listedAssets[1]!.assetId });
  assert.equal(cover.status, 200);

  const reloaded = await admin.get(`/api/admin/media?collectionKey=${collection}`);
  const after = (reloaded.body as { assets: Array<{ assetId: string; position: number; isCover: boolean }> }).assets;
  assert.deepEqual(after.map((a) => a.assetId), [listedAssets[2]!.assetId, listedAssets[0]!.assetId, listedAssets[1]!.assetId]);
  assert.deepEqual(after.map((a) => a.isCover), [false, false, true]);

  // Invalid operations.
  assert.equal(
    (await admin.patch(`/api/admin/media/collection/${collection}/order`, { assetIds: [listedAssets[0]!.assetId, listedAssets[0]!.assetId] })).status,
    422,
  );
  assert.equal(
    (await admin.patch(`/api/admin/media/collection/${collection}/order`, { assetIds: ['m_not-in-this-collection'] })).status,
    422,
  );
  assert.equal((await admin.patch(`/api/admin/media/collection/${collection}/cover`, { assetId: 'm_nope' })).status, 422);
});

test('D08 per-collection file count is enforced', async () => {
  const collection = 'count-limit';
  for (let index = 0; index < 3; index += 1) {
    const res = await upload(admin, png(60 + index, 60), 'image/png', collection);
    assert.equal(res.status, 201, `upload ${index} failed`);
  }
  const over = await upload(admin, png(64, 64), 'image/png', collection);
  assert.equal(over.status, 422);
  assert.match(String(over.body.error?.message), /maximum of 3 files/i);
});

test('D10 a storage failure is recorded as failed with a working retry', async () => {
  const collection = 'broken-storage';
  // Staging succeeds; the final promotion write fails — the realistic partial-outage case.
  const failing: MediaStorage = {
    driver: 'failing-promotion',
    put: async (key, bytes) => {
      if (key.startsWith('staging/')) return await storage.put(key, bytes);
      throw new Error('disk on fire');
    },
    get: (key) => storage.get(key),
    delete: (key) => storage.delete(key),
    exists: (key) => storage.exists(key),
  };
  const service = createMediaService({ db: handle.db, logger: silentLogger(), config, storage: failing, withTransaction: handle.withTransaction });

  const failed = await service
    .upload({
      bytes: png(80, 80),
      declaredMime: 'image/png',
      collectionKey: collection,
      actor: { reference: adminRef, requestId: 'test' },
    })
    .then(() => null)
    .catch((err: unknown) => err as { code?: string; details?: { assetId?: string } });
  assert.ok(failed, 'the upload must not silently succeed');
  assert.equal(failed!.code, 'SERVICE_UNAVAILABLE', 'a storage outage is retryable, not a validation failure');

  const record = await handle.db.collection(COLLECTIONS.mediaAssets).findOne({ collectionKey: collection });
  assert.ok(record, 'a failed upload is recorded so the operator can see it');
  assert.equal(record!.status, 'failed');
  assert.match(String(record!.statusReason), /storage/i);
  assert.ok(record!.stagingKey, 'the staged bytes are kept for a retry');

  // The failing asset cannot be served, and the API says so honestly.
  const preview = await admin.get(`/api/admin/media/${record!.assetId}/file`);
  assert.equal(preview.status, 404);

  // Retry through the API with working storage: the staged bytes are promoted.
  const retried = await fetch(`${baseUrl}/api/admin/media/${record!.assetId}/retry`, {
    method: 'POST',
    headers: {
      'x-csrf-token': admin.csrfToken() ?? '',
      cookie: `sid=${admin.cookie('sid')}; csrf=${admin.csrfToken()}`,
    },
  });
  assert.equal(retried.status, 200, await retried.clone().text());
  const retriedAsset = (await retried.json()) as { asset: { status: string } };
  assert.equal(retriedAsset.asset.status, 'ready');

  // Retrying something that is not failed is a conflict, not a silent no-op.
  const again = await fetch(`${baseUrl}/api/admin/media/${record!.assetId}/retry`, {
    method: 'POST',
    headers: {
      'x-csrf-token': admin.csrfToken() ?? '',
      cookie: `sid=${admin.cookie('sid')}; csrf=${admin.csrfToken()}`,
    },
  });
  assert.equal(again.status, 409);

  // Total outage: staging itself fails, so there is nothing staged and nothing to retry. The
  // record must still explain what happened rather than disappearing.
  const deadStorage: MediaStorage = {
    driver: 'dead',
    put: async () => {
      throw new Error('storage offline');
    },
    get: (key) => storage.get(key),
    delete: (key) => storage.delete(key),
    exists: (key) => storage.exists(key),
  };
  const unreachable = createMediaService({
    db: handle.db,
    logger: silentLogger(),
    config,
    storage: deadStorage,
    withTransaction: handle.withTransaction,
  });
  const outage = await unreachable
    .upload({
      bytes: png(50, 50),
      declaredMime: 'image/png',
      collectionKey: 'dead-storage',
      actor: { reference: adminRef, requestId: 'test' },
    })
    .then(() => null)
    .catch((err: unknown) => err as { code?: string });
  assert.equal(outage?.code, 'SERVICE_UNAVAILABLE', 'an unusable store is an outage, not a bad file');

  const outageRecord = await handle.db.collection(COLLECTIONS.mediaAssets).findOne({ collectionKey: 'dead-storage' });
  assert.equal(outageRecord?.status, 'failed', 'the failed attempt is recorded');
  assert.equal(outageRecord?.stagingKey, null, 'nothing was staged, so nothing can be promoted later');
  assert.match(String(outageRecord?.statusReason), /unavailable/i);

  const noRetry = await fetch(`${baseUrl}/api/admin/media/${outageRecord!.assetId}/retry`, {
    method: 'POST',
    headers: {
      'x-csrf-token': admin.csrfToken() ?? '',
      cookie: `sid=${admin.cookie('sid')}; csrf=${admin.csrfToken()}`,
    },
  });
  assert.equal(noRetry.status, 409, 'a retry with no staged copy is refused, not silently accepted');
});

test('D11 referenced media cannot be deleted, and safe orphans can be cleaned', async () => {
  const collection = 'reference-guard';
  const created = await upload(admin, png(100, 100), 'image/png', collection);
  const assetId = (created.body.asset as { assetId: string }).assetId;

  // Reference it the way a listing will in Phase 05.
  const service = createMediaService({ db: handle.db, logger: silentLogger(), config, storage, withTransaction: handle.withTransaction });
  await service.addReference({ assetId, ownerType: 'listing_draft', ownerId: 'listing-1', actor: adminRef });

  const blocked = await fetch(`${baseUrl}/api/admin/media/${assetId}`, {
    method: 'DELETE',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': admin.csrfToken() ?? '',
      cookie: `sid=${admin.cookie('sid')}; csrf=${admin.csrfToken()}`,
    },
    body: JSON.stringify({ reason: 'cleanup attempt' }),
  });
  assert.equal(blocked.status, 409);
  assert.match(String(((await blocked.json()) as { error: { message: string } }).error.message), /in use/i);
  assert.ok(await storage.exists((await handle.db.collection(COLLECTIONS.mediaAssets).findOne({ assetId }))!.storageKey!));

  // An unreferenced ready asset can be deleted, and its blob goes with it.
  const spare = await upload(admin, png(110, 110), 'image/png', 'reference-spare');
  const spareId = (spare.body.asset as { assetId: string }).assetId;
  const spareDoc = await handle.db.collection(COLLECTIONS.mediaAssets).findOne({ assetId: spareId });
  const deleted = await fetch(`${baseUrl}/api/admin/media/${spareId}`, {
    method: 'DELETE',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': admin.csrfToken() ?? '',
      cookie: `sid=${admin.cookie('sid')}; csrf=${admin.csrfToken()}`,
    },
    body: JSON.stringify({ reason: 'not needed' }),
  });
  assert.equal(deleted.status, 200);
  assert.equal(await storage.exists(spareDoc!.storageKey!), false, 'the blob must be gone');

  // Orphan cleanup: a stale staging record is collected, a referenced one is not.
  const stale = await handle.db.collection(COLLECTIONS.mediaAssets).insertOne({
    assetId: 'm_stale_staging',
    storageKey: null,
    stagingKey: 'staging/m_stale_staging',
    collectionKey: 'cleanup',
    position: 0,
    isCover: false,
    declaredMime: 'image/png',
    mime: null,
    bytes: 10,
    checksum: null,
    image: null,
    status: 'staging',
    statusReason: null,
    metadataStripped: false,
    source: 'upload',
    createdBy: adminRef,
    createdAt: new Date(Date.now() - 48 * 3_600_000),
    updatedAt: new Date(Date.now() - 48 * 3_600_000),
    deletedAt: null,
  });
  assert.ok(stale.insertedId);
  await storage.put('staging/m_stale_staging', Buffer.from('staged-bytes'));

  const dryRun = await admin.post('/api/admin/media/cleanup', { olderThanHours: 24, apply: false });
  assert.equal(dryRun.status, 200);
  assert.ok((dryRun.body as { candidates: string[] }).candidates.includes('m_stale_staging'));
  assert.deepEqual((dryRun.body as { removed: string[] }).removed, [], 'a dry run must not delete anything');
  assert.equal(await storage.exists('staging/m_stale_staging'), true);

  const applied = await admin.post('/api/admin/media/cleanup', { olderThanHours: 24, apply: true });
  assert.equal(applied.status, 200);
  assert.ok((applied.body as { removed: string[] }).removed.includes('m_stale_staging'));
  assert.equal(await storage.exists('staging/m_stale_staging'), false);
  assert.equal((await handle.db.collection(COLLECTIONS.mediaAssets).findOne({ assetId: 'm_stale_staging' }))!.status, 'deleted');
  assert.ok(
    !(applied.body as { removed: string[] }).removed.includes(assetId),
    'a referenced asset must never be treated as an orphan',
  );
});

test('D08 media bytes are never reachable without an authorized session', async () => {
  const collection = 'preview-guard';
  const created = await upload(admin, png(70, 70), 'image/png', collection);
  const assetId = (created.body.asset as { assetId: string }).assetId;

  assert.equal((await fetch(`${baseUrl}/api/admin/media/${assetId}/file`)).status, 401);
  assert.equal((await customer.get(`/api/admin/media/${assetId}/file`)).status, 403);
  assert.equal((await admin.get(`/api/admin/media/${assetId}/file`)).status, 200);

  const list = await admin.get(`/api/admin/media?collectionKey=${collection}`);
  const entry = (list.body as { assets: Array<{ url: string }> }).assets[0]!;
  assert.equal(entry.url, `/api/admin/media/${assetId}/file`, 'the only URL offered is the authorized endpoint');
});

test('the local filesystem adapter refuses to act in production without explicit opt-in', async () => {
  const productionStorage = createLocalStorage({ root: storageRoot, nodeEnv: 'production', allowInProduction: false });
  await assert.rejects(
    () => productionStorage.put('media/x.png', Buffer.from('x')),
    /not configured for this environment/,
  );
  const allowed = createLocalStorage({ root: storageRoot, nodeEnv: 'production', allowInProduction: true });
  await allowed.put('media/opt-in.png', Buffer.from('x'));
  assert.equal(await allowed.exists('media/opt-in.png'), true);
  await assert.rejects(() => allowed.put('../escape.png', Buffer.from('x')), /Unsafe storage key/);
});
