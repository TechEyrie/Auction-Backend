import type { ClientSession, Db } from 'mongodb';
import { enqueueJob } from '../jobs/repository.ts';

export const MAIL_JOB_TYPES = {
  winnerWon: 'mail.winner_won',
  winnerAction: 'mail.winner_action',
  lotEnding: 'mail.lot_ending',
} as const;

const LOT_ENDING_LEAD_MS = 30 * 60 * 1000;
const WINNER_ACTION_DELAY_MS = 60 * 60 * 1000;

export type WinnerMailPayload = {
  lotReference: string;
  userReference: string;
  orderReference: string;
};

export function lotEndingRunAfter(endsAt: Date, now = new Date()): Date | null {
  const runAfter = new Date(endsAt.getTime() - LOT_ENDING_LEAD_MS);
  if (runAfter.getTime() <= now.getTime()) return null;
  return runAfter;
}

export async function enqueueLotEndingReminder(
  db: Db,
  input: { lotReference: string; endsAt: Date },
  session?: ClientSession,
  options?: { reschedule?: boolean },
): Promise<void> {
  const runAfter = lotEndingRunAfter(input.endsAt);
  if (!runAfter) return;
  await enqueueJob(
    db,
    {
      type: MAIL_JOB_TYPES.lotEnding,
      key: input.lotReference,
      payload: { lotReference: input.lotReference },
      runAfter,
      reschedule: options?.reschedule ?? false,
    },
    session,
  );
}

export async function enqueueWinnerMailJobs(
  db: Db,
  input: { lotReference: string; userReference: string; orderReference: string; closedAt: Date },
  session?: ClientSession,
): Promise<void> {
  const payload: WinnerMailPayload = {
    lotReference: input.lotReference,
    userReference: input.userReference,
    orderReference: input.orderReference,
  };
  await enqueueJob(
    db,
    {
      type: MAIL_JOB_TYPES.winnerWon,
      key: input.lotReference,
      payload,
      runAfter: input.closedAt,
    },
    session,
  );
  await enqueueJob(
    db,
    {
      type: MAIL_JOB_TYPES.winnerAction,
      key: input.lotReference,
      payload,
      runAfter: new Date(input.closedAt.getTime() + WINNER_ACTION_DELAY_MS),
    },
    session,
  );
}
