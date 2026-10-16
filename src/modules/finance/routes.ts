import { Router } from 'express';
import type { Db } from 'mongodb';
import { z } from 'zod';
import { COLLECTIONS } from '../../db/indexes.ts';
import { AppError } from '../../shared/errors.ts';
import { parseInput } from '../../shared/validate.ts';
import { requireCapability } from '../auth/middleware.ts';
import { recordAudit } from '../audit/repository.ts';

const DEFINITIONS = {
  currency: 'QAR',
  timezone: 'Asia/Qatar',
  collectedRevenueMinor: 'Sum of winning prices on orders whose paymentState is paid. Unpaid wins are excluded.',
  unsettledPayableMinor: 'Sum of seller nets on paid orders with sellerNetStatus ready that are not settled.',
};

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function financeRouter(deps: { db: Db }): Router {
  const router = Router();
  const orders = () => deps.db.collection(COLLECTIONS.orders);
  const entries = () => deps.db.collection(COLLECTIONS.financialEntries);

  router.get('/summary', requireCapability('finance.view'), async (_req, res, next) => {
    try {
      const [orderCount, unpaidWins, sums] = await Promise.all([
        orders().countDocuments({}),
        orders().countDocuments({ paymentState: { $ne: 'paid' } }),
        orders().aggregate<{ collected: number; payable: number }>([
          { $match: { paymentState: 'paid' } },
          { $group: {
            _id: null,
            collected: { $sum: '$winningPriceMinor' },
            payable: { $sum: { $cond: [{ $and: [{ $eq: ['$sellerNetStatus', 'ready'] }, { $ne: ['$settlementState', 'settled'] }] }, '$sellerNetAmountMinor', 0] } },
          } },
        ]).toArray(),
      ]);
      const collectedRevenueMinor = sums[0]?.collected ?? 0;
      const unsettledPayableMinor = sums[0]?.payable ?? 0;
      res.json({ definitions: DEFINITIONS, orderCount, unpaidWins, collectedRevenueMinor, unsettledPayableMinor });
    } catch (err) { next(err); }
  });

  router.get('/orders', requireCapability('finance.view'), async (req, res, next) => {
    try {
      const page = Math.max(1, Number(req.query.page ?? 1) || 1);
      const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 20) || 20));
      const filter: Record<string, unknown> = {};
      if (typeof req.query.paymentState === 'string' && req.query.paymentState) filter.paymentState = req.query.paymentState;
      if (typeof req.query.q === 'string' && req.query.q) filter.orderReference = req.query.q;
      const [total, rows] = await Promise.all([
        orders().countDocuments(filter),
        orders().find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
      ]);
      res.json({
        page,
        limit,
        total,
        orders: rows.map((order) => ({
          orderReference: order.orderReference,
          paymentState: order.paymentState,
          winningPriceMinor: order.winningPriceMinor,
          sellerNetAmountMinor: order.sellerNetAmountMinor ?? null,
          sellerNetStatus: order.sellerNetStatus,
          settlementState: order.settlementState ?? 'unsettled',
        })),
      });
    } catch (err) { next(err); }
  });

  router.post('/settlements', requireCapability('settlements.manage'), async (req, res, next) => {
    try {
      const body = parseInput(z.object({
        orderReference: z.string().min(4).max(80),
        reason: z.string().trim().min(3).max(500),
        confirm: z.literal(true),
        amountMinor: z.number().optional(),
      }).strict(), req.body ?? {});
      const claimed = await orders().findOneAndUpdate(
        {
          orderReference: body.orderReference,
          paymentState: 'paid',
          sellerNetStatus: 'ready',
          settlementState: { $ne: 'settled' },
        },
        { $set: { settlementState: 'settled', settledAt: new Date(), updatedAt: new Date() } },
        { returnDocument: 'after' },
      );
      if (!claimed) throw new AppError('CONFLICT', 'This order cannot be settled');
      await entries().insertOne({
        eventId: `settle:${body.orderReference}`,
        orderReference: body.orderReference,
        type: 'seller_payout',
        amountMinor: claimed.sellerNetAmountMinor,
        currency: 'QAR',
        createdAt: new Date(),
      });
      await recordAudit(deps.db, {
        actorId: req.auth!.user.publicReference,
        action: 'settlement.recorded',
        targetType: 'order',
        targetId: body.orderReference,
        requestId: req.requestId ?? 'n/a',
        changeSummary: { amountMinor: claimed.sellerNetAmountMinor },
        reason: body.reason,
      });
      res.status(201).json({
        settlement: { orderReference: body.orderReference, amountMinor: claimed.sellerNetAmountMinor, ignoredClientAmount: body.amountMinor ?? null },
      });
    } catch (err) { next(err); }
  });

  router.post('/settlements/reverse', requireCapability('settlements.manage'), async (req, res, next) => {
    try {
      const body = parseInput(z.object({
        orderReference: z.string().min(4).max(80),
        reason: z.string().trim().min(3).max(500),
        confirm: z.literal(true),
      }).strict(), req.body ?? {});
      const order = await orders().findOne({ orderReference: body.orderReference, settlementState: 'settled' });
      if (!order) throw new AppError('CONFLICT', 'Only a recorded settlement can be reversed');
      const eventId = `reverse:${body.orderReference}:${Date.now()}`;
      await entries().insertOne({
        eventId,
        orderReference: body.orderReference,
        type: 'settlement_reversal',
        amountMinor: -Number(order.sellerNetAmountMinor ?? 0),
        currency: 'QAR',
        reverses: `settle:${body.orderReference}`,
        createdAt: new Date(),
      });
      await orders().updateOne({ orderReference: body.orderReference }, { $set: { settlementState: 'reversed', updatedAt: new Date() } });
      await recordAudit(deps.db, {
        actorId: req.auth!.user.publicReference,
        action: 'settlement.reversed',
        targetType: 'order',
        targetId: body.orderReference,
        requestId: req.requestId ?? 'n/a',
        changeSummary: { eventId },
        reason: body.reason,
      });
      res.json({ reversal: { orderReference: body.orderReference, eventId } });
    } catch (err) { next(err); }
  });

  router.get('/export', requireCapability('finance.view'), async (_req, res, next) => {
    try {
      const rows = await orders().find({}).limit(500).toArray();
      const header = ['orderReference', 'paymentState', 'winningPriceMinor', 'sellerNetAmountMinor', 'settlementState'];
      const lines = [header.join(',')];
      for (const order of rows) {
        lines.push([
          order.orderReference,
          order.paymentState,
          order.winningPriceMinor,
          order.sellerNetAmountMinor ?? '',
          order.settlementState ?? 'unsettled',
        ].map(csvCell).join(','));
      }
      res.setHeader('content-type', 'text/csv; charset=utf-8');
      res.send(lines.join('\n'));
    } catch (err) { next(err); }
  });

  return router;
}
