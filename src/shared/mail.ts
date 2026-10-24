import nodemailer from 'nodemailer';
import type { Db } from 'mongodb';
import type { AppConfig } from '../config/index.ts';
import { AppError } from './errors.ts';
import { insertEmailLog } from '../modules/mail/emailLogRepository.ts';
import { redactMailBodyPreview } from '../modules/mail/redact.ts';

export const mailCaptures: Array<{ to: string; subject: string; text: string }> = [];

function safeSendErrorMessage(err: unknown): string {
  if (err instanceof AppError && err.expose) return err.message;
  if (err instanceof AppError) return 'Email delivery failed';
  if (err instanceof Error && err.message) return 'Email delivery failed';
  return 'Email delivery failed';
}

async function persistEmailLog(
  db: Db,
  input: {
    to: string;
    subject: string;
    purpose: string;
    status: 'sent' | 'failed';
    error: string | null;
    userReference?: string | null;
    listingReference?: string | null;
    lotReference?: string | null;
    body: string;
  },
): Promise<void> {
  try {
    await insertEmailLog(db, {
      to: input.to,
      subject: input.subject,
      purpose: input.purpose,
      status: input.status,
      error: input.error,
      userReference: input.userReference ?? null,
      listingReference: input.listingReference ?? null,
      lotReference: input.lotReference ?? null,
      body: input.body,
    });
  } catch {
    // Logging must not fail a send the user already waited for.
  }
}

export async function sendTransactionalMail(input: {
  config: AppConfig;
  to: string;
  subject: string;
  text: string;
  db?: Db;
  purpose?: string;
  userReference?: string | null;
  listingReference?: string | null;
  lotReference?: string | null;
}): Promise<void> {
  const { config, to, subject, text, db, purpose, userReference, listingReference, lotReference } = input;
  const shouldLog = Boolean(db && purpose);
  const redactedBody = redactMailBodyPreview(text);

  const logFailure = async (err: unknown) => {
    if (!shouldLog || !db || !purpose) return;
    await persistEmailLog(db, {
      to,
      subject,
      purpose,
      status: 'failed',
      error: safeSendErrorMessage(err),
      userReference,
      listingReference,
      lotReference,
      body: redactedBody,
    });
  };

  if (config.isTest) {
    mailCaptures.push({ to, subject, text });
    if (shouldLog && db && purpose) {
      await persistEmailLog(db, {
        to,
        subject,
        purpose,
        status: 'sent',
        error: null,
        userReference,
        listingReference,
        lotReference,
        body: redactedBody,
      });
    }
    return;
  }

  const host = config.smtpHost;
  const fromEmail = config.quoteFromEmail;
  if (!host || !fromEmail) {
    const err = new AppError('SERVICE_UNAVAILABLE', 'Email is not configured on this server');
    await logFailure(err);
    throw err;
  }
  const fromName = config.quoteFromName?.trim() || 'Araq & Kahraman';
  const transport = nodemailer.createTransport({
    host,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass ?? '' } : undefined,
    connectionTimeout: 15_000,
    socketTimeout: 15_000,
    greetingTimeout: 10_000,
  });
  try {
    await transport.sendMail({
      from: `${fromName} <${fromEmail}>`,
      to,
      subject,
      text,
    });
    if (shouldLog && db && purpose) {
      await persistEmailLog(db, {
        to,
        subject,
        purpose,
        status: 'sent',
        error: null,
        userReference,
        listingReference,
        lotReference,
        body: redactedBody,
      });
    }
  } catch (err) {
    await logFailure(err);
    if (err instanceof AppError) throw err;
    throw new AppError('SERVICE_UNAVAILABLE', 'We could not send email right now. Try again in a few minutes.', {
      expose: true,
      cause: err,
    });
  }
}
