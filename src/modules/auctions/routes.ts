import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Db, ClientSession } from 'mongodb';
import type { AppConfig } from '../../config/index.ts';
import { requireActiveUser, requireAuth, requireCapability } from '../auth/middleware.ts';
import { parseInput } from '../../shared/validate.ts';
import { createAuctionService, adminStateOf, stateOf } from './service.ts';

const adminListSchema = z.object({
  listingReference: z.string().max(80).optional(),
  status: z.enum(['draft', 'scheduled', 'live', 'closed', 'cancelled']).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const createSchema = z.object({
  listingReference: z.string().min(1).max(80),
  startingBidMinor: z.number().int().nonnegative(),
  incrementMinor: z.number().int().positive(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
}).strict();

const bidSchema = z.object({
  amountMinor: z.number().int().nonnegative(),
  expectedVersion: z.number().int().positive(),
}).strict();

const closeSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  confirm: z.literal(true),
}).strict();

export function auctionRouter(deps: {
  db: Db;
  config: AppConfig;
  withTransaction: <T>(fn: (session: ClientSession) => Promise<T>) => Promise<T>;
}): Router {
  const router = Router();
  const auctions = createAuctionService(deps);
  void deps.config;

  router.get('/:lot', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const lot = String(req.params.lot);
      const auction = await auctions.get(lot);
      const viewerReference = req.auth?.user.publicReference;
      const recentBids = await auctions.history(lot, 3, { viewerReference, order: 'topAmount' });
      res.json({ auction: stateOf(auction, recentBids) });
    } catch (err) { next(err); }
  });

  router.get('/:lot/bids', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = Math.min(Number(req.query.limit ?? 20) || 20, 50);
      const before = typeof req.query.before === 'string' ? req.query.before : undefined;
      const viewerReference = req.auth?.user.publicReference;
      res.json({ bids: await auctions.history(String(req.params.lot), limit, { before, viewerReference }) });
    } catch (err) { next(err); }
  });

  router.post('/:lot/bids', requireAuth(), requireActiveUser(), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = parseInput(bidSchema, req.body);
      const user = req.auth!.user;
      const key = req.header('idempotency-key');
      const result = await auctions.placeBid({
        lot: String(req.params.lot),
        amountMinor: body.amountMinor,
        expectedVersion: body.expectedVersion,
        userReference: user.publicReference,
        roles: user.roles,
        status: user.status,
        idempotencyKey: key && key.length <= 200 ? key : null,
      });
      res.status(result.replay ? 200 : 201).json({
        replay: result.replay,
        bid: result.bid && 'sequence' in result.bid ? { sequence: result.bid.sequence, amountMinor: result.bid.amountMinor, bidderLabel: result.bid.bidderLabel } : null,
        auction: result.auction ? stateOf(result.auction) : null,
      });
    } catch (err) { next(err); }
  });

  return router;
}

export function adminAuctionRouter(deps: {
  db: Db;
  withTransaction: <T>(fn: (session: ClientSession) => Promise<T>) => Promise<T>;
}): Router {
  const router = Router();
  const auctions = createAuctionService(deps);

  router.get('/', requireAuth(), requireActiveUser(), requireCapability('auctions.manage'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = parseInput(adminListSchema, req.query);
      res.json(await auctions.listAdmin(query));
    } catch (err) { next(err); }
  });

  router.post('/', requireAuth(), requireActiveUser(), requireCapability('auctions.manage'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = parseInput(createSchema, req.body);
      const user = req.auth!.user;
      const auction = await auctions.create(body, user.publicReference);
      res.status(201).json({ auction: adminStateOf(auction) });
    } catch (err) { next(err); }
  });

  router.get('/:lot', requireAuth(), requireActiveUser(), requireCapability('auctions.manage'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ auction: adminStateOf(await auctions.getAdmin(String(req.params.lot))) });
    } catch (err) { next(err); }
  });

  router.post('/:lot/open', requireAuth(), requireActiveUser(), requireCapability('auctions.manage'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.auth!.user;
      res.json({ auction: adminStateOf(await auctions.open(String(req.params.lot), user.publicReference)) });
    } catch (err) { next(err); }
  });

  router.post('/:lot/close', requireAuth(), requireActiveUser(), requireCapability('auctions.manage'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = parseInput(closeSchema, req.body);
      const user = req.auth!.user;
      res.json({ auction: adminStateOf(await auctions.closeOne(String(req.params.lot), user.publicReference, body.reason)) });
    } catch (err) { next(err); }
  });

  router.post('/reconcile', requireAuth(), requireActiveUser(), requireCapability('auctions.manage'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.auth!.user;
      res.json({ closed: await auctions.closeDue(user.publicReference) });
    } catch (err) { next(err); }
  });

  router.get('/:lot/bids', requireAuth(), requireActiveUser(), requireCapability('auctions.manage'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 200);
      const before = typeof req.query.before === 'string' ? req.query.before : undefined;
      res.json({ bids: await auctions.adminHistory(String(req.params.lot), limit, { before }) });
    } catch (err) { next(err); }
  });

  router.patch('/:lot/bids/:sequence', (_req, res) => {
    res.status(405).json({ error: { code: 'FORBIDDEN', message: 'Accepted bids cannot be edited' } });
  });
  router.delete('/:lot/bids/:sequence', (_req, res) => {
    res.status(405).json({ error: { code: 'FORBIDDEN', message: 'Accepted bids cannot be deleted' } });
  });

  return router;
}
