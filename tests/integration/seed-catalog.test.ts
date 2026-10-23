import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createReplSet } from '../helpers/mongo.ts';
import { connectDb, type DbHandle } from '../../src/db/connection.ts';
import { loadConfig } from '../../src/config/index.ts';
import { COLLECTIONS, ensureIndexes } from '../../src/db/indexes.ts';
import { silentLogger } from '../helpers/context.ts';
import { seedCatalog, CATEGORY_SEED, SCHEMA_SEED, LOCATION_SEED } from '../../scripts/seed-catalog.ts';
import { isCatalogueCategory } from '../../src/modules/taxonomy/models.ts';
import { createTaxonomyService } from '../../src/modules/taxonomy/service.ts';
import { createAttributeService } from '../../src/modules/attributes/service.ts';
import { createLocationService } from '../../src/modules/locations/service.ts';

/**
 * The seed is the only supported way to get a development database into a usable state,
 * so it runs against a real `mongod` replica set here: unique indexes, transactions and
 * the taxonomy/attribute services are all exercised for real.
 */

let replSet: MongoMemoryReplSet;
let handle: DbHandle;

const CATEGORY_COUNT = CATEGORY_SEED.reduce((total, root) => total + 1 + (root.children?.length ?? 0), 0);
const VISIBLE_CATEGORY_COUNT = 10;

before(async () => {
  replSet = await createReplSet();
  const config = loadConfig({
    NODE_ENV: 'test',
    PORT: '0',
    MONGODB_URI: replSet.getUri(),
    MONGODB_DB: 'seed_catalog_test',
    CORS_ORIGINS: 'http://localhost:3000',
    LOG_LEVEL: 'error',
    MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    ADMIN_BOOTSTRAP_TOKEN: 'seed-catalog-token',
  });
  handle = await connectDb(config);
  await ensureIndexes(handle.db);
});

after(async () => {
  if (handle) await handle.close();
  if (replSet) await replSet.stop();
});

test('the seed creates the representative catalogue once and is idempotent', async () => {
  const deps = { db: handle.db, logger: silentLogger(), withTransaction: handle.withTransaction };

  const first = await seedCatalog(deps);
  assert.equal(first.categoriesCreated, CATEGORY_COUNT);
  assert.equal(first.schemasPublished, Object.keys(SCHEMA_SEED).length);
  assert.equal(first.locationsCreated, LOCATION_SEED.length);

  const second = await seedCatalog(deps);
  assert.deepEqual(second, { categoriesCreated: 0, schemasPublished: 0, locationsCreated: 0 }, 'a re-run must add nothing');

  const categories = await handle.db.collection(COLLECTIONS.categories).countDocuments({});
  assert.equal(categories, CATEGORY_COUNT, 'no duplicate categories');
  const locations = await handle.db.collection(COLLECTIONS.locations).countDocuments({});
  assert.equal(locations, LOCATION_SEED.length);
});

test('every seeded category has a published attribute schema as its current version', async () => {
  const attributes = createAttributeService({ db: handle.db, logger: silentLogger(), withTransaction: handle.withTransaction });
  const taxonomy = createTaxonomyService({ db: handle.db, logger: silentLogger(), withTransaction: handle.withTransaction });

  for (const categoryKey of Object.keys(SCHEMA_SEED)) {
    const category = await taxonomy.getByKey(categoryKey);
    assert.ok(category, `${categoryKey} exists`);
    assert.equal(category.currentAttributeSchemaVersion, 1, `${categoryKey} points at version 1`);

    const current = await attributes.currentForCategory(categoryKey);
    assert.ok(current, `${categoryKey} has a published schema`);
    assert.equal(current.status, 'published');
    assert.equal(current.version, 1);
    assert.equal(current.fields.length, SCHEMA_SEED[categoryKey]!.length);
  }
});

test('seeded schemas stay valid and leaf categories allow auction', async () => {
  const attributes = createAttributeService({ db: handle.db, logger: silentLogger(), withTransaction: handle.withTransaction });
  const taxonomy = createTaxonomyService({ db: handle.db, logger: silentLogger(), withTransaction: handle.withTransaction });

  const result = await attributes.validateValues(
    'perfume',
    { item_condition: 'new', brand_name: 'Oud House' },
    'public',
  );
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const injected = await attributes.validateValues('perfume', { item_condition: 'new', nonsense: 1 }, 'public');
  assert.equal(injected.ok, false, 'an unknown attribute key must not be accepted');
  assert.match(String(injected.errors.nonsense), /unknown/i);

  const categories = await taxonomy.list(true);
  assert.equal(categories.length, VISIBLE_CATEGORY_COUNT);
  for (const category of categories) {
    assert.ok(
      category.listingMethods.includes('auction'),
      `${category.key} must allow auction listings`,
    );
  }

  const locations = await createLocationService({ db: handle.db, logger: silentLogger() }).list({ includeInactive: true });
  assert.ok(locations.every((location) => location.countryCode === 'QA'));
  assert.ok(locations.some((location) => location.point !== null), 'at least one area carries validated coordinates');
});

test('taxonomy list shows only the product catalogue parents', async () => {
  const taxonomy = createTaxonomyService({ db: handle.db, logger: silentLogger(), withTransaction: handle.withTransaction });
  const forbidden = new Set(['jobs', 'property', 'vehicles', 'general', 'men', 'women']);
  for (const includeInactive of [false, true]) {
    const listed = await taxonomy.list(includeInactive);
    for (const category of listed) {
      assert.equal(isCatalogueCategory(category.key, category.ancestors), true, `${category.key} must be catalogue`);
      assert.equal(forbidden.has(category.key), false, `${category.key} must not appear in list(${includeInactive})`);
    }
  }
});
