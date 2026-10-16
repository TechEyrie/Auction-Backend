import { Router } from 'express';
import { requireCapability } from '../auth/middleware.ts';
import { capabilitiesFor } from '../auth/roles.ts';
import { toAdminUserDto } from '../auth/dto.ts';
import { createAdminService, type AdminDeps } from './service.ts';

export function adminRouter(deps: AdminDeps): Router {
  const router = Router();
  const service = createAdminService(deps);

  router.get('/users', requireCapability('users.view'), async (req, res, next) => {
    try {
      const limit = Math.min(Number(req.query.limit ?? 100) || 100, 200);
      res.json({ users: await service.listUsers(limit) });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/users/:ref/status', requireCapability('users.manage'), async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { status?: unknown; reason?: unknown };
      const user = await service.setStatus(
        req.auth!.user,
        String(req.params.ref),
        body.status,
        body.reason,
        req.requestId ?? 'n/a',
      );
      res.json({ user });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/users/:ref/roles', requireCapability('roles.manage'), async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { roles?: unknown };
      const user = await service.setRoles(
        req.auth!.user,
        String(req.params.ref),
        body.roles,
        req.requestId ?? 'n/a',
      );
      res.json({ user });
    } catch (err) {
      next(err);
    }
  });

  router.get('/me', requireCapability('admin.access'), (req, res) => {
    res.json({
      user: toAdminUserDto(req.auth!.user),
      capabilities: [...capabilitiesFor(req.auth!.user.roles)],
    });
  });

  return router;
}
