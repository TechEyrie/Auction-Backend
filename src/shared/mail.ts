import nodemailer from 'nodemailer';
import type { AppConfig } from '../config/index.ts';
import { AppError } from './errors.ts';

export async function sendTransactionalMail(input: {
  config: AppConfig;
  to: string;
  subject: string;
  text: string;
}): Promise<void> {
  const { config, to, subject, text } = input;
  if (config.isTest) return;
  const host = config.smtpHost;
  const fromEmail = config.quoteFromEmail;
  if (!host || !fromEmail) {
    if (config.isProduction) {
      throw new AppError('SERVICE_UNAVAILABLE', 'Email is not configured on this server');
    }
    return;
  }
  const fromName = config.quoteFromName?.trim() || 'Araq & Kahraman';
  const transport = nodemailer.createTransport({
    host,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass ?? '' } : undefined,
  });
  await transport.sendMail({
    from: `${fromName} <${fromEmail}>`,
    to,
    subject,
    text,
  });
}
