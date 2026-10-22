import { Router } from 'express';
import type { Db } from 'mongodb';
import { COLLECTIONS } from '../../db/indexes.ts';
import { AppError } from '../../shared/errors.ts';
import { requireCapability } from '../auth/middleware.ts';

const DEFINITIONS = {
  currency: 'QAR',
  timezone: 'Asia/Qatar',
  collectedRevenueMinor:
    'Sum of winning prices on orders whose paymentState is paid. The full customer payment is platform revenue; seller payouts are not active.',
  awaitingPaymentCount: 'Orders that are not yet paid.',
};

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

function paymentLabel(state: unknown): string {
  if (state === 'paid') return 'Paid';
  if (state === 'awaiting_payment') return 'Awaiting payment';
  if (state === 'failed') return 'Failed';
  return String(state ?? '');
}

function sourceLabel(source: unknown): string {
  if (source === 'fixed_price') return 'Buy now';
  if (source === 'auction') return 'Auction win';
  return 'Order';
}

export function financeRouter(deps: { db: Db }): Router {
  const router = Router();
  const orders = () => deps.db.collection(COLLECTIONS.orders);

  router.get('/summary', requireCapability('finance.view'), async (_req, res, next) => {
    try {
      const [orderCount, awaitingPaymentCount, sums] = await Promise.all([
        orders().countDocuments({}),
        orders().countDocuments({ paymentState: { $ne: 'paid' } }),
        orders()
          .aggregate<{ collected: number }>([
            { $match: { paymentState: 'paid' } },
            { $group: { _id: null, collected: { $sum: '$winningPriceMinor' } } },
          ])
          .toArray(),
      ]);
      const collectedRevenueMinor = sums[0]?.collected ?? 0;
      res.json({
        definitions: DEFINITIONS,
        orderCount,
        unpaidWins: awaitingPaymentCount,
        awaitingPaymentCount,
        collectedRevenueMinor,
        // Kept at 0 for older clients; seller payables are not active.
        unsettledPayableMinor: 0,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/orders', requireCapability('finance.view'), async (req, res, next) => {
    try {
      const page = Math.max(1, Number(req.query.page ?? 1) || 1);
      const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 20) || 20));
      const filter: Record<string, unknown> = {};
      if (typeof req.query.paymentState === 'string' && req.query.paymentState) {
        filter.paymentState = req.query.paymentState;
      }
      if (typeof req.query.q === 'string' && req.query.q.trim()) {
        const q = req.query.q.trim();
        filter.$or = [
          { orderReference: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
          { listingReference: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
        ];
      }
      const [total, rows] = await Promise.all([
        orders().countDocuments(filter),
        orders().find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
      ]);
      const listingRefs = [...new Set(rows.map((order) => String(order.listingReference ?? '')).filter(Boolean))];
      const listings = listingRefs.length
        ? await deps.db
            .collection(COLLECTIONS.listings)
            .find({ listingReference: { $in: listingRefs } })
            .project({ listingReference: 1, title: 1, _id: 0 })
            .toArray()
        : [];
      const titleByRef = new Map(
        listings.map((listing) => {
          const title = listing.title as { en?: string; ar?: string } | undefined;
          return [String(listing.listingReference), title?.en?.trim() || title?.ar?.trim() || 'Product'] as const;
        }),
      );
      const bilingualTitleByRef = new Map(
        listings.map((listing) => {
          const title = listing.title as { en?: string; ar?: string } | undefined;
          return [
            String(listing.listingReference),
            { en: title?.en?.trim() || null, ar: title?.ar?.trim() || null },
          ] as const;
        }),
      );
      res.json({
        page,
        limit,
        total,
        orders: rows.map((order) => ({
          orderReference: order.orderReference,
          source: order.source === 'fixed_price' ? 'fixed_price' : 'auction',
          sourceLabel: sourceLabel(order.source),
          listingReference: order.listingReference,
          listingTitle: titleByRef.get(String(order.listingReference)) ?? 'Product',
          title: bilingualTitleByRef.get(String(order.listingReference)) ?? { en: null, ar: null },
          paymentState: order.paymentState,
          paymentLabel: paymentLabel(order.paymentState),
          amountPaidMinor: order.winningPriceMinor,
          winningPriceMinor: order.winningPriceMinor,
          currency: 'QAR',
          createdAt: order.createdAt instanceof Date ? order.createdAt.toISOString() : order.createdAt,
          paidAt: order.paidAt instanceof Date ? order.paidAt.toISOString() : order.paidAt ?? null,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/settlements', requireCapability('settlements.manage'), async (_req, res, next) => {
    try {
      throw new AppError(
        'FORBIDDEN',
        'Seller settlements are not active. Customer payments are retained by the platform.',
      );
    } catch (err) {
      next(err);
    }
  });

  router.post('/settlements/reverse', requireCapability('settlements.manage'), async (_req, res, next) => {
    try {
      throw new AppError(
        'FORBIDDEN',
        'Seller settlements are not active. Customer payments are retained by the platform.',
      );
    } catch (err) {
      next(err);
    }
  });

  router.get('/export', requireCapability('finance.view'), async (_req, res, next) => {
    try {
      const rows = await orders().find({}).sort({ createdAt: -1 }).limit(500).toArray();
      const header = [
        'orderReference',
        'source',
        'listingReference',
        'paymentState',
        'amountPaidMinor',
        'createdAt',
        'paidAt',
      ];
      const lines = [header.join(',')];
      for (const order of rows) {
        lines.push(
          [
            order.orderReference,
            order.source ?? 'auction',
            order.listingReference,
            order.paymentState,
            order.winningPriceMinor,
            order.createdAt instanceof Date ? order.createdAt.toISOString() : order.createdAt,
            order.paidAt instanceof Date ? order.paidAt.toISOString() : order.paidAt ?? '',
          ]
            .map(csvCell)
            .join(','),
        );
      }
      res.setHeader('content-type', 'text/csv; charset=utf-8');
      res.setHeader('content-disposition', 'attachment; filename="platform-orders.csv"');
      res.send(lines.join('\n'));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
