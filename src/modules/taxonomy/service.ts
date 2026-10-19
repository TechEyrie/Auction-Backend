import type { ClientSession, Collection, Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import type { Logger } from '../../shared/logger.ts';
import { AppError, conflict, notFound } from '../../shared/errors.ts';
import { duplicateKeyIndex, isDuplicateKeyError } from '../../shared/mongoErrors.ts';
import { recordAudit } from '../audit/repository.ts';
import { COLLECTIONS } from '../../db/indexes.ts';
import {
  isCatalogueCategory,
  MAX_CATEGORY_DEPTH,
  type CategoryDoc,
  type CategoryWithId,
  type ListingMethod,
} from './models.ts';

export type TaxonomyDeps = {
  db: Db;
  logger: Logger;
  withTransaction: <T>(fn: (session: ClientSession) => Promise<T>) => Promise<T>;
};

export type CategoryInput = {
  key: string;
  parentKey: string | null;
  nameEn: string;
  nameAr?: string | null;
  descriptionEn?: string | null;
  descriptionAr?: string | null;
  icon?: string | null;
  order?: number;
  active?: boolean;
  listingMethods: ListingMethod[];
};

const KEY_PATTERN = /^[a-z][a-z0-9-]{1,59}$/;

function assertKey(key: string): string {
  const value = String(key ?? '').trim().toLowerCase();
  if (!KEY_PATTERN.test(value)) {
    throw new AppError('VALIDATION_ERROR', 'Invalid category key', {
      fieldErrors: { key: 'lowercase letters, digits and dashes, 2-60 characters' },
    });
  }
  return value;
}

function assertMethods(methods: ListingMethod[]): ListingMethod[] {
  if (!Array.isArray(methods) || methods.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'Choose at least one listing method', {
      fieldErrors: { listingMethods: 'required' },
    });
  }
  return methods;
}

export function createTaxonomyService(deps: TaxonomyDeps) {
  const { db, logger, withTransaction } = deps;

  // The session is passed per operation, not per collection handle.
  const categories = (_session?: ClientSession): Collection<CategoryDoc> =>
    db.collection<CategoryDoc>(COLLECTIONS.categories);

  /**
   * Cycle and depth validation for a proposed parent, inside the caller's transaction.
   *
   * A cycle can only be created if the proposed parent is a descendant of the node being
   * moved. Reading the proposed parent's materialized ancestor chain inside the
   * transaction means a concurrent move that would make both edits individually valid is
   * detected as a write conflict by MongoDB and aborted, rather than committing a loop.
   */
  async function resolveParent(
    parentKey: string | null,
    movingKey: string | null,
    session: ClientSession,
  ): Promise<{ parentId: ObjectId | null; parentKey: string | null; ancestors: string[]; depth: number }> {
    if (parentKey === null) return { parentId: null, parentKey: null, ancestors: [], depth: 0 };
    const key = assertKey(parentKey);
    const parent = await categories(session).findOne({ key });
    if (!parent) {
      throw new AppError('VALIDATION_ERROR', 'Parent category does not exist', {
        fieldErrors: { parentKey: 'unknown category' },
      });
    }
    if (movingKey && (parent.key === movingKey || parent.ancestors.includes(movingKey))) {
      throw conflict('A category cannot be moved under itself or its own descendant', {
        reason: 'category_cycle',
      });
    }
    const depth = parent.depth + 1;
    // MAX_CATEGORY_DEPTH is the number of levels, so depth indexes run 0..MAX-1.
    if (depth >= MAX_CATEGORY_DEPTH) {
      throw new AppError('VALIDATION_ERROR', `Categories may nest up to ${MAX_CATEGORY_DEPTH} levels deep`, {
        fieldErrors: { parentKey: 'too deep' },
      });
    }
    return { parentId: parent._id, parentKey: parent.key, ancestors: [...parent.ancestors, parent.key], depth };
  }

  return {
    async create(input: CategoryInput, actor: { reference: string; requestId: string }): Promise<CategoryWithId> {
      const key = assertKey(input.key);
      const methods = assertMethods(input.listingMethods);
      const now = new Date();
      const doc = await withTransaction(async (session) => {
        const parent = await resolveParent(input.parentKey, null, session);
        const created: CategoryDoc = {
          key,
          parentId: parent.parentId,
          parentKey: parent.parentKey,
          ancestors: parent.ancestors,
          depth: parent.depth,
          labels: {
            en: { name: input.nameEn.trim(), description: input.descriptionEn?.trim() ?? null },
            ar: input.nameAr ? { name: input.nameAr.trim(), description: input.descriptionAr?.trim() ?? null } : null,
          },
          icon: input.icon ?? null,
          order: input.order ?? 0,
          active: input.active ?? true,
          listingMethods: methods,
          currentAttributeSchemaVersion: null,
          hierarchyVersion: 1,
          createdBy: actor.reference,
          updatedBy: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
        };
        const result = await categories(session).insertOne(created);
        return { ...created, _id: result.insertedId };
      }).catch((err: unknown) => {
        if (isDuplicateKeyError(err)) {
          throw conflict('A category with this key already exists', { index: duplicateKeyIndex(err) });
        }
        throw err;
      });

      await recordAudit(db, {
        actorId: actor.reference,
        action: 'category.created',
        targetType: 'category',
        targetId: doc.key,
        requestId: actor.requestId,
        changeSummary: { parent: doc.parentKey, methods: doc.listingMethods },
        reason: null,
      });
      logger.info('category created', { key: doc.key, parent: doc.parentKey });
      return doc;
    },

    async update(
      key: string,
      input: Partial<CategoryInput>,
      expectedHierarchyVersion: number | null,
      actor: { reference: string; requestId: string },
    ): Promise<CategoryWithId> {
      const targetKey = assertKey(key);
      const now = new Date();
      let parentChanged = false;

      const updated = await withTransaction(async (session) => {
        const current = await categories(session).findOne({ key: targetKey });
        if (!current) throw notFound('Category not found');
        if (expectedHierarchyVersion !== null && current.hierarchyVersion !== expectedHierarchyVersion) {
          throw conflict('This category changed while you were editing it', {
            reason: 'stale_version',
            current: current.hierarchyVersion,
          });
        }

        const patch: Partial<CategoryDoc> = { updatedAt: now, updatedBy: actor.reference, hierarchyVersion: current.hierarchyVersion + 1 };
        if (input.nameEn !== undefined || input.nameAr !== undefined || input.descriptionEn !== undefined || input.descriptionAr !== undefined) {
          patch.labels = {
            en: {
              name: (input.nameEn ?? current.labels.en.name).trim(),
              description: input.descriptionEn !== undefined ? (input.descriptionEn?.trim() ?? null) : current.labels.en.description,
            },
            ar: input.nameAr !== undefined
              ? (input.nameAr ? { name: input.nameAr.trim(), description: input.descriptionAr?.trim() ?? null } : null)
              : current.labels.ar,
          };
        }
        if (input.icon !== undefined) patch.icon = input.icon;
        if (input.order !== undefined) patch.order = input.order;
        if (input.active !== undefined) patch.active = input.active;
        if (input.listingMethods !== undefined) patch.listingMethods = assertMethods(input.listingMethods);
        if (input.parentKey !== undefined && input.parentKey !== current.parentKey) {
          const parent = await resolveParent(input.parentKey, current.key, session);
          patch.parentId = parent.parentId;
          patch.parentKey = parent.parentKey;
          patch.ancestors = parent.ancestors;
          patch.depth = parent.depth;
          parentChanged = true;
        }

        // Conditional on the version we read, so a competing write cannot be overwritten silently.
        const result = await categories(session).findOneAndUpdate(
          { key: targetKey, hierarchyVersion: current.hierarchyVersion },
          { $set: patch },
          { returnDocument: 'after', session },
        );
        if (!result) throw conflict('This category changed while you were editing it', { reason: 'stale_version' });
        return result;
      });

      if (parentChanged) {
        await recordAudit(db, {
          actorId: actor.reference,
          action: 'category.moved',
          targetType: 'category',
          targetId: targetKey,
          requestId: actor.requestId,
          changeSummary: { parent: updated.parentKey, depth: updated.depth },
          reason: 'hierarchy change',
        });
      } else {
        await recordAudit(db, {
          actorId: actor.reference,
          action: 'category.updated',
          targetType: 'category',
          targetId: targetKey,
          requestId: actor.requestId,
          changeSummary: { fields: Object.keys(input) },
          reason: null,
        });
      }
      return updated;
    },

    /** Archiving is the only removal: children and (later) listings keep their references. */
    async archive(key: string, reason: string, actor: { reference: string; requestId: string }): Promise<CategoryWithId> {
      const targetKey = assertKey(key);
      const updated = await withTransaction(async (session) => {
        const current = await categories(session).findOne({ key: targetKey });
        if (!current) throw notFound('Category not found');
        const activeChildren = await categories(session).countDocuments({ parentKey: targetKey, active: true });
        if (activeChildren > 0) {
          throw conflict('Archive or move the subcategories first', { activeChildren });
        }
        const result = await categories(session).findOneAndUpdate(
          { key: targetKey, hierarchyVersion: current.hierarchyVersion },
          {
            $set: {
              active: false,
              archivedAt: new Date(),
              updatedAt: new Date(),
              updatedBy: actor.reference,
              hierarchyVersion: current.hierarchyVersion + 1,
            },
          },
          { returnDocument: 'after', session },
        );
        if (!result) throw conflict('This category changed while you were editing it', { reason: 'stale_version' });
        return result;
      });

      await recordAudit(db, {
        actorId: actor.reference,
        action: 'category.archived',
        targetType: 'category',
        targetId: targetKey,
        requestId: actor.requestId,
        changeSummary: { active: false },
        reason,
      });
      return updated;
    },

    async restore(key: string, reason: string, actor: { reference: string; requestId: string }): Promise<CategoryWithId> {
      const targetKey = assertKey(key);
      const current = await categories().findOne({ key: targetKey });
      if (!current) throw notFound('Category not found');
      if (current.parentKey) {
        const parent = await categories().findOne({ key: current.parentKey });
        if (!parent || !parent.active) throw conflict('Restore the parent category first');
      }
      const updated = await withTransaction(async (session) => {
        const result = await categories(session).findOneAndUpdate(
          { key: targetKey, hierarchyVersion: current.hierarchyVersion },
          {
            $set: {
              active: true,
              archivedAt: null,
              updatedAt: new Date(),
              updatedBy: actor.reference,
              hierarchyVersion: current.hierarchyVersion + 1,
            },
          },
          { returnDocument: 'after', session },
        );
        if (!result) throw conflict('This category changed while you were editing it', { reason: 'stale_version' });
        return result;
      });
      await recordAudit(db, {
        actorId: actor.reference,
        action: 'category.restored',
        targetType: 'category',
        targetId: targetKey,
        requestId: actor.requestId,
        changeSummary: { active: true },
        reason,
      });
      return updated;
    },

    async list(includeInactive: boolean): Promise<CategoryWithId[]> {
      const filter = includeInactive ? {} : { active: true };
      const rows = await categories().find(filter).sort({ depth: 1, order: 1, key: 1 }).toArray();
      return rows.filter((c) => isCatalogueCategory(c.key, c.ancestors));
    },

    async getByKey(key: string): Promise<CategoryWithId | null> {
      return categories().findOne({ key });
    },

    async setCurrentSchemaVersion(
      key: string,
      version: number,
      session?: ClientSession,
    ): Promise<void> {
      const result = await categories(session).findOneAndUpdate(
        { key },
        { $set: { currentAttributeSchemaVersion: version, updatedAt: new Date() } },
        { ...(session ? { session } : {}), returnDocument: 'after' },
      );
      if (!result) throw notFound('Category not found');
    },
  };
}

export type TaxonomyService = ReturnType<typeof createTaxonomyService>;
