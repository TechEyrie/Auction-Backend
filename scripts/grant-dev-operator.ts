import { loadConfig } from '../src/config/index.ts';
import { connectDb } from '../src/db/connection.ts';
import { ensureIndexes } from '../src/db/indexes.ts';
import { createAuthService } from '../src/modules/auth/service.ts';
import * as repo from '../src/modules/auth/repository.ts';
import { createLogger } from '../src/shared/logger.ts';
import { normalizeEmail } from '../src/shared/normalize.ts';

/**
 * Development-only: give an existing or new email account inventory access.
 * Refuses production. Does not print the password.
 */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const emailArg = argv.find((arg) => arg.startsWith('--email='))?.slice('--email='.length);
  const passwordArg = argv.find((arg) => arg.startsWith('--password='))?.slice('--password='.length);
  const config = loadConfig();
  if (config.nodeEnv === 'production') {
    throw new Error('Refusing to grant a development operator when NODE_ENV=production');
  }
  const email = normalizeEmail(emailArg);
  const password = passwordArg ?? '';
  if (!email || password.length < 8) {
    throw new Error('Pass --email= and --password= (at least 8 characters)');
  }
  const logger = createLogger(config.logLevel);
  const db = await connectDb(config);
  try {
    await ensureIndexes(db.db);
    const auth = createAuthService({ db: db.db, config, logger });
    let user = await repo.findUserByIdentifier(db.db, email);
    if (!user) {
      await auth.register(
        { fullName: 'Development operator', email, password, termsAccepted: true },
        { ip: null, userAgent: 'grant-dev-operator' },
      );
      user = await repo.findUserByIdentifier(db.db, email);
    }
    if (!user) throw new Error('Operator account was not created');
    await repo.updateUserRoles(db.db, user._id, ['auction_manager']);
    logger.info('development operator granted inventory access', { publicReference: user.publicReference });
  } finally {
    await db.close();
  }
}

const invokedPath = process.argv[1];
if (invokedPath && invokedPath.endsWith('grant-dev-operator.ts')) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
