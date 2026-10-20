/**
 * Phase 05 integration coverage — listings, the wizard's backend contract, publication,
 * public discovery and the public media boundary.
 *
 * Everything runs against a real replica-set MongoDB and a real HTTP server. Optimistic
 * concurrency, unique references and archive/visibility behaviour are only proven by real
 * conditional writes against real indexes, so nothing here is mocked at the domain boundary.
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
import { jpeg, png, webp } from '../helpers/images.ts';
import { createLocalStorage, type MediaStorage } from '../../src/modules/media/storage.ts';

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

const ADMIN_PHONE = '55556000';
const ADMIN_PW = 'listings admin pw 1';
const BOOTSTRAP_TOKEN = 'listings-integration-token';
const CUSTOMER_PHONE = '55556001';
const CUSTOMER_PW = 'Listings-Integration-Pw-2026!9x';

/** Fixture world, created once: sellers, taxonomy, schemas and locations. */
const world = {
  seller: '',
  verifiedSeller: '',
  carsVersion: 0,
  electronicsVersion: 0,
  changeVersion: 0,
  inactiveLocation: 'qa-alwakrah-alwakrah',
  cityLocation: 'qa-doha-doha',
  areaLocation: 'qa-doha-al-sadd',
  westBayLocation: 'qa-doha-west-bay',
};

before(async () => {
  replSet = await createReplSet();
  storageRoot = mkdtempSync(path.join(tmpdir(), 'araq-listings-'));
  config = loadConfig({
    NODE_ENV: 'test',
    PORT: '0',
    MONGODB_URI: replSet.getUri(),
    MONGODB_DB: 'listings_test',
    CORS_ORIGINS: 'http://localhost:3000',
    LOG_LEVEL: 'error',
    MFA_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString('base64'),
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
  adminRef = fixture.publicReference;
  customer = await createCustomerFixture({ baseUrl, phone: CUSTOMER_PHONE, password: CUSTOMER_PW });

  world.seller = await createSeller({ displayName: 'Inventory Seller', phone: '55556100' });
  world.verifiedSeller = await createSeller({ displayName: 'Verified Seller', phone: '55556101' });
  await admin.patch(`/api/admin/sellers/${world.verifiedSeller}/verification`, {
    state: 'verified',
    reason: 'QID and CR checked in person',
    evidence: [{ kind: 'qid', reference: 'QID-9001-2026' }],
  });

  await createCategory({ key: 'vehicles', parentKey: null, nameEn: 'Vehicles', listingMethods: ['auction', 'fixed_price'] });
  await createCategory({ key: 'cars', parentKey: 'vehicles', nameEn: 'Cars', listingMethods: ['auction', 'fixed_price'] });
  await createCategory({ key: 'sedans', parentKey: 'cars', nameEn: 'Sedans', listingMethods: ['auction'] });
  await createCategory({ key: 'electronics', parentKey: null, nameEn: 'Electronics', listingMethods: ['auction', 'fixed_price', 'enquiry'] });
  await createCategory({ key: 'services', parentKey: null, nameEn: 'Services', listingMethods: ['enquiry'] });
  await createCategory({ key: 'retired-cat', parentKey: null, nameEn: 'Retired', listingMethods: ['auction'] });
  await createCategory({ key: 'change-cat', parentKey: null, nameEn: 'Changing schema', listingMethods: ['auction'] });
  await createCategory({ key: 'clothes-thobes', parentKey: null, nameEn: 'Clothes and Thobes', listingMethods: ['auction', 'fixed_price', 'enquiry'] });
  await createCategory({ key: 'perfume', parentKey: null, nameEn: 'Perfume', listingMethods: ['auction', 'fixed_price', 'enquiry'] });

  const catalogueLeafFields = [
    { key: 'item_condition', type: 'select', labelEn: 'Condition', required: true, options: [{ key: 'new', labelEn: 'New' }, { key: 'used', labelEn: 'Used' }] },
    { key: 'brand_name', type: 'text', labelEn: 'Brand' },
  ];
  await publishSchema('clothes-thobes', catalogueLeafFields);
  await publishSchema('perfume', catalogueLeafFields);

  world.carsVersion = await publishSchema('cars', [
    { key: 'make', type: 'select', labelEn: 'Make', required: true, filterable: true, options: [{ key: 'toyota', labelEn: 'Toyota' }, { key: 'nissan', labelEn: 'Nissan' }] },
    { key: 'model', type: 'text', labelEn: 'Model', required: true, constraints: { minLength: 2, maxLength: 60 } },
    { key: 'colour', type: 'select', labelEn: 'Colour', options: [{ key: 'white', labelEn: 'White' }, { key: 'black', labelEn: 'Black' }] },
    { key: 'mileage_km', type: 'number', labelEn: 'Mileage', unit: 'km', constraints: { min: 0, max: 999999, integer: true } },
    { key: 'internal_grade', type: 'text', labelEn: 'Internal grade', adminOnly: true },
  ]);
  world.electronicsVersion = await publishSchema('electronics', [
    { key: 'brand', type: 'select', labelEn: 'Brand', required: true, options: [{ key: 'apple', labelEn: 'Apple' }, { key: 'samsung', labelEn: 'Samsung' }] },
    { key: 'model', type: 'text', labelEn: 'Model' },
    { key: 'warranty_months', type: 'number', labelEn: 'Warranty', constraints: { min: 0, max: 60, integer: true } },
  ]);
  world.changeVersion = await publishSchema('change-cat', [{ key: 'spec', type: 'text', labelEn: 'Specification' }]);

  await createLocation({ countryCode: 'QA', cityKey: 'doha', areaKey: 'al-sadd', labelEn: 'Al Sadd, Doha', publicPrecision: 'area' });
  await createLocation({ countryCode: 'QA', cityKey: 'doha', areaKey: 'west-bay', labelEn: 'West Bay, Doha', publicPrecision: 'area' });
  await createLocation({ countryCode: 'QA', cityKey: 'doha', areaKey: 'doha', labelEn: 'Doha', publicPrecision: 'city' });
  await createLocation({ countryCode: 'QA', cityKey: 'alwakrah', areaKey: 'alwakrah', labelEn: 'Al Wakrah', publicPrecision: 'city' });
});

after(async () => {
  if (running) await running.stop();
  else if (handle) await handle.close();
  if (replSet) await replSet.stop();
  rmSync(storageRoot, { recursive: true, force: true });
});

async function createSeller(body: { displayName: string; phone: string }): Promise<string> {
  const res = await admin.post('/api/admin/sellers', {
    type: 'individual',
    displayName: body.displayName,
    contact: { contactName: body.displayName, phone: body.phone },
    address: { line1: 'Villa 1, Street 1', locationKey: null, publicPrecision: 'city' },
    internalNotes: 'Private negotiation note that must never reach the public DTO',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return (res.body as { seller: { sellerReference: string } }).seller.sellerReference;
}

async function createCategory(body: Record<string, unknown>): Promise<void> {
  const res = await admin.post('/api/admin/categories', body);
  assert.ok([201, 409].includes(res.status), `category ${String(body.key)}: ${JSON.stringify(res.body)}`);
}

async function publishSchema(categoryKey: string, fields: unknown[]): Promise<number> {
  const created = await admin.post('/api/admin/attribute-schemas', { categoryKey, fields });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const schema = (created.body as { schema: { _id: string; version: number } }).schema;
  const published = await admin.post(`/api/admin/attribute-schemas/${schema._id}/publish`, {});
  assert.equal(published.status, 200, JSON.stringify(published.body));
  return schema.version;
}

async function createLocation(body: Record<string, unknown>): Promise<void> {
  const res = await admin.post('/api/admin/locations', body);
  assert.ok([201, 409].includes(res.status), JSON.stringify(res.body));
}

type UploadResult = { status: number; body: { asset?: { assetId: string; status: string }; error?: { message: string } } };

/** Raw-body upload, exactly how the wizard sends a file. */
async function upload(collectionKey: string, bytes: Buffer, contentType = 'image/png'): Promise<UploadResult> {
  const res = await fetch(`${baseUrl}/api/admin/media/upload`, {
    method: 'POST',
    headers: {
      'content-type': contentType,
      'x-collection-key': collectionKey,
      'x-csrf-token': admin.csrfToken() ?? '',
      cookie: `sid=${admin.cookie('sid')}; csrf=${admin.csrfToken()}`,
    },
    body: new Uint8Array(bytes),
  });
  return { status: res.status, body: (await res.json()) as UploadResult['body'] };
}

type ListingDto = {
  listingReference: string;
  status: string;
  version: number;
  languageMode: string;
  title: { en: string | null; ar: string | null };
  description: { en: string | null; ar: string | null };
  attributes: Record<string, unknown>;
  attributeSchemaVersion: number | null;
  category: { key: string; path: string[] };
  location: { countryCode: string | null; cityKey: string | null; areaKey: string | null; label: string | null; publicPrecision: string };
  locationKey: string | null;
  media: Array<{ assetId: string; position: number; url: string | null; mediaStatus: string }>;
  coverAssetId: string | null;
  mediaCollectionKey: string;
  adminNotes: string | null;
  moderation: { state: string; note: string | null };
  createdBy: string;
  publishedBy: string | null;
  archivedReason: string | null;
  publishedAt: string | null;
  publicUrl: string;
  featured: boolean;
  seller: { sellerReference: string; displayName: string; verificationBadge: boolean };
};

async function createDraft(overrides: Record<string, unknown> = {}): Promise<ListingDto> {
  const res = await admin.post('/api/admin/listings', {
    sellerReference: world.seller,
    categoryKey: 'cars',
    listingMethod: 'auction',
    languageMode: 'en',
    audience: 'men',
    title: { en: 'Draft listing' },
    description: { en: 'A draft description that is comfortably long.' },
    attributes: { make: 'toyota', model: 'Corolla' },
    locationKey: world.cityLocation,
    ...overrides,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return (res.body as { listing: ListingDto }).listing;
}

function patchListing(ref: string, body: Record<string, unknown>) {
  return admin.patch(`/api/admin/listings/${ref}`, body);
}

async function attachMedia(ref: string, version: number, assetIds: string[]) {
  return patchListing(ref, {
    media: assetIds.map((assetId) => ({ assetId, alt: { en: `Photo of the item ${assetId}` } })),
    coverAssetId: assetIds[0] ?? null,
    expectedVersion: version,
  });
}

/** create → upload → attach → publish, the path the wizard takes. */
async function createPublishedListing(options: {
  categoryKey?: string;
  titleEn: string;
  titleAr?: string | null;
  languageMode?: string;
  sellerReference?: string;
  locationKey?: string | null;
  listingMethod?: string;
  attributes?: Record<string, unknown>;
  featured?: boolean;
  image?: Buffer;
  imageType?: string;
  audience?: string;
  priceMinor?: number;
}): Promise<{ reference: string; assetId: string; version: number }> {
  const draft = await createDraft({
    ...(options.categoryKey ? { categoryKey: options.categoryKey } : {}),
    ...(options.audience ? { audience: options.audience } : {}),
    ...(options.languageMode ? { languageMode: options.languageMode } : {}),
    ...(options.sellerReference ? { sellerReference: options.sellerReference } : {}),
    ...(options.listingMethod ? { listingMethod: options.listingMethod } : {}),
    ...(options.listingMethod === 'fixed_price' ? { priceMinor: options.priceMinor ?? 45_000 } : {}),
    ...(options.attributes ? { attributes: options.attributes } : {}),
    ...(options.featured !== undefined ? { featured: options.featured } : {}),
    ...(options.locationKey !== undefined ? { locationKey: options.locationKey } : {}),
    title: options.titleAr ? { en: options.titleEn, ar: options.titleAr } : { en: options.titleEn },
    description: { en: `Full description for ${options.titleEn} so it passes validation.` },
  });
  const uploaded = await upload(`listing_${draft.listingReference}`, options.image ?? png(48, 36), options.imageType ?? 'image/png');
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  const assetId = uploaded.body.asset!.assetId;
  const attached = await attachMedia(draft.listingReference, draft.version, [assetId]);
  assert.equal(attached.status, 200, JSON.stringify(attached.body));
  const version = (attached.body as { listing: ListingDto }).listing.version;
  const published = await admin.post(`/api/admin/listings/${draft.listingReference}/publish`, { expectedVersion: version });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const listing = (published.body as { listing: ListingDto }).listing;
  return { reference: listing.listingReference, assetId, version: listing.version };
}

async function publicListing(ref: string): Promise<{ status: number; body: { listing?: Record<string, unknown>; error?: { code: string; message: string } } }> {
  const res = await fetch(`${baseUrl}/api/listings/${ref}`);
  return { status: res.status, body: (await res.json()) as never };
}

async function publicMedia(ref: string, assetId: string) {
  const res = await fetch(`${baseUrl}/api/listings/${ref}/media/${assetId}/file`);
  return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
}

// ---------------------------------------------------------------------------
// E01 — drafts, autosave and optimistic concurrency
// ---------------------------------------------------------------------------

test('P05-E01 a draft is persisted, versioned and survives reload', async () => {
  const draft = await createDraft({
    title: { en: 'Reload probe' },
    adminNotes: 'Private staff note',
    attributes: { make: 'toyota', model: 'Hilux', mileage_km: 120000, internal_grade: 'B' },
  });
  assert.match(draft.listingReference, /^l_[A-Za-z0-9_-]{6,32}$/);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.version, 1);
  assert.equal(draft.createdBy, adminRef);
  assert.equal(draft.mediaCollectionKey, `listing_${draft.listingReference}`);
  assert.equal(draft.attributeSchemaVersion, world.carsVersion);

  const saved = await patchListing(draft.listingReference, {
    title: { en: 'Reload probe v2' },
    attributes: { make: 'toyota', model: 'Hilux', mileage_km: 121000, internal_grade: 'B' },
    expectedVersion: 1,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const savedListing = (saved.body as { listing: ListingDto }).listing;
  assert.equal(savedListing.version, 2);

  // A fresh read (the "reload" half of the wizard) returns exactly what was written.
  const reloaded = await admin.get(`/api/admin/listings/${draft.listingReference}`);
  assert.equal(reloaded.status, 200);
  const listing = (reloaded.body as { listing: ListingDto }).listing;
  assert.equal(listing.title.en, 'Reload probe v2');
  assert.equal(listing.attributes.model, 'Hilux');
  assert.equal(listing.attributes.internal_grade, 'B');
  assert.equal(listing.adminNotes, 'Private staff note');
  assert.equal(listing.version, 2);

  // Several autosaves update the same document; they never create a second draft.
  for (let i = 3; i <= 5; i += 1) {
    const res = await patchListing(draft.listingReference, { title: { en: `Reload probe v${i}` }, expectedVersion: i - 1 });
    assert.equal(res.status, 200);
  }
  const documents = await handle.db.collection(COLLECTIONS.listings).countDocuments({ listingReference: draft.listingReference });
  assert.equal(documents, 1, 'autosave must update one draft, never accumulate them');
  assert.equal((await handle.db.collection(COLLECTIONS.listings).countDocuments({})), 1);
});

test('P05-E01 a stale autosave conflicts instead of overwriting newer work', async () => {
  const draft = await createDraft({ title: { en: 'Conflict probe' } });

  // A second editor saved first: the version the first editor read is now stale.
  const first = await patchListing(draft.listingReference, { title: { en: 'Editor A wins' }, expectedVersion: 1 });
  assert.equal(first.status, 200);

  const stale = await patchListing(draft.listingReference, { title: { en: 'Editor B overwrites' }, expectedVersion: 1 });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  const error = (stale.body as { error: { code: string; message: string; details: { currentVersion: number; reloadRequired: boolean } } }).error;
  assert.equal(error.code, 'CONFLICT');
  assert.equal(error.details.currentVersion, 2);
  assert.equal(error.details.reloadRequired, true);

  const stored = await handle.db.collection(COLLECTIONS.listings).findOne({ listingReference: draft.listingReference });
  assert.equal(stored?.title.en, 'Editor A wins', 'a stale write must not change stored content');
  assert.equal(stored?.version, 2);
});

test('P05-E01 simultaneous autosaves cannot both win', async () => {
  const draft = await createDraft({ title: { en: 'Race probe' } });
  const [left, right] = await Promise.all([
    patchListing(draft.listingReference, { title: { en: 'Race editor left' }, expectedVersion: draft.version }),
    patchListing(draft.listingReference, { title: { en: 'Race editor right' }, expectedVersion: draft.version }),
  ]);
  const statuses = [left.status, right.status].sort();
  assert.deepEqual(statuses, [200, 409], `exactly one writer may win (got ${statuses.join('/')})`);

  const stored = await handle.db.collection(COLLECTIONS.listings).findOne({ listingReference: draft.listingReference });
  assert.equal(stored?.version, 2, 'a losing write must not bump the version');
  const winner = left.status === 200 ? 'Race editor left' : 'Race editor right';
  assert.equal(stored?.title.en, winner, 'stored content must be the winning editor’s, not a blend');
});

test('P05-E01 a failed save changes nothing and is never reported as saved', async () => {
  const draft = await createDraft({ title: { en: 'Failure probe' }, attributes: { make: 'toyota', model: 'Camry' } });

  const rejected = await patchListing(draft.listingReference, {
    title: { en: 'Failure probe edited' },
    attributes: { make: 'toyota', model: 'Camry', colour_unknown_field: 'white' },
    expectedVersion: 1,
  });
  assert.equal(rejected.status, 422, JSON.stringify(rejected.body));
  const fieldErrors = (rejected.body as { error: { fieldErrors: Record<string, string> } }).error.fieldErrors;
  assert.match(Object.keys(fieldErrors).join(','), /attributes\.colour_unknown_field/);

  const stored = await handle.db.collection(COLLECTIONS.listings).findOne({ listingReference: draft.listingReference });
  assert.equal(stored?.version, 1, 'a rejected save must not advance the version');
  assert.equal(stored?.title.en, 'Failure probe', 'a rejected save must not write any field');
  assert.equal(Object.keys(stored?.attributes ?? {}).includes('colour_unknown_field'), false);

  // An invalid option value is refused by the server, not by trusting the form.
  const badValue = await patchListing(draft.listingReference, { attributes: { make: 'honda', model: 'Camry' }, expectedVersion: 1 });
  assert.equal(badValue.status, 422);

  // An oversized page limit on the admin list is refused rather than silently clamped.
  assert.equal((await admin.get('/api/admin/listings?limit=500')).status, 422);
});

test('P05-E01 client-supplied lifecycle fields are ignored, not trusted', async () => {
  const created = await admin.post('/api/admin/listings', {
    sellerReference: world.seller,
    categoryKey: 'cars',
    title: { en: 'Protected field probe' },
    description: { en: 'Attempting to self-publish through the body.' },
    attributes: { make: 'toyota', model: 'Yaris' },
    locationKey: null,
    status: 'published',
    publishedBy: 'attacker',
    publishedAt: '2001-01-01T00:00:00.000Z',
    archivedBy: 'attacker',
    version: 99,
    createdBy: 'attacker',
    moderation: { state: 'blocked', note: 'nope' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const listing = (created.body as { listing: ListingDto }).listing;
  assert.equal(listing.status, 'draft');
  assert.equal(listing.publishedBy, null);
  assert.equal(listing.publishedAt, null);
  assert.equal(listing.version, 1);
  assert.equal(listing.createdBy, adminRef);

  const stored = await handle.db.collection(COLLECTIONS.listings).findOne({ listingReference: listing.listingReference });
  assert.equal(stored?.status, 'draft');
  assert.equal(stored?.archivedBy, null);
  assert.equal(stored?.moderation.state, 'ok');
});

// ---------------------------------------------------------------------------
// E02 — inventory is admin-only
// ---------------------------------------------------------------------------

test('P05-E02 every listing operation is admin-only and audited', async () => {
  const anon = await fetch(`${baseUrl}/api/admin/listings`);
  assert.equal(anon.status, 401);
  assert.equal((await fetch(`${baseUrl}/api/listings/not-a-reference`)).status, 422);

  assert.equal((await customer.get('/api/admin/listings')).status, 403);
  assert.equal((await customer.post('/api/admin/listings', { sellerReference: world.seller, categoryKey: 'cars' })).status, 403);
  assert.equal((await customer.patch('/api/admin/listings/l_000000000', { expectedVersion: 1 })).status, 403);
  assert.equal((await customer.post('/api/admin/listings/l_000000000/publish', { expectedVersion: 1 })).status, 403);
  assert.equal((await customer.post('/api/admin/listings/l_000000000/archive', { reason: 'not mine' })).status, 403);

  const draft = await createDraft({ title: { en: 'Audited draft' } });
  const audits = await handle.db
    .collection(COLLECTIONS.auditLogs)
    .find({ targetType: 'listing', targetId: draft.listingReference })
    .toArray();
  assert.deepEqual(audits.map((entry) => entry.action), ['listing.created']);
  assert.equal(audits[0]?.actorId, adminRef);

  const listed = await admin.get('/api/admin/listings?status=draft&search=Audited');
  const body = listed.body as { listings: ListingDto[]; total: number; totalPages: number };
  assert.equal(body.total, 1);
  assert.equal(body.listings[0]?.listingReference, draft.listingReference);
  assert.equal(body.totalPages, 1);

  const missing = await admin.get('/api/admin/listings/l_zzzzzzzzz');
  assert.equal(missing.status, 404);
});

test('P05-E02 a draft is created and saved while required attributes are still missing', async () => {
  // A draft with no attribute values at all, for a category whose schema has required fields.
  const created = await admin.post('/api/admin/listings', {
    sellerReference: world.seller,
    categoryKey: 'electronics',
    listingMethod: 'auction',
    audience: 'men',
    description: { en: 'A draft whose description is written but whose attributes are not.' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const draft = (created.body as { listing: ListingDto }).listing;
  assert.equal(draft.status, 'draft');
  assert.deepEqual(draft.attributes, {});
  assert.equal(draft.attributeSchemaVersion, world.electronicsVersion);

  // Saving the draft later still does not demand the required value...
  const saved = await patchListing(draft.listingReference, {
    title: { en: 'Incomplete draft' },
    expectedVersion: draft.version,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const savedListing = (saved.body as { listing: ListingDto }).listing;
  assert.deepEqual(savedListing.attributes, {});

  // ... publication does, by name, and the record stays a draft.
  const refused = await admin.post(`/api/admin/listings/${draft.listingReference}/publish`, {
    expectedVersion: savedListing.version,
  });
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(
    (refused.body as { error: { fieldErrors: Record<string, string> } }).error.fieldErrors['attributes.brand'],
    'required',
    JSON.stringify(refused.body),
  );
  const stillDraft = await admin.get(`/api/admin/listings/${draft.listingReference}`);
  assert.equal((stillDraft.body as { listing: ListingDto }).listing.status, 'draft');
});

// ---------------------------------------------------------------------------
// E03 — category-dependent wizard, reconciliation and revalidation
// ---------------------------------------------------------------------------

test('P05-E03 changing category reconciles attributes instead of silently keeping or dropping them', async () => {
  const draft = await createDraft({
    title: { en: 'Category change probe' },
    attributes: { make: 'toyota', model: 'Corolla', colour: 'white', mileage_km: 120000, internal_grade: 'B' },
  });
  assert.equal(draft.attributes.mileage_km, 120000);

  // A draft may be incomplete. Switching category without the new category's required values is
  // accepted, the compatible value survives, and the incompatible ones are reported as cleared.
  const incomplete = await patchListing(draft.listingReference, { categoryKey: 'electronics', expectedVersion: 1 });
  assert.equal(incomplete.status, 200, JSON.stringify(incomplete.body));
  const incompleteBody = incomplete.body as { listing: ListingDto; reconciliation: { kept: string[]; cleared: string[] } };
  assert.deepEqual(incompleteBody.listing.attributes, { model: 'Corolla' });
  assert.ok(incompleteBody.reconciliation.kept.includes('model'), 'a compatible value must be preserved');
  for (const cleared of ['make', 'colour', 'mileage_km', 'internal_grade']) {
    assert.ok(incompleteBody.reconciliation.cleared.includes(cleared), `${cleared} must be reported as cleared`);
  }

  // The value the new schema requires is what stops publication, named precisely.
  const incompletePublish = await admin.post(`/api/admin/listings/${draft.listingReference}/publish`, {
    expectedVersion: incompleteBody.listing.version,
  });
  assert.equal(incompletePublish.status, 422, JSON.stringify(incompletePublish.body));
  assert.equal(
    (incompletePublish.body as { error: { fieldErrors: Record<string, string> } }).error.fieldErrors['attributes.brand'],
    'required',
  );

  // Supplying the required value completes the draft; the compatible value is still there.
  const changed = await patchListing(draft.listingReference, {
    categoryKey: 'electronics',
    attributes: { brand: 'apple' },
    expectedVersion: incompleteBody.listing.version,
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  const result = changed.body as { listing: ListingDto };
  assert.equal(result.listing.category.key, 'electronics');
  assert.deepEqual(result.listing.category.path, ['electronics']);
  assert.equal(result.listing.attributeSchemaVersion, world.electronicsVersion);
  assert.deepEqual(result.listing.attributes, { model: 'Corolla', brand: 'apple' });

  // Moving to a category with no published schema clears every value and says so. The listing
  // method has to move with the category, because the new category does not offer auctions.
  const unschemed = await patchListing(draft.listingReference, { categoryKey: 'services', listingMethod: 'enquiry', expectedVersion: 3 });
  assert.equal(unschemed.status, 200, JSON.stringify(unschemed.body));
  const unschemedBody = unschemed.body as { listing: ListingDto; reconciliation: { cleared: string[]; reason: string | null } };
  assert.deepEqual(unschemedBody.listing.attributes, {});
  assert.equal(unschemedBody.listing.attributeSchemaVersion, null);
  assert.match(String(unschemedBody.reconciliation.reason), /no published schema/);
  assert.ok(unschemedBody.reconciliation.cleared.includes('brand'));

  // And values that do not belong to the chosen category are refused outright, by name.
  const unknown = await patchListing(draft.listingReference, {
    categoryKey: 'cars',
    listingMethod: 'auction',
    attributes: { make: 'toyota', model: 'Corolla', nope: 'x' },
    expectedVersion: 4,
  });
  assert.equal(unknown.status, 422);
  assert.equal((unknown.body as { error: { fieldErrors: Record<string, string> } }).error.fieldErrors['attributes.nope'], 'unknown attribute for this category');
});

test('P05-E03 a changed schema version must be revalidated before publication', async () => {
  const draft = await createDraft({ categoryKey: 'change-cat', title: { en: 'Schema change probe' }, attributes: { spec: 'v1 specification' } });
  assert.equal(draft.attributeSchemaVersion, world.changeVersion);

  // v2 adds a required field. Drafting is unaffected; publishing is not.
  await publishSchema('change-cat', [
    { key: 'spec', type: 'text', labelEn: 'Specification' },
    { key: 'certification', type: 'text', labelEn: 'Certification', required: true },
  ]);

  const staleRead = await admin.get(`/api/admin/listings/${draft.listingReference}`);
  assert.equal((staleRead.body as { schemaChanged: boolean }).schemaChanged, true, 'the wizard must be told the schema moved on');
  assert.equal((staleRead.body as { schema: { version: number } }).schema.version, world.changeVersion + 1);

  const blocked = await admin.post(`/api/admin/listings/${draft.listingReference}/publish`, { expectedVersion: draft.version });
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
  assert.equal((blocked.body as { error: { details: { revalidateRequired: boolean } } }).error.details.revalidateRequired, true);

  // Revalidating the attributes advances the recorded version ...
  const revalidated = await patchListing(draft.listingReference, {
    attributes: { spec: 'v1 specification', certification: 'ISO-9001' },
    expectedVersion: draft.version,
  });
  assert.equal(revalidated.status, 200, JSON.stringify(revalidated.body));
  const listing = (revalidated.body as { listing: ListingDto }).listing;
  assert.equal(listing.attributeSchemaVersion, world.changeVersion + 1);

  // ... while editing only the title leaves the version alone (nothing was revalidated).
  const media = await upload(`listing_${draft.listingReference}`, png(40, 30));
  const attached = await attachMedia(draft.listingReference, listing.version, [media.body.asset!.assetId]);
  const attachedListing = (attached.body as { listing: ListingDto }).listing;
  const titleOnly = await patchListing(draft.listingReference, { title: { en: 'Schema change probe again' }, expectedVersion: attachedListing.version });
  assert.equal((titleOnly.body as { listing: ListingDto }).listing.attributeSchemaVersion, world.changeVersion + 1);

  const published = await admin.post(`/api/admin/listings/${draft.listingReference}/publish`, {
    expectedVersion: (titleOnly.body as { listing: ListingDto }).listing.version,
  });
  assert.equal(published.status, 200, JSON.stringify(published.body));
});

// ---------------------------------------------------------------------------
// E04 — media association
// ---------------------------------------------------------------------------

test('P05-E04 images attach in order, with a real cover and localized alt text', async () => {
  const draft = await createDraft({ title: { en: 'Media probe' } });
  const collection = `listing_${draft.listingReference}`;
  const first = await upload(collection, png(64, 48));
  const second = await upload(collection, png(32, 24));
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(first.body.asset?.status, 'ready');

  const attached = await patchListing(draft.listingReference, {
    media: [
      { assetId: second.body.asset!.assetId, alt: { en: 'Second photo', ar: 'الصورة الثانية' } },
      { assetId: first.body.asset!.assetId, alt: { en: 'First photo' } },
    ],
    coverAssetId: first.body.asset!.assetId,
    expectedVersion: draft.version,
  });
  assert.equal(attached.status, 200, JSON.stringify(attached.body));
  const listing = (attached.body as { listing: ListingDto }).listing;
  assert.deepEqual(listing.media.map((entry) => [entry.assetId, entry.position]), [
    [second.body.asset!.assetId, 0],
    [first.body.asset!.assetId, 1],
  ]);
  assert.equal(listing.coverAssetId, first.body.asset!.assetId, 'the chosen cover must be kept');
  assert.equal(listing.media[0]?.mediaStatus, 'ready');
  assert.ok(listing.media[0]?.url?.startsWith('/api/admin/media/'), 'the staff preview URL is staff-scoped');

  // A cover that is not among the listing's own assets falls back to the first, never to nothing.
  const badCover = await patchListing(draft.listingReference, { coverAssetId: 'm_notthisee', expectedVersion: listing.version });
  assert.equal(badCover.status, 200);
  assert.equal((badCover.body as { listing: ListingDto }).listing.coverAssetId, second.body.asset!.assetId);

  // Reordering is the media list's job: position follows the submitted order.
  const reordered = await patchListing(draft.listingReference, {
    media: [
      { assetId: first.body.asset!.assetId, alt: { en: 'First photo' } },
      { assetId: second.body.asset!.assetId, alt: { en: 'Second photo' } },
    ],
    expectedVersion: (badCover.body as { listing: ListingDto }).listing.version,
  });
  assert.equal((reordered.body as { listing: ListingDto }).listing.media[0]?.assetId, first.body.asset!.assetId);

  // Detaching removes the reference so the asset is no longer this listing's public material.
  const detached = await patchListing(draft.listingReference, { media: [], expectedVersion: (reordered.body as { listing: ListingDto }).listing.version });
  assert.equal(detached.status, 200);
  assert.deepEqual((detached.body as { listing: ListingDto }).listing.media, []);
  assert.equal((detached.body as { listing: ListingDto }).listing.coverAssetId, null);
  const references = await handle.db.collection(COLLECTIONS.mediaReferences).countDocuments({ assetId: first.body.asset!.assetId, ownerType: 'listing' });
  assert.equal(references, 0);
});

test('P05-E04 media attachment refuses foreign, cross-purpose, unready and invented assets', async () => {
  const target = await createDraft({ title: { en: 'Attachment rules probe' } });
  const other = await createDraft({ title: { en: 'Other listing' } });

  // Bytes that are not an image never become an asset at all.
  const truncated = await upload(`listing_${target.listingReference}`, png(40, 30).subarray(0, 30));
  assert.equal(truncated.status, 422, JSON.stringify(truncated.body));

  // An asset from another listing's collection cannot be attached here.
  const foreign = await upload(`listing_${other.listingReference}`, png(20, 20));
  assert.equal(foreign.status, 201);
  const foreignAttach = await patchListing(target.listingReference, {
    media: [{ assetId: foreign.body.asset!.assetId }],
    expectedVersion: target.version,
  });
  assert.equal(foreignAttach.status, 422, JSON.stringify(foreignAttach.body));
  assert.match((foreignAttach.body as { error: { fieldErrors: Record<string, string> } }).error.fieldErrors.media ?? '', /another collection/);

  // An asset already owned by another purpose (seller verification evidence) is refused too,
  // even when it was uploaded into this listing's own collection.
  const reusable = await upload(`listing_${target.listingReference}`, png(24, 24));
  const reusableId = reusable.body.asset!.assetId;
  await handle.db.collection(COLLECTIONS.mediaReferences).insertOne({
    assetId: reusableId,
    ownerType: 'seller_evidence',
    ownerId: world.seller,
    addedAt: new Date(),
    addedBy: adminRef,
  });
  const crossPurpose = await patchListing(target.listingReference, {
    media: [{ assetId: reusableId }],
    expectedVersion: target.version,
  });
  assert.equal(crossPurpose.status, 422);
  assert.match((crossPurpose.body as { error: { fieldErrors: Record<string, string> } }).error.fieldErrors.media ?? '', /another record/);
  await handle.db.collection(COLLECTIONS.mediaReferences).deleteOne({ assetId: reusableId, ownerType: 'seller_evidence' });

  // A failed asset is not ready material.
  const failing = await upload(`listing_${target.listingReference}`, png(22, 22));
  const failingId = failing.body.asset!.assetId;
  await handle.db.collection(COLLECTIONS.mediaAssets).updateOne({ assetId: failingId }, { $set: { status: 'failed', statusReason: 'storage outage' } });
  const notReady = await patchListing(target.listingReference, { media: [{ assetId: failingId }], expectedVersion: target.version });
  assert.equal(notReady.status, 422);
  assert.match((notReady.body as { error: { fieldErrors: Record<string, string> } }).error.fieldErrors.media ?? '', /not ready/);

  // Client-supplied URLs and unknown identifiers are never accepted: only resolvable asset IDs.
  const invented = await patchListing(target.listingReference, {
    media: [{ assetId: 'https://evil.example/pixel.png' }],
    expectedVersion: target.version,
  });
  assert.equal(invented.status, 422);
  assert.match((invented.body as { error: { fieldErrors: Record<string, string> } }).error.fieldErrors.media ?? '', /does not exist/);

  const duplicated = await patchListing(target.listingReference, {
    media: [{ assetId: reusableId }, { assetId: reusableId }],
    expectedVersion: target.version,
  });
  assert.equal(duplicated.status, 422);

  const stored = await handle.db.collection(COLLECTIONS.listings).findOne({ listingReference: target.listingReference });
  assert.deepEqual(stored?.media, [], 'refused attachments must leave the listing untouched');
  assert.equal(stored?.version, target.version);
});

// ---------------------------------------------------------------------------
// E04/E05 — publication is validated server-side
// ---------------------------------------------------------------------------

test('P05-E05 publication re-checks content, references and media on the server', async () => {
  const draft = await createDraft({
    title: { en: 'Publication probe' },
    description: { en: 'Publication probe description, long enough to pass.' },
    attributes: { make: 'toyota', model: 'Land Cruiser' },
  });

  // No images.
  const noMedia = await admin.post(`/api/admin/listings/${draft.listingReference}/publish`, { expectedVersion: draft.version });
  assert.equal(noMedia.status, 422);
  assert.match((noMedia.body as { error: { fieldErrors: Record<string, string> } }).error.fieldErrors.media ?? '', /at least one image/);

  const asset = await upload(`listing_${draft.listingReference}`, png(50, 40));
  const attached = await attachMedia(draft.listingReference, draft.version, [asset.body.asset!.assetId]);
  let listing = (attached.body as { listing: ListingDto }).listing;
  assert.equal(listing.coverAssetId, asset.body.asset!.assetId);

  // ... then an Arabic title is missing while the advertisement language asks for both.
  const bilingual = await patchListing(draft.listingReference, { languageMode: 'both', expectedVersion: listing.version });
  listing = (bilingual.body as { listing: ListingDto }).listing;
  const missingArabic = await admin.post(`/api/admin/listings/${draft.listingReference}/publish`, { expectedVersion: listing.version });
  assert.equal(missingArabic.status, 422);
  assert.ok((missingArabic.body as { error: { fieldErrors: Record<string, string> } }).error.fieldErrors['title.ar']);

  const arabicTitle = await patchListing(draft.listingReference, {
    title: { en: 'Publication probe', ar: 'مركبة للبيع' },
    description: { en: 'Publication probe description, long enough to pass.', ar: null },
    expectedVersion: listing.version,
  });
  listing = (arabicTitle.body as { listing: ListingDto }).listing;
  const missingArabicDescription = await admin.post(`/api/admin/listings/${draft.listingReference}/publish`, { expectedVersion: listing.version });
  assert.equal(missingArabicDescription.status, 422);
  assert.ok((missingArabicDescription.body as { error: { fieldErrors: Record<string, string> } }).error.fieldErrors['description.ar']);

  // A stale editor cannot publish over someone else's newer work.
  const stalePublish = await admin.post(`/api/admin/listings/${draft.listingReference}/publish`, { expectedVersion: 1 });
  assert.equal(stalePublish.status, 409);

  const completed = await patchListing(draft.listingReference, {
    description: { en: 'Publication probe description, long enough to pass.', ar: 'وصف كامل للمركبة المعروضة للبيع.' },
    expectedVersion: listing.version,
  });
  listing = (completed.body as { listing: ListingDto }).listing;

  const published = await admin.post(`/api/admin/listings/${draft.listingReference}/publish`, { expectedVersion: listing.version });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const publishedBody = published.body as { listing: ListingDto; publicUrl: string };
  assert.equal(publishedBody.listing.status, 'published');
  assert.equal(publishedBody.listing.publishedBy, adminRef);
  assert.ok(publishedBody.listing.publishedAt, 'a published listing records when');
  assert.equal(publishedBody.publicUrl, '/product/publication-probe');

  const audit = await handle.db.collection(COLLECTIONS.auditLogs).findOne({ action: 'listing.published', targetId: draft.listingReference });
  assert.equal(audit?.actorId, adminRef);

  assert.equal((await admin.post(`/api/admin/listings/${draft.listingReference}/publish`, { expectedVersion: publishedBody.listing.version })).status, 409);

  // Editing a published listing keeps it published: autosave may not silently unpublish.
  const editPublished = await patchListing(draft.listingReference, { title: { en: 'Publication probe edited', ar: 'مركبة للبيع' }, expectedVersion: publishedBody.listing.version });
  assert.equal(editPublished.status, 200, JSON.stringify(editPublished.body));
  const afterEdit = (editPublished.body as { listing: ListingDto }).listing;
  assert.equal(afterEdit.status, 'published');
  assert.equal((await publicListing(draft.listingReference)).status, 200);
});

test('P05-E05 publication refuses inactive, archived and non-applicable references', async () => {
  // Archived seller.
  const archivedSeller = await createSeller({ displayName: 'Archived Seller', phone: '55556102' });
  await admin.patch(`/api/admin/sellers/${archivedSeller}/status`, { status: 'archived', reason: 'duplicate record' });
  const sellerDraft = await createDraft({ sellerReference: archivedSeller, title: { en: 'Archived seller probe' } });
  const sellerAsset = await upload(`listing_${sellerDraft.listingReference}`, png(30, 30));
  let listing = (await attachMedia(sellerDraft.listingReference, sellerDraft.version, [sellerAsset.body.asset!.assetId])).body as { listing: ListingDto };
  const sellerPublish = await admin.post(`/api/admin/listings/${sellerDraft.listingReference}/publish`, { expectedVersion: listing.listing.version });
  assert.equal(sellerPublish.status, 422);
  assert.ok((sellerPublish.body as { error: { fieldErrors: Record<string, string> } }).error.fieldErrors.sellerReference);

  // Archived category.
  const retiredDraft = await createDraft({ categoryKey: 'retired-cat', title: { en: 'Retired category probe' }, attributes: {} });
  const retiredAsset = await upload(`listing_${retiredDraft.listingReference}`, png(30, 30));
  listing = (await attachMedia(retiredDraft.listingReference, retiredDraft.version, [retiredAsset.body.asset!.assetId])).body as { listing: ListingDto };
  assert.equal((await admin.post('/api/admin/categories/retired-cat/archive', { reason: 'no longer offered' })).status, 200);
  const categoryPublish = await admin.post(`/api/admin/listings/${retiredDraft.listingReference}/publish`, { expectedVersion: listing.listing.version });
  assert.equal(categoryPublish.status, 422);
  assert.match((categoryPublish.body as { error: { fieldErrors: Record<string, string> } }).error.fieldErrors.categoryKey ?? '', /archived/);

  // Inactive location.
  const locationDraft = await createDraft({ locationKey: world.inactiveLocation, title: { en: 'Inactive location probe' } });
  const locationAsset = await upload(`listing_${locationDraft.listingReference}`, png(30, 30));
  listing = (await attachMedia(locationDraft.listingReference, locationDraft.version, [locationAsset.body.asset!.assetId])).body as { listing: ListingDto };
  assert.equal((await admin.patch(`/api/admin/locations/${world.inactiveLocation}`, { active: false })).status, 200);
  const locationPublish = await admin.post(`/api/admin/listings/${locationDraft.listingReference}/publish`, { expectedVersion: listing.listing.version });
  assert.equal(locationPublish.status, 422);
  assert.match((locationPublish.body as { error: { fieldErrors: Record<string, string> } }).error.fieldErrors.locationKey ?? '', /inactive/);

  // A condition that does not apply to the listing method is refused at write time.
  const badCondition = await admin.post('/api/admin/listings', {
    sellerReference: world.seller,
    categoryKey: 'services',
    listingMethod: 'enquiry',
    condition: 'used',
    title: { en: 'Condition mismatch' },
  });
  assert.equal(badCondition.status, 422);

  // A method the category does not offer is refused, too.
  const badMethod = await admin.post('/api/admin/listings', {
    sellerReference: world.seller,
    categoryKey: 'services',
    listingMethod: 'auction',
    title: { en: 'Method mismatch' },
  });
  assert.equal(badMethod.status, 422);

  // Unknown references are refused with field errors, not a 500.
  for (const overrides of [
    { sellerReference: 's_doesnotexist' },
    { categoryKey: 'does-not-exist' },
    { locationKey: 'qa-nowhere-nowhere' },
  ]) {
    const res = await admin.post('/api/admin/listings', {
      sellerReference: world.seller,
      categoryKey: 'cars',
      title: { en: 'Reference probe' },
      ...overrides,
    });
    assert.equal(res.status, 422, JSON.stringify(res.body));
  }
});

// ---------------------------------------------------------------------------
// E09/E13 — DTO boundaries
// ---------------------------------------------------------------------------

test('P05-E09 the public listing DTO redacts private material and keeps public precision', async () => {
  const created = await createPublishedListing({
    categoryKey: 'cars',
    titleEn: 'Redaction probe',
    sellerReference: world.verifiedSeller,
    locationKey: world.areaLocation,
    attributes: { make: 'nissan', model: 'Patrol', internal_grade: 'A-internal' },
  });
  await patchListing(created.reference, { adminNotes: 'Internal note: settle in cash', expectedVersion: created.version });

  const publicView = await publicListing(created.reference);
  assert.equal(publicView.status, 200);
  const listing = publicView.body.listing!;
  const serialized = JSON.stringify(publicView.body);
  for (const secret of [
    'A-internal',
    'internal_grade',
    'Internal note: settle in cash',
    'adminNotes',
    'Private negotiation note',
    '55556101',
    'moderation',
    'createdBy',
    'publishedBy',
    'attributeSchemaVersion',
    'mediaCollectionKey',
    '/api/admin/media/',
  ]) {
    assert.ok(!serialized.includes(secret), `public listing DTO leaked ${secret}`);
  }
  assert.equal((listing.attributes as Record<string, unknown>).make, 'nissan');
  assert.deepEqual(Object.keys(listing.seller as Record<string, unknown>).sort(), ['displayName', 'sellerReference', 'verificationBadge']);
  assert.equal((listing.seller as { verificationBadge: boolean }).verificationBadge, true);
  assert.equal((listing.location as { label: string }).label, 'Al Sadd, Doha');
  assert.equal((listing.location as { publicPrecision: string }).publicPrecision, 'area');
  assert.equal((listing.category as { key: string }).key, 'cars');
  assert.equal(listing.status, undefined);
  assert.equal(listing.coverAssetId, created.assetId);
  const media = listing.media as Array<{ url: string }>;
  assert.equal(media[0]?.url, `/api/listings/${created.reference}/media/${created.assetId}/file`);

  // A signed-in customer gets a projection identical to the anonymous one: no session-only leak.
  const customerView = await customer.get(`/api/listings/${created.reference}`);
  assert.equal(customerView.status, 200);
  assert.deepEqual(customerView.body, publicView.body);

  // A 'hidden' precision location publishes nothing about where the item is.
  const hidden = await createPublishedListing({ categoryKey: 'cars', titleEn: 'Hidden location probe', locationKey: null, attributes: { make: 'nissan', model: 'Sunny' } });
  const hiddenView = await publicListing(hidden.reference);
  const hiddenListing = hiddenView.body.listing as { location: { label: string | null; publicPrecision: string; areaKey: string | null } };
  assert.equal(hiddenListing.location.publicPrecision, 'hidden');
  assert.equal(hiddenListing.location.label, null);
  assert.equal(hiddenListing.location.areaKey, null);
});

// ---------------------------------------------------------------------------
// E05/E06 — visibility, archive policy and the public media boundary
// ---------------------------------------------------------------------------

test('P05-E05 drafts, archived and blocked listings are invisible; archive is reversible', async () => {
  const draft = await createDraft({ title: { en: 'Invisible draft' } });
  assert.equal((await publicListing(draft.listingReference)).status, 404);
  assert.equal((await admin.get(`/api/admin/listings/${draft.listingReference}`)).status, 200);

  const published = await createPublishedListing({ categoryKey: 'cars', titleEn: 'Archive policy probe', attributes: { make: 'nissan', model: 'X-Trail' } });
  assert.equal((await publicListing(published.reference)).status, 200);

  const archived = await admin.post(`/api/admin/listings/${published.reference}/archive`, { reason: 'seller withdrew the item' });
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  const archivedListing = (archived.body as { listing: ListingDto }).listing;
  assert.equal(archivedListing.status, 'archived');
  assert.equal(archivedListing.archivedReason, 'seller withdrew the item');
  assert.ok(archivedListing.publishedAt, 'when a listing was published is kept as history after archiving');

  assert.equal((await publicListing(published.reference)).status, 404, 'an archived listing must leave public view');
  assert.equal((await publicMedia(published.reference, published.assetId)).status, 404, 'and so must its images');
  assert.equal((await admin.get(`/api/admin/listings/${published.reference}`)).status, 200, 'history is preserved');

  const archiveAudit = await handle.db.collection(COLLECTIONS.auditLogs).findOne({ action: 'listing.archived', targetId: published.reference });
  assert.equal(archiveAudit?.reason, 'seller withdrew the item');
  assert.equal((await admin.post(`/api/admin/listings/${published.reference}/archive`, { reason: 'again' })).status, 409);

  // Re-publishing an archived listing is an explicit, audited act.
  const republished = await admin.post(`/api/admin/listings/${published.reference}/publish`, { expectedVersion: archivedListing.version });
  assert.equal(republished.status, 200, JSON.stringify(republished.body));
  assert.equal((republished.body as { listing: ListingDto }).listing.status, 'published');
  assert.equal((await publicListing(published.reference)).status, 200);
  assert.equal((await handle.db.collection(COLLECTIONS.listings).countDocuments({ listingReference: published.reference })), 1);

  // A blocked listing stays stored but out of public view, and cannot be published.
  const blocked = await createDraft({ title: { en: 'Blocked probe' } });
  const blockedAsset = await upload(`listing_${blocked.listingReference}`, png(30, 30));
  const blockedAttached = await attachMedia(blocked.listingReference, blocked.version, [blockedAsset.body.asset!.assetId]);
  const blockedVersion = (blockedAttached.body as { listing: ListingDto }).listing.version;
  const setBlocked = await patchListing(blocked.listingReference, { moderationState: 'blocked', moderationNote: 'awaiting compliance check', expectedVersion: blockedVersion });
  assert.equal(setBlocked.status, 200);
  const blockedPublish = await admin.post(`/api/admin/listings/${blocked.listingReference}/publish`, {
    expectedVersion: (setBlocked.body as { listing: ListingDto }).listing.version,
  });
  assert.equal(blockedPublish.status, 409);
});

test('P05-E06 public image access is authorized by the published listing, nothing else', async () => {
  const published = await createPublishedListing({
    categoryKey: 'cars',
    titleEn: 'Media policy probe',
    attributes: { make: 'toyota', model: 'Prado' },
    image: png(60, 45),
  });

  // The published listing's own image is served, with the stored content type and bytes.
  const served = await publicMedia(published.reference, published.assetId);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  // cross-origin so a separate frontend host (e.g. Vercel) can embed these in <img>.
  assert.equal(served.headers.get('cross-origin-resource-policy'), 'cross-origin');
  assert.deepEqual([...served.bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(served.bytes.length, png(60, 45).length);

  // Knowing an asset ID does not bypass authorization: the staff preview stays staff-only.
  assert.equal((await fetch(`${baseUrl}/api/admin/media/${published.assetId}/file`)).status, 401);
  assert.equal((await customer.get(`/api/admin/media/${published.assetId}/file`)).status, 403);

  // A draft's image is not reachable, even through a published listing's URL.
  const draft = await createDraft({ title: { en: 'Private media probe' } });
  const draftAsset = await upload(`listing_${draft.listingReference}`, png(28, 28));
  assert.equal((await publicMedia(published.reference, draftAsset.body.asset!.assetId)).status, 404);
  assert.equal((await publicMedia(draft.listingReference, draftAsset.body.asset!.assetId)).status, 404);

  // An upload that was never attached is not public material.
  const unattached = await upload(`draft_orphan_${Math.random().toString(36).slice(2, 8)}`, png(26, 26));
  const orphanId = unattached.body.asset!.assetId;
  assert.equal((await publicMedia(published.reference, orphanId)).status, 404);

  // Seller verification evidence and settlement material share the media store but never the
  // public route, even when the asset ids are known and the asset is 'ready'.
  const evidence = await upload(`seller_evidence_${world.seller}`, png(34, 34));
  await handle.db.collection(COLLECTIONS.mediaReferences).insertOne({
    assetId: evidence.body.asset!.assetId,
    ownerType: 'seller_evidence',
    ownerId: world.seller,
    addedAt: new Date(),
    addedBy: adminRef,
  });
  assert.equal((await publicMedia(published.reference, evidence.body.asset!.assetId)).status, 404);

  // Another published listing's image cannot be served through this listing's URL.
  const second = await createPublishedListing({ categoryKey: 'cars', titleEn: 'Second media probe', attributes: { make: 'toyota', model: 'Camry' } });
  assert.equal((await publicMedia(published.reference, second.assetId)).status, 404);
  assert.equal((await publicMedia(second.reference, published.assetId)).status, 404);
  assert.equal((await publicMedia(second.reference, second.assetId)).status, 200);

  // Probing cannot distinguish "does not exist" from "exists but is not yours".
  const probe = await fetch(`${baseUrl}/api/listings/${published.reference}/media/m_zzzzzzzzz/file`);
  const hiddenResponse = await fetch(`${baseUrl}/api/listings/${published.reference}/media/${draftAsset.body.asset!.assetId}/file`);
  assert.equal(probe.status, 404);
  assert.equal(hiddenResponse.status, 404);
  const probeBody = (await probe.json()) as { error: { code: string; message: string; requestId: string } };
  const hiddenBody = (await hiddenResponse.json()) as { error: { code: string; message: string; requestId: string } };
  assert.deepEqual(
    { code: probeBody.error.code, message: probeBody.error.message },
    { code: hiddenBody.error.code, message: hiddenBody.error.message },
    'responses must not reveal whether an asset exists',
  );
  assert.notEqual(probeBody.error.requestId, hiddenBody.error.requestId, 'each refusal is still individually traceable');

  // Defence in depth: listing document media without a matching ownership reference is refused.
  await handle.db.collection(COLLECTIONS.mediaReferences).deleteOne({ assetId: second.assetId, ownerType: 'listing', ownerId: second.reference });
  assert.equal((await publicMedia(second.reference, second.assetId)).status, 404);
});

// ---------------------------------------------------------------------------
// E07/E08/E10 — public discovery and shareable URL state
// ---------------------------------------------------------------------------

test('P05-E07 discovery filters, sorts and paginates deterministically', async () => {
  const sedan = await createPublishedListing({
    categoryKey: 'sedans',
    titleEn: 'Aurora sedan',
    listingMethod: 'auction',
    locationKey: world.areaLocation,
    attributes: {},
  });
  const featured = await createPublishedListing({
    categoryKey: 'cars',
    titleEn: 'Blue pickup truck',
    listingMethod: 'fixed_price',
    locationKey: world.cityLocation,
    featured: true,
    attributes: { make: 'nissan', model: 'Pickup' },
  });
  const enquiry = await createPublishedListing({
    categoryKey: 'electronics',
    titleEn: 'Zoom lens kit',
    listingMethod: 'enquiry',
    locationKey: null,
    attributes: { brand: 'samsung', model: 'Lens kit' },
  });
  const jpegListing = await createPublishedListing({
    categoryKey: 'cars',
    titleEn: 'Cedar SUV',
    listingMethod: 'auction',
    locationKey: world.cityLocation,
    attributes: { make: 'toyota', model: 'Cedar SUV' },
    image: jpeg(40, 30),
    imageType: 'image/jpeg',
  });
  const westBayListing = await createPublishedListing({
    categoryKey: 'cars',
    titleEn: 'West Bay coupe',
    listingMethod: 'auction',
    locationKey: world.westBayLocation,
    attributes: { make: 'nissan', model: 'Coupe' },
  });

  const discoveryNow = Date.now();
  await openLot(sedan.reference, new Date(discoveryNow - 60_000), new Date(discoveryNow + 3_600_000));
  await openLot(jpegListing.reference, new Date(discoveryNow - 60_000), new Date(discoveryNow + 3_600_000));
  await openLot(westBayListing.reference, new Date(discoveryNow - 60_000), new Date(discoveryNow + 3_600_000));

  const catalogueDefault = await fetch(`${baseUrl}/api/listings?limit=48`);
  const catalogueRefs = ((await catalogueDefault.json()) as { listings: Array<{ listingReference: string }> }).listings.map((entry) => entry.listingReference);
  assert.ok(!catalogueRefs.includes(sedan.reference), 'unscoped browse must hide legacy non-catalogue paths');

  const all = await fetch(`${baseUrl}/api/listings?category=vehicles&limit=48`);
  const allBody = (await all.json()) as { listings: Array<{ listingReference: string; coverAssetId: string | null }>; total: number; totalPages: number; sort: string };
  const references = allBody.listings.map((entry) => entry.listingReference);
  assert.ok(references.includes(sedan.reference));
  assert.ok(references.includes(jpegListing.reference));
  assert.ok(allBody.total >= references.length);
  assert.equal(allBody.sort, 'recent');
  assert.ok(allBody.listings.every((entry) => entry.coverAssetId !== null), 'a public card always has a cover');

  // Category filtering includes descendants.
  const vehicles = await fetch(`${baseUrl}/api/listings?category=vehicles&limit=48`);
  const vehicleRefs = ((await vehicles.json()) as { listings: Array<{ listingReference: string }> }).listings.map((entry) => entry.listingReference);
  assert.ok(vehicleRefs.includes(sedan.reference), 'a parent category must include its descendants');
  assert.ok(vehicleRefs.includes(featured.reference));
  assert.ok(!vehicleRefs.includes(enquiry.reference));

  const sedansOnly = await fetch(`${baseUrl}/api/listings?category=sedans&limit=48`);
  assert.deepEqual(((await sedansOnly.json()) as { listings: Array<{ listingReference: string }> }).listings.map((e) => e.listingReference), [sedan.reference]);

  // Search, method, country/city and featured filters.
  const search = await fetch(`${baseUrl}/api/listings?category=vehicles&q=cedar&limit=48`);
  const searchBody = (await search.json()) as { listings: Array<{ listingReference: string }>; filters: { q: string | null } };
  assert.deepEqual(searchBody.listings.map((e) => e.listingReference), [jpegListing.reference]);
  assert.equal(searchBody.filters.q, 'cedar');

  const noMatch = await fetch(`${baseUrl}/api/listings?q=nothing-matches-this`);
  const noMatchBody = (await noMatch.json()) as { listings: unknown[]; total: number };
  assert.deepEqual(noMatchBody.listings, [], 'an empty result is empty, never replaced by demo inventory');
  assert.equal(noMatchBody.total, 0);

  const fixedPrice = await fetch(`${baseUrl}/api/listings?category=vehicles&method=fixed_price&limit=48`);
  assert.deepEqual(((await fixedPrice.json()) as { listings: Array<{ listingReference: string }> }).listings.map((e) => e.listingReference), [featured.reference]);

  const dohaCity = await fetch(`${baseUrl}/api/listings?category=vehicles&country=QA&city=doha&limit=48`);
  const cityBody = (await dohaCity.json()) as { listings: Array<{ listingReference: string; location: { cityKey: string | null } }> };
  const cityRefs = cityBody.listings.map((entry) => entry.listingReference);
  assert.ok(cityRefs.includes(featured.reference));
  assert.ok(cityRefs.includes(sedan.reference), 'a city filter includes every listing in that city');
  assert.ok(cityBody.listings.every((entry) => entry.location.cityKey === 'doha'), 'a city filter must not leak other cities’ listings');
  assert.ok(!cityRefs.includes(enquiry.reference), 'a listing with no location is not in any city');
  assert.ok(cityRefs.includes(westBayListing.reference), 'a city filter includes every Doha area');

  const alSaddArea = await fetch(`${baseUrl}/api/listings?category=vehicles&country=QA&city=doha&area=al-sadd&limit=48`);
  const alSaddBody = (await alSaddArea.json()) as { listings: Array<{ listingReference: string }>; filters: { area: string | null } };
  assert.equal(alSaddBody.filters.area, 'al-sadd');
  assert.deepEqual(
    alSaddBody.listings.map((entry) => entry.listingReference),
    [sedan.reference],
    'area=al-sadd must return only that neighbourhood',
  );

  const westBayArea = await fetch(`${baseUrl}/api/listings?category=vehicles&country=QA&city=doha&area=west-bay&limit=48`);
  const westBayBody = (await westBayArea.json()) as { listings: Array<{ listingReference: string }>; filters: { area: string | null } };
  assert.equal(westBayBody.filters.area, 'west-bay');
  assert.deepEqual(westBayBody.listings.map((entry) => entry.listingReference), [westBayListing.reference]);

  const featuredOnly = await fetch(`${baseUrl}/api/listings?category=vehicles&featured=true&limit=48`);
  const featuredRefs = ((await featuredOnly.json()) as { listings: Array<{ listingReference: string; featured: boolean }> }).listings;
  assert.equal(featuredRefs.every((entry) => entry.featured), true);
  assert.ok(featuredRefs.some((entry) => entry.listingReference === featured.reference));

  // Deterministic sorting, stable across identical requests.
  const sortTitle = await fetch(`${baseUrl}/api/listings?category=vehicles&sort=title&limit=48`);
  const titleBody = (await sortTitle.json()) as { listings: Array<{ title: { en: string } }> };
  const titles = titleBody.listings.map((entry) => entry.title.en.toLowerCase());
  assert.deepEqual(titles, [...titles].sort(), 'sort=title must be ordered');
  const sortTitleAgain = await fetch(`${baseUrl}/api/listings?category=vehicles&sort=title&limit=48`);
  assert.deepEqual(await sortTitleAgain.json(), titleBody, 'the same URL must produce the same page');

  const sortFeatured = await fetch(`${baseUrl}/api/listings?category=vehicles&sort=featured&limit=48`);
  assert.equal(((await sortFeatured.json()) as { listings: Array<{ listingReference: string }> }).listings[0]?.listingReference, featured.reference);

  // Bounded, non-overlapping pagination.
  const pageOne = await fetch(`${baseUrl}/api/listings?category=vehicles&limit=2&page=1`);
  const pageTwo = await fetch(`${baseUrl}/api/listings?category=vehicles&limit=2&page=2`);
  const pageOneBody = (await pageOne.json()) as { listings: Array<{ listingReference: string }>; page: number; limit: number; totalPages: number };
  const pageTwoBody = (await pageTwo.json()) as { listings: Array<{ listingReference: string }> };
  assert.equal(pageOneBody.limit, 2);
  const overlap = pageOneBody.listings.filter((entry) => pageTwoBody.listings.some((other) => other.listingReference === entry.listingReference));
  assert.deepEqual(overlap, [], 'pages must not overlap');

  // Drafts and archived listings never appear in discovery, even when they match a search.
  const draft = await createDraft({ title: { en: 'Findable draft' } });
  const draftSearch = await fetch(`${baseUrl}/api/listings?q=Findable`);
  assert.deepEqual(((await draftSearch.json()) as { listings: unknown[] }).listings, []);
  assert.equal((await publicListing(draft.listingReference)).status, 404);
});

test('P05-E08 invalid or unknown URL state is handled explicitly', async () => {
  const cases: Array<[string, number]> = [
    ['?sort=nonsense', 422],
    ['?limit=500', 422],
    ['?limit=0', 422],
    ['?page=0', 422],
    ['?page=abc', 422],
    ['?category=a', 422],
    ['?country=QAT', 422],
    ['?method=raffle', 422],
    ['?condition=broken', 422],
    [`?q=${'x'.repeat(130)}`, 422],
    ['?featured=maybe', 422],
  ];
  for (const [query, expected] of cases) {
    const res = await fetch(`${baseUrl}/api/listings${query}`);
    assert.equal(res.status, expected, `${query} should be refused with ${expected}`);
    const body = (await res.json()) as { error: { code: string; fieldErrors: Record<string, string> } };
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.ok(Object.keys(body.error.fieldErrors).length > 0, `${query} should name the offending parameter`);
  }

  // A well-formed but unknown identifier is a valid, empty page rather than an error.
  const unknownCategory = await fetch(`${baseUrl}/api/listings?category=does-not-exist`);
  const unknownBody = (await unknownCategory.json()) as { listings: unknown[]; total: number; filters: { category: string } };
  assert.equal(unknownCategory.status, 200);
  assert.deepEqual(unknownBody.listings, []);
  assert.equal(unknownBody.filters.category, 'does-not-exist');

  // A page past the end is empty, not an error and not a wrapped page.
  const beyond = await fetch(`${baseUrl}/api/listings?page=999&limit=5`);
  assert.deepEqual(((await beyond.json()) as { listings: unknown[] }).listings, []);

  // Malformed references are refused before any lookup.
  for (const bad of ['not-a-ref', 'l_', 'l_short']) {
    assert.equal((await publicListing(bad)).status, 422, `${bad} should be rejected as a malformed reference`);
  }
  assert.equal((await publicListing('l_aaaaaaaaa')).status, 404);
});

test('P05-E10 published images render for the whole catalogue, including JPEG uploads', async () => {
  const jpegListing = await createPublishedListing({
    categoryKey: 'cars',
    titleEn: 'Vega sedan',
    attributes: { make: 'toyota', model: 'Vega' },
    image: jpeg(64, 48),
    imageType: 'image/jpeg',
  });
  const webpListing = await createPublishedListing({
    categoryKey: 'cars',
    titleEn: 'Webp probe',
    attributes: { make: 'toyota', model: 'Webp probe model' },
    image: webp(48, 48, { exif: true }),
    imageType: 'image/webp',
  });

  const jpegServed = await publicMedia(jpegListing.reference, jpegListing.assetId);
  assert.equal(jpegServed.status, 200);
  assert.equal(jpegServed.headers.get('content-type'), 'image/jpeg');
  assert.equal(jpegServed.bytes[0], 0xff);
  assert.equal(jpegServed.bytes[1], 0xd8);

  const webpServed = await publicMedia(webpListing.reference, webpListing.assetId);
  assert.equal(webpServed.status, 200);
  assert.equal(webpServed.headers.get('content-type'), 'image/webp');
  assert.equal(webpServed.bytes.subarray(0, 4).toString('latin1'), 'RIFF');
  assert.equal(webpServed.bytes.includes(Buffer.from('GPS 25.2854')), false, 'EXIF GPS must not be served');

  // Each card links to its own record.
  for (const entry of [jpegListing, webpListing]) {
    const view = await publicListing(entry.reference);
    const listing = view.body.listing as { listingReference: string; media: Array<{ url: string }>; coverAssetId: string };
    assert.equal(listing.listingReference, entry.reference);
    assert.equal(listing.coverAssetId, entry.assetId);
    assert.equal(listing.media[0]?.url, `/api/listings/${entry.reference}/media/${entry.assetId}/file`);
  }
});

test('P05 audience filters public listings and is required to publish', async () => {
  const men = await createPublishedListing({
    titleEn: 'Audience men probe',
    audience: 'men',
    listingMethod: 'fixed_price',
    categoryKey: 'clothes-thobes',
    attributes: { item_condition: 'new', brand_name: 'Men audience probe' },
  });
  const women = await createPublishedListing({
    titleEn: 'Audience women probe',
    audience: 'women',
    listingMethod: 'fixed_price',
    categoryKey: 'perfume',
    attributes: { item_condition: 'new', brand_name: 'Women audience probe' },
  });

  const storedWomen = await handle.db.collection(COLLECTIONS.listings).findOne({ listingReference: women.reference });
  assert.equal(storedWomen?.audience, 'women');
  const storedMen = await handle.db.collection(COLLECTIONS.listings).findOne({ listingReference: men.reference });
  assert.equal(storedMen?.audience, 'men');

  const womenOnly = await fetch(`${baseUrl}/api/listings?audience=women&limit=48`);
  assert.equal(womenOnly.status, 200);
  const womenBody = (await womenOnly.json()) as { listings: Array<{ listingReference: string; audience?: string | null }> };
  assert.ok(
    womenBody.listings.every((entry) => entry.audience === 'women' || entry.audience === 'unisex'),
    `expected women or unisex listings, got: ${JSON.stringify(womenBody.listings.map((e) => [e.listingReference, e.audience]))}`,
  );
  assert.ok(womenBody.listings.some((entry) => entry.listingReference === women.reference));
  assert.equal(womenBody.listings.some((entry) => entry.listingReference === men.reference), false);

  const menOnly = await fetch(`${baseUrl}/api/listings?audience=men&limit=48`);
  const menBody = (await menOnly.json()) as { listings: Array<{ listingReference: string }> };
  assert.ok(menBody.listings.some((entry) => entry.listingReference === men.reference));
  assert.equal(menBody.listings.some((entry) => entry.listingReference === women.reference), false);

  const draft = await createDraft({ audience: null, title: { en: 'Audience missing probe' } });
  const asset = await upload(`listing_${draft.listingReference}`, png(30, 30));
  const attached = (await attachMedia(draft.listingReference, draft.version, [asset.body.asset!.assetId])).body as { listing: ListingDto };
  const refused = await admin.post(`/api/admin/listings/${draft.listingReference}/publish`, { expectedVersion: attached.listing.version });
  assert.equal(refused.status, 422);
  assert.match((refused.body as { error: { fieldErrors: Record<string, string> } }).error.fieldErrors.audience ?? '', /Men, Women or Unisex/i);
});

test('P05-E13 the wizard can explain every refusal without a fake success path', async () => {
  // a) Unknown listing reference for the admin view: a real 404 with code NOT_FOUND.
  const missing = await admin.get('/api/admin/listings/l_aaaaaaaaa');
  assert.equal(missing.status, 404);
  assert.equal((missing.body as { error: { code: string } }).error.code, 'NOT_FOUND');

  // b) A draft whose seller was archived is still readable and editable, but not publishable.
  const failureSeller = await createSeller({ displayName: 'Honest Failure Seller', phone: '55556103' });
  const draft = await createDraft({ sellerReference: failureSeller, title: { en: 'Honest failure probe' } });
  const asset = await upload(`listing_${draft.listingReference}`, png(30, 30));
  const attached = (await attachMedia(draft.listingReference, draft.version, [asset.body.asset!.assetId])).body as { listing: ListingDto };
  await admin.patch(`/api/admin/sellers/${failureSeller}/status`, { status: 'archived', reason: 'temporary archive for the test' });
  const refused = await admin.post(`/api/admin/listings/${draft.listingReference}/publish`, { expectedVersion: attached.listing.version });
  assert.equal(refused.status, 422);
  assert.equal((await publicListing(draft.listingReference)).status, 404, 'a refused publication must not leak into public view');
  await admin.patch(`/api/admin/sellers/${failureSeller}/status`, { status: 'active', reason: 're-activated by the test' });

  // c) A partial autosave is allowed while drafting, but publication refuses the same content —
  // and every refusal is machine-readable: code, message and per-field errors.
  const partial = await patchListing(draft.listingReference, { title: { en: 'x' }, expectedVersion: attached.listing.version });
  assert.equal(partial.status, 200, 'drafting may save incomplete content');
  const invalid = await admin.post(`/api/admin/listings/${draft.listingReference}/publish`, {
    expectedVersion: (partial.body as { listing: ListingDto }).listing.version,
  });
  assert.equal(invalid.status, 422);
  const error = (invalid.body as { error: { code: string; message: string; fieldErrors: Record<string, string>; requestId: string } }).error;
  assert.equal(error.code, 'VALIDATION_ERROR');
  assert.ok(error.fieldErrors['title.en']);
  assert.ok(error.requestId.length > 0);

  // d) A public failure is the same shape, never a stack trace.
  const failure = await fetch(`${baseUrl}/api/listings/l_aaaaaaaaa`);
  const failureBody = (await failure.json()) as { error: Record<string, unknown> };
  assert.equal(Object.keys(failureBody.error).sort().join(','), 'code,details,fieldErrors,message,requestId');
});

test('fixed-price buy reserves inventory, pays once, and refuses publish without price', async () => {
  const priceMinor = 32_000;
  const published = await createPublishedListing({
    categoryKey: 'cars',
    titleEn: 'Buy now sedan',
    listingMethod: 'fixed_price',
    priceMinor,
    attributes: { make: 'toyota', model: 'Buy now sedan' },
  });

  const noPriceDraft = await createDraft({
    categoryKey: 'cars',
    title: { en: 'Missing price draft' },
    description: { en: 'Description long enough for validation rules.' },
    attributes: { make: 'toyota', model: 'Missing price' },
  });
  const asset = await upload(`listing_${noPriceDraft.listingReference}`, png(30, 30));
  const attached = await attachMedia(noPriceDraft.listingReference, noPriceDraft.version, [asset.body.asset!.assetId]);
  const switched = await patchListing(noPriceDraft.listingReference, {
    expectedVersion: (attached.body as { listing: ListingDto }).listing.version,
    listingMethod: 'fixed_price',
  });
  assert.equal(switched.status, 422);
  assert.ok((switched.body as { error: { fieldErrors: Record<string, string> } }).error.fieldErrors.priceMinor);

  const fulfillment = {
    fullName: 'Test Buyer',
    phone: '55556099',
    city: 'Doha',
    address: 'Al Sadd Street 12',
  };
  const buy = await customer.post<{ order: { orderReference: string; winningPriceMinor: number; source: string } }>(
    `/api/listings/${published.reference}/buy`,
    fulfillment,
  );
  assert.equal(buy.status, 201);
  assert.equal(buy.body.order.source, 'fixed_price');
  assert.equal(buy.body.order.winningPriceMinor, priceMinor);

  const stored = await handle.db.collection(COLLECTIONS.listings).findOne({ listingReference: published.reference });
  assert.equal(stored?.availability, 'sold');

  const secondBuy = await customer.post(`/api/listings/${published.reference}/buy`, fulfillment);
  assert.equal(secondBuy.status, 409);

  const browse = await fetch(`${baseUrl}/api/listings?method=fixed_price&limit=48`);
  const browseRefs = ((await browse.json()) as { listings: Array<{ listingReference: string }> }).listings.map((e) => e.listingReference);
  assert.equal(browseRefs.includes(published.reference), false);
  assert.equal((await publicListing(published.reference)).status, 200);

  const pay = await customer.post<{ order: { paymentState: string } }>('/api/payments/complete', {
    orderReference: buy.body.order.orderReference,
  });
  assert.equal(pay.status, 200);
  assert.equal(pay.body.order.paymentState, 'paid');
});

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

test('at most ten published listings can be featured', async () => {
  const existing = await handle.db.collection(COLLECTIONS.listings).countDocuments({
    status: 'published',
    archivedAt: null,
    'moderation.state': { $ne: 'blocked' },
    'featured.featured': true,
  });
  const fill = Math.max(0, 10 - existing);
  const featuredRefs: string[] = [];
  for (let i = 0; i < fill; i++) {
    const row = await createPublishedListing({
      categoryKey: 'cars',
      titleEn: `Featured cap ${Date.now()} ${i}`,
      featured: true,
      attributes: { make: 'toyota', model: `Cap ${i}` },
    });
    featuredRefs.push(row.reference);
  }

  const spare = await createPublishedListing({
    categoryKey: 'cars',
    titleEn: `Featured cap spare ${Date.now()}`,
    attributes: { make: 'nissan', model: 'Spare' },
  });
  const denied = await patchListing(spare.reference, { featured: true, expectedVersion: spare.version });
  assert.equal(denied.status, 422);
  assert.equal(
    (denied.body as { error: { fieldErrors: Record<string, string> } }).error.fieldErrors.featured,
    'At most 10 published listings can be featured. Unfeature one first.',
  );

  let victimRef = featuredRefs[0];
  if (!victimRef) {
    const one = await handle.db.collection(COLLECTIONS.listings).findOne({
      status: 'published',
      archivedAt: null,
      'moderation.state': { $ne: 'blocked' },
      'featured.featured': true,
    });
    assert.ok(one?.listingReference);
    victimRef = one!.listingReference as string;
  }
  assert.ok(victimRef);
  const loaded = await admin.get<{ listing: ListingDto }>(`/api/admin/listings/${victimRef}`);
  assert.equal(loaded.status, 200);
  const unfeatured = await patchListing(victimRef, {
    featured: false,
    expectedVersion: loaded.body.listing.version,
  });
  assert.equal(unfeatured.status, 200);

  const allowed = await patchListing(spare.reference, { featured: true, expectedVersion: spare.version });
  assert.equal(allowed.status, 200);

  const reloadSpare = await admin.get<{ listing: ListingDto }>(`/api/admin/listings/${spare.reference}`);
  const noop = await patchListing(spare.reference, {
    featured: true,
    expectedVersion: reloadSpare.body.listing.version,
  });
  assert.equal(noop.status, 200);
});

test('endingSoonHours lists live auctions closing inside the window', async () => {
  const shape = await fetch(`${baseUrl}/api/listings?endingSoonHours=2&limit=20`);
  assert.equal(shape.status, 200);
  const shapeBody = (await shape.json()) as { listings: unknown[]; filters: { endingSoonHours: number | null } };
  assert.ok(Array.isArray(shapeBody.listings));
  assert.equal(shapeBody.filters.endingSoonHours, 2);

  const published = await createPublishedListing({
    categoryKey: 'clothes-thobes',
    titleEn: `Ending soon window ${Date.now()}`,
    attributes: { item_condition: 'new', brand_name: 'Window' },
  });
  const now = Date.now();
  await openLot(published.reference, new Date(now - 60_000), new Date(now + 45 * 60_000));

  const listed = await fetch(`${baseUrl}/api/listings?endingSoonHours=2&limit=20`);
  assert.equal(listed.status, 200);
  const refs = ((await listed.json()) as { listings: Array<{ listingReference: string }> }).listings.map((row) => row.listingReference);
  assert.ok(refs.includes(published.reference));
});
