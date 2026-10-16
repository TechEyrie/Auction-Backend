import type { Request, Response } from 'express';
import type { AppConfig } from '../../config/index.ts';

export const SESSION_COOKIE = 'sid';
export const CSRF_COOKIE = 'csrf';

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      out[name] = part.slice(idx + 1).trim();
    }
  }
  return out;
}

export function readCookie(req: Request, name: string): string | undefined {
  return parseCookies(req.header('cookie'))[name];
}

type CookieOptions = {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Lax' | 'Strict' | 'None';
  path: string;
  maxAgeMs?: number;
  domain?: string | undefined;
  partitioned?: boolean;
};

function serialize(name: string, value: string, opts: CookieOptions): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path}`, `SameSite=${opts.sameSite}`];
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  if (opts.maxAgeMs !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAgeMs / 1000)}`);
  // CHIPS: required for Chrome to keep third-party cookies when frontend and API are different sites.
  if (opts.partitioned) parts.push('Partitioned');
  return parts.join('; ');
}

function baseOptions(config: AppConfig): Omit<CookieOptions, 'httpOnly' | 'maxAgeMs'> {
  return {
    secure: config.cookieSecure,
    sameSite: config.cookieSameSite,
    path: '/',
    domain: config.cookieDomain,
    partitioned: config.cookiePartitioned,
  };
}

/**
 * Session cookie: HttpOnly, Secure in production, SameSite from config, path-scoped to /.
 * A `maxAgeMs` is only set for explicit keep-me-signed-in; otherwise it is a
 * browser-session cookie with a shorter server-side absolute expiry.
 *
 * Cross-origin deploys (Vercel → API host) must use SameSite=None; Secure so the
 * browser sends `sid` on credentialed fetch. Same-site deploys keep Lax.
 */
export function setSessionCookie(res: Response, config: AppConfig, token: string, maxAgeMs?: number): void {
  res.append(
    'Set-Cookie',
    serialize(SESSION_COOKIE, token, { ...baseOptions(config), httpOnly: true, ...(maxAgeMs !== undefined ? { maxAgeMs } : {}) }),
  );
}

export function clearSessionCookie(res: Response, config: AppConfig): void {
  res.append(
    'Set-Cookie',
    serialize(SESSION_COOKIE, '', { ...baseOptions(config), httpOnly: true, maxAgeMs: 0 }),
  );
}

/** CSRF cookie is readable by the browser so the client can echo it in a header. */
export function setCsrfCookie(res: Response, config: AppConfig, token: string): void {
  res.append(
    'Set-Cookie',
    serialize(CSRF_COOKIE, token, { ...baseOptions(config), httpOnly: false, maxAgeMs: config.keepSignedInMs }),
  );
}
