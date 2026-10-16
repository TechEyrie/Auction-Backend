import { AppError } from '../../shared/errors.ts';

/** Prefix for persisted storage keys that reference an ImageKit `fileId`. */
export const IMAGEKIT_STORAGE_KEY_PREFIX = 'ik:';

export function imageKitStorageKey(fileId: string): string {
  return `${IMAGEKIT_STORAGE_KEY_PREFIX}${fileId}`;
}

export function parseImageKitStorageKey(key: string): string | null {
  if (!key.startsWith(IMAGEKIT_STORAGE_KEY_PREFIX)) return null;
  const fileId = key.slice(IMAGEKIT_STORAGE_KEY_PREFIX.length);
  return fileId.length > 0 ? fileId : null;
}

// Keys are server-generated (base64url ids and hex digests), so mixed case is fine. What
// matters is that a key can never traverse out of the root or introduce a hidden path.
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9/._-]{0,200}$/;
const IMAGEKIT_KEY = new RegExp(`^${IMAGEKIT_STORAGE_KEY_PREFIX}[A-Za-z0-9._-]{1,120}$`);

/** Keys are generated server-side; this is the second line of defence against traversal. */
export function assertSafeKey(key: string): string {
  if (IMAGEKIT_KEY.test(key)) return key;
  if (!SAFE_KEY.test(key) || key.includes('..') || key.includes('//')) {
    throw new AppError('INTERNAL', 'Unsafe storage key', { details: { key } });
  }
  return key;
}
