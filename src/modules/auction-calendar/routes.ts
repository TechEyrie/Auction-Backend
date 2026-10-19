import { Router, type NextFunction, type Request, type Response } from 'express';
import type { Db } from 'mongodb';
import { z } from 'zod';
import { parseInput } from '../../shared/validate.ts';
import { qatarNowYearMonth } from '../../shared/qatarCalendar.ts';
import { getAuctionCalendar } from './service.ts';

const querySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  locale: z.enum(['en', 'ar']).default('en'),
});

export function auctionCalendarRouter(deps: { db: Db }): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = parseInput(querySchema, req.query, 'Invalid calendar parameters');
      const now = qatarNowYearMonth();
      const year = query.year ?? now.year;
      const month = query.month ?? now.month;
      const payload = await getAuctionCalendar(deps.db, year, month, query.locale);
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.json(payload);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
