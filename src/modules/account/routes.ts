import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import type { Db } from 'mongodb';
import { z } from 'zod';
import { COLLECTIONS } from '../../db/indexes.ts';
import { AppError } from '../../shared/errors.ts';
import { parseInput } from '../../shared/validate.ts';
import { toUserDto } from '../auth/dto.ts';
import { requireActiveUser, requireAuth, requireCapability, requireMfa } from '../auth/middleware.ts';
import { chromePublishSchema, mergeChromeBody } from './content-chrome.ts';

const TERMS_KEY = 'terms';

const termsPublishSchema = z.object({
  key: z.literal(TERMS_KEY),
  text: z.string().min(8).max(8000),
}).strict();

const adminContentPublishSchema = z.union([termsPublishSchema, chromePublishSchema]);

function noStore(_req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) {
  res.setHeader('Cache-Control', 'private, no-store');
  next();
}

/** Own profile, bids, wins, and the accepted legal version. No id parameter, so another user cannot be requested. */
export function accountRouter(deps: { db: Db }): Router {
  const router = Router();
  router.use(noStore);
  router.get('/', requireAuth(), requireActiveUser(), requireMfa(), async (req, res, next) => {
    try {
      const ref = req.auth!.user.publicReference;
      const [bids, orders] = await Promise.all([
        deps.db.collection(COLLECTIONS.bids).find({ userReference: ref }).sort({ acceptedAt: -1 }).limit(50)
          .project({ amountMinor: 1, lotReference: 1, sequence: 1, acceptedAt: 1, _id: 0 }).toArray(),
        deps.db.collection(COLLECTIONS.orders).find({ winnerUserReference: ref }).sort({ createdAt: -1 }).limit(50)
          .project({
            orderReference: 1,
            source: 1,
            lotReference: 1,
            listingReference: 1,
            winningPriceMinor: 1,
            paymentState: 1,
            currency: 1,
            createdAt: 1,
            _id: 0,
          }).toArray(),
      ]);
      const listingRefs = [...new Set(orders.map((order) => String(order.listingReference ?? '')).filter(Boolean))];
      const listings = listingRefs.length
        ? await deps.db.collection(COLLECTIONS.listings)
          .find({ listingReference: { $in: listingRefs } })
          .project({ listingReference: 1, title: 1, _id: 0 })
          .toArray()
        : [];
      const titleByRef = new Map(
        listings.map((listing) => {
          const title = listing.title as { en?: string; ar?: string } | undefined;
          return [String(listing.listingReference), title?.en?.trim() || title?.ar?.trim() || 'Purchased item'] as const;
        }),
      );
      res.json({
        profile: toUserDto(req.auth!.user),
        bids: bids.map((bid) => ({
          lotReference: bid.lotReference,
          amountMinor: bid.amountMinor,
          sequence: bid.sequence,
          acceptedAt: bid.acceptedAt instanceof Date ? bid.acceptedAt.toISOString() : bid.acceptedAt,
        })),
        orders: orders.map((order) => ({
          orderReference: order.orderReference,
          source: order.source === 'fixed_price' ? 'fixed_price' : 'auction',
          lotReference: order.lotReference,
          listingReference: order.listingReference,
          listingTitle: titleByRef.get(String(order.listingReference)) ?? 'Purchased item',
          winningPriceMinor: order.winningPriceMinor,
          paymentState: order.paymentState,
          currency: order.currency,
          createdAt: order.createdAt instanceof Date ? order.createdAt.toISOString() : order.createdAt,
        })),
      });
    } catch (err) { next(err); }
  });
  router.post('/terms', requireAuth(), requireActiveUser(), requireMfa(), async (req, res, next) => {
    try {
      const body = parseInput(z.object({ version: z.number().int().positive() }).strict(), req.body);
      const published = await deps.db.collection(COLLECTIONS.contentDocuments).findOne({ key: TERMS_KEY, status: 'published' });
      if (!published || published.version !== body.version) {
        throw new AppError('VALIDATION_ERROR', 'That is not the published terms version');
      }
      await deps.db.collection(COLLECTIONS.users).updateOne(
        { publicReference: req.auth!.user.publicReference },
        { $set: { termsVersion: String(body.version) } },
      );
      res.json({ termsVersion: String(body.version) });
    } catch (err) { next(err); }
  });
  return router;
}

export function contentRouter(deps: { db: Db }): Router {
  const router = Router();
  router.get('/:key', async (req, res, next) => {
    try {
      const key = parseInput(z.string().regex(/^[a-z]{2,24}$/), req.params.key);
      const doc = await deps.db.collection(COLLECTIONS.contentDocuments).findOne({ key, status: 'published' });
      if (!doc) throw new AppError('NOT_FOUND', 'No published content');
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.json({ key, version: doc.version, body: doc.body, publishedAt: doc.publishedAt });
    } catch (err) { next(err); }
  });
  return router;
}

const enquirySchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(120),
  subject: z.string().trim().min(2).max(120),
  message: z.string().trim().min(10).max(2000),
  listingReference: z.string().max(40).optional(),
  website: z.string().max(0).optional(),
}).strict();

export function enquiryRouter(deps: { db: Db }): Router {
  const router = Router();
  router.post('/', async (req, res, next) => {
    try {
      const body = parseInput(enquirySchema, req.body);
      const reference = `enq_${randomBytes(6).toString('hex')}`;
      await deps.db.collection(COLLECTIONS.enquiries).insertOne({
        reference,
        name: body.name,
        email: body.email.toLowerCase(),
        subject: body.subject,
        message: body.message,
        listingReference: body.listingReference ?? null,
        status: 'open',
        createdAt: new Date(),
      });
      res.status(201).json({ reference });
    } catch (err) { next(err); }
  });
  return router;
}

export function adminContentRouter(deps: { db: Db }): Router {
  const router = Router();
  router.get('/enquiries', requireAuth(), requireCapability('content.manage'), async (_req, res, next) => {
    try {
      const items = await deps.db.collection(COLLECTIONS.enquiries).find({}).sort({ createdAt: -1 }).limit(50)
        .project({ reference: 1, name: 1, email: 1, subject: 1, message: 1, listingReference: 1, status: 1, createdAt: 1, _id: 0 }).toArray();
      res.json({ enquiries: items });
    } catch (err) { next(err); }
  });
  router.post('/content', requireAuth(), requireCapability('content.manage'), async (req, res, next) => {
    try {
      const body = parseInput(adminContentPublishSchema, req.body);
      const current = await deps.db.collection(COLLECTIONS.contentDocuments).findOne({ key: body.key });
      const version = (typeof current?.version === 'number' ? current.version : 0) + 1;
      const publishedAt = new Date();
      const storedBody = body.key === TERMS_KEY
        ? body.text
        : mergeChromeBody(current?.body, { en: body.en, ar: body.ar });
      await deps.db.collection(COLLECTIONS.contentDocuments).updateOne(
        { key: body.key },
        { $set: { key: body.key, status: 'published', version, body: storedBody, publishedAt, publishedBy: req.auth!.user.publicReference } },
        { upsert: true },
      );
      res.status(201).json({ key: body.key, version });
    } catch (err) { next(err); }
  });
  return router;
}
