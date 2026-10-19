import type { Db } from 'mongodb';
import type { AppConfig } from '../../config/index.ts';
import { AppError, conflict } from '../../shared/errors.ts';
import type { Logger } from '../../shared/logger.ts';
import { decryptSecret, encryptSecret, randomToken, recoveryCodeHash, safeEqualHex, sha256Hex } from '../../shared/crypto.ts';
import { hashPassword, verifyPassword } from '../../shared/password.ts';
import { evaluatePassword, passwordPolicyMessage } from '../../shared/passwordPolicy.ts';
import { normalizeEmail, normalizePhoneE164 } from '../../shared/normalize.ts';
import { generateTotpSecret, verifyTotp, TOTP_STEP_SECONDS } from '../../shared/totp.ts';
import { recordAudit } from '../audit/repository.ts';
import { toUserDto, type UserDto } from './dto.ts';
import { capabilitiesFor, isStaff } from './roles.ts';
import * as repo from './repository.ts';
import type { AuthContext, SessionDoc, UserDoc, UserWithId } from './models.ts';

export type AuthDeps = { db: Db; config: AppConfig; logger: Logger };

const CHALLENGE_TTL_MS = 30 * 60_000;
const CHALLENGE_MAX_ATTEMPTS = 5;
const RECOVERY_CODE_COUNT = 10;

export type IssuedSession = { token: string; csrfToken: string; cookieMaxAgeMs: number | undefined };

function publicReference(): string {
  return `u_${randomToken(9)}`;
}

function currentStep(atMs = Date.now()): number {
  return Math.floor(atMs / 1000 / TOTP_STEP_SECONDS);
}

/** Customers must satisfy TOTP MFA; staff enforcement is deferred. */
export function requiresMfa(user: UserDoc): boolean {
  if (isStaff(user.roles)) return false; // TEMP: staff MFA later
  return true;
}

function assertPasswordPolicy(
  password: string,
  ctx: { email?: string | null; fullName?: string | null } = {},
): void {
  const result = evaluatePassword(password, ctx);
  if (result.acceptable) return;
  throw new AppError('VALIDATION_ERROR', 'Password does not meet requirements', {
    fieldErrors: { password: passwordPolicyMessage(result) },
    details: { score: result.score, issues: result.issues },
  });
}

async function issueSession(
  deps: AuthDeps,
  user: UserWithId,
  options: { keepSignedIn: boolean; ip: string | null; userAgent: string | null },
): Promise<IssuedSession> {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const now = new Date();
  const mfaRequired = requiresMfa(user);
  const absolute = options.keepSignedIn ? deps.config.keepSignedInMs : deps.config.sessionAbsoluteMs;

  const doc: SessionDoc = {
    userId: user._id,
    tokenHash: sha256Hex(token),
    csrfHash: sha256Hex(csrfToken),
    createdAt: now,
    lastUsedAt: now,
    idleExpiresAt: new Date(now.getTime() + deps.config.sessionIdleMs),
    absoluteExpiresAt: new Date(now.getTime() + absolute),
    revokedAt: null,
    revokedReason: null,
    mfaSatisfied: !mfaRequired,
    lastMfaStep: null,
    keepSignedIn: options.keepSignedIn,
    ip: options.ip,
    userAgent: options.userAgent,
  };
  await repo.createSession(deps.db, doc);
  return {
    token,
    csrfToken,
    cookieMaxAgeMs: options.keepSignedIn ? deps.config.keepSignedInMs : undefined,
  };
}

export type RegisterInput = {
  fullName: string;
  phone?: string | null;
  email?: string | null;
  password: string;
  preferredLocale?: string;
  termsAccepted: boolean;
  termsVersion?: string | null;
};

export function createAuthService(deps: AuthDeps) {
  const { db, config } = deps;

  async function register(input: RegisterInput, ctx: { ip: string | null; userAgent: string | null }) {
    const phoneE164 = input.phone?.trim() ? normalizePhoneE164(input.phone) : null;
    const emailNormalized = normalizeEmail(input.email ?? null);
    if (!phoneE164 && !emailNormalized) {
      throw new AppError('VALIDATION_ERROR', 'Enter an email address', {
        fieldErrors: { email: 'required' },
      });
    }
    assertPasswordPolicy(input.password, { email: emailNormalized, fullName: input.fullName });
    if (input.termsAccepted !== true) {
      throw new AppError('VALIDATION_ERROR', 'You must accept the terms of use', {
        fieldErrors: { termsAccepted: 'required' },
      });
    }
    // Never invent a legal version: use the published one, or record none.
    if (config.legalTermsVersion && input.termsVersion && input.termsVersion !== config.legalTermsVersion) {
      throw new AppError('VALIDATION_ERROR', 'Terms version is not current', {
        fieldErrors: { termsVersion: 'out of date' },
      });
    }
    const termsVersion = config.legalTermsVersion ?? input.termsVersion ?? null;
    const passwordHash = await hashPassword(input.password);
    const now = new Date();
    const doc: UserDoc = {
      publicReference: publicReference(),
      fullName: String(input.fullName ?? '').trim().slice(0, 120),
      phoneE164,
      emailNormalized,
      passwordHash,
      status: 'active',
      // Roles/status/verification are server-controlled only — never from public input.
      roles: ['customer'],
      phoneVerifiedAt: null,
      emailVerifiedAt: null,
      preferredLocale: (input.preferredLocale ?? 'en').slice(0, 8),
      termsVersion,
      termsAcceptedAt: now,
      lastLoginAt: null,
      suspension: null,
      mfa: { enabled: false, secretEnc: null, confirmedAt: null, recoveryCodes: [], lastStep: null },
      createdAt: now,
      updatedAt: now,
    };
    let insertedId;
    try {
      insertedId = await repo.insertUser(db, doc);
    } catch (err) {
      if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000) {
        // Unique index is the authority: concurrent duplicates cannot both win.
        throw conflict('An account with those details already exists');
      }
      throw err;
    }
    const user: UserWithId = { ...doc, _id: insertedId };
    const session = await issueSession(deps, user, { keepSignedIn: false, ...ctx });
    await repo.markLastLogin(db, insertedId);
    await recordAudit(db, {
      actorId: insertedId.toHexString(),
      action: 'user.register',
      targetType: 'user',
      targetId: doc.publicReference,
      requestId: 'n/a',
      changeSummary: { phoneE164, roles: doc.roles },
      reason: null,
    });
    return { user: toUserDto(user), session };
  }

  async function login(
    input: { identifier: string; password: string; keepSignedIn?: boolean },
    ctx: { ip: string | null; userAgent: string | null },
  ) {
    const identifierRaw = String(input.identifier ?? '').trim();
    let identifier = identifierRaw.toLowerCase();
    if (identifierRaw.replace(/[^\d]/g, '').length >= 8 && !identifierRaw.includes('@')) {
      identifier = normalizePhoneE164(identifierRaw);
    }
    const user = await repo.findUserByIdentifier(db, identifier);
    // Verify against a dummy hash when the user is unknown to keep timing uniform.
    const stored = user?.passwordHash ?? 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAA';
    const okPassword = await verifyPassword(String(input.password ?? ''), stored);
    if (!user || !okPassword) {
      throw new AppError('UNAUTHORIZED', 'Invalid credentials');
    }
    if (user.status !== 'active') {
      throw new AppError('FORBIDDEN', 'This account cannot sign in');
    }
    const session = await issueSession(deps, user, {
      keepSignedIn: input.keepSignedIn === true,
      ...ctx,
    });
    await repo.markLastLogin(db, user._id);
    return { user: toUserDto(user), session, mfaRequired: requiresMfa(user) };
  }

  async function logout(ctx: AuthContext | null): Promise<void> {
    if (!ctx) return;
    await repo.revokeSession(db, ctx.session._id, 'logout');
  }

  async function forgotPassword(identifierRaw: string, ip: string | null): Promise<string | null> {
    const raw = String(identifierRaw ?? '').trim();
    let identifier = raw.toLowerCase();
    if (raw.replace(/[^\d]/g, '').length >= 8 && !raw.includes('@')) identifier = normalizePhoneE164(raw);
    const user = await repo.findUserByIdentifier(db, identifier);
    if (!user || user.status !== 'active') {
      // Generic response: do not reveal whether the identifier exists.
      return null;
    }
    await repo.invalidateUserChallenges(db, user._id, 'password_reset');
    const token = randomToken(32);
    await repo.insertChallenge(db, {
      purpose: 'password_reset',
      userId: user._id,
      identifier,
      tokenHash: sha256Hex(token),
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
      attempts: 0,
      maxAttempts: CHALLENGE_MAX_ATTEMPTS,
      consumedAt: null,
      createdAt: new Date(),
      requestIp: ip,
    });
    // Delivery adapter is not configured: the token is returned only outside production.
    return config.isProduction ? null : token;
  }

  async function resetPassword(token: string, newPassword: string): Promise<void> {
    const challenge = await repo.findChallengeByTokenHash(db, sha256Hex(String(token ?? '')));
    if (!challenge || challenge.purpose !== 'password_reset' || challenge.consumedAt) {
      throw new AppError('VALIDATION_ERROR', 'This reset link is invalid or has already been used');
    }
    if (challenge.expiresAt.getTime() < Date.now()) {
      throw new AppError('VALIDATION_ERROR', 'This reset link has expired');
    }
    if (challenge.attempts >= challenge.maxAttempts) {
      throw new AppError('RATE_LIMITED', 'Too many attempts on this reset link');
    }
    const existing = challenge.userId ? await repo.findUserById(db, challenge.userId) : null;
    assertPasswordPolicy(newPassword, {
      email: existing?.emailNormalized ?? null,
      fullName: existing?.fullName ?? null,
    });
    await repo.incrementChallengeAttempts(db, challenge._id);
    const consumed = await repo.consumeChallenge(db, challenge._id);
    if (!consumed) throw new AppError('VALIDATION_ERROR', 'This reset link has already been used');
    if (!challenge.userId) throw new AppError('VALIDATION_ERROR', 'This reset link is invalid');
    const passwordHash = await hashPassword(newPassword);
    await repo.updateUserPasswordHash(db, challenge.userId, passwordHash);
    // Password reset invalidates every existing session for that user.
    await repo.revokeAllUserSessions(db, challenge.userId, 'password_reset');
  }

  async function startMfaEnrollment(user: UserWithId, keyBase64: string, code?: string) {
    let mfaState = user.mfa;
    if (mfaState.enabled) {
      if (!code) {
        throw new AppError('CONFLICT', 'MFA is already enabled');
      }
      let verified = false;
      if (mfaState.secretEnc) {
        const existingSecret = decryptSecret(mfaState.secretEnc, keyBase64);
        if (verifyTotp(existingSecret, String(code))) verified = true;
      }
      if (!verified) {
        const hash = recoveryCodeHash(String(code));
        const index = mfaState.recoveryCodes.findIndex((c) => c.usedAt === null && safeEqualHex(c.hash, hash));
        if (index >= 0) {
          mfaState = {
            ...mfaState,
            recoveryCodes: mfaState.recoveryCodes.map((c, i) => (i === index ? { ...c, usedAt: new Date() } : c)),
          };
          verified = true;
        }
      }
      if (!verified) {
        throw new AppError('VALIDATION_ERROR', 'That code is not valid', { fieldErrors: { code: 'invalid' } });
      }
    }
    const secret = generateTotpSecret();
    await repo.updateUserMfa(db, user._id, {
      ...mfaState,
      enabled: false,
      secretEnc: encryptSecret(secret, keyBase64),
      confirmedAt: null,
      recoveryCodes: [],
      lastStep: null,
    });
    const label = encodeURIComponent(`Araq & Kahraman:${user.emailNormalized ?? user.phoneE164 ?? user.publicReference}`);
    const otpauthUrl = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent('Araq & Kahraman')}&period=30&digits=6`;
    // Secret is returned once for the authenticator; never logged.
    return { secret, otpauthUrl };
  }

  async function confirmMfaEnrollment(user: UserWithId, session: AuthContext['session'], code: string, keyBase64: string) {
    if (!user.mfa.secretEnc) throw new AppError('VALIDATION_ERROR', 'Start MFA enrollment first');
    const secret = decryptSecret(user.mfa.secretEnc, keyBase64);
    if (!verifyTotp(secret, String(code ?? ''))) {
      throw new AppError('VALIDATION_ERROR', 'That code is not valid', { fieldErrors: { code: 'invalid' } });
    }
    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => randomToken(8));
    await repo.updateUserMfa(db, user._id, {
      enabled: true,
      secretEnc: user.mfa.secretEnc,
      confirmedAt: new Date(),
      recoveryCodes: recoveryCodes.map((c) => ({ hash: recoveryCodeHash(c), usedAt: null })),
      // Enrollment confirmation is not a login challenge; leave replay guard unset.
      lastStep: null,
    });
    await repo.setSessionMfaSatisfied(db, session._id, currentStep());
    return { recoveryCodes };
  }

  async function mfaChallenge(user: UserWithId, session: AuthContext['session'], code: string, keyBase64: string) {
    if (session.mfaSatisfied) throw new AppError('CONFLICT', 'MFA is already satisfied for this session');
    if (!user.mfa.enabled || !user.mfa.secretEnc) {
      throw new AppError('VALIDATION_ERROR', 'MFA is not enabled for this account');
    }
    const step = currentStep();
    if (user.mfa.lastStep !== null && step <= user.mfa.lastStep) {
      // The code was already accepted (possibly for another session): refuse replay.
      throw new AppError('CONFLICT', 'This code has already been used');
    }
    const secret = decryptSecret(user.mfa.secretEnc, keyBase64);
    if (!verifyTotp(secret, String(code ?? ''))) {
      throw new AppError('VALIDATION_ERROR', 'That code is not valid', { fieldErrors: { code: 'invalid' } });
    }
    // Record the step on the user so the same code cannot open a second session.
    await repo.updateUserMfa(db, user._id, { ...user.mfa, lastStep: step });
    await repo.setSessionMfaSatisfied(db, session._id, step);
    // Rotate the credential on the privilege change.
    const token = randomToken(32);
    const csrfToken = randomToken(24);
    await repo.rotateSession(db, session._id, sha256Hex(token), sha256Hex(csrfToken));
    return { token, csrfToken };
  }

  async function mfaRecover(user: UserWithId, session: AuthContext['session'], code: string) {
    if (session.mfaSatisfied) throw new AppError('CONFLICT', 'MFA is already satisfied for this session');
    const hash = recoveryCodeHash(String(code ?? ''));
    const index = user.mfa.recoveryCodes.findIndex((c) => c.usedAt === null && safeEqualHex(c.hash, hash));
    if (index < 0) throw new AppError('VALIDATION_ERROR', 'That recovery code is not valid');
    const codes = user.mfa.recoveryCodes.map((c, i) => (i === index ? { ...c, usedAt: new Date() } : c));
    await repo.updateUserMfa(db, user._id, { ...user.mfa, recoveryCodes: codes });
    await repo.setSessionMfaSatisfied(db, session._id, currentStep());
    const token = randomToken(32);
    const csrfToken = randomToken(24);
    await repo.rotateSession(db, session._id, sha256Hex(token), sha256Hex(csrfToken));
    return { token, csrfToken, remainingRecoveryCodes: codes.filter((c) => c.usedAt === null).length };
  }

  function sessionView(
    user: UserWithId,
    session: AuthContext['session'],
  ): { user: UserDto; mfaRequired: boolean; mfaEnabled: boolean; capabilities: string[] } {
    const mfaRequired = requiresMfa(user);
    return {
      user: toUserDto(user),
      mfaRequired: mfaRequired && !session.mfaSatisfied,
      mfaEnabled: user.mfa.enabled,
      capabilities: !mfaRequired || session.mfaSatisfied ? capabilitiesOf(user) : [],
    };
  }

  function capabilitiesOf(user: UserDoc): string[] {
    return [...capabilitiesFor(user.roles)];
  }

  return {
    register,
    login,
    logout,
    forgotPassword,
    resetPassword,
    startMfaEnrollment,
    confirmMfaEnrollment,
    mfaChallenge,
    mfaRecover,
    sessionView,
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
