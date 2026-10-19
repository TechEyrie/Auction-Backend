import { loadConfig } from '../src/config/index.ts';
import { connectDb } from '../src/db/connection.ts';
import { COLLECTIONS } from '../src/db/indexes.ts';
import type { ListingDoc } from '../src/modules/listings/models.ts';
import { createTaxonomyService } from '../src/modules/taxonomy/service.ts';
import { isCatalogueCategory } from '../src/modules/taxonomy/models.ts';
import { mapListingCategory } from '../src/modules/taxonomy/mapListingCategory.ts';
import { createLogger } from '../src/shared/logger.ts';
import { seedCatalog } from './seed-catalog.ts';
import { assertSeedTarget } from './seed.ts';

const ACTOR = { reference: 'system:migrate-men-women-catalogue', requestId: 'catalogue-migrate' } as const;
const ARCHIVE_REASON = 'Replaced by product catalogue parents';

async function main(): Promise<void> {
  assertSeedTarget(process.env, process.argv.slice(2));
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const handle = await connectDb(config);
  try {
    const seed = await seedCatalog({
      db: handle.db,
      logger,
      withTransaction: handle.withTransaction,
    });

    const taxonomy = createTaxonomyService({
      db: handle.db,
      logger,
      withTransaction: handle.withTransaction,
    });

    const listings = handle.db.collection<ListingDoc>(COLLECTIONS.listings);
    const allListings = await listings.find({}).toArray();
    let listingsUpdated = 0;
    for (const listing of allListings) {
      const titleEn = listing.title?.en ?? '';
      const mapped = mapListingCategory(listing.audience ?? null, titleEn);
      const category = await taxonomy.getByKey(mapped.categoryKey);
      if (!category) {
        logger.warn('mapped category missing after seed', { listingReference: listing.listingReference, categoryKey: mapped.categoryKey });
        continue;
      }
      await listings.updateOne(
        { listingReference: listing.listingReference },
        {
          $set: {
            categoryKey: category.key,
            categoryPath: [...category.ancestors, category.key],
            updatedAt: new Date(),
          },
        },
      );
      listingsUpdated += 1;
    }

    const allCategories = await handle.db.collection(COLLECTIONS.categories).find({}).toArray();
    const toArchive = allCategories
      .filter((category) => category.active && !isCatalogueCategory(String(category.key), category.ancestors ?? []))
      .sort((left, right) => (right.depth ?? 0) - (left.depth ?? 0));

    let categoriesArchived = 0;
    for (const category of toArchive) {
      if (!category.active || category.archivedAt) continue;
      await taxonomy.archive(String(category.key), ARCHIVE_REASON, ACTOR);
      categoriesArchived += 1;
    }

    logger.info('men/women catalogue migration complete', {
      database: config.mongodbDb,
      seed,
      listingsUpdated,
      categoriesArchived,
      listingsTotal: allListings.length,
    });
  } finally {
    await handle.close();
  }
}

const invokedPath = process.argv[1];
if (invokedPath && invokedPath.endsWith('migrate-men-women-catalogue.ts')) {
  main().catch((err: unknown) => {
    process.stderr.write(`catalogue migration failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
