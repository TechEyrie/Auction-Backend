import { loadConfig } from '../src/config/index.ts';
import { connectDb } from '../src/db/connection.ts';
import { ensureIndexes, INDEX_SPECS } from '../src/db/indexes.ts';
import { createLogger } from '../src/shared/logger.ts';

export async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const db = await connectDb(config);
  try {
    await ensureIndexes(db.db);
    logger.info('indexes ensured', {
      collections: Object.keys(INDEX_SPECS),
      database: config.mongodbDb,
      env: config.nodeEnv,
    });
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`ensure-indexes failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
