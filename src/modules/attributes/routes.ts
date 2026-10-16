import { Router } from 'express';
import { z } from 'zod';
import { parseInput } from '../../shared/validate.ts';
import { requireCapability } from '../auth/middleware.ts';
import { ATTRIBUTE_TYPES } from './models.ts';
import { publicSchemaFields } from './validate.ts';
import { createAttributeService, type AttributeDeps } from './service.ts';

const fieldSchema = z.object({
  key: z.string().min(2).max(40),
  type: z.enum(ATTRIBUTE_TYPES),
  labelEn: z.string().min(2).max(120),
  labelAr: z.string().max(120).optional().nullable(),
  helpEn: z.string().max(300).optional().nullable(),
  unit: z.string().max(24).optional().nullable(),
  required: z.boolean().default(false),
  filterable: z.boolean().default(false),
  publicDisplay: z.boolean().default(true),
  adminOnly: z.boolean().default(false),
  order: z.coerce.number().int().min(0).max(999).default(0),
  options: z
    .array(z.object({ key: z.string().min(1).max(40), labelEn: z.string().min(1).max(120), labelAr: z.string().max(120).optional().nullable() }))
    .max(200)
    .default([]),
  constraints: z
    .object({
      min: z.coerce.number().optional().nullable(),
      max: z.coerce.number().optional().nullable(),
      integer: z.boolean().optional().nullable(),
      minLength: z.coerce.number().int().min(0).optional().nullable(),
      maxLength: z.coerce.number().int().min(1).optional().nullable(),
      pattern: z.string().max(200).optional().nullable(),
      unit: z.string().max(24).optional().nullable(),
    })
    .default({}),
  dependsOn: z
    .object({
      field: z.string().min(1).max(40),
      equals: z.union([z.string(), z.number(), z.boolean()]).optional().nullable(),
      in: z.array(z.union([z.string(), z.number()])).max(50).optional().nullable(),
    })
    .nullable()
    .default(null),
});

const draftSchema = z.object({
  categoryKey: z.string().min(2).max(60),
  fields: z.array(fieldSchema).min(1).max(60),
  notes: z.string().max(1000).optional().nullable(),
});

const patchSchema = z.object({
  fields: z.array(fieldSchema).min(1).max(60).optional(),
  notes: z.string().max(1000).optional().nullable(),
});

const validateValuesSchema = z.object({
  values: z.record(z.string(), z.unknown()),
  audience: z.enum(['public', 'admin']).default('admin'),
  version: z.coerce.number().int().min(1).optional(),
});

/** Public schema: admin-only fields are stripped, so a public form can never see them. */
export function publicAttributeRouter(deps: AttributeDeps): Router {
  const router = Router();
  const service = createAttributeService(deps);
  router.get('/:categoryKey/current', async (req, res, next) => {
    try {
      const schema = await service.currentForCategory(String(req.params.categoryKey));
      res.setHeader('Cache-Control', 'no-store');
      if (!schema) {
        res.json({ schema: null, categoryKey: String(req.params.categoryKey) });
        return;
      }
      res.json({
        schema: {
          categoryKey: schema.categoryKey,
          version: schema.version,
          status: schema.status,
          fields: publicSchemaFields(schema.fields)
            .filter((field) => field.publicDisplay)
            .sort((a, b) => a.order - b.order),
        },
      });
    } catch (err) {
      next(err);
    }
  });
  return router;
}

export function adminAttributeRouter(deps: AttributeDeps): Router {
  const router = Router();
  const service = createAttributeService(deps);

  router.get('/', requireCapability('inventory.manage'), async (req, res, next) => {
    try {
      const categoryKey = String(req.query.categoryKey ?? '');
      if (!categoryKey) {
        res.status(422).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'categoryKey is required',
            fieldErrors: { categoryKey: 'required' },
            requestId: req.requestId ?? '',
            details: {},
          },
        });
        return;
      }
      res.json({ schemas: await service.listForCategory(categoryKey) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/', requireCapability('inventory.manage'), async (req, res, next) => {
    try {
      const body = parseInput(draftSchema, req.body);
      const schema = await service.createDraft(body, {
        reference: req.auth!.user.publicReference,
        requestId: req.requestId ?? 'n/a',
      });
      res.status(201).json({ schema });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', requireCapability('inventory.manage'), async (req, res, next) => {
    try {
      // Historical versions stay readable: a record created under version 1 must remain
      // interpretable after version 2 is published.
      res.json({ schema: await service.getById(String(req.params.id)) });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:id', requireCapability('inventory.manage'), async (req, res, next) => {
    try {
      const body = parseInput(patchSchema, req.body);
      const schema = await service.updateDraft(String(req.params.id), body, {
        reference: req.auth!.user.publicReference,
        requestId: req.requestId ?? 'n/a',
      });
      res.json({ schema });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/publish', requireCapability('inventory.manage'), async (req, res, next) => {
    try {
      const schema = await service.publish(String(req.params.id), {
        reference: req.auth!.user.publicReference,
        requestId: req.requestId ?? 'n/a',
      });
      res.json({ schema });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:categoryKey/validate', requireCapability('inventory.manage'), async (req, res, next) => {
    try {
      const body = parseInput(validateValuesSchema, req.body);
      const result = await service.validateValues(String(req.params.categoryKey), body.values, body.audience, body.version);
      res.status(result.ok ? 200 : 422).json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
