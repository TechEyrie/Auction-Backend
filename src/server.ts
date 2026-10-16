import { createServer as createHttpServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createApp } from './app.ts';
import { ConfigurationError, loadConfig, type AppConfig } from './config/index.ts';
import { connectDb, type DbHandle } from './db/connection.ts';
import { createLogger, type Logger } from './shared/logger.ts';
import { createMediaStorage, type MediaStorage } from './modules/media/storage.ts';
import { createAuctionService } from './modules/auctions/service.ts';
import { attachRealtime } from './realtime.ts';

export type RunningServer = {
  server: Server;
  port: number;
  config: AppConfig;
  db: DbHandle;
  /** Stop accepting connections, drain within the timeout, then close resources. */
  stop: () => Promise<void>;
};

export async function startServer(deps: {
  config: AppConfig;
  logger: Logger;
  db: DbHandle;
  /** Tests inject an isolated store; production uses the configured adapter. */
  mediaStorage?: MediaStorage;
}): Promise<RunningServer> {
  const app = createApp({
    config: deps.config,
    logger: deps.logger,
    ping: deps.db.ping,
    db: deps.db.db,
    withTransaction: deps.db.withTransaction,
    mediaStorage: deps.mediaStorage ?? createMediaStorage(deps.config),
  });
  const server = createHttpServer(app);
  const stopRealtime = attachRealtime(server, { db: deps.db.db, config: deps.config });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(deps.config.port, () => resolve());
  });

  const closer = createAuctionService({ db: deps.db.db, withTransaction: deps.db.withTransaction });
  const closeTimer = deps.config.isTest
    ? null
    : setInterval(() => {
        void closer.closeDue('system').catch((err: unknown) => deps.logger.error('auction close failed', { err: String(err) }));
      }, 5000);
  closeTimer?.unref?.();

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : deps.config.port;

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (closeTimer) clearInterval(closeTimer);
    stopRealtime();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    // Stop accepting new work; let in-flight requests finish within the grace period.
    server.closeIdleConnections();
    await Promise.race([
      closed,
      new Promise<void>((resolve) => setTimeout(resolve, deps.config.shutdownTimeoutMs)),
    ]);
    server.closeAllConnections();
    await deps.db.close();
  };

  return { server, port, config: deps.config, db: deps.db, stop };
}

export async function main(): Promise<void> {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigurationError) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const logger = createLogger(config.logLevel);
  const db = await connectDb(config);
  const running = await startServer({ config, logger, db });
  logger.info('server started', { port: running.port, env: config.nodeEnv });

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.info('shutting down', { signal });
    try {
      await running.stop();
      logger.info('shutdown complete');
      process.exitCode = 0;
    } catch (err) {
      logger.error('shutdown failed', { err });
      process.exitCode = 1;
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

const invokedPath = process.argv[1];
const isEntrypoint = Boolean(invokedPath) && import.meta.url === pathToFileURL(invokedPath as string).href;
if (isEntrypoint) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`fatal: ${message}\n`);
    process.exit(1);
  });
}
