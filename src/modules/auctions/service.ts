import { createHash, randomBytes } from 'node:crypto';
import type { ClientSession, Db, ObjectId } from 'mongodb';
import { COLLECTIONS } from '../../db/indexes.ts';
import { AppError, conflict } from '../../shared/errors.ts';
import { enqueueEvent } from '../outbox/repository.ts';
import { isStaff, type Role } from '../auth/roles.ts';
import type { UserDoc } from '../auth/models.ts';
import { insertSoldOrder } from '../orders/service.ts';
import { enqueueLotEndingReminder, enqueueWinnerMailJobs } from '../mail/jobs.ts';

export type AuctionStatus = 'draft' | 'scheduled' | 'live' | 'closed' | 'cancelled';

export type AuctionDoc = {
  lotReference: string;
  listingReference: string;
  status: AuctionStatus;
  outcome: 'pending' | 'sold' | 'no_bids';
  startsAt: Date;
  endsAt: Date;
  startingBidMinor: number;
  incrementMinor: number;
  currentAmountMinor: number | null;
  highestBidId: ObjectId | null;
  highestUserReference: string | null;
  bidCount: number;
  version: number;
  publishedBy: string | null;
  publishedAt: Date | null;
  closedAt: Date | null;
  closedBy: string | null;
  closureReason: string | null;
  winningBidId: ObjectId | null;
  winningUserReference: string | null;
  orderReference: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type BidDoc = {
  auctionId: ObjectId;
  lotReference: string;
  userReference: string;
  bidderLabel: string;
  amountMinor: number;
  sequence: number;
  auctionVersion: number;
  acceptedAt: Date;
  idempotencyKey: string | null;
};

type Tx = <T>(fn: (session: ClientSession) => Promise<T>) => Promise<T>;

function lotReference(): string {
  return `lot_${randomBytes(6).toString('hex')}`;
}

function bidderLabel(userReference: string): string {
  const digest = createHash('sha256').update(userReference).digest('hex').slice(0, 4);
  return `Bidder ${digest}`;
}

async function displayNamesByUserRef(db: Db, refs: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(refs.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const users = await db
    .collection<Pick<UserDoc, 'publicReference' | 'fullName'>>(COLLECTIONS.users)
    .find({ publicReference: { $in: unique } })
    .project({ publicReference: 1, fullName: 1 })
    .toArray();
  return new Map(
    users
      .map((user) => [user.publicReference, (user.fullName ?? '').trim()] as const)
      .filter((entry) => entry[1].length > 0),
  );
}

function money(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new AppError('VALIDATION_ERROR', 'Amount must be a non-negative integer in minor units', {
      fieldErrors: { [field]: 'invalid' },
    });
  }
  return value;
}

export function createAuctionService(deps: { db: Db; withTransaction: Tx }) {
  const auctions = () => deps.db.collection<AuctionDoc>(COLLECTIONS.auctions);
  const bids = () => deps.db.collection<BidDoc>(COLLECTIONS.bids);

  async function publicView(lot: string) {
    const auction = await auctions().findOne({ lotReference: lot });
    if (!auction || auction.status === 'draft' || auction.status === 'cancelled') {
      throw new AppError('NOT_FOUND', 'Auction not found');
    }
    return auction;
  }

  return {
    async create(input: {
      listingReference: string;
      startingBidMinor: number;
      incrementMinor: number;
      startsAt: string;
      endsAt: string;
    }, actor: string) {
      const startsAt = new Date(input.startsAt);
      const endsAt = new Date(input.endsAt);
      if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
        throw new AppError('VALIDATION_ERROR', 'Auction end must be after the start', { fieldErrors: { endsAt: 'invalid' } });
      }
      const now = new Date();
      const doc: AuctionDoc = {
        lotReference: lotReference(),
        listingReference: input.listingReference,
        status: 'draft',
        outcome: 'pending',
        startsAt,
        endsAt,
        startingBidMinor: money(input.startingBidMinor, 'startingBidMinor'),
        incrementMinor: money(input.incrementMinor, 'incrementMinor'),
        currentAmountMinor: null,
        highestBidId: null,
        highestUserReference: null,
        bidCount: 0,
        version: 1,
        publishedBy: null,
        publishedAt: null,
        closedAt: null,
        closedBy: null,
        closureReason: null,
        winningBidId: null,
        winningUserReference: null,
        orderReference: null,
        createdAt: now,
        updatedAt: now,
      };
      if (doc.incrementMinor < 1) throw new AppError('VALIDATION_ERROR', 'Increment must be at least 1 minor unit', { fieldErrors: { incrementMinor: 'invalid' } });
      void actor;
      await auctions().insertOne(doc);
      await enqueueLotEndingReminder(deps.db, { lotReference: doc.lotReference, endsAt: doc.endsAt });
      return doc;
    },

    async open(lot: string, actor: string) {
      const now = new Date();
      const current = await auctions().findOne({ lotReference: lot });
      if (!current || current.status !== 'draft') throw new AppError('CONFLICT', 'Only a draft auction can be opened');
      const status: AuctionStatus = current.startsAt <= now ? 'live' : 'scheduled';
      const updated = await auctions().findOneAndUpdate(
        { lotReference: lot, status: 'draft', version: current.version },
        { $set: { status, publishedBy: actor, publishedAt: now, updatedAt: now }, $inc: { version: 1 } },
        { returnDocument: 'after' },
      );
      if (!updated) throw conflict('Auction changed');
      // A previous sold outcome must not keep the product out of the catalogue when a new lot opens.
      await deps.db.collection(COLLECTIONS.listings).updateOne(
        { listingReference: current.listingReference },
        { $set: { availability: 'available', updatedAt: now } },
      );
      await enqueueEvent(deps.db, {
        aggregateType: 'auction',
        aggregateId: lot,
        aggregateVersion: updated.version,
        type: 'auction.started',
        eventId: `${lot}:started`,
        payload: { status: updated.status },
      });
      await enqueueLotEndingReminder(
        deps.db,
        { lotReference: updated.lotReference, endsAt: updated.endsAt },
        undefined,
        { reschedule: true },
      );
      return updated;
    },

    async placeBid(input: {
      lot: string;
      amountMinor: number;
      expectedVersion: number;
      userReference: string;
      roles: Role[];
      status: string;
      idempotencyKey: string | null;
    }) {
      if (input.status !== 'active') throw new AppError('FORBIDDEN', 'This account cannot bid');
      if (isStaff(input.roles)) throw new AppError('FORBIDDEN', 'Staff cannot bid');
      const amountMinor = money(input.amountMinor, 'amountMinor');
      if (input.idempotencyKey) {
        const prior = await bids().findOne({ userReference: input.userReference, idempotencyKey: input.idempotencyKey });
        if (prior) {
          if (prior.amountMinor !== amountMinor) throw conflict('Idempotency key was reused with a different amount');
          const auction = await auctions().findOne({ _id: prior.auctionId });
          return { replay: true, bid: prior, auction };
        }
      }

      const acceptedAt = new Date();
      try {
        return await deps.withTransaction(async (session) => {
          const auction = await auctions().findOne({ lotReference: input.lot }, { session });
          if (!auction) throw new AppError('NOT_FOUND', 'Auction not found');
          if (auction.publishedBy === input.userReference) throw new AppError('FORBIDDEN', 'The auction owner cannot bid');
          const inWindow = auction.startsAt <= acceptedAt && auction.endsAt > acceptedAt;
          const eligible =
            inWindow && (auction.status === 'live' || auction.status === 'scheduled');
          if (!eligible || auction.version !== input.expectedVersion) {
            throw conflict('Bid was not accepted', { auction: stateOf(auction) });
          }
          const minimum = auction.bidCount === 0 ? auction.startingBidMinor : (auction.currentAmountMinor ?? 0) + auction.incrementMinor;
          if (amountMinor < minimum) {
            throw new AppError('VALIDATION_ERROR', 'Bid is below the minimum', {
              fieldErrors: { amountMinor: `minimum is ${minimum}` },
              details: { auction: stateOf(auction) },
            });
          }
          const BID_COOLDOWN_MS = 60_000;
          const priorBid = await bids().findOne(
            { userReference: input.userReference, lotReference: input.lot },
            { session, sort: { acceptedAt: -1 } },
          );
          if (priorBid) {
            const elapsedMs = acceptedAt.getTime() - priorBid.acceptedAt.getTime();
            if (elapsedMs < BID_COOLDOWN_MS) {
              const retryAfterMs = BID_COOLDOWN_MS - elapsedMs;
              const nextBidAt = new Date(priorBid.acceptedAt.getTime() + BID_COOLDOWN_MS);
              throw new AppError('VALIDATION_ERROR', 'Wait before bidding again', {
                details: { retryAfterMs, nextBidAt: nextBidAt.toISOString(), auction: stateOf(auction) },
              });
            }
          }
          const sequence = auction.bidCount + 1;
          const bid: BidDoc = {
            auctionId: auction._id!,
            lotReference: auction.lotReference,
            userReference: input.userReference,
            bidderLabel: bidderLabel(input.userReference),
            amountMinor,
            sequence,
            auctionVersion: auction.version + 1,
            acceptedAt,
            idempotencyKey: input.idempotencyKey,
          };
          const inserted = await bids().insertOne(bid, { session });
          const updated = await auctions().findOneAndUpdate(
            {
              _id: auction._id,
              version: auction.version,
              status: { $in: ['live', 'scheduled'] },
              startsAt: { $lte: acceptedAt },
              endsAt: { $gt: acceptedAt },
            },
            {
              $set: {
                status: 'live',
                currentAmountMinor: amountMinor,
                highestBidId: inserted.insertedId,
                highestUserReference: input.userReference,
                updatedAt: acceptedAt,
              },
              $inc: { version: 1, bidCount: 1 },
            },
            { session, returnDocument: 'after' },
          );
          if (!updated) throw conflict('Bid was not accepted', { auction: stateOf(auction) });
          await enqueueEvent(deps.db, {
            aggregateType: 'auction',
            aggregateId: auction.lotReference,
            aggregateVersion: updated.version,
            type: 'bid.accepted',
            eventId: `${auction.lotReference}:${sequence}`,
            payload: { sequence, amountMinor },
          }, session);
          return { replay: false, bid: { ...bid, _id: inserted.insertedId }, auction: updated };
        });
      } catch (err) {
        if (typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000) {
          const auction = await auctions().findOne({ lotReference: input.lot });
          throw conflict('Bid was not accepted', { auction: auction ? stateOf(auction) : null });
        }
        throw err;
      }
    },

    /** Close every live auction whose end is in the past. Safe for many workers. */
    async closeDue(actor: string) {
      const due = await auctions().find({ status: 'live', endsAt: { $lte: new Date() } }).limit(20).toArray();
      const closed: string[] = [];
      for (const auction of due) closed.push((await this.closeOne(auction.lotReference, actor, 'deadline')).lotReference);
      const scheduled = await auctions().find({ status: 'scheduled', startsAt: { $lte: new Date() } }).limit(20).toArray();
      for (const auction of scheduled) {
        await auctions().updateOne(
          { _id: auction._id, status: 'scheduled', version: auction.version },
          { $set: { status: 'live', updatedAt: new Date() }, $inc: { version: 1 } },
        );
      }
      return closed;
    },

    async closeOne(lot: string, actor: string, reason: string) {
      const now = new Date();
      return deps.withTransaction(async (session) => {
        const auction = await auctions().findOne({ lotReference: lot }, { session });
        if (!auction) throw new AppError('NOT_FOUND', 'Auction not found');
        if (auction.status === 'closed') return auction;
        if (auction.status !== 'live' && auction.status !== 'scheduled') throw conflict('Auction cannot be closed');
        const top = await bids().find({ auctionId: auction._id }, { session }).sort({ sequence: -1 }).limit(1).next();
        const sold = Boolean(top);
        const updated = await auctions().findOneAndUpdate(
          { _id: auction._id, status: auction.status, version: auction.version },
          {
            $set: {
              status: 'closed',
              outcome: sold ? 'sold' : 'no_bids',
              closedAt: now,
              closedBy: actor,
              closureReason: reason,
              winningBidId: top?._id ?? null,
              winningUserReference: top?.userReference ?? null,
              orderReference: sold ? `ord_${auction.lotReference}` : null,
              updatedAt: now,
            },
            $inc: { version: 1 },
          },
          { session, returnDocument: 'after' },
        );
        if (!updated) {
          const again = await auctions().findOne({ lotReference: lot }, { session });
          if (again?.status === 'closed') return again;
          throw conflict('Auction changed while closing');
        }
        if (sold && top) {
          const orderReference = `ord_${auction.lotReference}`;
          await insertSoldOrder(deps.db, {
            lotReference: auction.lotReference,
            listingReference: auction.listingReference,
            winnerUserReference: top.userReference,
            winningPriceMinor: top.amountMinor,
          }, session);
          await enqueueWinnerMailJobs(
            deps.db,
            {
              lotReference: auction.lotReference,
              listingReference: auction.listingReference,
              userReference: top.userReference,
              orderReference,
              closedAt: now,
            },
            session,
          );
        }
        await enqueueEvent(deps.db, {
          aggregateType: 'auction',
          aggregateId: lot,
          aggregateVersion: updated.version,
          type: 'auction.closed',
          eventId: `${lot}:closed`,
          payload: { outcome: updated.outcome, orderReference: updated.orderReference },
        }, session);
        return updated;
      });
    },

    async adminHistory(lot: string, limit: number, options?: { before?: string }) {
      const auction = await auctions().findOne({ lotReference: lot });
      if (!auction) throw new AppError('NOT_FOUND', 'Auction not found');
      const query: Record<string, unknown> = { auctionId: auction._id };
      const beforeSequence = options?.before ? Number(options.before) : NaN;
      if (Number.isInteger(beforeSequence)) query.sequence = { $lt: beforeSequence };
      const rows = await bids().find(query).sort({ sequence: -1 }).limit(limit).toArray();
      const refs = [...new Set(rows.map((row) => row.userReference))];
      const users = refs.length
        ? await deps.db.collection<Pick<UserDoc, 'publicReference' | 'fullName'>>(COLLECTIONS.users)
          .find({ publicReference: { $in: refs } })
          .project({ publicReference: 1, fullName: 1 })
          .toArray()
        : [];
      const fullNameByRef = new Map(users.map((user) => [user.publicReference, user.fullName]));
      return rows.map((bid) => ({
        sequence: bid.sequence,
        userReference: bid.userReference,
        bidderLabel: bid.bidderLabel,
        fullName: fullNameByRef.get(bid.userReference) ?? null,
        amountMinor: bid.amountMinor,
        acceptedAt: bid.acceptedAt.toISOString(),
      }));
    },

    async history(
      lot: string,
      limit: number,
      options?: { before?: string; viewerReference?: string; order?: 'sequence' | 'topAmount' },
    ) {
      const auction = await publicView(lot);
      const query: Record<string, unknown> = { auctionId: auction._id };
      const beforeSequence = options?.before ? Number(options.before) : NaN;
      if (Number.isInteger(beforeSequence)) query.sequence = { $lt: beforeSequence };
      const order = options?.order ?? 'sequence';
      const rows = order === 'topAmount'
        ? await bids().find(query).sort({ amountMinor: -1, sequence: -1 }).limit(limit).toArray()
        : await bids().find(query).sort({ sequence: -1 }).limit(limit).toArray();
      const viewerReference = options?.viewerReference;
      const names = await displayNamesByUserRef(deps.db, rows.map((row) => row.userReference));
      return rows.map((bid) => toPublicBidRow(bid, viewerReference, names.get(bid.userReference)));
    },

    get: publicView,

    async getAdmin(lot: string) {
      const auction = await auctions().findOne({ lotReference: lot });
      if (!auction) throw new AppError('NOT_FOUND', 'Auction not found');
      return auction;
    },

    async listAdmin(query: { listingReference?: string; status?: AuctionStatus; page: number; limit: number }) {
      const filter: Record<string, unknown> = {};
      if (query.listingReference) filter.listingReference = query.listingReference;
      if (query.status) filter.status = query.status;
      const skip = (query.page - 1) * query.limit;
      const coll = auctions();
      const [items, total] = await Promise.all([
        coll.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit).toArray(),
        coll.countDocuments(filter),
      ]);
      const totalPages = total === 0 ? 0 : Math.ceil(total / query.limit);
      return {
        auctions: items.map(adminStateOf),
        page: query.page,
        limit: query.limit,
        total,
        totalPages,
      };
    },
  };
}

export type PublicBidRow = {
  sequence: number;
  bidderLabel: string;
  amountMinor: number;
  acceptedAt: string;
  isMine?: boolean;
};

function toPublicBidRow(bid: BidDoc, viewerReference?: string, displayName?: string): PublicBidRow {
  const row: PublicBidRow = {
    sequence: bid.sequence,
    bidderLabel: displayName?.trim() || bid.bidderLabel,
    amountMinor: bid.amountMinor,
    acceptedAt: bid.acceptedAt.toISOString(),
  };
  if (viewerReference) row.isMine = bid.userReference === viewerReference;
  return row;
}

export function stateOf(auction: AuctionDoc, recentBids?: PublicBidRow[]) {
  return {
    lotReference: auction.lotReference,
    listingReference: auction.listingReference,
    status: auction.status,
    version: auction.version,
    bidCount: auction.bidCount,
    currentAmountMinor: auction.currentAmountMinor,
    startingBidMinor: auction.startingBidMinor,
    incrementMinor: auction.incrementMinor,
    startsAt: auction.startsAt.toISOString(),
    endsAt: auction.endsAt.toISOString(),
    outcome: auction.outcome,
    orderReference: auction.orderReference,
    ...(recentBids ? { recentBids } : {}),
  };
}

export function adminStateOf(auction: AuctionDoc) {
  return {
    lotReference: auction.lotReference,
    listingReference: auction.listingReference,
    status: auction.status,
    outcome: auction.outcome,
    bidCount: auction.bidCount,
    startingBidMinor: auction.startingBidMinor,
    incrementMinor: auction.incrementMinor,
    currentAmountMinor: auction.currentAmountMinor,
    startsAt: auction.startsAt.toISOString(),
    endsAt: auction.endsAt.toISOString(),
    closedAt: auction.closedAt?.toISOString() ?? null,
    winningUserReference: auction.winningUserReference,
    orderReference: auction.orderReference,
    version: auction.version,
  };
}
