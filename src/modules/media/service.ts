import { createHash } from 'node:crypto';
import type { ClientSession, Collection, Db } from 'mongodb';
import type { AppConfig } from '../../config/index.ts';
import type { Logger } from '../../shared/logger.ts';
import { AppError, conflict, notFound } from '../../shared/errors.ts';
import { isDuplicateKeyError } from '../../shared/mongoErrors.ts';
import { randomToken } from '../../shared/crypto.ts';
import { recordAudit } from '../audit/repository.ts';
import { COLLECTIONS } from '../../db/indexes.ts';
import {
  ALLOWED_IMAGE_MIME,
  detectExecutableMarkup,
  inspectImage,
  stripImageMetadata,
  verifyImageIntegrity,
  type AllowedImageMime,
} from './imageInfo.ts';
import type { MediaAssetDoc, MediaReferenceDoc } from './models.ts';
import type { MediaStorage } from './storage.ts';

export type MediaDeps = {
  db: Db;
  logger: Logger;
  config: AppConfig;
  storage: MediaStorage;
  withTransaction: <T>(fn: (session: ClientSession) => Promise<T>) => Promise<T>;
};

export type UploadInput = {
  bytes: Buffer;
  declaredMime: string;
  collectionKey?: string | null;
  actor: { reference: string; requestId: string };
};

const EXTENSION_BY_MIME: Record<AllowedImageMime, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * Final object key: date-partitioned, checksum-first, and unique per asset.
 *
 * Uniqueness matters because media deletion removes the object: if two assets shared one key,
 * deleting the unreferenced one would blank the other's image. The asset id suffix keeps the
 * key collision-free while the checksum stays visible for operators and duplicate detection.
 */
function storageKeyFor(checksum: string, assetId: string, mime: AllowedImageMime, now: Date): string {
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `media/${now.getUTCFullYear()}/${month}/${checksum}-${assetId}.${EXTENSION_BY_MIME[mime]}`;
}

export function createMediaService(deps: MediaDeps) {
  const { db, logger, config, storage, withTransaction } = deps;

  // The session is passed per operation, not per collection handle.
  const assets = (_session?: ClientSession): Collection<MediaAssetDoc> => db.collection<MediaAssetDoc>(COLLECTIONS.mediaAssets);
  const references = (): Collection<MediaReferenceDoc> => db.collection<MediaReferenceDoc>(COLLECTIONS.mediaReferences);

  async function record(
    doc: Omit<MediaAssetDoc, 'createdAt' | 'updatedAt'> & { createdAt?: Date; updatedAt?: Date },
  ): Promise<MediaAssetDoc> {
    const now = new Date();
    const full: MediaAssetDoc = { ...doc, createdAt: doc.createdAt ?? now, updatedAt: doc.updatedAt ?? now };
    await assets().insertOne(full);
    return full;
  }

  /**
   * Record a rejection (status + reason) so the admin UI can explain what happened, then
   * return the error for the caller to `throw`. Returning instead of throwing keeps
   * TypeScript's control-flow narrowing honest at the call sites.
   */
  async function reject(input: {
    declaredMime: string;
    bytes: number;
    collectionKey: string;
    actor: { reference: string; requestId: string };
    reason: string;
    status?: 'rejected' | 'failed';
  }): Promise<AppError> {
    const assetId = `m_${randomToken(9)}`;
    await record({
      assetId,
      storageKey: null,
      stagingKey: null,
      collectionKey: input.collectionKey,
      position: await nextPosition(input.collectionKey),
      isCover: false,
      declaredMime: input.declaredMime,
      mime: null,
      bytes: input.bytes,
      checksum: null,
      image: null,
      status: input.status ?? 'rejected',
      statusReason: input.reason,
      metadataStripped: false,
      source: 'upload',
      createdBy: input.actor.reference,
      deletedAt: null,
    });
    await recordAudit(db, {
      actorId: input.actor.reference,
      action: 'media.upload_rejected',
      targetType: 'media_asset',
      targetId: assetId,
      requestId: input.actor.requestId,
      changeSummary: { declaredMime: input.declaredMime, bytes: input.bytes, reason: input.reason },
      reason: null,
    });
    // A storage outage is retryable (503); a rejected file is the caller's problem (422).
    return input.status === 'failed'
      ? new AppError('SERVICE_UNAVAILABLE', input.reason, { details: { assetId } })
      : new AppError('VALIDATION_ERROR', input.reason, { fieldErrors: { file: input.reason }, details: { assetId } });
  }

  async function nextPosition(collectionKey: string): Promise<number> {
    const last = await assets().find({ collectionKey }).sort({ position: -1 }).limit(1).toArray();
    return (last[0]?.position ?? -1) + 1;
  }

  /** Local (not `this`) so callers can destructure the service safely. */
  const listByCollection = async (collectionKey: string): Promise<MediaAssetDoc[]> =>
    assets().find({ collectionKey, status: { $ne: 'deleted' } }).sort({ position: 1, _id: 1 }).toArray();

  const getByAssetId = async (assetId: string): Promise<MediaAssetDoc> => {
    const asset = await assets().findOne({ assetId, status: { $ne: 'deleted' } });
    if (!asset) throw notFound('Media asset not found');
    return asset;
  };

  return {
    listByCollection,
    getByAssetId,
    /**
     * Upload one image. Order of operations is deliberate: size, declared type, storage
     * staging, then content validation — so an oversized or forged file never lands in the
     * final store, and a failed write leaves a retryable record rather than a silent loss.
     */
    async upload(input: UploadInput): Promise<MediaAssetDoc> {
      const declaredMime = String(input.declaredMime ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      const bytes = input.bytes;
      const collectionKey = (input.collectionKey ?? '').trim() || `draft_${randomToken(6)}`;

      if (!ALLOWED_IMAGE_MIME.includes(declaredMime as AllowedImageMime)) {
        // Video is deliberately unavailable until storage/processing is approved.
        const reason = declaredMime.startsWith('video/')
          ? 'Video uploads are not enabled'
          : `Unsupported file type "${declaredMime || 'unknown'}" (allowed: ${ALLOWED_IMAGE_MIME.join(', ')})`;
        throw await reject({ declaredMime, bytes: bytes.length, collectionKey, actor: input.actor, reason });
      }
      if (bytes.length === 0) {
        throw await reject({ declaredMime, bytes: 0, collectionKey, actor: input.actor, reason: 'The uploaded file is empty' });
      }
      if (bytes.length > config.mediaMaxBytes) {
        throw await reject({
          declaredMime,
          bytes: bytes.length,
          collectionKey,
          actor: input.actor,
          reason: `File is larger than the ${Math.floor(config.mediaMaxBytes / 1024)} KB limit`,
        });
      }

      const existingCount = await assets().countDocuments({ collectionKey, status: { $in: ['ready', 'staging'] } });
      if (existingCount >= config.mediaMaxFilesPerCollection) {
        throw await reject({
          declaredMime,
          bytes: bytes.length,
          collectionKey,
          actor: input.actor,
          reason: `This collection already holds the maximum of ${config.mediaMaxFilesPerCollection} files`,
        });
      }

      const markup = detectExecutableMarkup(bytes);
      if (markup) throw await reject({ declaredMime, bytes: bytes.length, collectionKey, actor: input.actor, reason: markup });

      const assetId = `m_${randomToken(9)}`;
      const stagingKey = `staging/${assetId}`;
      try {
        await storage.put(stagingKey, bytes);
      } catch (err) {
        // Any storage failure is an outage, not a client error: record it and report a
        // retryable 503. The underlying error stays in the logs, never in the response.
        logger.error('media staging failed', { assetId, err });
        throw await reject({
          declaredMime,
          bytes: bytes.length,
          collectionKey,
          actor: input.actor,
          reason: 'Media storage was unavailable while receiving the upload',
          status: 'failed',
        });
      }

      const info = inspectImage(bytes);
      if (!info) {
        await storage.delete(stagingKey).catch(() => {});
        throw await reject({
          declaredMime,
          bytes: bytes.length,
          collectionKey,
          actor: input.actor,
          reason: 'The file content does not match a supported image format',
        });
      }
      if (info.mime !== declaredMime) {
        await storage.delete(stagingKey).catch(() => {});
        throw await reject({
          declaredMime,
          bytes: bytes.length,
          collectionKey,
          actor: input.actor,
          reason: `Content is ${info.mime} but the request declared ${declaredMime}`,
        });
      }

      // Integrity before anything else: a truncated or corrupt container is rejected here rather
      // than stored, so a half-uploaded file can never become a listing image.
      const integrity = verifyImageIntegrity(bytes, info.mime);
      if (integrity) {
        await storage.delete(stagingKey).catch(() => {});
        throw await reject({
          declaredMime,
          bytes: bytes.length,
          collectionKey,
          actor: input.actor,
          reason: integrity,
        });
      }
      if (info.width > config.mediaMaxDimension || info.height > config.mediaMaxDimension) {
        await storage.delete(stagingKey).catch(() => {});
        throw await reject({
          declaredMime,
          bytes: bytes.length,
          collectionKey,
          actor: input.actor,
          reason: `Image is ${info.width}x${info.height}; the limit is ${config.mediaMaxDimension}px per side`,
        });
      }

      // Metadata is removed before the bytes reach the final store: EXIF GPS must never be served.
      const stripped = stripImageMetadata(bytes, info.mime);
      const checksum = createHash('sha256').update(bytes).digest('hex');
      const now = new Date();
      // The checksum names the content, the asset id makes the key unique: two listings may
      // legitimately upload the same photo, and a shared object key would let deleting one
      // asset's bytes break the other. The `rq_media_checksum` index still finds duplicates.
      const storageKey = storageKeyFor(checksum, assetId, info.mime, now);

      const position = await nextPosition(collectionKey);
      const isCover = position === 0;
      let promoted = false;
      try {
        await storage.put(storageKey, stripped);
        promoted = true;
      } catch (err) {
        logger.error('media promotion failed', { assetId, err });
      }

      const doc = await record({
        assetId,
        storageKey: promoted ? storageKey : null,
        // The staging copy is kept only when the promotion failed, so a retry is possible.
        stagingKey: promoted ? null : stagingKey,
        collectionKey,
        position,
        isCover,
        declaredMime,
        mime: info.mime,
        bytes: bytes.length,
        checksum,
        image: { width: info.width, height: info.height },
        status: promoted ? 'ready' : 'failed',
        statusReason: promoted ? null : 'Storage was unavailable while finalising the upload',
        metadataStripped: true,
        source: 'upload',
        createdBy: input.actor.reference,
        deletedAt: null,
      });

      if (promoted) await storage.delete(stagingKey).catch(() => {});

      await recordAudit(db, {
        actorId: input.actor.reference,
        action: promoted ? 'media.uploaded' : 'media.upload_failed',
        targetType: 'media_asset',
        targetId: assetId,
        requestId: input.actor.requestId,
        changeSummary: { mime: info.mime, bytes: bytes.length, width: info.width, height: info.height, collectionKey },
        reason: promoted ? null : 'storage unavailable',
      });

      if (!promoted) {
        throw new AppError('SERVICE_UNAVAILABLE', 'Media storage was unavailable; the upload can be retried', {
          details: { assetId },
        });
      }
      logger.info('media uploaded', { assetId, mime: info.mime, collectionKey });
      return doc;
    },

    /** Retry a failed promotion from the retained staging copy. */
    async retry(assetId: string, actor: { reference: string; requestId: string }): Promise<MediaAssetDoc> {
      const asset = await assets().findOne({ assetId });
      if (!asset) throw notFound('Media asset not found');
      if (asset.status !== 'failed') throw conflict('Only failed uploads can be retried', { status: asset.status });
      if (!asset.stagingKey) throw conflict('No staged copy remains for this upload');

      const bytes = await storage.get(asset.stagingKey);
      const info = inspectImage(bytes);
      if (!info) throw new AppError('VALIDATION_ERROR', 'The staged file is not a readable image');
      const stripped = stripImageMetadata(bytes, info.mime);
      const checksum = asset.checksum ?? createHash('sha256').update(bytes).digest('hex');
      const now = new Date();
      const storageKey = storageKeyFor(checksum, assetId, info.mime, now);
      await storage.put(storageKey, stripped);
      const updated = await assets().findOneAndUpdate(
        { assetId, status: 'failed' },
        { $set: { status: 'ready', storageKey, stagingKey: null, statusReason: null, updatedAt: new Date() } },
        { returnDocument: 'after' },
      );
      if (!updated) throw conflict('This upload changed while retrying');
      await storage.delete(asset.stagingKey).catch(() => {});
      await recordAudit(db, {
        actorId: actor.reference,
        action: 'media.retried',
        targetType: 'media_asset',
        targetId: assetId,
        requestId: actor.requestId,
        changeSummary: { status: 'ready' },
        reason: 'retry after storage recovery',
      });
      return updated;
    },


    async readBytes(asset: MediaAssetDoc): Promise<Buffer> {
      if (!asset.storageKey) throw new AppError('NOT_FOUND', 'Media object is not available');
      return storage.get(asset.storageKey);
    },

    /** Full-order update. Every asset must belong to the collection and be servable. */
    async setOrder(collectionKey: string, assetIds: string[], actor: { reference: string; requestId: string }): Promise<MediaAssetDoc[]> {
      const items = await assets().find({ collectionKey, status: { $ne: 'deleted' } }).toArray();
      const byId = new Map(items.map((item) => [item.assetId, item]));
      const ordered: MediaAssetDoc[] = [];
      const seen = new Set<string>();
      for (const assetId of assetIds) {
        const asset = byId.get(assetId);
        if (!asset) {
          throw new AppError('VALIDATION_ERROR', `Asset ${assetId} is not part of this collection`, {
            fieldErrors: { assetIds: 'unknown asset' },
          });
        }
        if (seen.has(assetId)) {
          throw new AppError('VALIDATION_ERROR', `Asset ${assetId} appears more than once`, {
            fieldErrors: { assetIds: 'duplicate asset' },
          });
        }
        seen.add(assetId);
        ordered.push(asset);
      }

      // Reordering changes order only. An explicitly chosen cover survives a reorder, and a
      // collection with no cover yet falls back to its first asset.
      const hasCover = ordered.some((asset) => asset.isCover);
      await withTransaction(async (session) => {
        for (let index = 0; index < ordered.length; index += 1) {
          const asset = ordered[index]!;
          await assets(session).updateOne(
            { assetId: asset.assetId },
            { $set: { position: index, updatedAt: new Date() } },
          );
        }
        if (!hasCover && ordered[0]) {
          await assets(session).updateOne({ assetId: ordered[0].assetId }, { $set: { isCover: true, updatedAt: new Date() } });
        }
        // Assets that were not listed keep their position but cannot be the cover anymore.
        await assets(session).updateMany(
          { collectionKey, assetId: { $nin: ordered.map((a) => a.assetId) }, isCover: true },
          { $set: { isCover: false, updatedAt: new Date() } },
        );
      });

      await recordAudit(db, {
        actorId: actor.reference,
        action: 'media.reordered',
        targetType: 'media_collection',
        targetId: collectionKey,
        requestId: actor.requestId,
        changeSummary: { order: ordered.map((a) => a.assetId) },
        reason: null,
      });
      return listByCollection(collectionKey);
    },

    async setCover(collectionKey: string, assetId: string, actor: { reference: string; requestId: string }): Promise<MediaAssetDoc[]> {
      const items = await assets().find({ collectionKey, status: { $ne: 'deleted' } }).toArray();
      const target = items.find((item) => item.assetId === assetId);
      if (!target) {
        throw new AppError('VALIDATION_ERROR', 'That asset is not part of this collection', {
          fieldErrors: { assetId: 'unknown asset' },
        });
      }
      if (target.status !== 'ready') {
        throw conflict('Only a ready asset can be the cover', { status: target.status });
      }
      await withTransaction(async (session) => {
        await assets(session).updateMany({ collectionKey, isCover: true }, { $set: { isCover: false, updatedAt: new Date() } });
        await assets(session).updateOne({ assetId }, { $set: { isCover: true, updatedAt: new Date() } });
      });
      await recordAudit(db, {
        actorId: actor.reference,
        action: 'media.cover_changed',
        targetType: 'media_collection',
        targetId: collectionKey,
        requestId: actor.requestId,
        changeSummary: { cover: assetId },
        reason: null,
      });
      return listByCollection(collectionKey);
    },

    /**
     * Deletion is refused while any owner references the asset. An asset that a listing
     * points at must never disappear underneath it.
     */
    async remove(assetId: string, reason: string, actor: { reference: string; requestId: string }): Promise<void> {
      const asset = await getByAssetId(assetId);
      const refs = await references().countDocuments({ assetId });
      if (refs > 0) {
        throw conflict('This media is in use and cannot be deleted', { references: refs });
      }
      if (asset.storageKey) await storage.delete(asset.storageKey).catch(() => {});
      if (asset.stagingKey) await storage.delete(asset.stagingKey).catch(() => {});
      await assets().updateOne(
        { assetId },
        { $set: { status: 'deleted', deletedAt: new Date(), updatedAt: new Date(), storageKey: null, stagingKey: null } },
      );
      await recordAudit(db, {
        actorId: actor.reference,
        action: 'media.deleted',
        targetType: 'media_asset',
        targetId: assetId,
        requestId: actor.requestId,
        changeSummary: { collectionKey: asset.collectionKey },
        reason,
      });
    },

    /**
     * Orphan cleanup. Only uploads that never became usable (staging/rejected/failed) and
     * are older than the cutoff are touched, and never one that is referenced.
     */
    async cleanupOrphans(options: { olderThanHours: number; apply: boolean; actor: { reference: string; requestId: string } }): Promise<{ candidates: string[]; removed: string[] }> {
      const cutoff = new Date(Date.now() - options.olderThanHours * 3_600_000);
      const stale = await assets()
        .find({ status: { $in: ['staging', 'rejected', 'failed'] }, createdAt: { $lt: cutoff } })
        .limit(500)
        .toArray();
      const referenced = new Set(
        (await references().find({ assetId: { $in: stale.map((a) => a.assetId) } }).toArray()).map((r) => r.assetId),
      );
      const candidates = stale.filter((asset) => !referenced.has(asset.assetId)).map((asset) => asset.assetId);
      if (!options.apply) return { candidates, removed: [] };

      for (const assetId of candidates) {
        const asset = stale.find((a) => a.assetId === assetId)!;
        if (asset.storageKey) await storage.delete(asset.storageKey).catch(() => {});
        if (asset.stagingKey) await storage.delete(asset.stagingKey).catch(() => {});
        await assets().updateOne(
          { assetId },
          { $set: { status: 'deleted', deletedAt: new Date(), updatedAt: new Date(), storageKey: null, stagingKey: null } },
        );
      }
      if (candidates.length > 0) {
        await recordAudit(db, {
          actorId: options.actor.reference,
          action: 'media.orphans_cleaned',
          targetType: 'media_collection',
          targetId: 'staging',
          requestId: options.actor.requestId,
          changeSummary: { removed: candidates.length, olderThanHours: options.olderThanHours },
          reason: 'scheduled orphan cleanup',
        });
      }
      return { candidates, removed: candidates };
    },

    /** Used by later phases (listings) and by tests to mark an asset as in use. */
    async addReference(input: { assetId: string; ownerType: string; ownerId: string; actor: string }): Promise<void> {
      await getByAssetId(input.assetId);
      try {
        await references().insertOne({
          assetId: input.assetId,
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          addedAt: new Date(),
          addedBy: input.actor,
        });
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
      }
    },

    /**
     * Remove exactly one reference. The asset itself is untouched, so detaching an image from a
     * listing never deletes the stored file — deletion stays a separate, guarded operation.
     */
    async removeReference(input: { assetId: string; ownerType: string; ownerId: string }): Promise<void> {
      await references().deleteOne({ assetId: input.assetId, ownerType: input.ownerType, ownerId: input.ownerId });
    },

    /** Every owner of an asset. Used to refuse cross-purpose attachment (e.g. evidence to a listing). */
    async listReferences(assetId: string): Promise<MediaReferenceDoc[]> {
      return references().find({ assetId }).toArray();
    },

    /** Resolve an asset for public serving. Returns null instead of throwing, so callers can 404. */
    async findReadyAsset(assetId: string): Promise<MediaAssetDoc | null> {
      return assets().findOne({ assetId, status: 'ready' });
    },
  };
}

export type MediaService = ReturnType<typeof createMediaService>;
