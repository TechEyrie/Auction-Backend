import type { Db, Collection } from 'mongodb';
import type { Logger } from '../../shared/logger.ts';
import { AppError, conflict, notFound } from '../../shared/errors.ts';
import { duplicateKeyIndex, isDuplicateKeyError } from '../../shared/mongoErrors.ts';
import { recordAudit } from '../audit/repository.ts';
import { COLLECTIONS } from '../../db/indexes.ts';

/** How precisely a location may be shown to the public. Default is deliberately coarse. */
export const PUBLIC_PRECISIONS = ['hidden', 'city', 'area', 'exact'] as const;
export type PublicPrecision = (typeof PUBLIC_PRECISIONS)[number];

export type GeoPoint = { type: 'Point'; coordinates: [number, number] };

export type LocationDoc = {
  key: string;
  countryCode: string;
  cityKey: string;
  areaKey: string;
  labels: { en: string; ar?: string | null };
  /** Optional GeoJSON point, [lng, lat]. Validated on write. */
  point: GeoPoint | null;
  publicPrecision: PublicPrecision;
  active: boolean;
  order: number;
  createdBy: string;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type LocationWithId = LocationDoc & { _id?: unknown };

const SLUG = /^[a-z][a-z0-9-]{1,59}$/;

/** Public view. `exact` coordinates and street-level detail are never published by default. */
export type PublicLocationDto = {
  key: string;
  countryCode: string;
  cityKey: string;
  areaKey: string | null;
  label: string;
  coordinates: [number, number] | null;
};

function assertCountry(code: string): string {
  const value = String(code ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(value)) {
    throw new AppError('VALIDATION_ERROR', 'Country must be an ISO 3166-1 alpha-2 code', {
      fieldErrors: { countryCode: 'two letters, e.g. QA' },
    });
  }
  return value;
}

function assertSlug(value: string, field: string): string {
  const slug = String(value ?? '').trim().toLowerCase();
  if (!SLUG.test(slug)) {
    throw new AppError('VALIDATION_ERROR', `Invalid ${field}`, {
      fieldErrors: { [field]: 'lowercase letters, digits and dashes' },
    });
  }
  return slug;
}

export function assertCoordinates(point: { lat: number; lng: number } | null | undefined): GeoPoint | null {
  if (point === null || point === undefined) return null;
  const lat = Number(point.lat);
  const lng = Number(point.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new AppError('VALIDATION_ERROR', 'Coordinates must be numbers', {
      fieldErrors: { coordinates: 'lat/lng must be numbers' },
    });
  }
  if (lat < -90 || lat > 90) {
    throw new AppError('VALIDATION_ERROR', 'Latitude must be between -90 and 90', {
      fieldErrors: { lat: 'out of range' },
    });
  }
  if (lng < -180 || lng > 180) {
    throw new AppError('VALIDATION_ERROR', 'Longitude must be between -180 and 180', {
      fieldErrors: { lng: 'out of range' },
    });
  }
  // GeoJSON order is [lng, lat] — stored once, in the canonical order.
  return { type: 'Point', coordinates: [Number(lng.toFixed(6)), Number(lat.toFixed(6))] };
}

/** Apply the precision policy. Exact coordinates require an explicit `exact` opt-in. */
export function toPublicLocationDto(location: LocationDoc): PublicLocationDto {
  const showArea = location.publicPrecision === 'area' || location.publicPrecision === 'exact';
  return {
    key: location.key,
    countryCode: location.countryCode,
    cityKey: location.cityKey,
    areaKey: showArea ? location.areaKey : null,
    label: location.labels.en,
    coordinates: location.publicPrecision === 'exact' ? location.point?.coordinates ?? null : null,
  };
}

export type LocationDeps = { db: Db; logger: Logger };

export function createLocationService(deps: LocationDeps) {
  const { db, logger } = deps;
  const locations = (): Collection<LocationDoc> => db.collection<LocationDoc>(COLLECTIONS.locations);

  return {
    async create(
      input: {
        countryCode: string;
        cityKey: string;
        areaKey: string;
        labelEn: string;
        labelAr?: string | null;
        coordinates?: { lat: number; lng: number } | null;
        publicPrecision?: PublicPrecision;
        order?: number;
      },
      actor: { reference: string; requestId: string },
    ): Promise<LocationDoc> {
      const countryCode = assertCountry(input.countryCode);
      const cityKey = assertSlug(input.cityKey, 'cityKey');
      const areaKey = assertSlug(input.areaKey, 'areaKey');
      const label = String(input.labelEn ?? '').trim();
      if (label.length < 2 || label.length > 120) {
        throw new AppError('VALIDATION_ERROR', 'Location needs a display label', {
          fieldErrors: { labelEn: '2-120 characters' },
        });
      }
      const precision = input.publicPrecision ?? 'city';
      if (!PUBLIC_PRECISIONS.includes(precision)) {
        throw new AppError('VALIDATION_ERROR', 'Invalid public precision', {
          fieldErrors: { publicPrecision: `one of ${PUBLIC_PRECISIONS.join(', ')}` },
        });
      }
      const now = new Date();
      const doc: LocationDoc = {
        key: `${countryCode.toLowerCase()}-${cityKey}-${areaKey}`,
        countryCode,
        cityKey,
        areaKey,
        labels: { en: label, ar: input.labelAr?.trim() ?? null },
        point: assertCoordinates(input.coordinates ?? null),
        publicPrecision: precision,
        active: true,
        order: input.order ?? 0,
        createdBy: actor.reference,
        updatedBy: null,
        createdAt: now,
        updatedAt: now,
      };
      try {
        await locations().insertOne(doc);
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          throw conflict('That country/city/area already exists', { index: duplicateKeyIndex(err) });
        }
        throw err;
      }
      await recordAudit(db, {
        actorId: actor.reference,
        action: 'location.created',
        targetType: 'location',
        targetId: doc.key,
        requestId: actor.requestId,
        changeSummary: { country: doc.countryCode, city: doc.cityKey, precision: doc.publicPrecision },
        reason: null,
      });
      logger.info('location created', { key: doc.key });
      return doc;
    },

    async update(
      key: string,
      input: {
        labelEn?: string;
        labelAr?: string | null;
        coordinates?: { lat: number; lng: number } | null;
        publicPrecision?: PublicPrecision;
        active?: boolean;
        order?: number;
      },
      actor: { reference: string; requestId: string },
    ): Promise<LocationDoc> {
      const patch: Partial<LocationDoc> = { updatedAt: new Date(), updatedBy: actor.reference };
      if (input.labelEn !== undefined) patch.labels = { en: input.labelEn.trim(), ar: input.labelAr ?? null };
      else if (input.labelAr !== undefined) {
        const current = await locations().findOne({ key });
        if (!current) throw notFound('Location not found');
        patch.labels = { en: current.labels.en, ar: input.labelAr };
      }
      if (input.coordinates !== undefined) patch.point = assertCoordinates(input.coordinates);
      if (input.publicPrecision !== undefined) {
        if (!PUBLIC_PRECISIONS.includes(input.publicPrecision)) {
          throw new AppError('VALIDATION_ERROR', 'Invalid public precision', {
            fieldErrors: { publicPrecision: 'invalid' },
          });
        }
        patch.publicPrecision = input.publicPrecision;
      }
      if (input.active !== undefined) patch.active = input.active;
      if (input.order !== undefined) patch.order = input.order;

      const updated = await locations().findOneAndUpdate({ key }, { $set: patch }, { returnDocument: 'after' });
      if (!updated) throw notFound('Location not found');
      await recordAudit(db, {
        actorId: actor.reference,
        action: 'location.updated',
        targetType: 'location',
        targetId: key,
        requestId: actor.requestId,
        changeSummary: { fields: Object.keys(patch).filter((k) => k !== 'updatedAt' && k !== 'updatedBy') },
        reason: null,
      });
      return updated;
    },

    async list(options: { includeInactive: boolean; countryCode?: string; cityKey?: string }): Promise<LocationDoc[]> {
      const filter: Record<string, unknown> = {};
      if (!options.includeInactive) filter.active = true;
      if (options.countryCode) filter.countryCode = assertCountry(options.countryCode);
      if (options.cityKey) filter.cityKey = options.cityKey;
      return locations().find(filter).sort({ countryCode: 1, cityKey: 1, order: 1, areaKey: 1 }).toArray();
    },

    async getByKey(key: string): Promise<LocationDoc | null> {
      return locations().findOne({ key });
    },

    /** Seller/listing references to a location must point at a real, active location. */
    async assertActiveKey(key: string): Promise<LocationDoc> {
      const location = await locations().findOne({ key });
      if (!location) {
        throw new AppError('VALIDATION_ERROR', 'Unknown location', { fieldErrors: { locationKey: 'unknown location' } });
      }
      if (!location.active) {
        throw new AppError('VALIDATION_ERROR', 'That location is no longer available', {
          fieldErrors: { locationKey: 'inactive location' },
        });
      }
      return location;
    },
  };
}

export type LocationService = ReturnType<typeof createLocationService>;
