import { Router, raw } from 'express';
import { z } from 'zod';
import { parseInput } from '../../shared/validate.ts';
import { AppError } from '../../shared/errors.ts';
import { requireCapability } from '../auth/middleware.ts';
import { ALLOWED_IMAGE_MIME } from './imageInfo.ts';
import { createMediaService, type MediaDeps } from './service.ts';

const collectionSchema = z.object({ collectionKey: z.string().min(3).max(80) });
const orderSchema = z.object({ assetIds: z.array(z.string().min(3).max(60)).min(1).max(50) });
const deleteSchema = z.object({ reason: z.string().min(3).max(300) });
const cleanupSchema = z.object({
  olderThanHours: z.coerce.number().int().min(1).max(24 * 30).default(24),
  apply: z.boolean().default(false),
});

export type MediaRouterDeps = MediaDeps;

/**
 * Media administration.
 *
 * Uploads are one image per request, sent as a raw body with the image content type
 * (`Content-Type: image/png` plus `x-collection-key`). That keeps the server free of a
 * multipart dependency and keeps the byte stream explicit. No client-supplied URL is ever
 * accepted: only bytes that pass signature validation become assets.
 */
export function adminMediaRouter(deps: MediaRouterDeps): Router {
  const router = Router();
  const service = createMediaService(deps);

  router.post(
    '/upload',
    requireCapability('inventory.manage'),
    raw({
      type: ALLOWED_IMAGE_MIME.map((mime) => mime),
      limit: deps.config.mediaMaxBytes,
    }),
    async (req, res, next) => {
      try {
        const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const collectionKey = typeof req.header('x-collection-key') === 'string' ? req.header('x-collection-key') : null;
        const asset = await service.upload({
          bytes,
          declaredMime: req.header('content-type') ?? '',
          collectionKey,
          actor: { reference: req.auth!.user.publicReference, requestId: req.requestId ?? 'n/a' },
        });
        res.status(201).json({ asset, url: `/api/admin/media/${asset.assetId}/file` });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get('/', requireCapability('admin.access'), async (req, res, next) => {
    try {
      const { collectionKey } = parseInput(collectionSchema, req.query);
      const assets = await service.listByCollection(collectionKey);
      res.json({
        assets: assets.map((asset) => ({
          ...asset,
          url: asset.status === 'ready' ? `/api/admin/media/${asset.assetId}/file` : null,
        })),
        limit: {
          maxFiles: deps.config.mediaMaxFilesPerCollection,
          maxBytes: deps.config.mediaMaxBytes,
          maxDimension: deps.config.mediaMaxDimension,
          allowedTypes: ALLOWED_IMAGE_MIME,
          videoEnabled: false,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Preview bytes. Staff-only for now: media is not public until it belongs to a published
   * listing (Phase 05), so no unauthenticated URL is treated as a verified asset.
   */
  router.get('/:assetId/file', requireCapability('admin.access'), async (req, res, next) => {
    try {
      const asset = await service.getByAssetId(String(req.params.assetId));
      if (asset.status !== 'ready') throw new AppError('NOT_FOUND', 'Media is not available yet');
      const bytes = await service.readBytes(asset);
      res.setHeader('Content-Type', asset.mime ?? 'application/octet-stream');
      // Non-executable serving: never inline a type a browser could script.
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      // Admin UI may be on a different origin than the API; allow <img> preview loads.
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Cache-Control', 'private, max-age=60');
      res.status(200).end(bytes);
    } catch (err) {
      next(err);
    }
  });

  router.patch('/collection/:collectionKey/order', requireCapability('inventory.manage'), async (req, res, next) => {
    try {
      const body = parseInput(orderSchema, req.body);
      const assets = await service.setOrder(String(req.params.collectionKey), body.assetIds, {
        reference: req.auth!.user.publicReference,
        requestId: req.requestId ?? 'n/a',
      });
      res.json({ assets });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/collection/:collectionKey/cover', requireCapability('inventory.manage'), async (req, res, next) => {
    try {
      const body = parseInput(z.object({ assetId: z.string().min(3).max(60) }), req.body);
      const assets = await service.setCover(String(req.params.collectionKey), body.assetId, {
        reference: req.auth!.user.publicReference,
        requestId: req.requestId ?? 'n/a',
      });
      res.json({ assets });
    } catch (err) {
      next(err);
    }
  });

  router.post('/cleanup', requireCapability('inventory.manage'), async (req, res, next) => {
    try {
      const body = parseInput(cleanupSchema, req.body);
      const result = await service.cleanupOrphans({ ...body, actor: { reference: req.auth!.user.publicReference, requestId: req.requestId ?? 'n/a' } });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post('/:assetId/retry', requireCapability('inventory.manage'), async (req, res, next) => {
    try {
      const asset = await service.retry(String(req.params.assetId), {
        reference: req.auth!.user.publicReference,
        requestId: req.requestId ?? 'n/a',
      });
      res.json({ asset });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:assetId', requireCapability('inventory.manage'), async (req, res, next) => {
    try {
      const body = parseInput(deleteSchema, req.body);
      await service.remove(String(req.params.assetId), body.reason, {
        reference: req.auth!.user.publicReference,
        requestId: req.requestId ?? 'n/a',
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
