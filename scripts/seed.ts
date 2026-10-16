import { loadConfig } from '../src/config/index.ts';
import { connectDb } from '../src/db/connection.ts';
import { ensureIndexes } from '../src/db/indexes.ts';
import { createLogger } from '../src/shared/logger.ts';
import { seedCatalog } from './seed-catalog.ts';

const ALLOWED_TARGETS = ['development', 'test'] as const;

export class UnsafeSeedTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeSeedTargetError';
  }
}

/**
 * Refuse to seed unless the operator both runs outside production and names an
 * allow-listed target explicitly. There are no default credentials and no
 * implicit "just seed the local database" behaviour.
 */
export function assertSeedTarget(env: Record<string, string | undefined>, argv: readonly string[]): void {
  if ((env.NODE_ENV ?? 'development') === 'production') {
    throw new UnsafeSeedTargetError('Refusing to seed: NODE_ENV=production');
  }
  const arg = argv.find((a) => a.startsWith('--target='));
  const target = arg ? arg.slice('--target='.length) : undefined;
  if (!target) {
    throw new UnsafeSeedTargetError(
      `Refusing to seed: pass --target=${ALLOWED_TARGETS.join('|')} explicitly`,
    );
  }
  if (!(ALLOWED_TARGETS as readonly string[]).includes(target)) {
    throw new UnsafeSeedTargetError(`Refusing to seed: unknown target "${target}"`);
  }
  const dbName = (env.MONGODB_DB ?? '').toLowerCase();
  if (dbName.includes('prod')) {
    throw new UnsafeSeedTargetError(`Refusing to seed: database name "${env.MONGODB_DB}" looks like production`);
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  assertSeedTarget(process.env, argv);
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const db = await connectDb(config);
  try {
    await ensureIndexes(db.db);
    // Structure plus the representative catalogue (categories, attribute schemas, QA
    // locations). No seller, listing, financial or user record is fabricated here.
    const summary = await seedCatalog({ db: db.db, logger, withTransaction: db.withTransaction });
    logger.info('seed complete', {
      database: config.mongodbDb,
      env: config.nodeEnv,
      ...summary,
    });
  } finally {
    await db.close();
  }
}

const invokedPath = process.argv[1];
if (invokedPath && invokedPath.endsWith('seed.ts')) {
  main().catch((err: unknown) => {
    process.stderr.write(`seed failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
