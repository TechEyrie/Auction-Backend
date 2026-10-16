import type { ZodType } from 'zod';
import { validationError } from './errors.ts';

export function toFieldErrors(issues: readonly { path: PropertyKey[]; message: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.map((p) => String(p)).join('.') || '_';
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

/** Parse external input; on failure throw a 422 with per-field errors. Never trust raw input. */
export function parseInput<T>(schema: ZodType<T>, input: unknown, message = 'Validation failed'): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw validationError(toFieldErrors(result.error.issues), message);
  }
  return result.data;
}
