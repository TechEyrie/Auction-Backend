import type { Request, RequestHandler } from 'express';
import type { Db } from 'mongodb';
import type { AppConfig } from '../../config/index.ts';
import { AppError } from '../../shared/errors.ts';
import { safeEqualHex, sha256Hex } from '../../shared/crypto.ts';
import { CSRF_COOKIE, SESSION_COOKIE, readCookie } from './cookies.ts';
import * as repo from './repository.ts';
import type { AuthContext } from './models.ts';
import { capabilitiesFor, type Capability } from './roles.ts';
import { requiresMfa } from './service.ts';

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export function clientIp(req: Request): string | null {
  return req.ip ?? null;
}

/**
 * Resolve the session cookie into `req.auth`. Never rejects: routes decide.
 * Expiry and revocation are checked here on every request — the TTL index is
 * only cleanup, never authorization. Mounted globally in `app.ts` for all routes.
 */
export function resolveAuth(db: Db): RequestHandler {
  return async (req, _res, next) => {
    try {
      const token = readCookie(req, SESSION_COOKIE);
      if (!token) return next();
      const session = await repo.findSessionByTokenHash(db, sha256Hex(token));
      if (!session || session.revokedAt) return next();

      const now = Date.now();
      if (session.idleExpiresAt.getTime() <= now) {
        await repo.revokeSession(db, session._id, 'idle_timeout');
        return next();
      }
      if (session.absoluteExpiresAt.getTime() <= now) {
        await repo.revokeSession(db, session._id, 'absolute_timeout');
        return next();
      }

      const user = await repo.findUserById(db, session.userId);
      if (!user) {
        await repo.revokeSession(db, session._id, 'user_missing');
        return next();
      }

      const idleExpiresAt = new Date(now + 60 * 60_000);
      await repo.touchSession(db, session._id, idleExpiresAt);
      session.lastUsedAt = new Date(now);
      session.idleExpiresAt = idleExpiresAt;

      req.auth = { user, session };
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * CSRF protection for state-changing methods. CORS alone is NOT CSRF protection.
 * Requires a double-submit token (header must equal the cookie) and, when a
 * session exists, a token bound to that session. Also rejects a disallowed Origin.
 */
export function csrfProtection(config: AppConfig): RequestHandler {
  const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
  return (req, _res, next) => {
    if (safeMethods.has(req.method)) return next();
    if (req.path.startsWith('/api/payments/webhooks/')) return next();

    const origin = req.header('origin');
    if (origin && !config.corsOrigins.includes(origin)) {
      return next(new AppError('FORBIDDEN', 'Request origin is not allowed'));
    }

    const header = req.header('x-csrf-token');
    const cookie = readCookie(req, CSRF_COOKIE);
    if (!header || !cookie || header !== cookie) {
      return next(new AppError('FORBIDDEN', 'Missing or invalid CSRF token'));
    }
    if (req.auth && !safeEqualHex(sha256Hex(header), req.auth.session.csrfHash)) {
      return next(new AppError('FORBIDDEN', 'CSRF token is not bound to this session'));
    }
    next();
  };
}

/** @alias resolveAuth */
export const optionalAuth = resolveAuth;

export function requireAuth(_db?: Db): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) return next(new AppError('UNAUTHORIZED', 'Authentication required'));
    next();
  };
}

/** Suspended or disabled accounts lose all protected capabilities. */
export function requireActiveUser(): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) return next(new AppError('UNAUTHORIZED', 'Authentication required'));
    if (req.auth.user.status !== 'active') {
      return next(new AppError('FORBIDDEN', 'This account is not active'));
    }
    next();
  };
}

/** A pre-MFA session must not authorize privileged APIs. */
export function requireMfa(): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) return next(new AppError('UNAUTHORIZED', 'Authentication required'));
    // Customer-only until staff MFA is re-enabled.
    if (requiresMfa(req.auth.user) && !req.auth.session.mfaSatisfied) {
      return next(new AppError('FORBIDDEN', 'MFA verification required', { details: { code: 'MFA_REQUIRED' } }));
    }
    next();
  };
}

/** Capability check: authentication + active + MFA + the required capability. */
export function requireCapability(capability: Capability): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) return next(new AppError('UNAUTHORIZED', 'Authentication required'));
    if (req.auth.user.status !== 'active') return next(new AppError('FORBIDDEN', 'This account is not active'));
    if (requiresMfa(req.auth.user) && !req.auth.session.mfaSatisfied) {
      return next(new AppError('FORBIDDEN', 'MFA verification required', { details: { code: 'MFA_REQUIRED' } }));
    }
    if (!capabilitiesFor(req.auth.user.roles).has(capability)) {
      return next(new AppError('FORBIDDEN', 'You do not have permission to do that'));
    }
    next();
  };
}

/**
 * Object ownership. Staff holding `super_admin` capabilities are exempt; everyone
 * else may only touch resources they own.
 */
export function requireOwnership(getOwnerId: (req: Request) => string | null): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) return next(new AppError('UNAUTHORIZED', 'Authentication required'));
    if (req.auth.user.status !== 'active') return next(new AppError('FORBIDDEN', 'This account is not active'));
    const ownerId = getOwnerId(req);
    if (ownerId && ownerId === req.auth.user.publicReference) return next();
    if (capabilitiesFor(req.auth.user.roles).has('users.manage')) return next();
    return next(new AppError('FORBIDDEN', 'You cannot access this resource'));
  };
}
