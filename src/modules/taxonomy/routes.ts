import { Router } from 'express';
import { z } from 'zod';
import { parseInput } from '../../shared/validate.ts';
import { requireCapability } from '../auth/middleware.ts';
import { LISTING_METHODS } from './models.ts';
import { toAdminCategoryDto, toPublicCategoryDto } from './dto.ts';
import { CATEGORY_ICON_KEYS, CATEGORY_ICONS } from './icons.ts';
import { createTaxonomyService, type TaxonomyDeps } from './service.ts';

const categoryIconSchema = z.enum(CATEGORY_ICON_KEYS);

const writeSchema = z.object({
  key: z.string().min(2).max(60),
  parentKey: z.string().max(60).nullable().default(null),
  nameEn: z.string().min(2).max(120),
  nameAr: z.string().max(120).optional().nullable(),
  descriptionEn: z.string().max(500).optional().nullable(),
  descriptionAr: z.string().max(500).optional().nullable(),
  icon: categoryIconSchema.optional().default('tag'),
  order: z.coerce.number().int().min(0).max(9999).optional(),
  active: z.boolean().optional(),
  listingMethods: z.array(z.enum(LISTING_METHODS)).min(1),
});

const patchSchema = writeSchema.partial().extend({
  icon: categoryIconSchema.optional(),
  /** Optimistic concurrency: the version the editor loaded. */
  expectedHierarchyVersion: z.coerce.number().int().min(1).optional(),
});

const reasonSchema = z.object({ reason: z.string().min(3).max(300) });

/** Public icon catalogue for admin pickers and documentation. */
export function publicCategoryIconsRouter(): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json({ icons: CATEGORY_ICONS });
  });
  return router;
}

/** Public taxonomy: active categories only. The same records the admin edits. */
export function publicTaxonomyRouter(deps: TaxonomyDeps): Router {
  const router = Router();
  const service = createTaxonomyService(deps);
  router.get('/', async (req, res, next) => {
    try {
      const locale = req.query.locale === 'ar' ? 'ar' : 'en';
      const categories = await service.list(false);
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        categories: categories.map((category) => toPublicCategoryDto(category, locale)),
        locale,
      });
    } catch (err) {
      next(err);
    }
  });
  return router;
}

export function adminTaxonomyRouter(deps: TaxonomyDeps): Router {
  const router = Router();
  const service = createTaxonomyService(deps);

  router.get('/', requireCapability('inventory.manage'), async (req, res, next) => {
    try {
      const includeInactive = req.query.includeInactive === 'true';
      const categories = await service.list(includeInactive);
      res.json({ categories: categories.map(toAdminCategoryDto) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/', requireCapability('inventory.manage'), async (req, res, next) => {
    try {
      const body = parseInput(writeSchema, req.body);
      const category = await service.create(body, {
        reference: req.auth!.user.publicReference,
        requestId: req.requestId ?? 'n/a',
      });
      res.status(201).json({ category: toAdminCategoryDto(category) });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:key', requireCapability('inventory.manage'), async (req, res, next) => {
    try {
      const body = parseInput(patchSchema, req.body);
      const { expectedHierarchyVersion, ...input } = body;
      const category = await service.update(
        String(req.params.key),
        input,
        expectedHierarchyVersion ?? null,
        { reference: req.auth!.user.publicReference, requestId: req.requestId ?? 'n/a' },
      );
      res.json({ category: toAdminCategoryDto(category) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:key/archive', requireCapability('inventory.manage'), async (req, res, next) => {
    try {
      const body = parseInput(reasonSchema, req.body);
      const category = await service.archive(String(req.params.key), body.reason, {
        reference: req.auth!.user.publicReference,
        requestId: req.requestId ?? 'n/a',
      });
      res.json({ category: toAdminCategoryDto(category) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:key/restore', requireCapability('inventory.manage'), async (req, res, next) => {
    try {
      const body = parseInput(reasonSchema, req.body);
      const category = await service.restore(String(req.params.key), body.reason, {
        reference: req.auth!.user.publicReference,
        requestId: req.requestId ?? 'n/a',
      });
      res.json({ category: toAdminCategoryDto(category) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
