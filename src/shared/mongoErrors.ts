/**
 * MongoDB duplicate-key detection.
 *
 * Unique indexes are the only concurrency-safe way to enforce "no duplicates", so the
 * catalog modules rely on them and translate the driver error into an explicit 409
 * instead of pre-checking with a read (which races).
 */
export function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

/** Name of the unique index that rejected the write, when the driver reports it. */
export function duplicateKeyIndex(err: unknown): string | null {
  const message = err instanceof Error ? err.message : '';
  return /index: (\S+)/.exec(message)?.[1] ?? null;
}
