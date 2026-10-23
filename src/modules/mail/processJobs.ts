import type { Db } from 'mongodb';
import type { AppConfig } from '../../config/index.ts';
import type { Logger } from '../../shared/logger.ts';
import { COLLECTIONS } from '../../db/indexes.ts';
import { sendTransactionalMail } from '../../shared/mail.ts';
import type { UserDoc } from '../auth/models.ts';
import type { AuctionDoc } from '../auctions/service.ts';
import type { OrderDoc } from '../orders/service.ts';
import type { ListingDoc, LocalizedText } from '../listings/models.ts';
import {
  claimJobs,
  completeJob,
  failJob,
  reclaimExpiredJobs,
  type DurableJobDoc,
} from '../jobs/repository.ts';
import { MAIL_JOB_TYPES, type WinnerMailPayload } from './jobs.ts';

const MAIL_BACKOFF_MS = 30_000;
const MAIL_RETRY_BACKOFF_MS = 10_000;
const MAIL_LEASE_MS = 60_000;

export type MailJobOutcome = 'sent' | 'skip' | 'retry';

type ListingMailProjection = Pick<ListingDoc, 'listingReference' | 'title'>;

function siteOrigin(config: AppConfig): string {
  return config.corsOrigins[0] ?? 'http://localhost:3000';
}

function listingDisplayTitle(title: LocalizedText | null | undefined): string {
  const en = title?.en?.trim() ?? '';
  const ar = title?.ar?.trim() ?? '';
  return en || ar || 'this item';
}

function productUrl(origin: string, listingReference: string): string {
  const ref = listingReference.trim();
  return `${origin}/product/${encodeURIComponent(ref)}`;
}

async function loadListingForMail(db: Db, listingReference: string): Promise<ListingMailProjection | null> {
  return db.collection<ListingMailProjection>(COLLECTIONS.listings).findOne(
    { listingReference },
    { projection: { listingReference: 1, title: 1 } },
  );
}

async function resolveWinnerListingReference(
  db: Db,
  payload: { lotReference: string; listingReference?: string },
): Promise<string | null> {
  if (payload.listingReference) return payload.listingReference;
  const auction = await db.collection<Pick<AuctionDoc, 'listingReference'>>(COLLECTIONS.auctions).findOne(
    { lotReference: payload.lotReference },
    { projection: { listingReference: 1 } },
  );
  return auction?.listingReference ?? null;
}

async function sendMailWithLogging(
  logger: Logger | undefined,
  jobType: string,
  input: {
    config: AppConfig;
    db: Db;
    to: string;
    subject: string;
    text: string;
    userReference: string | null;
  },
): Promise<void> {
  const { to, subject } = input;
  try {
    await sendTransactionalMail({
      ...input,
      purpose: jobType,
    });
    logger?.info('transactional mail sent', { type: jobType, to, subject });
  } catch (err) {
    logger?.error('transactional mail failed', {
      type: jobType,
      to,
      subject,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function resolveUserEmail(db: Db, userReference: string): Promise<string | null> {
  const user = await db.collection<Pick<UserDoc, 'emailNormalized'>>(COLLECTIONS.users).findOne(
    { publicReference: userReference },
    { projection: { emailNormalized: 1 } },
  );
  const email = user?.emailNormalized?.trim();
  return email || null;
}

async function processOneMailJob(
  db: Db,
  config: AppConfig,
  job: DurableJobDoc,
  logger?: Logger,
): Promise<MailJobOutcome> {
  const origin = siteOrigin(config);

  if (job.type === MAIL_JOB_TYPES.winnerWon || job.type === MAIL_JOB_TYPES.winnerAction) {
    const raw = job.payload;
    if (
      typeof raw.lotReference !== 'string' ||
      typeof raw.userReference !== 'string' ||
      typeof raw.orderReference !== 'string'
    ) {
      logger?.warn('transactional mail skipped', { type: job.type, reason: 'invalid payload' });
      return 'skip';
    }
    const listingReference = await resolveWinnerListingReference(db, {
      lotReference: raw.lotReference,
      listingReference: typeof raw.listingReference === 'string' ? raw.listingReference : undefined,
    });
    if (!listingReference) {
      logger?.warn('transactional mail skipped', { type: job.type, reason: 'listing not found' });
      return 'skip';
    }
    const payload: WinnerMailPayload = {
      lotReference: raw.lotReference,
      listingReference,
      userReference: raw.userReference,
      orderReference: raw.orderReference,
    };
    if (job.type === MAIL_JOB_TYPES.winnerAction) {
      const order = await db.collection<Pick<OrderDoc, 'paymentState'>>(COLLECTIONS.orders).findOne(
        { orderReference: payload.orderReference },
        { projection: { paymentState: 1 } },
      );
      if (order?.paymentState === 'paid') {
        logger?.warn('transactional mail skipped', { type: job.type, reason: 'order already paid' });
        return 'skip';
      }
    }
    const to = await resolveUserEmail(db, payload.userReference);
    if (!to) {
      logger?.warn('transactional mail deferred', { type: job.type, reason: 'recipient email missing' });
      return 'retry';
    }
    const listing = await loadListingForMail(db, listingReference);
    const title = listingDisplayTitle(listing?.title);
    const product = productUrl(origin, listingReference);
    if (job.type === MAIL_JOB_TYPES.winnerWon) {
      const subject = `You won the auction for ${title}`;
      await sendMailWithLogging(logger, job.type, {
        config,
        db,
        to,
        subject,
        text: `You won the auction for ${title}. ${product}`,
        userReference: payload.userReference,
      });
      return 'sent';
    }
    const subject = `Reminder: complete payment for ${title}`;
    await sendMailWithLogging(logger, job.type, {
      config,
      db,
      to,
      subject,
      text: `Reminder: you won the auction for ${title}. Please complete payment. ${product}`,
      userReference: payload.userReference,
    });
    return 'sent';
  }

  if (job.type === MAIL_JOB_TYPES.lotEnding) {
    const lotReference =
      typeof job.payload.lotReference === 'string' ? job.payload.lotReference : job.key;
    const auction = await db.collection<AuctionDoc>(COLLECTIONS.auctions).findOne({ lotReference });
    if (!auction) {
      logger?.warn('transactional mail skipped', { type: job.type, reason: 'auction not found' });
      return 'skip';
    }
    if (auction.status === 'cancelled' || auction.status === 'closed') {
      logger?.warn('transactional mail skipped', {
        type: job.type,
        reason: `auction ${auction.status}`,
      });
      return 'skip';
    }
    if (auction.status === 'draft') {
      logger?.warn('transactional mail deferred', { type: job.type, reason: 'auction draft' });
      return 'retry';
    }
    if (auction.status !== 'live' && auction.status !== 'scheduled') {
      logger?.warn('transactional mail skipped', { type: job.type, reason: `auction ${auction.status}` });
      return 'skip';
    }
    if (!auction.highestUserReference || auction.bidCount < 1) {
      logger?.warn('transactional mail deferred', { type: job.type, reason: 'no high bidder yet' });
      return 'retry';
    }
    const to = await resolveUserEmail(db, auction.highestUserReference);
    if (!to) {
      logger?.warn('transactional mail deferred', { type: job.type, reason: 'recipient email missing' });
      return 'retry';
    }
    const listing = await loadListingForMail(db, auction.listingReference);
    const title = listingDisplayTitle(listing?.title);
    const product = productUrl(origin, auction.listingReference);
    const subject = `The auction for ${title} is ending soon`;
    await sendMailWithLogging(logger, job.type, {
      config,
      db,
      to,
      subject,
      text: `The auction for ${title} is ending soon. You are the current high bidder. ${product}`,
      userReference: auction.highestUserReference,
    });
    return 'sent';
  }

  logger?.warn('transactional mail skipped', { type: job.type, reason: 'unknown mail job type' });
  return 'skip';
}

/**
 * Claim and run due `mail.*` durable jobs. Returns how many jobs were claimed this round.
 */
export async function processMailJobs(deps: {
  db: Db;
  config: AppConfig;
  logger?: Logger;
  owner: string;
  limit?: number;
  now?: Date;
}): Promise<number> {
  const now = deps.now ?? new Date();
  await reclaimExpiredJobs(deps.db, { limit: 20, now });
  const jobs = await claimJobs(deps.db, {
    owner: deps.owner,
    limit: deps.limit ?? 10,
    leaseMs: MAIL_LEASE_MS,
    typePrefix: 'mail.',
    now,
  });
  for (const job of jobs) {
    deps.logger?.info('mail job claimed', { type: job.type, jobId: job.jobId, key: job.key });
    try {
      const outcome = await processOneMailJob(deps.db, deps.config, job, deps.logger);
      if (outcome === 'retry') {
        await failJob(deps.db, {
          jobId: job.jobId,
          owner: deps.owner,
          error: 'mail deferred for retry',
          backoffMs: MAIL_RETRY_BACKOFF_MS,
          now,
        });
        continue;
      }
      const done = await completeJob(deps.db, { jobId: job.jobId, owner: deps.owner });
      if (!done) {
        await failJob(deps.db, {
          jobId: job.jobId,
          owner: deps.owner,
          error: 'lost lease while completing mail job',
          backoffMs: MAIL_BACKOFF_MS,
          now,
        });
      }
    } catch (err) {
      await failJob(deps.db, {
        jobId: job.jobId,
        owner: deps.owner,
        error: err instanceof Error ? err.message : String(err),
        backoffMs: MAIL_BACKOFF_MS,
        now,
      });
    }
  }
  return jobs.length;
}
