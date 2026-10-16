import type { ClientSession, Collection, Db } from 'mongodb';
import { COLLECTIONS } from '../../db/indexes.ts';

export type AuditLogDoc = {
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  requestId: string;
  timestamp: Date;
  /** Redacted, non-sensitive summary of what changed. Never raw secrets/PII. */
  changeSummary: Record<string, unknown>;
  /** Mandatory reason for sensitive administrative actions. */
  reason: string | null;
};

function collection(db: Db): Collection<AuditLogDoc> {
  return db.collection<AuditLogDoc>(COLLECTIONS.auditLogs);
}

/**
 * Append an audit entry. This module intentionally exports no update/delete
 * operations: audit history is append-only. Pair with the business write via the
 * same `session` so the record and the change commit together.
 */
export async function recordAudit(
  db: Db,
  entry: Omit<AuditLogDoc, 'timestamp'> & { timestamp?: Date },
  session?: ClientSession,
): Promise<void> {
  await collection(db).insertOne(
    { ...entry, timestamp: entry.timestamp ?? new Date() },
    session ? { session } : {},
  );
}
