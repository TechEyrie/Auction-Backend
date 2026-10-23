/** Redact OTP codes and long tokens before persisting mail body previews. */
export function redactMailBodyPreview(text: string): string {
  let out = text;
  out = out.replace(/\b\d{6}\b/g, '[redacted]');
  out = out.replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[redacted]');
  return out.slice(0, 500);
}
