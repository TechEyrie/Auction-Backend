import { Router } from 'express';
import type { Db } from 'mongodb';
import { AppError } from '../../shared/errors.ts';
import { toAdminUserDto, toUserDto } from '../auth/dto.ts';
import { requireAuth, requireOwnership } from '../auth/middleware.ts';
import { capabilitiesFor } from '../auth/roles.ts';
import * as repo from '../auth/repository.ts';

/**
 * `GET /api/users/:ref` — the caller may read their own record, or any record if
 * they hold `users.manage`. Ownership is enforced separately from capability.
 */
export function usersRouter(deps: { db: Db }): Router {
  const router = Router();

  router.get(
    '/:ref',
    requireAuth(),
    requireOwnership((req) => (typeof req.params.ref === 'string' ? req.params.ref : null)),
    async (req, res, next) => {
      try {
        const user = await repo.findUserByPublicReference(deps.db, String(req.params.ref));
        if (!user) throw new AppError('NOT_FOUND', 'User not found');
        const canManage = capabilitiesFor(req.auth!.user.roles).has('users.manage');
        res.json({ user: canManage ? toAdminUserDto(user) : toUserDto(user) });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
