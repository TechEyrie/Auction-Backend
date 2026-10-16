import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../shared/errors.ts';

/**
 * Storage boundary for uploaded media.
 *
 * Object storage is not approved yet (see OPEN_QUESTIONS), so the only implementation is a
 * local filesystem adapter used by development and tests. It refuses to operate in
 * production unless `MEDIA_ALLOW_LOCAL_FILESYSTEM=true` is set explicitly, so a development
 * adapter can never silently become the production store. Adding a provider later means
 * writing one more implementation of this type — nothing else changes.
 */
export type MediaStorage = {
  readonly driver: string;
  put: (key: string, bytes: Buffer) => Promise<void>;
  get: (key: string) => Promise<Buffer>;
  delete: (key: string) => Promise<void>;
  exists: (key: string) => Promise<boolean>;
};

// Keys are server-generated (base64url ids and hex digests), so mixed case is fine. What
// matters is that a key can never traverse out of the root or introduce a hidden path.
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9/._-]{0,200}$/;

/** Keys are generated server-side; this is the second line of defence against traversal. */
export function assertSafeKey(key: string): string {
  if (!SAFE_KEY.test(key) || key.includes('..') || key.includes('//')) {
    throw new AppError('INTERNAL', 'Unsafe storage key', { details: { key } });
  }
  return key;
}

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

export function createMediaStorage(config: {
  mediaStorageRoot: string;
  nodeEnv: string;
  mediaAllowLocalFilesystem: boolean;
}): MediaStorage {
  return createLocalStorage({
    root: config.mediaStorageRoot,
    nodeEnv: config.nodeEnv,
    allowInProduction: config.mediaAllowLocalFilesystem,
  });
}
