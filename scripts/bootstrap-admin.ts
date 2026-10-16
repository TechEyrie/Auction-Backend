import { loadConfig } from '../src/config/index.ts';
import { connectDb } from '../src/db/connection.ts';
import { ensureIndexes } from '../src/db/indexes.ts';
import { bootstrapSuperAdmin } from '../src/modules/admin/bootstrap.ts';
import { createLogger } from '../src/shared/logger.ts';

/**
 * Creates the first super admin from environment variables. Never prints the
 * password. Refuses if required values are missing or a super admin already exists.
 *
 *   ADMIN_BOOTSTRAP_NAME="Iris Farah" \
 *   ADMIN_BOOTSTRAP_PHONE="+97455551234" \
 *   ADMIN_BOOTSTRAP_PASSWORD="<strong password>" \
 *   ADMIN_BOOTSTRAP_TOKEN="<operator token>" \
 *   npm run admin:bootstrap
 */
export function readBootstrapEnv(env: Record<string, string | undefined>): {
  fullName: string;
  phone: string;
  password: string;
  confirmToken: string;
} {
  const fullName = (env.ADMIN_BOOTSTRAP_NAME ?? '').trim();
  const phone = (env.ADMIN_BOOTSTRAP_PHONE ?? '').trim();
  const password = env.ADMIN_BOOTSTRAP_PASSWORD ?? '';
  const confirmToken = (env.ADMIN_BOOTSTRAP_TOKEN ?? '').trim();
  const missing = [
    !fullName ? 'ADMIN_BOOTSTRAP_NAME' : null,
    !phone ? 'ADMIN_BOOTSTRAP_PHONE' : null,
    !password ? 'ADMIN_BOOTSTRAP_PASSWORD' : null,
    !confirmToken ? 'ADMIN_BOOTSTRAP_TOKEN' : null,
  ].filter((x): x is string => x !== null);
  if (missing.length > 0) {
    throw new Error(`Refusing to bootstrap: missing ${missing.join(', ')}`);
  }
  return { fullName, phone, password, confirmToken };
}

export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  const input = readBootstrapEnv(env);
  const config = loadConfig(env);
  const logger = createLogger(config.logLevel);
  const db = await connectDb(config);
  try {
    await ensureIndexes(db.db);
    const result = await bootstrapSuperAdmin(
      db.db,
      { fullName: input.fullName, phone: input.phone, password: input.password },
      { expectedToken: config.adminBootstrapToken, confirmToken: input.confirmToken },
    );
    logger.info('super admin bootstrapped', {
      publicReference: result.publicReference,
      database: config.mongodbDb,
      env: config.nodeEnv,
    });
  } finally {
    await db.close();
  }
}

const invokedPath = process.argv[1];
if (invokedPath && invokedPath.endsWith('bootstrap-admin.ts')) {
  // ADMIN_BOOTSTRAP is paused. The function above is kept for when the client wants it back.
  // main().catch((err: unknown) => {
  //   process.stderr.write(`bootstrap failed: ${err instanceof Error ? err.message : String(err)}\n`);
  //   process.exit(1);
  // });
  process.stderr.write('ADMIN_BOOTSTRAP is commented out. Create an account with email and password instead.\n');
  process.exit(1);
}
