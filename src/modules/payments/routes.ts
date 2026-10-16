import { createHmac } from 'node:crypto';
import { Router } from 'express';
import type { Db } from 'mongodb';
import { z } from 'zod';
import type { AppConfig } from '../../config/index.ts';
import { AppError } from '../../shared/errors.ts';
import { parseInput } from '../../shared/validate.ts';
import { requireActiveUser, requireAuth, requireCapability } from '../auth/middleware.ts';
import { COLLECTIONS } from '../../db/indexes.ts';
import {
  applyVerifiedPayment,
  assertPaymentSignature,
  orderView,
  parseFulfillmentBody,
  readOrderForWinner,
  updateOrderFulfillment,
  webhookSecret,
} from '../orders/service.ts';

const webhookSchema = z.object({
  orderReference: z.string().min(4).max(80),
  amountMinor: z.number().int().nonnegative(),
  currency: z.string().min(3).max(3),
  eventId: z.string().min(4).max(120),
  status: z.enum(['succeeded', 'failed']),
}).strict();

export function paymentRouter(deps: { db: Db; config: AppConfig }): Router {
  const router = Router();

  router.post('/complete', requireAuth(), requireActiveUser(), async (req, res, next) => {
    try {
      if (deps.config.isProduction) {
        throw new AppError('FORBIDDEN', 'The manual payment placeholder is rejected in production');
      }
      const body = parseInput(z.object({
        orderReference: z.string().min(4).max(80),
        amountMinor: z.number().optional(),
        currency: z.string().optional(),
        winnerUserReference: z.string().optional(),
      }).strict(), req.body ?? {});
      const order = await readOrderForWinner(deps.db, body.orderReference, req.auth!.user.publicReference);
      const paid = await applyVerifiedPayment(deps.db, {
        orderReference: order.orderReference,
        amountMinor: order.winningPriceMinor,
        currency: order.currency,
        eventId: `manual:${order.orderReference}`,
        status: 'succeeded',
      });
      res.status(paid.paymentState === 'paid' ? 200 : 201).json({
        order: orderView(paid),
        ignoredClientAmount: body.amountMinor ?? null,
        message: 'Recorded against the server total. No card was charged. This is not a gateway payment.',
      });
    } catch (err) { next(err); }
  });

  router.post('/webhooks/manual', async (req, res, next) => {
    try {
      const secret = webhookSecret(deps.config.paymentWebhookSecret, deps.config.isProduction);
      assertPaymentSignature(secret, req.body, req.header('x-payment-signature'));
      const body = parseInput(webhookSchema, req.body ?? {});
      const order = await applyVerifiedPayment(deps.db, body);
      res.json({ order: orderView(order) });
    } catch (err) { next(err); }
  });

  router.post('/reconcile', requireAuth(), requireActiveUser(), requireCapability('finance.manage'), async (req, res, next) => {
    try {
      const body = parseInput(z.object({
        orderReference: z.string().min(4).max(80),
        eventId: z.string().min(4).max(120),
        status: z.enum(['succeeded', 'failed']),
      }).strict(), req.body ?? {});
      const stored = await deps.db.collection(COLLECTIONS.orders).findOne({ orderReference: body.orderReference });
      if (!stored) throw new AppError('NOT_FOUND', 'Order not found');
      const order = await applyVerifiedPayment(deps.db, {
        orderReference: body.orderReference,
        amountMinor: stored.winningPriceMinor as number,
        currency: 'QAR',
        eventId: body.eventId,
        status: body.status,
      });
      res.json({ order: orderView(order) });
    } catch (err) { next(err); }
  });

  return router;
}

const fulfillmentSchema = z.object({
  fullName: z.string().min(2).max(120),
  phone: z.string().min(6).max(40),
  city: z.string().min(2).max(80),
  address: z.string().min(6).max(300),
}).strict();

export function orderRouter(deps: { db: Db }): Router {
  const router = Router();
  router.get('/:orderReference', requireAuth(), requireActiveUser(), async (req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      const order = await readOrderForWinner(deps.db, String(req.params.orderReference), req.auth!.user.publicReference);
      const listing = await deps.db.collection(COLLECTIONS.listings).findOne(
        { listingReference: order.listingReference },
        { projection: { title: 1 } },
      );
      const title = listing?.title as { en?: string; ar?: string } | undefined;
      const listingTitle = title?.en?.trim() || title?.ar?.trim() || 'Your purchase';
      res.json({ order: { ...order, listingTitle } });
    } catch (err) { next(err); }
  });
  router.patch('/:orderReference/fulfillment', requireAuth(), requireActiveUser(), async (req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      const body = parseInput(fulfillmentSchema, req.body ?? {});
      const fulfillment = parseFulfillmentBody(body);
      const order = await updateOrderFulfillment(
        deps.db,
        String(req.params.orderReference),
        req.auth!.user.publicReference,
        fulfillment,
      );
      res.json({ order: orderView(order) });
    } catch (err) { next(err); }
  });
  return router;
}

export function devPaymentSignature(secret: string, body: unknown): string {
  return createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
}
