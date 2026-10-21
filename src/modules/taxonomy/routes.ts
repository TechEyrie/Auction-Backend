import { Router, raw } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../../config/index.ts';
import { parseInput } from '../../shared/validate.ts';
import { AppError } from '../../shared/errors.ts';
import { requireCapability } from '../auth/middleware.ts';
import { ALLOWED_IMAGE_MIME } from '../media/imageInfo.ts';
import type { MediaService } from '../media/service.ts';
import { categoryMediaCollectionKey, LISTING_METHODS } from './models.ts';
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

export type TaxonomyRouterDeps = TaxonomyDeps & {
  media: MediaService;
  config: AppConfig;
};

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
export function publicTaxonomyRouter(deps: TaxonomyRouterDeps): Router {
  const router = Router();
  const service = createTaxonomyService(deps);
  const { media } = deps;

  router.get('/:key/image', async (req, res, next) => {
    try {
      const key = String(req.params.key);
      const category = await service.getByKey(key);
      if (!category || !category.active) throw new AppError('NOT_FOUND', 'Category image not found');
      const imageAssetId = category.imageAssetId ?? null;
      if (!imageAssetId) throw new AppError('NOT_FOUND', 'Category image not found');
      const asset = await media.findReadyAsset(imageAssetId);
      if (!asset || asset.collectionKey !== categoryMediaCollectionKey(key)) {
        throw new AppError('NOT_FOUND', 'Category image not found');
      }
      if (asset.publicUrl) {
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.redirect(302, asset.publicUrl);
        return;
      }
      const bytes = await media.readBytes(asset);
      res.setHeader('Content-Type', asset.mime ?? 'application/octet-stream');
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.status(200).end(bytes);
    } catch (err) {
      next(err);
    }
  });

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

export function adminTaxonomyRouter(deps: TaxonomyRouterDeps): Router {
  const router = Router();
  const service = createTaxonomyService(deps);
  const { media, config } = deps;

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

  router.post(
    '/:key/image',
    requireCapability('inventory.manage'),
    raw({
      type: ALLOWED_IMAGE_MIME.map((mime) => mime),
      limit: config.mediaMaxBytes,
    }),
    async (req, res, next) => {
      try {
        const key = String(req.params.key);
        const current = await service.getByKey(key);
        if (!current) throw new AppError('NOT_FOUND', 'Category not found');
        const collectionKey = categoryMediaCollectionKey(key);
        const priorId = current.imageAssetId ?? null;
        if (priorId) {
          await media.remove(priorId, 'Replaced category photo', {
            reference: req.auth!.user.publicReference,
            requestId: req.requestId ?? 'n/a',
          });
        }
        const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const asset = await media.upload({
          bytes,
          declaredMime: req.header('content-type') ?? '',
          collectionKey,
          actor: { reference: req.auth!.user.publicReference, requestId: req.requestId ?? 'n/a' },
        });
        const category = await service.setImageAsset(key, asset.assetId, {
          reference: req.auth!.user.publicReference,
          requestId: req.requestId ?? 'n/a',
        });
        res.status(201).json({ category: toAdminCategoryDto(category) });
      } catch (err) {
        next(err);
      }
    },
  );

  router.delete('/:key/image', requireCapability('inventory.manage'), async (req, res, next) => {
    try {
      const key = String(req.params.key);
      const body = parseInput(reasonSchema, req.body);
      const current = await service.getByKey(key);
      if (!current) throw new AppError('NOT_FOUND', 'Category not found');
      const priorId = current.imageAssetId ?? null;
      if (priorId) {
        await media.remove(priorId, body.reason, {
          reference: req.auth!.user.publicReference,
          requestId: req.requestId ?? 'n/a',
        });
      }
      const category = await service.clearImageAsset(key, {
        reference: req.auth!.user.publicReference,
        requestId: req.requestId ?? 'n/a',
      }, body.reason);
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
