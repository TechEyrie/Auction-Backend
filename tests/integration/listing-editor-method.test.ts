/**
 * Product-editor contract: create with explicit listingMethod, fixed_price price rules,
 * and auction ↔ fixed_price switches (the bug that blocked photo upload).
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createReplSet } from '../helpers/mongo.ts';
import { loadConfig, type AppConfig } from '../../src/config/index.ts';
import { connectDb, type DbHandle } from '../../src/db/connection.ts';
import { ensureIndexes } from '../../src/db/indexes.ts';
import { startServer, type RunningServer } from '../../src/server.ts';
import { silentLogger } from '../helpers/context.ts';
import { TestClient } from '../helpers/client.ts';
import { createAdminFixture } from '../helpers/authFixture.ts';
import { createLocalStorage, type MediaStorage } from '../../src/modules/media/storage.ts';
import { jpeg } from '../helpers/images.ts';

let replSet: MongoMemoryReplSet;
let handle: DbHandle;
let running: RunningServer;
let config: AppConfig;
let baseUrl: string;
let admin: TestClient;
let storageRoot: string;
let storage: MediaStorage;
let sellerReference = '';

const ADMIN_PHONE = '55557000';
const ADMIN_PW = 'editor method admin pw';
const BOOTSTRAP_TOKEN = 'editor-method-token';

before(async () => {
  replSet = await createReplSet();
  storageRoot = mkdtempSync(path.join(tmpdir(), 'araq-editor-method-'));
  config = loadConfig({
    NODE_ENV: 'test',
    PORT: '0',
    MONGODB_URI: replSet.getUri(),
    MONGODB_DB: 'editor_method_test',
    CORS_ORIGINS: 'http://localhost:3000',
    LOG_LEVEL: 'error',
    MFA_ENCRYPTION_KEY: Buffer.alloc(32, 12).toString('base64'),
    ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
    MEDIA_STORAGE_ROOT: storageRoot,
    MEDIA_MAX_BYTES: '400000',
    MEDIA_MAX_DIMENSION: '1600',
    MEDIA_MAX_FILES_PER_COLLECTION: '8',
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

  const seller = await admin.post<{ seller: { sellerReference: string } }>('/api/admin/sellers', {
    type: 'individual',
    displayName: 'Editor Method Seller',
    contact: { contactName: 'Editor Method Seller', phone: '55557100' },
    address: { line1: 'Villa 1', locationKey: null, publicPrecision: 'city' },
  });
  assert.equal(seller.status, 201, JSON.stringify(seller.body));
  sellerReference = seller.body.seller.sellerReference;

  const category = await admin.post('/api/admin/categories', {
    key: 'clothing',
    parentKey: null,
    nameEn: 'Clothing',
    nameAr: 'ملابس',
    listingMethods: ['auction', 'fixed_price', 'enquiry'],
    active: true,
    order: 1,
  });
  assert.ok([201, 409].includes(category.status), JSON.stringify(category.body));
});

after(async () => {
  if (running) await running.stop();
  else if (handle) await handle.close();
  if (replSet) await replSet.stop();
  rmSync(storageRoot, { recursive: true, force: true });
});

test('create as auction without price succeeds (photo-upload create path)', async () => {
  const created = await admin.post<{ listing: { listingReference: string; listingMethod: string; priceMinor: number | null } }>(
    '/api/admin/listings',
    {
      sellerReference,
      categoryKey: 'clothing',
      listingMethod: 'auction',
      audience: 'men',
      priceMinor: null,
    },
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.listing.listingMethod, 'auction');
  assert.equal(created.body.listing.priceMinor, null);
});

test('create as fixed_price without price is rejected', async () => {
  const created = await admin.post('/api/admin/listings', {
    sellerReference,
    categoryKey: 'clothing',
    listingMethod: 'fixed_price',
    audience: 'women',
    priceMinor: null,
  });
  assert.equal(created.status, 422);
  assert.match(JSON.stringify(created.body), /priceMinor/);
});

test('switch fixed_price → auction clears price and media upload works', async () => {
  const created = await admin.post<{ listing: { listingReference: string; version: number } }>('/api/admin/listings', {
    sellerReference,
    categoryKey: 'clothing',
    listingMethod: 'fixed_price',
    audience: 'men',
    priceMinor: 45000,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const ref = created.body.listing.listingReference;

  const switched = await admin.patch<{ listing: { listingMethod: string; priceMinor: number | null; version: number } }>(
    `/api/admin/listings/${ref}`,
    {
      listingMethod: 'auction',
      priceMinor: null,
      title: { en: 'Switched to auction', ar: null },
      description: { en: 'Long enough description for the ad copy.', ar: null },
      languageMode: 'en',
      condition: 'used',
      audience: 'men',
      expectedVersion: created.body.listing.version,
    },
  );
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  assert.equal(switched.body.listing.listingMethod, 'auction');
  assert.equal(switched.body.listing.priceMinor, null);

  const synced = await admin.patch(`/api/admin/listings/${ref}`, {
    listingMethod: 'auction',
    priceMinor: null,
    media: [],
    coverAssetId: null,
    expectedVersion: switched.body.listing.version,
  });
  assert.equal(synced.status, 200, JSON.stringify(synced.body));

  const upload = await fetch(`${baseUrl}/api/admin/media/upload`, {
    method: 'POST',
    headers: {
      'content-type': 'image/jpeg',
      'x-collection-key': `listing_${ref}`,
      'x-csrf-token': admin.csrfToken() ?? '',
      cookie: `sid=${admin.cookie('sid')}; csrf=${admin.csrfToken()}`,
    },
    body: new Uint8Array(jpeg(80, 60)),
  });
  assert.equal(upload.status, 201, await upload.text());
});
