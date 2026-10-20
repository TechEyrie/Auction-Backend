import { loadConfig } from '../src/config/index.ts';
import { connectDb } from '../src/db/connection.ts';
import { COLLECTIONS } from '../src/db/indexes.ts';
import { createLogger } from '../src/shared/logger.ts';
import { assertSeedTarget } from './seed.ts';

export async function backfillEmailVerified(db: import('mongodb').Db): Promise<{ matchedCount: number; modifiedCount: number }> {
  const now = new Date();
  const result = await db.collection(COLLECTIONS.users).updateMany(
    { emailNormalized: { $type: 'string' }, emailVerifiedAt: null },
    { $set: { emailVerifiedAt: now, updatedAt: now } },
  );
  return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
}

async function main(): Promise<void> {
  assertSeedTarget(process.env, process.argv.slice(2));
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const handle = await connectDb(config);
  try {
    const stats = await backfillEmailVerified(handle.db);
    logger.info('email verified backfill complete', stats);
    process.stdout.write(`matched=${stats.matchedCount} modified=${stats.modifiedCount}\n`);
  } finally {
    await handle.close();
  }
}

const invokedPath = process.argv[1];
if (invokedPath && invokedPath.endsWith('backfill-email-verified.ts')) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
