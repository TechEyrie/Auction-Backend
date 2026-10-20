import { loadConfig } from '../src/config/index.ts';
import { connectDb } from '../src/db/connection.ts';
import { backfillCategoryIcons } from '../src/modules/taxonomy/backfillCategoryIcons.ts';
import { createLogger } from '../src/shared/logger.ts';
import { assertSeedTarget } from './seed.ts';

async function main(): Promise<void> {
  assertSeedTarget(process.env, process.argv.slice(2));
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const handle = await connectDb(config);
  try {
    const summary = await backfillCategoryIcons(handle.db);
    logger.info('category icon backfill complete', { database: config.mongodbDb, ...summary });
  } finally {
    await handle.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`backfill-category-icons failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
