import { Router } from 'express';
import type { Db } from 'mongodb';
import { z } from 'zod';
import type { Logger } from '../../shared/logger.ts';
import { AppError } from '../../shared/errors.ts';
import { parseInput } from '../../shared/validate.ts';
import { requireCapability } from '../auth/middleware.ts';
import { capabilitiesFor } from '../auth/roles.ts';
import { createSellerService, type SellerInput } from './service.ts';

export type SellerRouterDeps = { db: Db; logger: Logger };

const MAX_LIMIT = 100;

const contactSchema = z.object({
  contactName: z.string().max(120).optional().nullable(),
  phone: z.string().min(4),
  email: z.string().max(254).optional().nullable(),
});

const addressSchema = z.object({
  line1: z.string().max(200).optional().nullable(),
  line2: z.string().max(200).optional().nullable(),
  locationKey: z.string().max(120).optional().nullable(),
  postalCode: z.string().max(24).optional().nullable(),
  publicPrecision: z.enum(['hidden', 'city', 'exact']).optional(),
});

const settlementSchema = z.object({
  method: z.enum(['bank_transfer', 'cheque', 'cash', 'not_set']).optional(),
  accountName: z.string().max(160).optional().nullable(),
  bankName: z.string().max(160).optional().nullable(),
  iban: z.string().max(40).optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
});

const createSchema = z.object({
  type: z.enum(['individual', 'company']),
  displayName: z.string().min(2).max(160),
  legalName: z.string().max(160).optional().nullable(),
  contact: contactSchema,
  address: addressSchema.optional(),
  internalNotes: z.string().max(4000).optional().nullable(),
  linkedUserReference: z.string().max(80).optional().nullable(),
  settlement: settlementSchema.optional(),
  reason: z.string().max(300).optional(),
});

const updateSchema = createSchema.partial().omit({ reason: true });

const verificationSchema = z.object({
  state: z.enum(['unverified', 'pending', 'verified', 'rejected']),
  reason: z.string().min(3).max(300),
  evidence: z
    .array(z.object({ kind: z.string().min(2).max(60), reference: z.string().min(2).max(200), note: z.string().max(500).optional().nullable() }))
    .max(20)
    .optional(),
});

const statusSchema = z.object({
  status: z.enum(['active', 'inactive', 'archived']),
  reason: z.string().min(3).max(300),
});

const listSchema = z.object({
  status: z.enum(['active', 'inactive', 'archived']).optional(),
  type: z.enum(['individual', 'company']).optional(),
  verification: z.enum(['unverified', 'pending', 'verified', 'rejected']).optional(),
  search: z.string().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(20),
});

/** Public route: marketplace-facing seller identity only (no contact, address or notes). */
export function publicSellerRouter(deps: SellerRouterDeps): Router {
  const router = Router();
  const service = createSellerService(deps);
  router.get('/:ref', async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ seller: await service.getPublic(String(req.params.ref)) });
    } catch (err) {
      next(err);
    }
  });
  return router;
}

export function adminSellerRouter(deps: SellerRouterDeps): Router {
  const router = Router();
  const service = createSellerService(deps);

  router.get('/', requireCapability('inventory.manage'), async (req, res, next) => {
    try {
      const query = parseInput(listSchema, req.query);
      const page = await service.list({ ...query, ...(query.search ? { search: query.search } : {}) });
      const capabilities = capabilitiesFor(req.auth!.user.roles);
      res.json({
        sellers: page.items.map((seller) => service.toAdminDto(seller, capabilities)),
        page: page.page,
        limit: page.limit,
        total: page.total,
        totalPages: page.totalPages,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/', requireCapability('inventory.manage'), async (req, res, next) => {
    try {
      const body = parseInput(createSchema, req.body);
      const seller = await service.create(body as SellerInput, {
        reference: req.auth!.user.publicReference,
        requestId: req.requestId ?? 'n/a',
      });
      res.status(201).json({ seller: service.toAdminDto(seller, capabilitiesFor(req.auth!.user.roles)) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:ref', requireCapability('inventory.manage'), async (req, res, next) => {
    try {
      const seller = await service.get(String(req.params.ref));
      res.json({ seller: service.toAdminDto(seller, capabilitiesFor(req.auth!.user.roles)) });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:ref', requireCapability('inventory.manage'), async (req, res, next) => {
    try {
      const body = parseInput(updateSchema, req.body) as Partial<SellerInput>;
      // Settlement instructions belong to the settlement capability even when the actor
      // may otherwise edit the seller.
      if (body.settlement) {
        const capabilities = capabilitiesFor(req.auth!.user.roles);
        if (!capabilities.has('settlements.manage') && !capabilities.has('finance.manage')) {
          throw new AppError('FORBIDDEN', 'You do not have permission to change settlement instructions');
        }
      }
      const seller = await service.update(String(req.params.ref), body, {
        reference: req.auth!.user.publicReference,
        requestId: req.requestId ?? 'n/a',
      });
      res.json({ seller: service.toAdminDto(seller, capabilitiesFor(req.auth!.user.roles)) });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:ref/verification', requireCapability('inventory.manage'), async (req, res, next) => {
    try {
      const body = parseInput(verificationSchema, req.body);
      const seller = await service.setVerification(
        String(req.params.ref),
        { ...body, ...(body.evidence ? { evidence: body.evidence } : {}) },
        { reference: req.auth!.user.publicReference, requestId: req.requestId ?? 'n/a' },
      );
      res.json({ seller: service.toAdminDto(seller, capabilitiesFor(req.auth!.user.roles)) });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:ref/status', requireCapability('inventory.manage'), async (req, res, next) => {
    try {
      const body = parseInput(statusSchema, req.body);
      const seller = await service.setStatus(String(req.params.ref), body.status, body.reason, {
        reference: req.auth!.user.publicReference,
        requestId: req.requestId ?? 'n/a',
      });
      res.json({ seller: service.toAdminDto(seller, capabilitiesFor(req.auth!.user.roles)) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
