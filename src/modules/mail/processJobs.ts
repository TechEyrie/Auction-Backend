import type { Db } from 'mongodb';
import type { AppConfig } from '../../config/index.ts';
import { COLLECTIONS } from '../../db/indexes.ts';
import { sendTransactionalMail } from '../../shared/mail.ts';
import type { UserDoc } from '../auth/models.ts';
import type { AuctionDoc } from '../auctions/service.ts';
import type { OrderDoc } from '../orders/service.ts';
import {
  claimJobs,
  completeJob,
  failJob,
  reclaimExpiredJobs,
  type DurableJobDoc,
} from '../jobs/repository.ts';
import { MAIL_JOB_TYPES, type WinnerMailPayload } from './jobs.ts';

const MAIL_BACKOFF_MS = 30_000;
const MAIL_LEASE_MS = 60_000;

function siteOrigin(config: AppConfig): string {
  return config.corsOrigins[0] ?? 'http://localhost:3000';
}

function asWinnerPayload(job: DurableJobDoc): WinnerMailPayload | null {
  const p = job.payload;
  if (
    typeof p.lotReference !== 'string' ||
    typeof p.userReference !== 'string' ||
    typeof p.orderReference !== 'string'
  ) {
    return null;
  }
  return {
    lotReference: p.lotReference,
    userReference: p.userReference,
    orderReference: p.orderReference,
  };
}

async function resolveUserEmail(db: Db, userReference: string): Promise<string | null> {
  const user = await db.collection<Pick<UserDoc, 'emailNormalized'>>(COLLECTIONS.users).findOne(
    { publicReference: userReference },
    { projection: { emailNormalized: 1 } },
  );
  const email = user?.emailNormalized?.trim();
  return email || null;
}

async function processOneMailJob(db: Db, config: AppConfig, job: DurableJobDoc): Promise<void> {
  if (job.type === MAIL_JOB_TYPES.winnerWon || job.type === MAIL_JOB_TYPES.winnerAction) {
    const payload = asWinnerPayload(job);
    if (!payload) return;
    if (job.type === MAIL_JOB_TYPES.winnerAction) {
      const order = await db.collection<Pick<OrderDoc, 'paymentState'>>(COLLECTIONS.orders).findOne(
        { orderReference: payload.orderReference },
        { projection: { paymentState: 1 } },
      );
      if (order?.paymentState === 'paid') return;
    }
    const to = await resolveUserEmail(db, payload.userReference);
    if (!to) return;
    const origin = siteOrigin(config);
    if (job.type === MAIL_JOB_TYPES.winnerWon) {
      await sendTransactionalMail({
        config,
        to,
        subject: `You won lot ${payload.lotReference}`,
        text: `You won lot ${payload.lotReference}.\n\nOpen ${origin}/account or ${origin}/product to pay.`,
      });
      return;
    }
    await sendTransactionalMail({
      config,
      to,
      subject: `Reminder: complete payment for lot ${payload.lotReference}`,
      text: `Reminder: you won lot ${payload.lotReference}. Please complete payment.\n\n${origin}/account`,
    });
    return;
  }

  if (job.type === MAIL_JOB_TYPES.lotEnding) {
    const lotReference =
      typeof job.payload.lotReference === 'string' ? job.payload.lotReference : job.key;
    const auction = await db.collection<AuctionDoc>(COLLECTIONS.auctions).findOne({ lotReference });
    if (!auction || auction.status !== 'live') return;
    if (!auction.highestUserReference || auction.bidCount < 1) return;
    const to = await resolveUserEmail(db, auction.highestUserReference);
    if (!to) return;
    await sendTransactionalMail({
      config,
      to,
      subject: `Lot ${lotReference} ends in about 30 minutes`,
      text: `Lot ${lotReference} ends in about 30 minutes. You are the current high bidder.\n\n${siteOrigin(config)}/lot/${lotReference}`,
    });
  }
}

/**
 * Claim and run due `mail.*` durable jobs. Returns how many jobs were claimed this round.
 */
export async function processMailJobs(deps: {
  db: Db;
  config: AppConfig;
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
    try {
      await processOneMailJob(deps.db, deps.config, job);
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
