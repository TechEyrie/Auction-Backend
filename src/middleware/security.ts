import type { RequestHandler } from 'express';

/** Conservative default security headers; do not advertise the framework. */
export function securityHeaders(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    next();
  };
}

/**
 * Explicit-origin CORS. Never emits a wildcard, so credentialed requests stay safe.
 * Disallowed origins simply receive no CORS headers.
 */
export function cors(allowedOrigins: readonly string[]): RequestHandler {
  const allow = new Set(allowedOrigins);
  return (req, res, next) => {
    const origin = req.header('origin');
    if (origin && allow.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
      // Must list every request header the browser sends, or the preflight fails and the
      // real request never happens. `x-csrf-token` is required on all mutations, and
      // `x-collection-key` carries the media upload target.
      res.setHeader(
        'Access-Control-Allow-Headers',
        'content-type,x-csrf-token,x-request-id,idempotency-key,x-collection-key',
      );
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}
