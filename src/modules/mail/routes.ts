import { Router } from 'express';
import type { Db } from 'mongodb';
import { z } from 'zod';
import { parseInput } from '../../shared/validate.ts';
import { requireActiveUser, requireAuth, requireCapability, requireMfa } from '../auth/middleware.ts';
import { toEmailLogDto } from './dto.ts';
import { listEmailLogs } from './emailLogRepository.ts';

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  q: z.string().max(200).optional(),
}).strict();

export function adminEmailLogRouter(deps: { db: Db }): Router {
  const router = Router();

  router.get(
    '/email-logs',
    requireAuth(),
    requireActiveUser(),
    requireMfa(),
    requireCapability('audit.view'),
    async (req, res, next) => {
      try {
        const query = parseInput(listQuerySchema, req.query);
        const limit = query.limit ?? 50;
        const rows = await listEmailLogs(deps.db, { limit, q: query.q });
        res.json({ emailLogs: rows.map(toEmailLogDto) });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
