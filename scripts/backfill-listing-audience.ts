import { loadConfig } from '../src/config/index.ts';
import { connectDb } from '../src/db/connection.ts';
import { COLLECTIONS } from '../src/db/indexes.ts';
import { AUDIENCES, type Audience, type ListingDoc } from '../src/modules/listings/models.ts';
import { createLogger } from '../src/shared/logger.ts';
import { assertSeedTarget } from './seed.ts';

/**
 * One-shot dev helper: assign `audience` on listings that never had it.
 * Alternates men/women by published order so both filters have demo data.
 */
export async function backfillListingAudience(db: import('mongodb').Db): Promise<{ updated: number; women: number }> {
  const collection = db.collection<ListingDoc>(COLLECTIONS.listings);
  const missing = await collection
    .find({ $or: [{ audience: null }, { audience: { $exists: false } }] })
    .sort({ publishedAt: 1, listingReference: 1 })
    .toArray();

  let index = 0;
  let women = 0;
  for (const listing of missing) {
    const audience: Audience = AUDIENCES[index % AUDIENCES.length]!;
    await collection.updateOne({ listingReference: listing.listingReference }, { $set: { audience } });
    if (audience === 'women') women += 1;
    index += 1;
  }

  if (women === 0 && (await collection.countDocuments({ status: 'published', audience: 'women' })) === 0) {
    const firstPublished = await collection.findOne(
      { status: 'published', audience: 'men' },
      { sort: { publishedAt: -1, listingReference: 1 } },
    );
    if (firstPublished) {
      await collection.updateOne({ listingReference: firstPublished.listingReference }, { $set: { audience: 'women' } });
      women = 1;
    }
  }

  return { updated: missing.length, women };
}

async function main(): Promise<void> {
  assertSeedTarget(process.env, process.argv.slice(2));
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const handle = await connectDb(config);
  try {
    const summary = await backfillListingAudience(handle.db);
    logger.info('listing audience backfill complete', { database: config.mongodbDb, ...summary });
  } finally {
    await handle.close();
  }
}

const invokedPath = process.argv[1];
if (invokedPath && invokedPath.endsWith('backfill-listing-audience.ts')) {
  main().catch((err: unknown) => {
    process.stderr.write(`backfill failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
