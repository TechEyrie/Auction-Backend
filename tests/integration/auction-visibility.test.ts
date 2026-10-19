/**
 * Auction products appear in public discovery/direct URL only while the clock is
 * inside [startsAt, endsAt). After the end, only the high bidder / winner can open them.
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
import { COLLECTIONS, ensureIndexes } from '../../src/db/indexes.ts';
import { startServer, type RunningServer } from '../../src/server.ts';
import { silentLogger } from '../helpers/context.ts';
import { TestClient } from '../helpers/client.ts';
import { createAdminFixture, createCustomerFixture } from '../helpers/authFixture.ts';
import { createLocalStorage, type MediaStorage } from '../../src/modules/media/storage.ts';
import { png } from '../helpers/images.ts';

let replSet: MongoMemoryReplSet;
let handle: DbHandle;
let running: RunningServer;
let config: AppConfig;
let baseUrl: string;
let admin: TestClient;
let winner: TestClient;
let stranger: TestClient;
let storageRoot: string;
let storage: MediaStorage;
let sellerReference = '';

const ADMIN_PHONE = '55558000';
const ADMIN_PW = 'auction visibility admin pw';
const BOOTSTRAP_TOKEN = 'auction-visibility-token';

before(async () => {
  replSet = await createReplSet();
  storageRoot = mkdtempSync(path.join(tmpdir(), 'araq-auction-vis-'));
  config = loadConfig({
    NODE_ENV: 'test',
    PORT: '0',
    MONGODB_URI: replSet.getUri(),
    MONGODB_DB: 'auction_visibility_test',
    CORS_ORIGINS: 'http://localhost:3000',
    LOG_LEVEL: 'error',
    MFA_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
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
    displayName: 'Visibility Seller',
    contact: { contactName: 'Visibility Seller', phone: '55558100' },
    address: { line1: 'Villa 1', locationKey: null, publicPrecision: 'city' },
  });
  assert.equal(seller.status, 201, JSON.stringify(seller.body));
  sellerReference = seller.body.seller.sellerReference;

  const clothesRoot = await admin.post('/api/admin/categories', {
    key: 'clothes-thobes',
    parentKey: null,
    nameEn: 'Clothes and Thobes',
    nameAr: 'ملابس وثياب',
    listingMethods: ['auction', 'fixed_price', 'enquiry'],
    active: true,
    order: 9,
  });
  assert.ok([201, 409].includes(clothesRoot.status), JSON.stringify(clothesRoot.body));

  winner = await createCustomerFixture({ baseUrl, phone: '55558101', password: 'winner password 1' });
  stranger = await createCustomerFixture({ baseUrl, phone: '55558102', password: 'stranger password 1' });
});

after(async () => {
  if (running) await running.stop();
  else if (handle) await handle.close();
  if (replSet) await replSet.stop();
  rmSync(storageRoot, { recursive: true, force: true });
});

async function publishAuctionListing(titleEn: string): Promise<string> {
  const created = await admin.post<{ listing: { listingReference: string; version: number } }>('/api/admin/listings', {
    sellerReference,
    categoryKey: 'clothes-thobes',
    listingMethod: 'auction',
    audience: 'men',
    languageMode: 'en',
    condition: 'used',
    title: { en: titleEn, ar: null },
    description: { en: 'Long enough description for an auction visibility listing.', ar: null },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const ref = created.body.listing.listingReference;

  const upload = await fetch(`${baseUrl}/api/admin/media/upload`, {
    method: 'POST',
    headers: {
      'content-type': 'image/png',
      'x-collection-key': `listing_${ref}`,
      'x-csrf-token': admin.csrfToken() ?? '',
      cookie: `sid=${admin.cookie('sid')}; csrf=${admin.csrfToken()}`,
    },
    body: new Uint8Array(png(32, 32)),
  });
  const uploadText = await upload.text();
  assert.equal(upload.status, 201, uploadText);
  const uploaded = JSON.parse(uploadText) as { asset: { assetId: string } };
  const assetId = uploaded.asset.assetId;

  const patched = await admin.patch<{ listing: { version: number } }>(`/api/admin/listings/${ref}`, {
    media: [{ assetId, alt: { en: 'Cover', ar: null } }],
    coverAssetId: assetId,
    expectedVersion: created.body.listing.version,
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));

  const published = await admin.post(`/api/admin/listings/${ref}/publish`, {
    expectedVersion: patched.body.listing.version,
  });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  return ref;
}

async function openLot(listingReference: string, startsAt: Date, endsAt: Date) {
  const created = await admin.post<{ auction: { lotReference: string } }>('/api/admin/auctions', {
    listingReference,
    startingBidMinor: 10_000,
    incrementMinor: 500,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const lot = created.body.auction.lotReference;
  const opened = await admin.post(`/api/admin/auctions/${lot}/open`);
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  return lot;
}

test('live auction inside the window is public; outside the window it disappears', async () => {
  const ref = await publishAuctionListing('Windowed auction jacket');
  const now = Date.now();
  const lot = await openLot(ref, new Date(now - 60_000), new Date(now + 120_000));

  const listed = await fetch(`${baseUrl}/api/listings?method=auction&limit=48`);
  assert.equal(listed.status, 200, await listed.clone().text());
  const liveBody = (await listed.json()) as { listings: Array<{ listingReference: string; liveLotReference: string | null }> };
  assert.ok(liveBody.listings.some((row) => row.listingReference === ref));
  assert.ok(liveBody.listings.some((row) => row.listingReference === ref && row.liveLotReference === lot));

  const detail = await fetch(`${baseUrl}/api/listings/${ref}`);
  assert.equal(detail.status, 200);

  // Force the lot past its end while leaving status live (worker lag).
  await handle.db.collection(COLLECTIONS.auctions).updateOne(
    { lotReference: lot },
    { $set: { endsAt: new Date(Date.now() - 5_000) } },
  );

  const gone = await fetch(`${baseUrl}/api/listings?method=auction&limit=48`);
  const goneBody = (await gone.json()) as { listings: Array<{ listingReference: string }> };
  assert.ok(!goneBody.listings.some((row) => row.listingReference === ref));

  const hidden = await fetch(`${baseUrl}/api/listings/${ref}`);
  assert.equal(hidden.status, 404);
});

test('scheduled lot that has reached its start time is already public', async () => {
  const ref = await publishAuctionListing('Scheduled-but-due jacket');
  const now = Date.now();
  // starts slightly in the future so open() stores status=scheduled…
  const lot = await openLot(ref, new Date(now + 2_000), new Date(now + 180_000));
  const row = await handle.db.collection(COLLECTIONS.auctions).findOne({ lotReference: lot });
  assert.equal(row?.status, 'scheduled');

  // …then move start into the past without promoting status (closer lag).
  await handle.db.collection(COLLECTIONS.auctions).updateOne(
    { lotReference: lot },
    { $set: { startsAt: new Date(Date.now() - 1_000) } },
  );

  const listed = await fetch(`${baseUrl}/api/listings?method=auction&limit=48`);
  assert.equal(listed.status, 200);
  const body = (await listed.json()) as { listings: Array<{ listingReference: string }> };
  assert.ok(body.listings.some((row) => row.listingReference === ref));

  const detail = await fetch(`${baseUrl}/api/listings/${ref}`);
  assert.equal(detail.status, 200);
});

test('reopening a sold listing clears availability so it returns to the catalogue', async () => {
  const ref = await publishAuctionListing('Resold jacket');
  const now = Date.now();
  const first = await openLot(ref, new Date(now - 60_000), new Date(now + 120_000));
  const bidAuction = await winner.get<{ auction: { version: number } }>(`/api/auctions/${first}`);
  assert.equal(bidAuction.status, 200);
  const bid = await winner.post(`/api/auctions/${first}/bids`, {
    amountMinor: 10_000,
    expectedVersion: bidAuction.body.auction.version,
  });
  assert.equal(bid.status, 201, JSON.stringify(bid.body));
  const closed = await admin.post(`/api/admin/auctions/${first}/close`, {
    reason: 'deadline reached',
    confirm: true,
  });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  const sold = await handle.db.collection(COLLECTIONS.listings).findOne({ listingReference: ref });
  assert.equal(sold?.availability, 'sold');

  const listedWhileSold = await fetch(`${baseUrl}/api/listings?method=auction&limit=48`);
  const soldBody = (await listedWhileSold.json()) as { listings: Array<{ listingReference: string }> };
  assert.ok(!soldBody.listings.some((row) => row.listingReference === ref));

  const second = await openLot(ref, new Date(Date.now() - 1_000), new Date(Date.now() + 180_000));
  void second;
  const reset = await handle.db.collection(COLLECTIONS.listings).findOne({ listingReference: ref });
  assert.equal(reset?.availability, 'available');

  const listedAgain = await fetch(`${baseUrl}/api/listings?method=auction&limit=48`);
  const againBody = (await listedAgain.json()) as { listings: Array<{ listingReference: string }> };
  assert.ok(againBody.listings.some((row) => row.listingReference === ref));
});

test('after the auction ends, only the high bidder can open the product', async () => {
  const ref = await publishAuctionListing('Winner-only payment jacket');
  const now = Date.now();
  const lot = await openLot(ref, new Date(now - 60_000), new Date(now + 180_000));

  const session = await winner.get('/api/auth/session');
  assert.equal(session.status, 200);
  const auction = await winner.get<{ auction: { version: number } }>(`/api/auctions/${lot}`);
  assert.equal(auction.status, 200);
  const bid = await winner.post(`/api/auctions/${lot}/bids`, {
    amountMinor: 10_000,
    expectedVersion: auction.body.auction.version,
  });
  assert.equal(bid.status, 201, JSON.stringify(bid.body));

  await handle.db.collection(COLLECTIONS.auctions).updateOne(
    { lotReference: lot },
    { $set: { endsAt: new Date(Date.now() - 2_000) } },
  );

  const strangerView = await stranger.get(`/api/listings/${ref}`);
  assert.equal(strangerView.status, 404);

  const anonymous = await fetch(`${baseUrl}/api/listings/${ref}`);
  assert.equal(anonymous.status, 404);

  const winnerView = await winner.get<{ listing: { listingReference: string } }>(`/api/listings/${ref}`);
  assert.equal(winnerView.status, 200, JSON.stringify(winnerView.body));
  assert.equal(winnerView.body.listing.listingReference, ref);

  // Close creates the order; winner still sees the product to pay.
  const closed = await admin.post(`/api/admin/auctions/${lot}/close`, { reason: 'deadline reached', confirm: true });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));

  const afterCloseStranger = await stranger.get(`/api/listings/${ref}`);
  assert.equal(afterCloseStranger.status, 404);

  const afterCloseWinner = await winner.get(`/api/listings/${ref}`);
  assert.equal(afterCloseWinner.status, 200);
});
