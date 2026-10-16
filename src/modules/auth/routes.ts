import { Router, type RequestHandler } from 'express';
import type { Db } from 'mongodb';
import { z } from 'zod';
import type { AppConfig } from '../../config/index.ts';
import type { Logger } from '../../shared/logger.ts';
import { AppError } from '../../shared/errors.ts';
import { consumeRateLimit } from '../../shared/rateLimit.ts';
import { parseInput } from '../../shared/validate.ts';
import { randomToken } from '../../shared/crypto.ts';
import { safeInternalPath } from '../../shared/returnUrl.ts';
import { clearSessionCookie, CSRF_COOKIE, readCookie, setCsrfCookie, setSessionCookie } from './cookies.ts';
import { clientIp, requireActiveUser, requireAuth } from './middleware.ts';
import { createAuthService } from './service.ts';

export type AuthRouterDeps = { db: Db; config: AppConfig; logger: Logger };

export function authRouter(deps: AuthRouterDeps): Router {
  const router = Router();
  const { db, config } = deps;
  const service = createAuthService(deps);

  const limit = (scope: string): RequestHandler => {
    return async (req, res, next) => {
      try {
        const ip = clientIp(req) ?? 'unknown';
        const result = await consumeRateLimit(db, {
          key: `${scope}:${ip}`,
          windowMs: config.rateLimitWindowMs,
          max: config.rateLimitMaxAttempts,
        });
        if (!result.allowed) {
          res.setHeader('Retry-After', String(result.retryAfterSeconds));
          throw new AppError('RATE_LIMITED', 'Too many attempts — please try again shortly');
        }
        next();
      } catch (err) {
        next(err);
      }
    };
  };

  const requireMfaKey = (): string => {
    if (!config.mfaEncryptionKey) {
      throw new AppError('SERVICE_UNAVAILABLE', 'MFA is not configured on this server');
    }
    return config.mfaEncryptionKey;
  };

  router.get('/session', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    let csrf = readCookie(req, CSRF_COOKIE);
    if (!csrf) {
      csrf = randomToken(24);
      setCsrfCookie(res, config, csrf);
    }
    if (!req.auth) {
      res.json({ user: null, mfaRequired: false, mfaEnabled: false, capabilities: [], csrfToken: csrf });
      return;
    }
    res.json({ ...service.sessionView(req.auth.user, req.auth.session), csrfToken: csrf });
  });

  const registerSchema = z.object({
    fullName: z.string().min(2).max(120),
    phone: z.string().min(4).optional().nullable(),
    email: z.string().optional().nullable(),
    password: z.string().min(8).max(200),
    preferredLocale: z.string().max(8).optional(),
    termsAccepted: z.boolean(),
    termsVersion: z.string().max(40).optional().nullable(),
    returnTo: z.string().optional(),
  });

  router.post('/register', limit('register'), async (req, res, next) => {
    try {
      const body = parseInput(registerSchema, req.body);
      const result = await service.register(body, { ip: clientIp(req), userAgent: req.header('user-agent') ?? null });
      setSessionCookie(res, config, result.session.token, result.session.cookieMaxAgeMs);
      setCsrfCookie(res, config, result.session.csrfToken);
      res.status(201).json({ user: result.user, returnTo: safeInternalPath(body.returnTo) });
    } catch (err) {
      next(err);
    }
  });

  const loginSchema = z.object({
    identifier: z.string().min(4),
    password: z.string().min(1),
    keepSignedIn: z.boolean().optional(),
    returnTo: z.string().optional(),
  });

  router.post('/login', limit('login'), async (req, res, next) => {
    try {
      const body = parseInput(loginSchema, req.body);
      const result = await service.login(body, { ip: clientIp(req), userAgent: req.header('user-agent') ?? null });
      setSessionCookie(res, config, result.session.token, result.session.cookieMaxAgeMs);
      setCsrfCookie(res, config, result.session.csrfToken);
      res.json({
        user: result.user,
        mfaRequired: result.mfaRequired,
        returnTo: safeInternalPath(body.returnTo),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', async (req, res, next) => {
    try {
      await service.logout(req.auth ?? null);
      clearSessionCookie(res, config);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  const forgotSchema = z.object({ identifier: z.string().min(4), returnTo: z.string().optional() });

  router.post('/password/forgot', limit('forgot'), async (req, res, next) => {
    try {
      const body = parseInput(forgotSchema, req.body);
      const token = await service.forgotPassword(body.identifier, clientIp(req));
      // Generic response; the token is only surfaced by the isolated dev adapter.
      res.json({
        ok: true,
        returnTo: safeInternalPath(body.returnTo),
        ...(token && !config.isProduction ? { devResetToken: token } : {}),
      });
    } catch (err) {
      next(err);
    }
  });

  const resetSchema = z.object({ token: z.string().min(10), password: z.string().min(8).max(200) });

  router.post('/password/reset', limit('reset'), async (req, res, next) => {
    try {
      const body = parseInput(resetSchema, req.body);
      await service.resetPassword(body.token, body.password);
      clearSessionCookie(res, config);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post('/mfa/enroll', requireAuth(), requireActiveUser(), async (req, res, next) => {
    try {
      const key = requireMfaKey();
      const body = parseInput(z.object({ currentPassword: z.string().min(1) }), req.body);
      const result = await service.startMfaEnrollment(req.auth!.user, body.currentPassword, key);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post('/mfa/enroll/confirm', requireAuth(), requireActiveUser(), async (req, res, next) => {
    try {
      const key = requireMfaKey();
      const body = parseInput(z.object({ code: z.string().min(6).max(6) }), req.body);
      const result = await service.confirmMfaEnrollment(req.auth!.user, req.auth!.session, body.code, key);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post('/mfa/challenge', requireAuth(), async (req, res, next) => {
    try {
      const key = requireMfaKey();
      const body = parseInput(z.object({ code: z.string().min(6).max(6) }), req.body);
      const rotated = await service.mfaChallenge(req.auth!.user, req.auth!.session, body.code, key);
      setSessionCookie(res, config, rotated.token);
      setCsrfCookie(res, config, rotated.csrfToken);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post('/mfa/recovery', requireAuth(), async (req, res, next) => {
    try {
      const body = parseInput(z.object({ code: z.string().min(4) }), req.body);
      const rotated = await service.mfaRecover(req.auth!.user, req.auth!.session, body.code);
      setSessionCookie(res, config, rotated.token);
      setCsrfCookie(res, config, rotated.csrfToken);
      res.json({ ok: true, remainingRecoveryCodes: rotated.remainingRecoveryCodes });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
