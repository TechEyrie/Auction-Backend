import { ObjectId, type ClientSession, type Db } from 'mongodb';
import type { Logger } from '../../shared/logger.ts';
import { AppError, conflict, notFound } from '../../shared/errors.ts';
import { duplicateKeyIndex, isDuplicateKeyError } from '../../shared/mongoErrors.ts';
import { recordAudit } from '../audit/repository.ts';
import { COLLECTIONS } from '../../db/indexes.ts';
import { createTaxonomyService } from '../taxonomy/service.ts';
import type { AttributeField, AttributeSchemaWithId } from './models.ts';
import { validateAttributeValues, validateSchemaDefinition, type AttributeAudience } from './validate.ts';

export type AttributeDeps = {
  db: Db;
  logger: Logger;
  withTransaction: <T>(fn: (session: ClientSession) => Promise<T>) => Promise<T>;
};

export function createAttributeService(deps: AttributeDeps) {
  const { db, logger, withTransaction } = deps;
  const taxonomy = createTaxonomyService(deps);

  // The session is passed per operation, not per collection handle.
  const schemas = (_session?: ClientSession) => db.collection<AttributeSchemaWithId>(COLLECTIONS.attributeSchemas);

  /** Local (not `this`) so callers can destructure the service safely. */
  const currentForCategory = async (categoryKey: string): Promise<AttributeSchemaWithId | null> => {
    const category = await taxonomy.getByKey(categoryKey);
    if (!category) throw notFound('Category not found');
    if (category.currentAttributeSchemaVersion === null) return null;
    return schemas().findOne({ categoryId: category._id, version: category.currentAttributeSchemaVersion });
  };

  return {
    currentForCategory,

    /** Create the next draft version for a category. Previous versions are never touched. */
    async createDraft(
      input: { categoryKey: string; fields: AttributeField[]; notes?: string | null },
      actor: { reference: string; requestId: string },
    ): Promise<AttributeSchemaWithId> {
      const category = await taxonomy.getByKey(input.categoryKey);
      if (!category) {
        throw new AppError('VALIDATION_ERROR', 'Unknown category', {
          fieldErrors: { categoryKey: 'unknown category' },
        });
      }
      const fields = validateSchemaDefinition(input.fields);
      const now = new Date();

      const created = await withTransaction(async (session) => {
        const latest = await schemas(session)
          .find({ categoryId: category._id })
          .sort({ version: -1 })
          .limit(1)
          .toArray();
        const doc = {
          categoryId: category._id,
          categoryKey: category.key,
          version: (latest[0]?.version ?? 0) + 1,
          status: 'draft' as const,
          fields,
          notes: input.notes ?? null,
          createdBy: actor.reference,
          publishedBy: null,
          publishedAt: null,
          archivedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        const result = await schemas(session).insertOne(doc as AttributeSchemaWithId);
        return { ...doc, _id: result.insertedId } as AttributeSchemaWithId;
      }).catch((err: unknown) => {
        if (isDuplicateKeyError(err)) {
          // Two admins created a version at once: the unique (categoryId, version) index wins.
          throw conflict('Another schema version was created at the same time; reload and retry', {
            index: duplicateKeyIndex(err),
          });
        }
        throw err;
      });

      await recordAudit(db, {
        actorId: actor.reference,
        action: 'attribute_schema.draft_created',
        targetType: 'attribute_schema',
        targetId: `${created.categoryKey}#${created.version}`,
        requestId: actor.requestId,
        changeSummary: { fields: created.fields.length },
        reason: null,
      });
      logger.info('attribute schema draft created', { category: created.categoryKey, version: created.version });
      return created;
    },

    /** Drafts are editable; published versions are immutable history. */
    async updateDraft(
      id: string,
      input: { fields?: AttributeField[]; notes?: string | null },
      actor: { reference: string; requestId: string },
    ): Promise<AttributeSchemaWithId> {
      const current = await schemas().findOne({ _id: toObjectId(id) });
      if (!current) throw notFound('Schema version not found');
      if (current.status !== 'draft') {
        throw conflict('Published schema versions are immutable; create a new draft version', {
          status: current.status,
        });
      }
      const patch: Partial<AttributeSchemaWithId> = { updatedAt: new Date() };
      if (input.fields !== undefined) patch.fields = validateSchemaDefinition(input.fields);
      if (input.notes !== undefined) patch.notes = input.notes;

      const updated = await schemas().findOneAndUpdate(
        { _id: current._id, status: 'draft' },
        { $set: patch },
        { returnDocument: 'after' },
      );
      if (!updated) throw conflict('This draft changed while you were editing it');
      await recordAudit(db, {
        actorId: actor.reference,
        action: 'attribute_schema.draft_updated',
        targetType: 'attribute_schema',
        targetId: `${updated.categoryKey}#${updated.version}`,
        requestId: actor.requestId,
        changeSummary: { fields: updated.fields.length },
        reason: null,
      });
      return updated;
    },

    /**
     * Publish a draft: it becomes the category's current schema, the previously published
     * version moves to `archived` and stays readable forever for historical records.
     */
    async publish(
      id: string,
      actor: { reference: string; requestId: string },
    ): Promise<AttributeSchemaWithId> {
      const draft = await schemas().findOne({ _id: toObjectId(id) });
      if (!draft) throw notFound('Schema version not found');
      if (draft.status === 'published') throw conflict('This version is already published');
      validateSchemaDefinition(draft.fields);
      const now = new Date();

      const published = await withTransaction(async (session) => {
        await schemas(session).updateMany(
          { categoryId: draft.categoryId, status: 'published' },
          { $set: { status: 'archived', archivedAt: now, updatedAt: now } },
        );
        const result = await schemas(session).findOneAndUpdate(
          { _id: draft._id, status: 'draft' },
          {
            $set: {
              status: 'published',
              publishedBy: actor.reference,
              publishedAt: now,
              updatedAt: now,
            },
          },
          { returnDocument: 'after', session },
        );
        if (!result) throw conflict('This draft was published or changed by someone else');
        await taxonomy.setCurrentSchemaVersion(draft.categoryKey, draft.version, session);
        return result;
      });

      await recordAudit(db, {
        actorId: actor.reference,
        action: 'attribute_schema.published',
        targetType: 'attribute_schema',
        targetId: `${published.categoryKey}#${published.version}`,
        requestId: actor.requestId,
        changeSummary: { fields: published.fields.length, replacedPreviousVersion: true },
        reason: 'schema published as current version',
      });
      logger.info('attribute schema published', { category: published.categoryKey, version: published.version });
      return published;
    },

    /** Any version, any status: historical records must stay interpretable. */
    async getById(id: string): Promise<AttributeSchemaWithId> {
      const schema = await schemas().findOne({ _id: toObjectId(id) });
      if (!schema) throw notFound('Schema version not found');
      return schema;
    },

    async listForCategory(categoryKey: string): Promise<AttributeSchemaWithId[]> {
      return schemas().find({ categoryKey }).sort({ version: -1 }).toArray();
    },


    /**
     * Reusable validation entry point: any module that accepts category-dependent values
     * (admin forms today, listings in Phase 05) calls this instead of re-implementing rules.
     */
    async validateValues(
      categoryKey: string,
      values: Record<string, unknown>,
      audience: AttributeAudience,
      version?: number,
    ): Promise<{ ok: boolean; errors: Record<string, string>; values: Record<string, unknown>; version: number | null }> {
      const schema = version
        ? await schemas().findOne({ categoryKey, version })
        : await currentForCategory(categoryKey);
      if (!schema) {
        // No schema yet: reject values rather than silently accepting unknown keys.
        if (Object.keys(values ?? {}).length === 0) return { ok: true, errors: {}, values: {}, version: null };
        throw new AppError('VALIDATION_ERROR', 'This category has no published attribute schema yet', {
          fieldErrors: { attributes: 'schema not published' },
        });
      }
      const result = validateAttributeValues(schema.fields, values, audience);
      return { ...result, version: schema.version };
    },
  };
}

function toObjectId(id: string) {
  // Kept local so the service owns its id parsing and returns 404 instead of a driver error.
  if (!ObjectId.isValid(id)) throw notFound('Schema version not found');
  return new ObjectId(id);
}

export type AttributeService = ReturnType<typeof createAttributeService>;
