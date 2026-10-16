import type { Db } from 'mongodb';
import { AppError } from '../../shared/errors.ts';
import { hashPassword } from '../../shared/password.ts';
import { normalizePhoneE164 } from '../../shared/normalize.ts';
import { randomToken } from '../../shared/crypto.ts';
import { recordAudit } from '../audit/repository.ts';
import * as repo from '../auth/repository.ts';
import { COLLECTIONS } from '../../db/indexes.ts';
import type { UserDoc } from '../auth/models.ts';
import { syncSuperAdminCounter } from './superAdminGuard.ts';
import { MIN_BOOTSTRAP_TOKEN_LENGTH } from '../../config/bootstrapToken.ts';

export type BootstrapInput = { fullName: string; phone: string; password: string };

export type BootstrapTicket = {
  /** Token expected by this deployment, when the environment defines one. */
  expectedToken?: string | null;
  /** Token supplied by the operator running the command. */
  confirmToken?: string;
};


/**
 * Create the first super admin. Explicit and one-time: refuses when any super
 * admin already exists. There is no default password and no HTTP route — this is
 * invoked by the documented CLI command only.
 *
 * Bootstrapping also requires an explicit operator token. It is a deliberate speed bump:
 * creating the first super admin must be a conscious, credentialed act, and a deployment that
 * already defines `ADMIN_BOOTSTRAP_TOKEN` refuses a command carrying anything else.
 */
export async function bootstrapSuperAdmin(
  db: Db,
  input: BootstrapInput,
  ticket: BootstrapTicket = {},
): Promise<{ publicReference: string }> {
  const expected = (ticket.expectedToken ?? '').trim();
  const supplied = (ticket.confirmToken ?? '').trim();
  if (expected) {
    if (supplied !== expected) {
      throw new AppError('FORBIDDEN', 'Refusing to bootstrap: ADMIN_BOOTSTRAP_TOKEN does not match this deployment');
    }
  } else if (supplied.length < MIN_BOOTSTRAP_TOKEN_LENGTH) {
    throw new AppError('FORBIDDEN', `Refusing to bootstrap: an operator token of at least ${MIN_BOOTSTRAP_TOKEN_LENGTH} characters is required`);
  }

  const existing = await db.collection(COLLECTIONS.users).countDocuments({ roles: 'super_admin' });
  if (existing > 0) {
    throw new AppError('CONFLICT', 'A super admin already exists; bootstrap is disabled');
  }
  if (String(input.password ?? '').length < 12 || String(input.password).length > 200) {
    throw new AppError('VALIDATION_ERROR', 'Bootstrap password must be at least 12 characters', {
      fieldErrors: { password: 'must be at least 12 characters' },
    });
  }
  const fullName = String(input.fullName ?? '').trim();
  if (fullName.length < 2) {
    throw new AppError('VALIDATION_ERROR', 'A full name is required', { fieldErrors: { fullName: 'required' } });
  }
  const phoneE164 = normalizePhoneE164(input.phone);
  const now = new Date();
  const doc: UserDoc = {
    publicReference: `u_${randomToken(9)}`,
    fullName,
    phoneE164,
    emailNormalized: null,
    passwordHash: await hashPassword(input.password),
    status: 'active',
    roles: ['super_admin'],
    phoneVerifiedAt: null,
    emailVerifiedAt: null,
    preferredLocale: 'en',
    termsVersion: null,
    termsAcceptedAt: null,
    lastLoginAt: null,
    suspension: null,
    mfa: { enabled: false, secretEnc: null, confirmedAt: null, recoveryCodes: [], lastStep: null },
    createdAt: now,
    updatedAt: now,
  };
  await repo.insertUser(db, doc);
  await syncSuperAdminCounter(db);
  await recordAudit(db, {
    actorId: null,
    action: 'admin.bootstrap',
    targetType: 'user',
    targetId: doc.publicReference,
    requestId: 'bootstrap',
    changeSummary: { roles: ['super_admin'] },
    reason: 'initial super admin bootstrap',
  });
  return { publicReference: doc.publicReference };
}
