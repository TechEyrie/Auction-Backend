/**
 * Public auction calendar: Qatar-month grouping by parent category and published listing visibility.
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
import { createAdminFixture } from '../helpers/authFixture.ts';
import { createLocalStorage, type MediaStorage } from '../../src/modules/media/storage.ts';
import { png } from '../helpers/images.ts';

let replSet: MongoMemoryReplSet;
let handle: DbHandle;
let running: RunningServer;
let config: AppConfig;
let baseUrl: string;
let admin: TestClient;
let storageRoot: string;
let storage: MediaStorage;
let sellerReference = '';

const ADMIN_PHONE = '55559000';
const ADMIN_PW = 'auction calendar admin pw';
const BOOTSTRAP_TOKEN = 'auction-calendar-token';

const CAL_YEAR = 2026;
const CAL_MONTH = 10;
const OCT_15_EARLY = '2026-10-15T08:00:00.000Z';
const OCT_15_LATE = '2026-10-15T20:00:00.000Z';
const OCT_20 = '2026-10-20T12:00:00.000Z';

before(async () => {
  replSet = await createReplSet();
  storageRoot = mkdtempSync(path.join(tmpdir(), 'araq-auction-cal-'));
  config = loadConfig({
    NODE_ENV: 'test',
    PORT: '0',
    MONGODB_URI: replSet.getUri(),
    MONGODB_DB: 'auction_calendar_test',
    CORS_ORIGINS: 'http://localhost:3000',
    LOG_LEVEL: 'error',
    MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
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
    displayName: 'Calendar Seller',
    contact: { contactName: 'Calendar Seller', phone: '55559100' },
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
    description: { en: 'Long enough description for an auction calendar listing.', ar: null },
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

  const patched = await admin.patch<{ listing: { version: number } }>(`/api/admin/listings/${ref}`, {
    media: [{ assetId: uploaded.asset.assetId, alt: { en: 'Cover', ar: null } }],
    coverAssetId: uploaded.asset.assetId,
    expectedVersion: created.body.listing.version,
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));

  const published = await admin.post(`/api/admin/listings/${ref}/publish`, {
    expectedVersion: patched.body.listing.version,
  });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  return ref;
}

async function scheduleLot(listingReference: string, startsAt: string, endsAt: string): Promise<string> {
  const created = await admin.post<{ auction: { lotReference: string } }>('/api/admin/auctions', {
    listingReference,
    startingBidMinor: 10_000,
    incrementMinor: 500,
    startsAt,
    endsAt,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const lot = created.body.auction.lotReference;
  const opened = await admin.post(`/api/admin/auctions/${lot}/open`);
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  return lot;
}

function calendarUrl(query = ''): string {
  const qs = query || `year=${CAL_YEAR}&month=${CAL_MONTH}&locale=en`;
  return `${baseUrl}/api/auction-calendar?${qs}`;
}

test('scheduled lot with future startsAt appears on calendar but not in auction listings', async () => {
  const ref = await publishAuctionListing('Future start calendar lot');
  const startsAt = '2026-10-25T12:00:00.000Z';
  const endsAt = '2026-10-28T12:00:00.000Z';
  await scheduleLot(ref, startsAt, endsAt);

  const cal = await fetch(calendarUrl());
  assert.equal(cal.status, 200, await cal.clone().text());
  assert.match(cal.headers.get('cache-control') ?? '', /public,\s*max-age=60/);
  const body = (await cal.json()) as {
    days: Array<{
      date: string;
      groups: Array<{ parentCategoryKey: string; listingCount: number; live: boolean }>;
    }>;
  };
  const day = body.days.find((row) => row.date === '2026-10-28');
  assert.ok(day, JSON.stringify(body.days));
  const clothesGroup = day.groups.find((g) => g.parentCategoryKey === 'clothes-thobes' && g.listingCount === 1);
  assert.ok(clothesGroup);
  assert.equal(typeof clothesGroup.live, 'boolean');
  assert.equal(clothesGroup.live, false);

  const listed = await fetch(`${baseUrl}/api/listings?method=auction&limit=48`);
  assert.equal(listed.status, 200);
  const listings = (await listed.json()) as { listings: Array<{ listingReference: string }> };
  assert.ok(!listings.listings.some((row) => row.listingReference === ref));
});

test('closed and unpublished listings are excluded from the calendar', async () => {
  const closedRef = await publishAuctionListing('Closed calendar lot');
  const closedLot = await scheduleLot(closedRef, '2026-10-01T00:00:00.000Z', OCT_15_EARLY);
  const closed = await admin.post(`/api/admin/auctions/${closedLot}/close`, {
    reason: 'test closure',
    confirm: true,
  });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));

  const draftCreated = await admin.post<{ listing: { listingReference: string } }>('/api/admin/listings', {
    sellerReference,
    categoryKey: 'clothes-thobes',
    listingMethod: 'auction',
    audience: 'men',
    languageMode: 'en',
    condition: 'used',
    title: { en: 'Draft calendar lot', ar: null },
    description: { en: 'Long enough description for draft calendar listing.', ar: null },
  });
  assert.equal(draftCreated.status, 201);
  const draftRef = draftCreated.body.listing.listingReference;
  await scheduleLot(draftRef, '2026-10-01T00:00:00.000Z', OCT_15_LATE);

  const cal = await fetch(calendarUrl());
  const body = (await cal.json()) as {
    days: Array<{ date: string; groups: Array<{ listingCount: number }> }>;
  };
  const oct15 = body.days.find((row) => row.date === '2026-10-15');
  if (oct15) {
    const total = oct15.groups.reduce((sum, g) => sum + g.listingCount, 0);
    assert.equal(total, 0);
  }
});

test('two published lots same parent and Qatar day aggregate with min endsAt', async () => {
  const refA = await publishAuctionListing('Calendar pair A');
  const refB = await publishAuctionListing('Calendar pair B');
  await scheduleLot(refA, '2026-10-01T00:00:00.000Z', OCT_15_EARLY);
  await scheduleLot(refB, '2026-10-01T00:00:00.000Z', OCT_15_LATE);

  const cal = await fetch(calendarUrl());
  assert.equal(cal.status, 200);
  const body = (await cal.json()) as {
    days: Array<{
      date: string;
      groups: Array<{
        parentCategoryKey: string;
        imageUrl: string | null;
        listingCount: number;
        endsAt: string;
        live: boolean;
      }>;
    }>;
  };
  const day = body.days.find((row) => row.date === '2026-10-15');
  assert.ok(day, JSON.stringify(body.days));
  const group = day.groups.find((g) => g.parentCategoryKey === 'clothes-thobes');
  assert.ok(group);
  assert.equal(group.listingCount, 2);
  assert.equal(group.endsAt, OCT_15_EARLY);
  assert.equal(group.imageUrl, null);
  assert.equal(group.live, false);
});

test('calendar group imageUrl points at public category photo when set', async () => {
  const bytes = png(48, 40);
  const upload = await fetch(`${baseUrl}/api/admin/categories/clothes-thobes/image`, {
    method: 'POST',
    headers: {
      'content-type': 'image/png',
      'x-csrf-token': admin.csrfToken() ?? '',
      cookie: `sid=${admin.cookie('sid')}; csrf=${admin.csrfToken()}`,
    },
    body: new Uint8Array(bytes),
  });
  assert.equal(upload.status, 201, await upload.text());

  const ref = await publishAuctionListing('Category photo calendar lot');
  await scheduleLot(ref, '2026-10-01T00:00:00.000Z', OCT_20);

  const cal = await fetch(calendarUrl());
  assert.equal(cal.status, 200);
  const body = (await cal.json()) as {
    days: Array<{ date: string; groups: Array<{ parentCategoryKey: string; imageUrl: string | null }> }>;
  };
  const day = body.days.find((row) => row.date === '2026-10-20');
  assert.ok(day);
  const group = day!.groups.find((g) => g.parentCategoryKey === 'clothes-thobes');
  assert.ok(group);
  assert.equal(group!.imageUrl, '/api/catalog/categories/clothes-thobes/image');
});

test('invalid month returns 422', async () => {
  const res = await fetch(calendarUrl(`year=${CAL_YEAR}&month=13`));
  assert.equal(res.status, 422);
});
