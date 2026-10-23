import type { ObjectId } from 'mongodb';
import type { EmailLogDoc } from './emailLogRepository.ts';

export type EmailLogDto = {
  id: string;
  to: string;
  subject: string;
  purpose: string;
  status: 'sent' | 'failed';
  error: string | null;
  createdAt: string;
  userReference: string | null;
};

export function toEmailLogDto(doc: EmailLogDoc & { _id: ObjectId }): EmailLogDto {
  return {
    id: doc._id.toHexString(),
    to: doc.to,
    subject: doc.subject,
    purpose: doc.purpose,
    status: doc.status,
    error: doc.error,
    createdAt: doc.createdAt.toISOString(),
    userReference: doc.userReference,
  };
}
