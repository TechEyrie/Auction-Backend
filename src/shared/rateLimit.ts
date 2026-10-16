import type { Db } from 'mongodb';
import { COLLECTIONS } from '../db/indexes.ts';

export type RateLimitResult = {
  allowed: boolean;
  count: number;
  remaining: number;
  retryAfterSeconds: number;
};

type RateLimitDoc = {
  _id: string;
  count: number;
  expiresAt: Date;
};

/**
 * Fixed-window counter. Each window bucket is its own document (`key:bucket`), so
 * `$inc` + upsert is atomic and no read-modify-write race exists. TTL removes old
 * buckets; the TTL is cleanup only and never an authorization decision.
 */
export async function consumeRateLimit(
  db: Db,
  input: { key: string; windowMs: number; max: number; now?: number },
): Promise<RateLimitResult> {
  const now = input.now ?? Date.now();
  const bucket = Math.floor(now / input.windowMs);
  const windowEnd = (bucket + 1) * input.windowMs;
  const doc = await db
    .collection<RateLimitDoc>(COLLECTIONS.rateLimits)
    .findOneAndUpdate(
      { _id: `${input.key}:${bucket}` },
      {
        $inc: { count: 1 },
        $setOnInsert: { expiresAt: new Date(windowEnd + input.windowMs) },
      },
      { upsert: true, returnDocument: 'after' },
    );
  const count = doc?.count ?? 1;
  return {
    allowed: count <= input.max,
    count,
    remaining: Math.max(0, input.max - count),
    retryAfterSeconds: Math.max(1, Math.ceil((windowEnd - now) / 1000)),
  };
}
