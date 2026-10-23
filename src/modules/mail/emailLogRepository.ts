import type { Collection, Db, ObjectId } from 'mongodb';
import { COLLECTIONS } from '../../db/indexes.ts';

export type EmailLogStatus = 'sent' | 'failed';

export type EmailLogDoc = {
  to: string;
  subject: string;
  purpose: string;
  status: EmailLogStatus;
  error: string | null;
  userReference: string | null;
  createdAt: Date;
};

function collection(db: Db): Collection<EmailLogDoc> {
  return db.collection<EmailLogDoc>(COLLECTIONS.emailLogs);
}

export async function insertEmailLog(
  db: Db,
  entry: Omit<EmailLogDoc, 'createdAt'> & { createdAt?: Date },
): Promise<ObjectId> {
  const result = await collection(db).insertOne({
    ...entry,
    createdAt: entry.createdAt ?? new Date(),
  });
  return result.insertedId;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function listEmailLogs(
  db: Db,
  input: { limit: number; q?: string },
): Promise<Array<EmailLogDoc & { _id: ObjectId }>> {
  const filter: Record<string, unknown> = {};
  const q = input.q?.trim();
  if (q) {
    const escaped = escapeRegex(q);
    filter.$or = [
      { to: { $regex: escaped, $options: 'i' } },
      { subject: { $regex: escaped, $options: 'i' } },
    ];
  }
  return collection(db)
    .find(filter)
    .sort({ createdAt: -1 })
    .limit(input.limit)
    .toArray();
}
