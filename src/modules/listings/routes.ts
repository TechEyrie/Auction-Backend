import { Router } from 'express';
import { z } from 'zod';
import { parseInput } from '../../shared/validate.ts';
import { requireActiveUser, requireAuth, requireCapability } from '../auth/middleware.ts';
import { parseFulfillmentBody } from '../orders/service.ts';
import { toAdminListingDto, toCustomerListingDto, toPublicListingDto } from './dto.ts';
import { AUDIENCES, CONDITIONS, LANGUAGE_MODES, LISTING_METHODS, type ListingMethod } from './models.ts';
import { PUBLIC_SORTS } from './repository.ts';
import { createListingService, type ListingDeps } from './service.ts';

export type ListingRouterDeps = ListingDeps;

export const MAX_PUBLIC_PAGE_SIZE = 48;
const MAX_ADMIN_PAGE_SIZE = 100;

/**
 * Public filters.
 *
 * Unknown or malformed values are refused with per-field errors rather than silently defaulted:
 * a shareable URL either means exactly what it says or tells the visitor why it does not. Every
 * identifier is validated (category keys, country/city slugs, enum members) and the page size is
 * bounded, so a crafted URL cannot turn into an unbounded query.
 */
const publicQuerySchema = z.object({
  q: z.string().max(120).optional(),
  category: z.string().min(2).max(60).optional(),
  method: z.enum(LISTING_METHODS).optional(),
  condition: z.enum(CONDITIONS).optional(),
  country: z.string().length(2).optional(),
  city: z.string().min(2).max(60).optional(),
  featured: z.enum(['true', 'false']).optional(),
  audience: z.enum(AUDIENCES).optional(),
  sort: z.enum(PUBLIC_SORTS).default('recent'),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PUBLIC_PAGE_SIZE).default(12),
});

const listingReferenceSchema = z.string().regex(/^l_[A-Za-z0-9_-]{6,32}$/, 'invalid listing reference');
const assetIdSchema = z.string().regex(/^m_[A-Za-z0-9_-]{6,32}$/, 'invalid media reference');

const titleSchema = z.object({ en: z.string().max(140).nullable().optional(), ar: z.string().max(140).nullable().optional() });
const descriptionSchema = z.object({ en: z.string().max(8000).nullable().optional(), ar: z.string().max(8000).nullable().optional() });
const mediaSchema = z
  .array(
    z.object({
      assetId: z.string().min(3).max(64),
      alt: z.object({ en: z.string().max(300).nullable().optional(), ar: z.string().max(300).nullable().optional() }).optional(),
    }),
  )
  .max(30);

/** Every writable listing field, plus the version the editor read. */
const writeSchema = z.object({
  sellerReference: z.string().min(3).max(80).optional(),
  categoryKey: z.string().min(2).max(60).optional(),
  listingMethod: z.enum(LISTING_METHODS).optional(),
  languageMode: z.enum(LANGUAGE_MODES).optional(),
  title: titleSchema.optional(),
  description: descriptionSchema.optional(),
  condition: z.enum(CONDITIONS).nullable().optional(),
  audience: z.enum(AUDIENCES).nullable().optional(),
  locationKey: z.string().min(2).max(120).nullable().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  media: mediaSchema.optional(),
  coverAssetId: z.string().max(64).nullable().optional(),
  featured: z.boolean().optional(),
  featuredOrder: z.coerce.number().int().min(0).max(9999).optional(),
  moderationState: z.enum(['ok', 'pending_review', 'blocked']).optional(),
  moderationNote: z.string().max(500).nullable().optional(),
  adminNotes: z.string().max(4000).nullable().optional(),
  priceMinor: z.number().int().positive().nullable().optional(),
  expectedVersion: z.coerce.number().int().min(1),
});

const buySchema = z.object({
  fullName: z.string().min(2).max(120),
  phone: z.string().min(6).max(40),
  city: z.string().min(2).max(80),
  address: z.string().min(6).max(300),
}).strict();

const versionSchema = z.object({ expectedVersion: z.coerce.number().int().min(1) });
const archiveSchema = z.object({ reason: z.string().min(3).max(300) });
const adminListSchema = z.object({
  status: z.enum(['draft', 'published', 'archived']).optional(),
  search: z.string().max(120).optional(),
  categoryKey: z.string().max(60).optional(),
  sellerReference: z.string().max(80).optional(),
  audience: z.enum(AUDIENCES).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_ADMIN_PAGE_SIZE).default(20),
});

/**
 * Public discovery and public media delivery.
 *
 * No route here writes anything, and none of them returns a raw document: the public DTO is
 * assembled by `dto.ts`, which strips admin-only attribute values and private staff fields, and
 * applies the location precision policy. Draft, archived and blocked listings are invisible —
 * including through `GET /:ref`, which answers 404 exactly like a missing record.
 */
export function publicListingRouter(deps: ListingRouterDeps): Router {
  const router = Router();
  const service = createListingService(deps);

  router.get('/', async (req, res, next) => {
    try {
      const query = parseInput(publicQuerySchema, req.query, 'Invalid search parameters');
      const page = await service.listPublic({
        ...(query.q ? { search: query.q } : {}),
        ...(query.category ? { categoryKeys: [query.category.toLowerCase()] } : {}),
        ...(query.method ? { method: query.method } : {}),
        ...(query.condition ? { condition: query.condition } : {}),
        ...(query.country ? { countryCode: query.country.toUpperCase() } : {}),
        ...(query.city ? { cityKey: query.city.toLowerCase() } : {}),
        ...(query.featured === 'true' ? { featuredOnly: true } : {}),
        ...(query.audience ? { audience: query.audience } : {}),
        sort: query.sort,
        page: query.page,
        limit: query.limit,
      });

      const listings = [];
      for (const item of page.items) {
        listings.push(toPublicListingDto(item, await service.publicDtoContext(item)));
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        listings,
        page: page.page,
        limit: page.limit,
        total: page.total,
        totalPages: page.totalPages,
        sort: query.sort,
        filters: {
          q: query.q ?? null,
          category: query.category ?? null,
          method: query.method ?? null,
          condition: query.condition ?? null,
          country: query.country ?? null,
          city: query.city ?? null,
          featured: query.featured === 'true',
          audience: query.audience ?? null,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:ref/buy', requireAuth(), requireActiveUser(), async (req, res, next) => {
    try {
      const ref = parseInput(listingReferenceSchema, String(req.params.ref), 'Invalid listing reference');
      const body = parseInput(buySchema, req.body ?? {});
      const fulfillment = parseFulfillmentBody(body);
      const order = await service.buyFixedPrice(ref, req.auth!.user.publicReference, fulfillment);
      res.status(201).json({ order });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:ref', async (req, res, next) => {
    try {
      const ref = parseInput(
        z.string().regex(/^(?:l_[A-Za-z0-9_-]{6,32}|[a-z0-9]+(?:-[a-z0-9]+){0,16})$/, 'invalid listing address'),
        String(req.params.ref),
        'Invalid listing address',
      );
      const listing = await service.getPublic(ref);
      const context = await service.publicDtoContext(listing);
      // A signed-in customer gets the customer projection; today it is deliberately identical to
      // the public one, so nothing private can arrive through a session.
      const dto = req.auth?.user ? toCustomerListingDto(listing, context) : toPublicListingDto(listing, context);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ listing: dto });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Public image bytes. Authorization is entirely the listing's: see
   * `ListingService.resolvePublicMedia` for the policy and why an asset ID proves nothing.
   */
  router.get('/:ref/media/:assetId/file', async (req, res, next) => {
    try {
      const ref = parseInput(listingReferenceSchema, String(req.params.ref), 'Invalid listing reference');
      const assetId = parseInput(assetIdSchema, String(req.params.assetId), 'Invalid media reference');
      const { mime } = await service.resolvePublicMedia(ref, assetId);
      const bytes = await service.readPublicMedia(assetId);
      res.setHeader('Content-Type', mime);
      // Non-executable serving, same as the staff preview: never inline a type a browser can script.
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      // Override securityHeaders' same-site CORP: listing images are loaded by <img> from the
      // separate frontend origin (e.g. Vercel → Render). same-site blocks that as NotSameSite.
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      // The URL is content-addressed per asset and authorization is re-checked on every request;
      // a short public lifetime keeps ordinary browsing cheap without letting a cached copy
      // outlive the visibility decision by much. Archiving stops new authorizations immediately.
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.status(200).end(bytes);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/**
 * Admin listing management. `inventory.manage` is required for every operation, including reads:
 * draft content, private notes and moderation state are staff material.
 */
export function adminListingRouter(deps: ListingRouterDeps): Router {
  const router = Router();
  const service = createListingService(deps);

  router.get('/', requireCapability('inventory.manage'), async (req, res, next) => {
    try {
      const query = parseInput(adminListSchema, req.query);
      const page = await service.listAdmin(query);
      const listings = [];
      for (const item of page.items) {
        listings.push(toAdminListingDto(item, await service.adminDtoContext(item)));
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({ listings, page: page.page, limit: page.limit, total: page.total, totalPages: page.totalPages });
    } catch (err) {
      next(err);
    }
  });

  router.post('/', requireCapability('inventory.manage'), async (req, res, next) => {
    try {
      const body = parseInput(writeSchema.omit({ expectedVersion: true }), req.body);
      const listing = await service.create(body, {
        reference: req.auth!.user.publicReference,
        requestId: req.requestId ?? 'n/a',
      });
      res.status(201).json({ listing: toAdminListingDto(listing, await service.adminDtoContext(listing)) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:ref', requireCapability('inventory.manage'), async (req, res, next) => {
    try {
      const ref = parseInput(listingReferenceSchema, String(req.params.ref), 'Invalid listing reference');
      const listing = await service.getAdmin(ref);
      const schema = await service.currentSchemaFor(listing.categoryKey);
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        listing: toAdminListingDto(listing, await service.adminDtoContext(listing)),
        // The wizard needs the current schema and whether the listing is still valid against it.
        schema: schema ? { version: schema.version, fields: schema.fields } : null,
        schemaChanged: schema ? schema.version !== listing.attributeSchemaVersion : listing.attributeSchemaVersion !== null,
      });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:ref', requireCapability('inventory.manage'), async (req, res, next) => {
    try {
      const ref = parseInput(listingReferenceSchema, String(req.params.ref), 'Invalid listing reference');
      const body = parseInput(writeSchema, req.body);
      const { expectedVersion, ...input } = body;
      const { listing, reconciliation } = await service.update(ref, input, expectedVersion, {
        reference: req.auth!.user.publicReference,
        requestId: req.requestId ?? 'n/a',
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        listing: toAdminListingDto(listing, await service.adminDtoContext(listing)),
        reconciliation,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:ref/publish', requireCapability('inventory.manage'), async (req, res, next) => {
    try {
      const ref = parseInput(listingReferenceSchema, String(req.params.ref), 'Invalid listing reference');
      const body = parseInput(versionSchema, req.body ?? {});
      const listing = await service.publish(ref, body.expectedVersion, {
        reference: req.auth!.user.publicReference,
        requestId: req.requestId ?? 'n/a',
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        listing: toAdminListingDto(listing, await service.adminDtoContext(listing)),
        publicUrl: `/product/${listing.slug || listing.listingReference}`,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:ref/archive', requireCapability('inventory.manage'), async (req, res, next) => {
    try {
      const ref = parseInput(listingReferenceSchema, String(req.params.ref), 'Invalid listing reference');
      const body = parseInput(archiveSchema, req.body);
      const listing = await service.archive(ref, body.reason, {
        reference: req.auth!.user.publicReference,
        requestId: req.requestId ?? 'n/a',
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ listing: toAdminListingDto(listing, await service.adminDtoContext(listing)) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** Exposed so the OpenAPI document and tests can share one list of accepted methods. */
export const ACCEPTED_LISTING_METHODS: readonly ListingMethod[] = LISTING_METHODS;
