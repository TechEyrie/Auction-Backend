import type { ClientSession, Db } from 'mongodb';
import type { AppConfig } from '../../config/index.ts';
import { AppError } from '../../shared/errors.ts';
import type { Logger } from '../../shared/logger.ts';
import { parseInput } from '../../shared/validate.ts';
import { z } from 'zod';
import { recordAudit } from '../audit/repository.ts';
import { toAdminUserDto, type AdminUserDto } from '../auth/dto.ts';
import type { UserWithId, UserStatus } from '../auth/models.ts';
import * as repo from '../auth/repository.ts';
import { isRole, ROLES, type Role } from '../auth/roles.ts';
import {
  getSuperAdminCounter,
  releaseSuperAdminSlot,
  reserveSuperAdminRemoval,
  syncSuperAdminCounter,
} from './superAdminGuard.ts';

export type AdminDeps = {
  db: Db;
  config: AppConfig;
  logger: Logger;
  withTransaction: <T>(fn: (session: ClientSession) => Promise<T>) => Promise<T>;
};

const rolesSchema = z.object({
  roles: z.array(z.string()).min(1).max(ROLES.length),
});

const statusSchema = z.object({
  status: z.enum(['active', 'suspended', 'disabled']),
  reason: z.string().min(3).max(300),
});

function isActiveSuperAdmin(user: UserWithId): boolean {
  return user.status === 'active' && user.roles.includes('super_admin');
}

export function createAdminService(deps: AdminDeps) {
  const { db } = deps;

  async function listUsers(limit = 100): Promise<AdminUserDto[]> {
    const users = await repo.listUsers(db, limit);
    return users.map(toAdminUserDto);
  }

  /** Assign roles. Only holders of `roles.manage` reach here (enforced by middleware). */
  async function setRoles(
    actor: UserWithId,
    targetRef: string,
    rawRoles: unknown,
    requestId: string,
  ): Promise<AdminUserDto> {
    const { roles } = parseInput(rolesSchema, { roles: rawRoles });
    if (!roles.every(isRole)) {
      throw new AppError('VALIDATION_ERROR', 'Unknown role', { fieldErrors: { roles: 'contains an unknown role' } });
    }
    const unique = [...new Set(roles)] as Role[];
    const target = await repo.findUserByPublicReference(db, targetRef);
    if (!target) throw new AppError('NOT_FOUND', 'User not found');

    await getSuperAdminCounter(db); // ensure the counter exists before adjusting it
    const keepsSuperAdmin = unique.includes('super_admin');
    const removingActiveSuper =
      isActiveSuperAdmin(target) && (!keepsSuperAdmin || target.status !== 'active');
    const addingActiveSuper = !isActiveSuperAdmin(target) && keepsSuperAdmin && target.status === 'active';

    if (removingActiveSuper) {
      // Serialize against other removals; the conditional decrement is the lock.
      await deps.withTransaction(async (session) => {
        await reserveSuperAdminRemoval(db, session);
        await repo.updateUserRoles(db, target._id, unique);
      });
    } else {
      await repo.updateUserRoles(db, target._id, unique);
      if (addingActiveSuper) await releaseSuperAdminSlot(db);
    }

    await recordAudit(db, {
      actorId: actor.publicReference,
      action: 'admin.user.roles_changed',
      targetType: 'user',
      targetId: target.publicReference,
      requestId,
      changeSummary: { from: target.roles, to: unique },
      reason: null,
    });
    const updated = await repo.findUserById(db, target._id);
    return toAdminUserDto(updated ?? target);
  }

  async function setStatus(
    actor: UserWithId,
    targetRef: string,
    rawStatus: unknown,
    rawReason: unknown,
    requestId: string,
  ): Promise<AdminUserDto> {
    const { status, reason } = parseInput(statusSchema, { status: rawStatus, reason: rawReason });
    const target = await repo.findUserByPublicReference(db, targetRef);
    if (!target) throw new AppError('NOT_FOUND', 'User not found');

    await getSuperAdminCounter(db); // ensure the counter exists before adjusting it
    const deactivating = isActiveSuperAdmin(target) && status !== 'active';
    const reactivating =
      target.roles.includes('super_admin') && target.status !== 'active' && status === 'active';
    const suspension: UserWithId['suspension'] =
      status === 'active' ? null : { reason, actorId: actor.publicReference, at: new Date() };

    if (deactivating) {
      await deps.withTransaction(async (session) => {
        await reserveSuperAdminRemoval(db, session);
        await repo.updateUserStatus(db, target._id, status as UserStatus, suspension);
        // Deactivating also revokes the target's sessions.
        await repo.revokeAllUserSessions(db, target._id, `status_${status}`);
      });
    } else {
      await repo.updateUserStatus(db, target._id, status as UserStatus, suspension);
      if (status !== 'active') await repo.revokeAllUserSessions(db, target._id, `status_${status}`);
      if (reactivating) await releaseSuperAdminSlot(db);
    }

    await recordAudit(db, {
      actorId: actor.publicReference,
      action: 'admin.user.status_changed',
      targetType: 'user',
      targetId: target.publicReference,
      requestId,
      changeSummary: { from: target.status, to: status },
      reason,
    });
    const updated = await repo.findUserById(db, target._id);
    return toAdminUserDto(updated ?? target);
  }

  return { listUsers, setRoles, setStatus, getSuperAdminCounter: () => getSuperAdminCounter(db), syncSuperAdminCounter: () => syncSuperAdminCounter(db) };
}

export type AdminService = ReturnType<typeof createAdminService>;
