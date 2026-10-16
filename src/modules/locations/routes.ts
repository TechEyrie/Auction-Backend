import { Router } from 'express';
import { z } from 'zod';
import { parseInput } from '../../shared/validate.ts';
import { requireCapability } from '../auth/middleware.ts';
import { createLocationService, toPublicLocationDto, PUBLIC_PRECISIONS, type LocationDeps } from './service.ts';

const coordinatesSchema = z.object({ lat: z.coerce.number(), lng: z.coerce.number() });

const createSchema = z.object({
  countryCode: z.string().length(2),
  cityKey: z.string().min(2).max(60),
  areaKey: z.string().min(2).max(60),
  labelEn: z.string().min(2).max(120),
  labelAr: z.string().max(120).optional().nullable(),
  coordinates: coordinatesSchema.optional().nullable(),
  publicPrecision: z.enum(PUBLIC_PRECISIONS).optional(),
  order: z.coerce.number().int().min(0).max(9999).optional(),
});

const patchSchema = z.object({
  labelEn: z.string().min(2).max(120).optional(),
  labelAr: z.string().max(120).optional().nullable(),
  coordinates: coordinatesSchema.optional().nullable(),
  publicPrecision: z.enum(PUBLIC_PRECISIONS).optional(),
  active: z.boolean().optional(),
  order: z.coerce.number().int().min(0).max(9999).optional(),
});

/** Public geography for forms and listings. Precision policy is applied server-side. */
export function publicLocationRouter(deps: LocationDeps): Router {
  const router = Router();
  const service = createLocationService(deps);
  router.get('/', async (req, res, next) => {
    try {
      const locations = await service.list({
        includeInactive: false,
        ...(typeof req.query.country === 'string' ? { countryCode: req.query.country } : {}),
        ...(typeof req.query.city === 'string' ? { cityKey: req.query.city } : {}),
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ locations: locations.map(toPublicLocationDto) });
    } catch (err) {
      next(err);
    }
  });
  return router;
}

export function adminLocationRouter(deps: LocationDeps): Router {
  const router = Router();
  const service = createLocationService(deps);

  router.get('/', requireCapability('inventory.manage'), async (_req, res, next) => {
    try {
      res.json({ locations: await service.list({ includeInactive: true }) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/', requireCapability('inventory.manage'), async (req, res, next) => {
    try {
      const body = parseInput(createSchema, req.body);
      const location = await service.create(body, {
        reference: req.auth!.user.publicReference,
        requestId: req.requestId ?? 'n/a',
      });
      res.status(201).json({ location });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:key', requireCapability('inventory.manage'), async (req, res, next) => {
    try {
      const body = parseInput(patchSchema, req.body);
      const location = await service.update(String(req.params.key), body, {
        reference: req.auth!.user.publicReference,
        requestId: req.requestId ?? 'n/a',
      });
      res.json({ location });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
