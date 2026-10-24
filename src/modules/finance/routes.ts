import { Router } from 'express';
import type { Db } from 'mongodb';
import { COLLECTIONS } from '../../db/indexes.ts';
import { AppError, validationError } from '../../shared/errors.ts';
import { normalizeEmail, normalizePhoneE164 } from '../../shared/normalize.ts';
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const USER_PUBLIC_REF_RE = /^u_[A-Za-z0-9_-]+$/;

function parseBuyerQuery(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') throw validationError({ buyer: 'invalid buyer reference' });
  const buyer = raw.trim();
  if (!buyer || buyer.length > 80 || !USER_PUBLIC_REF_RE.test(buyer)) {
    throw validationError({ buyer: 'invalid buyer reference' });
  }
  return buyer;
}

function parseSourceQuery(raw: unknown): 'auction' | 'fixed_price' | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string' || (raw !== 'auction' && raw !== 'fixed_price')) {
    throw validationError({ source: 'invalid source' });
  }
  return raw;
}

function looksLikePersonQuery(q: string): boolean {
  if (q.includes('@')) return true;
  if (q.startsWith('u_')) return true;
  if (/\s/.test(q)) return true;
  const digits = q.replace(/\D/g, '');
  if (digits.length >= 4 && digits.length >= q.replace(/\s/g, '').length * 0.6) return true;
  if (
    /[a-zA-Z]/.test(q) &&
    !/^l_[a-z0-9]+$/i.test(q) &&
    !/^ord_/i.test(q) &&
    !/^lot_/i.test(q)
  ) {
    return true;
  }
  return false;
}

async function userRefsMatchingPersonQuery(db: Db, q: string): Promise<string[]> {
  const trimmed = q.trim();
  if (!trimmed) return [];
  const escaped = escapeRegex(trimmed);
  const or: Record<string, unknown>[] = [
    { publicReference: { $regex: escaped, $options: 'i' } },
    { fullName: { $regex: escaped, $options: 'i' } },
    { emailNormalized: { $regex: escaped, $options: 'i' } },
    { phoneE164: { $regex: escaped, $options: 'i' } },
  ];
  const email = normalizeEmail(trimmed);
  if (email) or.push({ emailNormalized: email });
  try {
    const phone = normalizePhoneE164(trimmed);
    if (phone) or.push({ phoneE164: phone });
  } catch {
    // not a valid phone — regex clauses above still apply
  }
  const rows = await db
    .collection(COLLECTIONS.users)
    .find({ $or: or })
    .limit(20)
    .project({ publicReference: 1, _id: 0 })
    .toArray();
  return rows.map((row) => String(row.publicReference));
}

type BuyerDto = {
  userReference: string;
  fullName: string | null;
  phone: string | null;
  email: string | null;
};

async function loadBuyersByRef(db: Db, winnerRefs: string[]): Promise<Map<string, BuyerDto>> {
  const unique = [...new Set(winnerRefs.filter(Boolean))];
  if (!unique.length) return new Map();
  const users = await db
    .collection(COLLECTIONS.users)
    .find({ publicReference: { $in: unique } })
    .project({ publicReference: 1, fullName: 1, phoneE164: 1, emailNormalized: 1, _id: 0 })
    .toArray();
  const byRef = new Map(
    users.map((user) => [
      String(user.publicReference),
      {
        userReference: String(user.publicReference),
        fullName: typeof user.fullName === 'string' ? user.fullName : null,
        phone: typeof user.phoneE164 === 'string' ? user.phoneE164 : null,
        email: typeof user.emailNormalized === 'string' ? user.emailNormalized : null,
      } satisfies BuyerDto,
    ]),
  );
  for (const ref of unique) {
    if (!byRef.has(ref)) {
      byRef.set(ref, { userReference: ref, fullName: null, phone: null, email: null });
    }
  }
  return byRef;
}

function mapFulfillment(order: Record<string, unknown>) {
  const f = order.fulfillment as
    | { fullName?: string; phone?: string; city?: string; address?: string }
    | undefined;
  if (!f || typeof f !== 'object') return null;
  return {
    fullName: f.fullName ?? '',
    phone: f.phone ?? '',
    city: f.city ?? '',
    address: f.address ?? '',
  };
}

function buyerForOrder(order: Record<string, unknown>, byRef: Map<string, BuyerDto>): BuyerDto {
  const ref = String(order.winnerUserReference ?? '');
  return byRef.get(ref) ?? { userReference: ref, fullName: null, phone: null, email: null };
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
      const buyer = parseBuyerQuery(req.query.buyer);
      if (buyer) filter.winnerUserReference = buyer;
      const source = parseSourceQuery(req.query.source);
      if (source) filter.source = source;
      if (typeof req.query.paymentState === 'string' && req.query.paymentState) {
        filter.paymentState = req.query.paymentState;
      }
      if (typeof req.query.q === 'string' && req.query.q.trim()) {
        const q = req.query.q.trim();
        const escaped = escapeRegex(q);
        const or: Record<string, unknown>[] = [
          { orderReference: { $regex: escaped, $options: 'i' } },
          { listingReference: { $regex: escaped, $options: 'i' } },
          { lotReference: { $regex: escaped, $options: 'i' } },
          { winnerUserReference: { $regex: escaped, $options: 'i' } },
        ];
        if (looksLikePersonQuery(q)) {
          const refs = await userRefsMatchingPersonQuery(deps.db, q);
          if (refs.length) or.push({ winnerUserReference: { $in: refs } });
        }
        filter.$or = or;
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
      const buyerByRef = await loadBuyersByRef(
        deps.db,
        rows.map((order) => String(order.winnerUserReference ?? '')),
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
          lotReference: order.lotReference ?? null,
          listingTitle: titleByRef.get(String(order.listingReference)) ?? 'Product',
          title: bilingualTitleByRef.get(String(order.listingReference)) ?? { en: null, ar: null },
          buyer: buyerForOrder(order as Record<string, unknown>, buyerByRef),
          fulfillment: mapFulfillment(order as Record<string, unknown>),
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
      const buyerByRef = await loadBuyersByRef(
        deps.db,
        rows.map((order) => String(order.winnerUserReference ?? '')),
      );
      const header = [
        'orderReference',
        'source',
        'listingReference',
        'lotReference',
        'buyerUserReference',
        'buyerName',
        'buyerPhone',
        'buyerEmail',
        'paymentState',
        'amountPaidMinor',
        'createdAt',
        'paidAt',
        'fulfillmentCity',
        'fulfillmentPhone',
        'fulfillmentAddress',
      ];
      const lines = [header.join(',')];
      for (const order of rows) {
        const buyer = buyerForOrder(order as Record<string, unknown>, buyerByRef);
        const fulfillment = mapFulfillment(order as Record<string, unknown>);
        lines.push(
          [
            order.orderReference,
            order.source ?? 'auction',
            order.listingReference,
            order.lotReference ?? '',
            buyer.userReference,
            buyer.fullName ?? '',
            buyer.phone ?? '',
            buyer.email ?? '',
            order.paymentState,
            order.winningPriceMinor,
            order.createdAt instanceof Date ? order.createdAt.toISOString() : order.createdAt,
            order.paidAt instanceof Date ? order.paidAt.toISOString() : order.paidAt ?? '',
            fulfillment?.city ?? '',
            fulfillment?.phone ?? '',
            fulfillment?.address ?? '',
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
