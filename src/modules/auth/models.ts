import type { ObjectId } from 'mongodb';
import type { Role } from './roles.ts';

export type UserStatus = 'active' | 'suspended' | 'disabled';

export type MfaRecoveryCode = { hash: string; usedAt: Date | null };

export type UserMfa = {
  enabled: boolean;
  /** AES-256-GCM encrypted TOTP secret; null until enrollment starts. */
  secretEnc: string | null;
  confirmedAt: Date | null;
  recoveryCodes: MfaRecoveryCode[];
  /** Highest accepted TOTP step for this user — prevents replaying a code in a new session. */
  lastStep: number | null;
};

export type UserDoc = {
  publicReference: string;
  fullName: string;
  /** Null when the account was created with email and password only. */
  phoneE164: string | null;
  emailNormalized: string | null;
  passwordHash: string;
  status: UserStatus;
  roles: Role[];
  phoneVerifiedAt: Date | null;
  emailVerifiedAt: Date | null;
  preferredLocale: string;
  termsVersion: string | null;
  termsAcceptedAt: Date | null;
  lastLoginAt: Date | null;
  suspension: { reason: string; actorId: string; at: Date } | null;
  mfa: UserMfa;
  createdAt: Date;
  updatedAt: Date;
};

export type UserWithId = UserDoc & { _id: ObjectId };

export type SessionDoc = {
  userId: ObjectId;
  /** SHA-256 hash of the opaque session credential. The raw value exists only in the cookie. */
  tokenHash: string;
  /** SHA-256 hash of the CSRF token bound to this session. */
  csrfHash: string;
  createdAt: Date;
  lastUsedAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
  /** False until the MFA challenge is completed — a pre-MFA session is NOT privileged. */
  mfaSatisfied: boolean;
  /** Highest accepted TOTP step, to prevent replay of a successful challenge. */
  lastMfaStep: number | null;
  keepSignedIn: boolean;
  ip: string | null;
  userAgent: string | null;
};

export type SessionWithId = SessionDoc & { _id: ObjectId };

export type ChallengePurpose = 'password_reset' | 'phone_verify' | 'email_verify' | 'login_otp';

export type ChallengeDoc = {
  purpose: ChallengePurpose;
  userId: ObjectId | null;
  /** Normalized phone/email the challenge was issued for. */
  identifier: string;
  tokenHash: string;
  expiresAt: Date;
  attempts: number;
  maxAttempts: number;
  consumedAt: Date | null;
  createdAt: Date;
  requestIp: string | null;
};

export type AuthContext = {
  user: UserWithId;
  session: SessionWithId;
};
