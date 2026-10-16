import { ObjectId, type ClientSession, type Collection, type Db } from 'mongodb';
import { COLLECTIONS } from '../../db/indexes.ts';
import { sessionRevoked } from '../../shared/sessionHooks.ts';
import type { ChallengeDoc, ChallengePurpose, SessionDoc, UserDoc, UserStatus } from './models.ts';
import type { Role } from './roles.ts';

function users(db: Db): Collection<UserDoc> {
  return db.collection<UserDoc>(COLLECTIONS.users);
}
function sessions(db: Db): Collection<SessionDoc> {
  return db.collection<SessionDoc>(COLLECTIONS.sessions);
}
function challenges(db: Db): Collection<ChallengeDoc> {
  return db.collection<ChallengeDoc>(COLLECTIONS.verificationChallenges);
}

export async function insertUser(db: Db, doc: UserDoc): Promise<ObjectId> {
  const result = await users(db).insertOne(doc);
  return result.insertedId;
}

export function findUserByPhone(db: Db, phoneE164: string) {
  return users(db).findOne({ phoneE164 });
}

export function findUserByEmail(db: Db, emailNormalized: string) {
  return users(db).findOne({ emailNormalized });
}

export async function findUserByIdentifier(db: Db, identifier: string) {
  return (await findUserByPhone(db, identifier)) ?? (await findUserByEmail(db, identifier));
}

export function findUserById(db: Db, id: ObjectId) {
  return users(db).findOne({ _id: id });
}

export function findUserByPublicReference(db: Db, publicReference: string) {
  return users(db).findOne({ publicReference });
}

export function listUsers(db: Db, limit: number) {
  return users(db).find({}).sort({ createdAt: -1 }).limit(limit).toArray();
}

export async function updateUserStatus(
  db: Db,
  id: ObjectId,
  status: UserStatus,
  suspension: UserDoc['suspension'],
): Promise<void> {
  await users(db).updateOne({ _id: id }, { $set: { status, suspension, updatedAt: new Date() } });
}

export async function updateUserPasswordHash(db: Db, id: ObjectId, passwordHash: string): Promise<void> {
  await users(db).updateOne({ _id: id }, { $set: { passwordHash, updatedAt: new Date() } });
}

export async function updateUserRoles(db: Db, id: ObjectId, roles: Role[]): Promise<void> {
  await users(db).updateOne({ _id: id }, { $set: { roles, updatedAt: new Date() } });
}

export async function countUsers(db: Db): Promise<number> {
  return users(db).countDocuments({});
}

export async function markLastLogin(db: Db, id: ObjectId): Promise<void> {
  await users(db).updateOne({ _id: id }, { $set: { lastLoginAt: new Date(), updatedAt: new Date() } });
}

export async function createSession(db: Db, doc: SessionDoc): Promise<ObjectId> {
  const result = await sessions(db).insertOne(doc);
  return result.insertedId;
}

export function findSessionByTokenHash(db: Db, tokenHash: string) {
  return sessions(db).findOne({ tokenHash });
}

export async function touchSession(db: Db, sessionId: ObjectId, idleExpiresAt: Date): Promise<void> {
  await sessions(db).updateOne(
    { _id: sessionId },
    { $set: { lastUsedAt: new Date(), idleExpiresAt } },
  );
}

export async function revokeSession(db: Db, sessionId: ObjectId, reason: string): Promise<void> {
  const result = await sessions(db).updateOne(
    { _id: sessionId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
  if (result.modifiedCount > 0) sessionRevoked(String(sessionId));
}

export async function revokeAllUserSessions(
  db: Db,
  userId: ObjectId,
  reason: string,
  exceptSessionId?: ObjectId,
): Promise<number> {
  const filter: Record<string, unknown> = { userId, revokedAt: null };
  if (exceptSessionId) filter._id = { $ne: exceptSessionId };
  const open = await sessions(db).find(filter).project<{ _id: ObjectId }>({ _id: 1 }).toArray();
  const result = await sessions(db).updateMany(filter, {
    $set: { revokedAt: new Date(), revokedReason: reason },
  });
  for (const session of open) sessionRevoked(String(session._id));
  return result.modifiedCount;
}

export async function rotateSession(
  db: Db,
  sessionId: ObjectId,
  tokenHash: string,
  csrfHash: string,
): Promise<void> {
  await sessions(db).updateOne(
    { _id: sessionId },
    { $set: { tokenHash, csrfHash, createdAt: new Date(), lastUsedAt: new Date() } },
  );
}

export async function setSessionMfaSatisfied(db: Db, sessionId: ObjectId, lastMfaStep: number): Promise<void> {
  await sessions(db).updateOne(
    { _id: sessionId },
    { $set: { mfaSatisfied: true, lastMfaStep } },
  );
}

export async function insertChallenge(db: Db, doc: ChallengeDoc): Promise<ObjectId> {
  const result = await challenges(db).insertOne(doc);
  return result.insertedId;
}

export function findChallengeByTokenHash(db: Db, tokenHash: string) {
  return challenges(db).findOne({ tokenHash });
}

export async function incrementChallengeAttempts(db: Db, id: ObjectId): Promise<void> {
  await challenges(db).updateOne({ _id: id }, { $inc: { attempts: 1 } });
}

/** Atomically consume a challenge; returns false if it was already used (single use). */
export async function consumeChallenge(db: Db, id: ObjectId): Promise<boolean> {
  const result = await challenges(db).updateOne(
    { _id: id, consumedAt: null },
    { $set: { consumedAt: new Date() } },
  );
  return result.modifiedCount === 1;
}

export async function invalidateUserChallenges(
  db: Db,
  userId: ObjectId,
  purpose: ChallengePurpose,
): Promise<void> {
  await challenges(db).updateMany(
    { userId, purpose, consumedAt: null },
    { $set: { consumedAt: new Date() } },
  );
}

export async function updateUserMfa(
  db: Db,
  id: ObjectId,
  mfa: UserDoc['mfa'],
  session?: ClientSession,
): Promise<void> {
  await users(db).updateOne({ _id: id }, { $set: { mfa, updatedAt: new Date() } }, session ? { session } : {});
}
