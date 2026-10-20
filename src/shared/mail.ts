import nodemailer from 'nodemailer';
import type { AppConfig } from '../config/index.ts';
import { AppError } from './errors.ts';

export const mailCaptures: Array<{ to: string; subject: string; text: string }> = [];

export async function sendTransactionalMail(input: {
  config: AppConfig;
  to: string;
  subject: string;
  text: string;
}): Promise<void> {
  const { config, to, subject, text } = input;
  if (config.isTest) {
    mailCaptures.push({ to, subject, text });
    return;
  }
  const host = config.smtpHost;
  const fromEmail = config.quoteFromEmail;
  if (!host || !fromEmail) {
    throw new AppError('SERVICE_UNAVAILABLE', 'Email is not configured on this server');
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
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('SERVICE_UNAVAILABLE', 'We could not send email right now. Try again in a few minutes.', {
      expose: true,
      cause: err,
    });
  }
}
