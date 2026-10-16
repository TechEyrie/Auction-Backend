import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../../config/index.ts';
import { AppError } from '../../shared/errors.ts';
import { assertSafeKey } from './storage-keys.ts';
import { createImageKitStorage } from './storage-imagekit.ts';

export { assertSafeKey, imageKitStorageKey, parseImageKitStorageKey, IMAGEKIT_STORAGE_KEY_PREFIX } from './storage-keys.ts';

/**
 * Storage boundary for uploaded media.
 *
 * Implementations: local filesystem (development/test) and ImageKit (`MEDIA_DRIVER=imagekit`).
 * The local adapter refuses to operate in production unless `MEDIA_ALLOW_LOCAL_FILESYSTEM=true`.
 */
export type MediaPutResult = {
  /** Persisted object key (logical path for local; `ik:<fileId>` for ImageKit). */
  key: string;
  /** Absolute CDN URL when the provider exposes one (ImageKit). */
  publicUrl?: string;
};

export type MediaStorage = {
  readonly driver: string;
  put: (key: string, bytes: Buffer) => Promise<MediaPutResult>;
  get: (key: string) => Promise<Buffer>;
  delete: (key: string) => Promise<void>;
  exists: (key: string) => Promise<boolean>;
};

export function createLocalStorage(options: { root: string; nodeEnv: string; allowInProduction: boolean }): MediaStorage {
  const root = path.resolve(options.root);
  const enabled = options.nodeEnv !== 'production' || options.allowInProduction;

  const resolve = (key: string): string => {
    const full = path.resolve(root, assertSafeKey(key));
    if (!full.startsWith(root + path.sep) && full !== root) {
      throw new AppError('INTERNAL', 'Storage key escapes the media root');
    }
    return full;
  };

  const guard = (): void => {
    if (!enabled) {
      throw new AppError(
        'SERVICE_UNAVAILABLE',
        'Media storage is not configured for this environment (the local filesystem adapter is development-only)',
      );
    }
  };

  return {
    driver: 'local-filesystem',
    async put(key, bytes) {
      guard();
      const full = resolve(key);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, bytes);
      return { key };
    },
    async get(key) {
      guard();
      try {
        return await readFile(resolve(key));
      } catch {
        throw new AppError('NOT_FOUND', 'Media object not found');
      }
    },
    async delete(key) {
      guard();
      await rm(resolve(key), { force: true });
    },
    async exists(key) {
      guard();
      try {
        await readFile(resolve(key));
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function createMediaStorage(config: AppConfig): MediaStorage {
  if (config.mediaDriver === 'imagekit') {
    return createImageKitStorage({
      urlEndpoint: config.imagekitUrlEndpoint,
      publicKey: config.imagekitPublicKey,
      privateKey: config.imagekitPrivateKey,
      folder: config.imagekitFolder,
    });
  }
  return createLocalStorage({
    root: config.mediaStorageRoot,
    nodeEnv: config.nodeEnv,
    allowInProduction: config.mediaAllowLocalFilesystem,
  });
}
