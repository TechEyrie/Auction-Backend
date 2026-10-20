import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createReplSet } from '../helpers/mongo.ts';
import { loadConfig } from '../../src/config/index.ts';
import { connectDb, type DbHandle } from '../../src/db/connection.ts';
import { COLLECTIONS, ensureIndexes } from '../../src/db/indexes.ts';
import { startServer, type RunningServer } from '../../src/server.ts';
import { silentLogger, stubMediaStorage } from '../helpers/context.ts';
import { TestClient } from '../helpers/client.ts';
import { createAdminFixture, createCustomerFixture } from '../helpers/authFixture.ts';

let replSet: MongoMemoryReplSet;
let handle: DbHandle;
let running: RunningServer;
let baseUrl: string;
let admin: TestClient;
let adminRef: string;
let customer: TestClient;

const ADMIN_PHONE = '55554000';
const ADMIN_PW = 'catalog admin pw 1';
const BOOTSTRAP_TOKEN = 'catalog-integration-token';
const CUSTOMER_PHONE = '55554001';
const CUSTOMER_PW = 'Qw9!xrTpm7k';

before(async () => {
  replSet = await createReplSet();
  const config = loadConfig({
    NODE_ENV: 'test',
    PORT: '0',
    MONGODB_URI: replSet.getUri(),
    MONGODB_DB: 'catalog_test',
    CORS_ORIGINS: 'http://localhost:3000',
    LOG_LEVEL: 'error',
    MFA_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
    ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
  });
  handle = await connectDb(config);
  await ensureIndexes(handle.db);
  running = await startServer({ config, logger: silentLogger(), db: handle, mediaStorage: stubMediaStorage() });
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
});

async function createSellerBody(overrides: Record<string, unknown> = {}) {
  return {
    type: 'individual',
    displayName: 'Amina Al Mansoori',
    contact: { contactName: 'Amina', phone: '55554010', email: 'amina@example.com' },
    address: { line1: 'Villa 12, Street 900', locationKey: null, publicPrecision: 'city' },
    internalNotes: 'Prefers phone calls after 6pm',
    ...overrides,
  };
}

test('D01 seller CRUD is permissioned, audited and paginated', async () => {
  // Anonymous and customer callers get nothing.
  const anon = await fetch(`${baseUrl}/api/admin/sellers`);
  assert.equal(anon.status, 401);
  assert.equal((await customer.get('/api/admin/sellers')).status, 403);
  assert.equal((await customer.post('/api/admin/sellers', await createSellerBody())).status, 403);

  const created = await admin.post('/api/admin/sellers', await createSellerBody());
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const seller = (created.body as { seller: { sellerReference: string; status: string; createdBy: string } }).seller;
  assert.match(seller.sellerReference, /^s_/);
  assert.equal(seller.status, 'active');
  assert.equal(seller.createdBy, adminRef);

  const read = await admin.get(`/api/admin/sellers/${seller.sellerReference}`);
  assert.equal(read.status, 200);

  const updated = await admin.patch(`/api/admin/sellers/${seller.sellerReference}`, {
    displayName: 'Amina Al Mansoori Trading',
    internalNotes: 'Confirmed by phone',
  });
  assert.equal(updated.status, 200);
  assert.equal((updated.body as { seller: { displayName: string } }).seller.displayName, 'Amina Al Mansoori Trading');

  // Every mutation is audited with the actor and target.
  const audits = await handle.db
    .collection(COLLECTIONS.auditLogs)
    .find({ targetType: 'seller', targetId: seller.sellerReference })
    .toArray();
  const actions = audits.map((entry) => entry.action).sort();
  assert.deepEqual(actions, ['seller.created', 'seller.updated']);
  assert.ok(audits.every((entry) => entry.actorId === adminRef));

  // Pagination is stable and bounded.
  await admin.post('/api/admin/sellers', await createSellerBody({ contact: { phone: '55554011' }, displayName: 'Second Seller' }));
  const firstPage = await admin.get('/api/admin/sellers?limit=1&page=1');
  const secondPage = await admin.get('/api/admin/sellers?limit=1&page=2');
  const firstBody = firstPage.body as { sellers: Array<{ sellerReference: string }>; total: number; totalPages: number };
  const secondBody = secondPage.body as { sellers: Array<{ sellerReference: string }> };
  assert.equal(firstBody.sellers.length, 1);
  assert.equal(firstBody.total, 2);
  assert.equal(firstBody.totalPages, 2);
  assert.notEqual(firstBody.sellers[0]!.sellerReference, secondBody.sellers[0]!.sellerReference);

  const searched = await admin.get('/api/admin/sellers?search=second');
  assert.equal((searched.body as { sellers: unknown[] }).sellers.length, 1);

  const limited = await admin.get('/api/admin/sellers?limit=500');
  assert.equal(limited.status, 422, 'an oversized page limit must be rejected, not silently clamped');
});

test('D01 duplicate sellers are refused by unique constraints, not by a racy read', async () => {
  const body = await createSellerBody({
    displayName: 'Duplicate Probe',
    contact: { phone: '55554012', email: 'dup@example.com' },
  });
  const first = await admin.post('/api/admin/sellers', body);
  assert.equal(first.status, 201);
  const second = await admin.post('/api/admin/sellers', body);
  assert.equal(second.status, 409);
  assert.match((second.body as { error: { message: string } }).error.message, /phone number already exists/i);

  const otherPhone = await admin.post(
    '/api/admin/sellers',
    await createSellerBody({
      type: 'company',
      displayName: 'Duplicate Company',
      legalName: 'Araq Trading WLL',
      contact: { phone: '55554013' },
    }),
  );
  assert.equal(otherPhone.status, 201);
  const sameCompany = await admin.post(
    '/api/admin/sellers',
    await createSellerBody({
      type: 'company',
      displayName: 'Duplicate Company Two',
      legalName: 'Araq Trading WLL',
      contact: { phone: '55554014' },
    }),
  );
  assert.equal(sameCompany.status, 409);
  assert.match((sameCompany.body as { error: { message: string } }).error.message, /identity already exists/i);
});

test('D02 the public seller DTO excludes private details', async () => {
  const created = await admin.post(
    '/api/admin/sellers',
    await createSellerBody({
      displayName: 'Private Probe',
      contact: { contactName: 'Private Person', phone: '55554020', email: 'private@example.com' },
      address: { line1: 'Villa 99, Al Sadd', publicPrecision: 'city' },
      internalNotes: 'Never share this note',
      settlement: { method: 'bank_transfer', bankName: 'QNB', iban: 'QA58DOHB00001234567890ABCDEFG', accountName: 'Private Probe' },
    }),
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const reference = (created.body as { seller: { sellerReference: string } }).seller.sellerReference;

  const publicView = await fetch(`${baseUrl}/api/catalog/sellers/${reference}`);
  assert.equal(publicView.status, 200);
  const publicBody = (await publicView.json()) as { seller: Record<string, unknown> };
  const serialized = JSON.stringify(publicBody);
  for (const secret of [
    'private@example.com',
    '+97455554020',
    'Villa 99',
    'Never share this note',
    'QA58DOHB00001234567890ABCDEFG',
    'iban',
    'settlement',
    'internalNotes',
    'contact',
    'address',
  ]) {
    assert.ok(!serialized.includes(secret), `public seller DTO leaked ${secret}`);
  }
  assert.equal(publicBody.seller.sellerReference, reference);
  assert.equal(publicBody.seller.displayName, 'Private Probe');
  assert.equal(publicBody.seller.verificationBadge, false);

  // The admin view does include them ...
  const adminView = await admin.get(`/api/admin/sellers/${reference}`);
  const adminSeller = (adminView.body as { seller: Record<string, unknown> }).seller;
  assert.equal(adminSeller.internalNotes, 'Never share this note');
  assert.ok(JSON.stringify(adminSeller).includes('private@example.com'));

  // ... but the stored IBAN is returned masked even to the admin.
  const settlement = adminSeller.settlement as { ibanMasked: string } | null;
  assert.ok(settlement, 'a settlement-managing admin should see settlement status');
  assert.match(settlement.ibanMasked, /••••/);
  assert.ok(!JSON.stringify(adminSeller).includes('QA58DOHB00001234567890ABCDEFG'));

  // Archiving removes the seller from public view without deleting the record.
  const archived = await admin.patch(`/api/admin/sellers/${reference}/status`, {
    status: 'archived',
    reason: 'duplicate record from migration',
  });
  assert.equal(archived.status, 200);
  assert.equal((await fetch(`${baseUrl}/api/catalog/sellers/${reference}`)).status, 404);
  assert.equal((await admin.get(`/api/admin/sellers/${reference}`)).status, 200);
  const archiveAudit = await handle.db
    .collection(COLLECTIONS.auditLogs)
    .findOne({ action: 'seller.archived', targetId: reference });
  assert.equal(archiveAudit?.reason, 'duplicate record from migration');
});

test('D01 verification requires evidence and records the actor and reason', async () => {
  const created = await admin.post(
    '/api/admin/sellers',
    await createSellerBody({ displayName: 'Verify Probe', contact: { phone: '55554021' } }),
  );
  const reference = (created.body as { seller: { sellerReference: string } }).seller.sellerReference;

  const withoutEvidence = await admin.patch(`/api/admin/sellers/${reference}/verification`, {
    state: 'verified',
    reason: 'documents checked',
  });
  assert.equal(withoutEvidence.status, 422);

  const verified = await admin.patch(`/api/admin/sellers/${reference}/verification`, {
    state: 'verified',
    reason: 'QID and CR checked in person',
    evidence: [{ kind: 'qid', reference: 'QID-4471-2026', note: 'checked at counter' }],
  });
  assert.equal(verified.status, 200);
  const seller = (verified.body as { seller: { verification: { state: string; evidence: unknown[]; lastActor: string } } }).seller;
  assert.equal(seller.verification.state, 'verified');
  assert.equal(seller.verification.evidence.length, 1);
  assert.equal(seller.verification.lastActor, adminRef);

  const publicView = await fetch(`${baseUrl}/api/catalog/sellers/${reference}`);
  const publicBody = (await publicView.json()) as { seller: { verificationBadge: boolean } };
  assert.equal(publicBody.seller.verificationBadge, true);

  const audit = await handle.db
    .collection(COLLECTIONS.auditLogs)
    .findOne({ action: 'seller.verification.changed', targetId: reference });
  assert.equal(audit?.reason, 'QID and CR checked in person');
});

test('D03 category hierarchy rejects duplicates, cycles and invalid parents', async () => {
  const anonymous = await fetch(`${baseUrl}/api/admin/categories`);
  assert.equal(anonymous.status, 401);
  assert.equal((await customer.post('/api/admin/categories', {})).status, 403);

  const root = await admin.post('/api/admin/categories', {
    key: 'vehicles',
    parentKey: null,
    nameEn: 'Vehicles',
    nameAr: 'مركبات',
    listingMethods: ['auction', 'fixed_price'],
  });
  assert.equal(root.status, 201, JSON.stringify(root.body));

  const duplicate = await admin.post('/api/admin/categories', {
    key: 'vehicles',
    parentKey: null,
    nameEn: 'Vehicles again',
    listingMethods: ['auction'],
  });
  assert.equal(duplicate.status, 409);

  const child = await admin.post('/api/admin/categories', {
    key: 'cars',
    parentKey: 'vehicles',
    nameEn: 'Cars',
    listingMethods: ['auction'],
  });
  assert.equal(child.status, 201);
  const grandchild = await admin.post('/api/admin/categories', {
    key: 'sedans',
    parentKey: 'cars',
    nameEn: 'Sedans',
    listingMethods: ['auction'],
  });
  assert.equal(grandchild.status, 201);

  // Unknown parent.
  const badParent = await admin.post('/api/admin/categories', {
    key: 'orphans',
    parentKey: 'does-not-exist',
    nameEn: 'Orphans',
    listingMethods: ['auction'],
  });
  assert.equal(badParent.status, 422);

  // Direct cycle: moving the root under its own descendant.
  const cycle = await admin.patch('/api/admin/categories/vehicles', { parentKey: 'sedans' });
  assert.equal(cycle.status, 409);
  assert.match((cycle.body as { error: { message: string } }).error.message, /cannot be moved under itself/i);

  // Self-parenting.
  assert.equal((await admin.patch('/api/admin/categories/cars', { parentKey: 'cars' })).status, 409);

  // Depth limit.
  await admin.post('/api/admin/categories', { key: 'level4', parentKey: 'sedans', nameEn: 'Level four', listingMethods: ['auction'] });
  const tooDeep = await admin.post('/api/admin/categories', {
    key: 'level5',
    parentKey: 'level4',
    nameEn: 'Level five',
    listingMethods: ['auction'],
  });
  assert.equal(tooDeep.status, 422);

  // The tree is intact after all the rejected attempts.
  const tree = await admin.get('/api/admin/categories');
  const keys = (tree.body as { categories: Array<{ key: string; depth: number; ancestors: string[] }> }).categories;
  assert.equal(keys.find((c) => c.key === 'sedans')?.ancestors.join('>'), 'vehicles>cars');
  assert.equal(keys.find((c) => c.key === 'vehicles')?.depth, 0);
});

test('D03 competing hierarchy edits cannot create a cycle', async () => {
  await admin.post('/api/admin/categories', { key: 'a-root', parentKey: null, nameEn: 'A root', listingMethods: ['auction'] });
  await admin.post('/api/admin/categories', { key: 'a-child', parentKey: 'a-root', nameEn: 'A child', listingMethods: ['auction'] });

  // Two admins simultaneously try to make each node the parent of the other.
  const [first, second] = await Promise.all([
    admin.patch('/api/admin/categories/a-root', { parentKey: 'a-child' }),
    admin.patch('/api/admin/categories/a-child', { parentKey: 'a-root' }),
  ]);

  const stored = await handle.db.collection(COLLECTIONS.categories).find({ key: { $in: ['a-root', 'a-child'] } }).toArray();
  const byKey = new Map(stored.map((doc) => [doc.key, doc]));
  const root = byKey.get('a-root')!;
  const child = byKey.get('a-child')!;
  const isCycle = root.parentKey === 'a-child' && child.parentKey === 'a-root';
  assert.equal(isCycle, false, `concurrent moves produced a cycle (statuses ${first.status}/${second.status})`);

  // Whichever edit won, the ancestor chains must still be consistent with the parent pointers.
  for (const doc of stored) {
    assert.equal(doc.ancestors.at(-1) ?? null, doc.parentKey);
    assert.ok(!doc.ancestors.includes(doc.key), 'a category must not be its own ancestor');
  }
  assert.ok([first.status, second.status].every((status) => [200, 409].includes(status)));
  assert.equal(stored.every((doc) => doc.depth <= 4), true);
});

test('D03 category icons are validated and exposed publicly', async () => {
  const iconsRes = await fetch(`${baseUrl}/api/catalog/category-icons`);
  assert.equal(iconsRes.status, 200);
  const iconsBody = (await iconsRes.json()) as { icons: Array<{ key: string; label: string }> };
  assert.ok(iconsBody.icons.some((entry) => entry.key === 'watches'));

  const badIcon = await admin.post('/api/admin/categories', {
    key: 'bad-icon-cat',
    parentKey: null,
    nameEn: 'Bad icon',
    listingMethods: ['auction'],
    icon: 'nope',
  });
  assert.equal(badIcon.status, 422);

  const watchesRoot = await admin.post('/api/admin/categories', {
    key: 'watches',
    parentKey: null,
    nameEn: 'Watches catalogue',
    listingMethods: ['auction', 'fixed_price'],
    icon: 'watches',
  });
  assert.equal(watchesRoot.status, 201, JSON.stringify(watchesRoot.body));

  const child = await admin.post('/api/admin/categories', {
    key: 'watch-styles',
    parentKey: 'watches',
    nameEn: 'Watch styles',
    listingMethods: ['auction'],
    icon: 'watches',
  });
  assert.equal(child.status, 201, JSON.stringify(child.body));

  const publicTree = await fetch(`${baseUrl}/api/catalog/categories`);
  const publicCategories = (await publicTree.json() as { categories: Array<{ key: string; icon: string | null }> }).categories;
  const styled = publicCategories.find((c) => c.key === 'watch-styles');
  assert.ok(styled, 'catalogue child must appear in public taxonomy');
  assert.equal(styled!.icon, 'watches');
});

test('D03 archiving is reversible and refuses to strand active children', async () => {
  await admin.post('/api/admin/categories', { key: 'archive-root', parentKey: null, nameEn: 'Archive root', listingMethods: ['auction'] });
  await admin.post('/api/admin/categories', { key: 'archive-child', parentKey: 'archive-root', nameEn: 'Archive child', listingMethods: ['auction'] });

  const blocked = await admin.post('/api/admin/categories/archive-root/archive', { reason: 'cleanup' });
  assert.equal(blocked.status, 409);
  assert.match((blocked.body as { error: { message: string } }).error.message, /subcategories/i);

  assert.equal((await admin.post('/api/admin/categories/archive-child/archive', { reason: 'cleanup' })).status, 200);
  assert.equal((await admin.post('/api/admin/categories/archive-root/archive', { reason: 'cleanup' })).status, 200);

  const publicTree = await fetch(`${baseUrl}/api/catalog/categories`);
  const publicKeys = (await publicTree.json() as { categories: Array<{ key: string }> }).categories.map((c) => c.key);
  assert.ok(!publicKeys.includes('archive-root'), 'archived categories must disappear from public taxonomy');

  const adminTree = await admin.get('/api/admin/categories?includeInactive=true');
  const adminKeys = (adminTree.body as { categories: Array<{ key: string }> }).categories.map((c) => c.key);
  assert.ok(adminKeys.includes('archive-root'), 'admins still see archived categories');

  assert.equal((await admin.post('/api/admin/categories/archive-root/restore', { reason: 're-open' })).status, 200);
  const afterRestore = await fetch(`${baseUrl}/api/catalog/categories`);
  assert.ok((await afterRestore.json() as { categories: Array<{ key: string }> }).categories.some((c) => c.key === 'archive-root'));
});

test('D04/D06 attribute schema versions validate values and preserve history', async () => {
  await admin.post('/api/admin/categories', { key: 'electronics', parentKey: null, nameEn: 'Electronics', listingMethods: ['auction', 'fixed_price'] });

  const draftBody = {
    categoryKey: 'electronics',
    fields: [
      { key: 'brand', type: 'select', labelEn: 'Brand', required: true, filterable: true, options: [{ key: 'apple', labelEn: 'Apple' }, { key: 'samsung', labelEn: 'Samsung' }] },
      { key: 'storage_gb', type: 'number', labelEn: 'Storage', unit: 'GB', constraints: { min: 8, max: 4096, integer: true } },
      { key: 'is_sealed', type: 'boolean', labelEn: 'Sealed' },
      { key: 'battery_health', type: 'number', labelEn: 'Battery health', dependsOn: { field: 'is_sealed', equals: false } },
      { key: 'internal_grade', type: 'text', labelEn: 'Internal grade', adminOnly: true },
    ],
  };
  const draft = await admin.post('/api/admin/attribute-schemas', draftBody);
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const version1 = (draft.body as { schema: { _id: string; version: number; status: string } }).schema;
  assert.equal(version1.version, 1);
  assert.equal(version1.status, 'draft');

  const published = await admin.post(`/api/admin/attribute-schemas/${version1._id}/publish`, {});
  assert.equal(published.status, 200);
  assert.equal((published.body as { schema: { status: string } }).schema.status, 'published');

  // Values are validated by the server for the category's current version.
  const valid = await admin.post('/api/admin/attribute-schemas/electronics/validate', {
    values: { brand: 'apple', storage_gb: 256, is_sealed: false, battery_health: 89 },
  });
  assert.equal(valid.status, 200, JSON.stringify(valid.body));

  const invalid = await admin.post('/api/admin/attribute-schemas/electronics/validate', {
    values: { brand: 'nokia', storage_gb: 12.5, is_sealed: false },
  });
  assert.equal(invalid.status, 422);
  const errors = (invalid.body as { errors: Record<string, string> }).errors;
  assert.equal(errors.brand, 'not one of the allowed options');
  assert.equal(errors.storage_gb, 'must be a whole number');

  // D06: publishing version 2 archives version 1 but leaves it fully readable.
  const draft2 = await admin.post('/api/admin/attribute-schemas', {
    categoryKey: 'electronics',
    fields: [...draftBody.fields, { key: 'colour', type: 'text', labelEn: 'Colour' }],
  });
  const version2 = (draft2.body as { schema: { _id: string; version: number } }).schema;
  assert.equal(version2.version, 2);
  assert.equal((await admin.post(`/api/admin/attribute-schemas/${version2._id}/publish`, {})).status, 200);

  const historical = await admin.get(`/api/admin/attribute-schemas/${version1._id}`);
  assert.equal(historical.status, 200);
  const oldSchema = (historical.body as { schema: { status: string; fields: Array<{ key: string }>; version: number } }).schema;
  assert.equal(oldSchema.status, 'archived');
  assert.equal(oldSchema.version, 1);
  assert.ok(!oldSchema.fields.some((field) => field.key === 'colour'));

  // A published version is immutable; edits require a new draft.
  const editPublished = await admin.patch(`/api/admin/attribute-schemas/${version1._id}`, { notes: 'changed my mind' });
  assert.equal(editPublished.status, 409);

  // Values can still be validated against the old version.
  const againstV1 = await admin.post('/api/admin/attribute-schemas/electronics/validate', {
    values: { brand: 'samsung', colour: 'blue' },
    version: 1,
  });
  assert.equal(againstV1.status, 422, 'a field that only exists in v2 must fail against v1');
  assert.equal((againstV1.body as { errors: Record<string, string> }).errors.colour, 'unknown attribute for this category');

  const category = await admin.get('/api/admin/categories');
  const electronics = (category.body as { categories: Array<{ key: string; attributeSchemaVersion: number | null }> }).categories.find((c) => c.key === 'electronics');
  assert.equal(electronics?.attributeSchemaVersion, 2, 'the category points at the current published version');
});

test('D05 unknown and admin-only attribute injection fails for a public audience', async () => {
  const publicSchema = await fetch(`${baseUrl}/api/catalog/attribute-schemas/electronics/current`);
  assert.equal(publicSchema.status, 200);
  const publicSchemaBody = (await publicSchema.json()) as { schema: { fields: Array<{ key: string; adminOnly: boolean }> } };
  const fields = publicSchemaBody.schema.fields.map((f) => f.key);
  assert.ok(!fields.includes('internal_grade'), 'admin-only fields must not be published');

  const asPublic = await admin.post('/api/admin/attribute-schemas/electronics/validate', {
    values: { brand: 'apple', internal_grade: 'A', something_else: 'x' },
    audience: 'public',
  });
  assert.equal(asPublic.status, 422);
  const errors = (asPublic.body as { errors: Record<string, string> }).errors;
  assert.equal(errors.internal_grade, 'this attribute is admin-only');
  assert.equal(errors.something_else, 'unknown attribute for this category');

  const asAdmin = await admin.post('/api/admin/attribute-schemas/electronics/validate', {
    values: { brand: 'apple', internal_grade: 'A' },
    audience: 'admin',
  });
  assert.equal(asAdmin.status, 200, JSON.stringify(asAdmin.body));
  assert.equal((asAdmin.body as { values: Record<string, unknown> }).values.internal_grade, 'A');
});

test('D05 an invalid schema definition is rejected before it can be stored', async () => {
  const cyclic = await admin.post('/api/admin/attribute-schemas', {
    categoryKey: 'electronics',
    fields: [
      { key: 'flag_a', type: 'boolean', labelEn: 'Flag A', dependsOn: { field: 'flag_b', equals: true } },
      { key: 'flag_b', type: 'boolean', labelEn: 'Flag B', dependsOn: { field: 'flag_a', equals: true } },
    ],
  });
  assert.equal(cyclic.status, 422);
  assert.match((cyclic.body as { error: { message: string } }).error.message, /cycle/i);

  const stored = await handle.db.collection(COLLECTIONS.attributeSchemas).countDocuments({ categoryKey: 'electronics' });
  assert.equal(stored, 2, 'the rejected schema must not be persisted');

  const unknownCategory = await admin.post('/api/admin/attribute-schemas', {
    categoryKey: 'no-such-category',
    fields: [{ key: 'brand', type: 'text', labelEn: 'Brand' }],
  });
  assert.equal(unknownCategory.status, 422);
});

test('D07 locations validate identifiers and coordinates and apply public precision', async () => {
  const created = await admin.post('/api/admin/locations', {
    countryCode: 'qa',
    cityKey: 'doha',
    areaKey: 'al-sadd',
    labelEn: 'Al Sadd, Doha',
    labelAr: 'السد، الدوحة',
    coordinates: { lat: 25.2854, lng: 51.531 },
    publicPrecision: 'city',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const location = (created.body as { location: { key: string; countryCode: string; point: { coordinates: number[] } } }).location;
  assert.equal(location.countryCode, 'QA');
  assert.equal(location.key, 'qa-doha-al-sadd');
  assert.deepEqual(location.point.coordinates, [51.531, 25.2854], 'GeoJSON stores [lng, lat]');

  // Duplicates and bad input.
  assert.equal(
    (await admin.post('/api/admin/locations', { countryCode: 'QA', cityKey: 'doha', areaKey: 'al-sadd', labelEn: 'Duplicate' })).status,
    409,
  );
  assert.equal(
    (await admin.post('/api/admin/locations', { countryCode: 'QAT', cityKey: 'doha', areaKey: 'west-bay', labelEn: 'Bad country' })).status,
    422,
  );
  assert.equal(
    (await admin.post('/api/admin/locations', { countryCode: 'QA', cityKey: 'doha', areaKey: 'west-bay', labelEn: 'Bad lat', coordinates: { lat: 91, lng: 51 } })).status,
    422,
  );
  assert.equal(
    (await admin.post('/api/admin/locations', { countryCode: 'QA', cityKey: 'doha', areaKey: 'west-bay', labelEn: 'Bad lng', coordinates: { lat: 25, lng: 181 } })).status,
    422,
  );
  assert.equal(
    (await admin.post('/api/admin/locations', { countryCode: 'QA', cityKey: 'DOHA CITY', areaKey: 'west-bay', labelEn: 'Bad slug' })).status,
    422,
  );

  // Public list applies the precision policy: no exact coordinates unless opted in.
  const publicList = await fetch(`${baseUrl}/api/catalog/locations?country=QA`);
  assert.equal(publicList.status, 200);
  const entry = (await publicList.json() as { locations: Array<{ key: string; areaKey: string | null; coordinates: unknown }> }).locations.find((l) => l.key === 'qa-doha-al-sadd');
  assert.ok(entry);
  assert.equal(entry!.areaKey, 'al-sadd', 'catalog identity keeps areaKey at city precision');
  assert.equal(entry!.coordinates, null, 'exact coordinates are not published by default');

  const exact = await admin.post('/api/admin/locations', {
    countryCode: 'QA',
    cityKey: 'doha',
    areaKey: 'pearl',
    labelEn: 'The Pearl, Doha',
    coordinates: { lat: 25.3685, lng: 51.5515 },
    publicPrecision: 'exact',
  });
  assert.equal(exact.status, 201);
  const afterExact = await fetch(`${baseUrl}/api/catalog/locations?country=QA`);
  const pearl = (await afterExact.json() as { locations: Array<{ key: string; coordinates: number[] | null }> }).locations.find((l) => l.key === 'qa-doha-pearl');
  assert.deepEqual(pearl?.coordinates, [51.5515, 25.3685]);

  // Inactive locations stay out of public lists but remain visible to admins.
  assert.equal((await admin.patch('/api/admin/locations/qa-doha-al-sadd', { active: false })).status, 200);
  const publicAfter = await fetch(`${baseUrl}/api/catalog/locations?country=QA`);
  assert.ok(!(await publicAfter.json() as { locations: Array<{ key: string }> }).locations.some((l) => l.key === 'qa-doha-al-sadd'));
  const adminList = await admin.get('/api/admin/locations');
  assert.ok((adminList.body as { locations: Array<{ key: string }> }).locations.some((l) => l.key === 'qa-doha-al-sadd'));
});

test('D12 public taxonomy and admin taxonomy come from the same records', async () => {
  const publicTree = await fetch(`${baseUrl}/api/catalog/categories`);
  const publicKeys = (await publicTree.json() as { categories: Array<{ key: string; name: string }> }).categories;
  const adminTree = await admin.get('/api/admin/categories?includeInactive=true');
  const adminKeys = (adminTree.body as { categories: Array<{ key: string; active: boolean; name: string }> }).categories;

  assert.ok(publicKeys.length > 0);
  const activeAdminKeys = adminKeys.filter((c) => c.active).map((c) => c.key);
  assert.deepEqual(
    publicKeys.map((c) => c.key).sort(),
    activeAdminKeys.sort(),
    'public and admin taxonomy must agree on which categories are active',
  );
  for (const publicCategory of publicKeys) {
    const adminCategory = adminKeys.find((c) => c.key === publicCategory.key);
    assert.equal(adminCategory?.name, publicCategory.name, 'labels come from the same field');
  }
});
