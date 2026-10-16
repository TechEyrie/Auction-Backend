import express, { type Express } from 'express';
import type { ClientSession, Db } from 'mongodb';
import type { AppConfig } from './config/index.ts';
import type { Logger } from './shared/logger.ts';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.ts';
import { requestLogger } from './middleware/logging.ts';
import { requestId } from './middleware/requestId.ts';
import { cors, securityHeaders } from './middleware/security.ts';
import { healthRouter } from './modules/health/routes.ts';
import { openApiDocument } from './openapi/openapi.ts';
import { authRouter } from './modules/auth/routes.ts';
import { adminRouter } from './modules/admin/routes.ts';
import { usersRouter } from './modules/users/routes.ts';
import { csrfProtection, resolveAuth } from './modules/auth/middleware.ts';
import { adminSellerRouter, publicSellerRouter } from './modules/sellers/routes.ts';
import { adminTaxonomyRouter, publicTaxonomyRouter } from './modules/taxonomy/routes.ts';
import { adminAttributeRouter, publicAttributeRouter } from './modules/attributes/routes.ts';
import { adminLocationRouter, publicLocationRouter } from './modules/locations/routes.ts';
import { adminMediaRouter } from './modules/media/routes.ts';
import { createMediaService } from './modules/media/service.ts';
import type { MediaStorage } from './modules/media/storage.ts';
import { adminListingRouter, publicListingRouter } from './modules/listings/routes.ts';
import { paymentRouter, orderRouter } from './modules/payments/routes.ts';
import { adminAuctionRouter, auctionRouter } from './modules/auctions/routes.ts';
import { financeRouter } from './modules/finance/routes.ts';
import { accountRouter, adminContentRouter, contentRouter, enquiryRouter } from './modules/account/routes.ts';

export type AppDeps = {
  config: AppConfig;
  logger: Logger;
  /** Injected dependency health check (MongoDB ping in production). */
  ping: () => Promise<void>;
  db: Db;
  withTransaction: <T>(fn: (session: ClientSession) => Promise<T>) => Promise<T>;
  /** Media storage adapter. Injected so tests can substitute an isolated store. */
  mediaStorage: MediaStorage;
};

/** Build the Express app. Network concerns stay in server.ts. */
export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', deps.config.trustProxy);

  app.use(requestId());
  app.use(securityHeaders());
  app.use(cors(deps.config.corsOrigins));
  app.use(express.json({ limit: deps.config.bodyLimit }));
  app.use(requestLogger(deps.logger));

  // Session resolution runs before CSRF so session-bound tokens can be checked.
  app.use(resolveAuth(deps.db));
  app.use(csrfProtection(deps.config));

  app.use(healthRouter({ ping: deps.ping }));
  app.get('/api/openapi.json', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(openApiDocument);
  });

  app.use('/api/auth', authRouter({ db: deps.db, config: deps.config, logger: deps.logger }));
  app.use('/api/users', usersRouter({ db: deps.db }));

  const catalogDeps = { db: deps.db, logger: deps.logger, withTransaction: deps.withTransaction };
  const locationDeps = { db: deps.db, logger: deps.logger };

  // Public catalog reads: the same records the admin edits (no second source of truth).
  app.use('/api/catalog/categories', publicTaxonomyRouter(catalogDeps));
  app.use('/api/catalog/locations', publicLocationRouter(locationDeps));
  app.use('/api/catalog/sellers', publicSellerRouter(locationDeps));
  app.use('/api/catalog/attribute-schemas', publicAttributeRouter(catalogDeps));

  app.use(
    '/api/admin/sellers',
    adminSellerRouter(locationDeps),
  );
  app.use('/api/admin/categories', adminTaxonomyRouter(catalogDeps));
  app.use('/api/admin/attribute-schemas', adminAttributeRouter(catalogDeps));
  app.use('/api/admin/locations', adminLocationRouter(locationDeps));
  app.use('/api/admin/media', adminMediaRouter({ ...catalogDeps, config: deps.config, storage: deps.mediaStorage }));

  // Listings own public discovery and the public media policy, so they receive the media service
  // rather than reaching into media collections themselves.
  const listingDeps = {
    ...catalogDeps,
    media: createMediaService({ ...catalogDeps, config: deps.config, storage: deps.mediaStorage }),
  };
  app.use('/api/payments', paymentRouter({ db: deps.db, config: deps.config }));
  app.use('/api/orders', orderRouter({ db: deps.db }));
  app.use('/api/auctions', auctionRouter({ db: deps.db, config: deps.config, withTransaction: deps.withTransaction }));
  app.use('/api/admin/auctions', adminAuctionRouter({ db: deps.db, withTransaction: deps.withTransaction }));
  app.use('/api/admin/finance', financeRouter({ db: deps.db }));
  app.use('/api/account', accountRouter({ db: deps.db }));
  app.use('/api/content', contentRouter({ db: deps.db }));
  app.use('/api/enquiries', enquiryRouter({ db: deps.db }));
  app.use('/api/admin', adminContentRouter({ db: deps.db }));
  app.use('/api/listings', publicListingRouter(listingDeps));
  app.use('/api/admin/listings', adminListingRouter(listingDeps));
  app.use('/api/admin', adminRouter({ db: deps.db, config: deps.config, logger: deps.logger, withTransaction: deps.withTransaction }));

  app.use(notFoundHandler());
  app.use(errorHandler(deps.logger));
  return app;
}
