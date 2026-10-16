/**
 * Return only an internal, absolute path. Rejects schemes, protocol-relative
 * URLs (`//evil`), backslash tricks, control characters, and anything that is
 * not a plain path. Falls back to `fallback` (default `/`).
 */
export function safeInternalPath(value: unknown, fallback = '/'): string {
  if (typeof value !== 'string') return fallback;
  const candidate = value.trim();
  if (candidate.length === 0 || candidate.length > 512) return fallback;
  if (!candidate.startsWith('/')) return fallback;
  if (candidate.startsWith('//') || candidate.startsWith('/\\')) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(candidate)) return fallback;
  if (candidate.includes('\\')) return fallback;
  if (/^\/[a-z][a-z0-9+.-]*:/i.test(candidate)) return fallback;
  return candidate;
}
