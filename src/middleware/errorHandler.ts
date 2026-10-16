import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError, notFound, type ErrorCode } from '../shared/errors.ts';
import type { Logger } from '../shared/logger.ts';

type HttpishError = { status?: unknown; statusCode?: unknown; type?: unknown };

function statusOf(err: unknown): number | undefined {
  const e = err as HttpishError;
  const raw = typeof e?.status === 'number' ? e.status : typeof e?.statusCode === 'number' ? e.statusCode : undefined;
  return raw;
}

export function notFoundHandler(): RequestHandler {
  return (_req, _res, next) => next(notFound());
}

/**
 * Emits exactly: { error: { code, message, fieldErrors, requestId, details } }
 * Unknown errors become a generic 500 — no message, stack, or internal detail leaks.
 */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    const requestId = req.requestId ?? 'unknown';

    if (err instanceof AppError) {
      const fields = { requestId, code: err.code, status: err.status };
      if (err.status >= 500) logger.error('request failed', { ...fields, err });
      else logger.warn('request rejected', fields);
      res.status(err.status).json({
        error: {
          code: err.code,
          message: err.expose ? err.message : 'Internal server error',
          fieldErrors: err.fieldErrors,
          requestId,
          details: err.expose ? err.details : {},
        },
      });
      return;
    }

    const status = statusOf(err) ?? 500;
    const code: ErrorCode =
      status === 413 ? 'PAYLOAD_TOO_LARGE' : status === 400 ? 'VALIDATION_ERROR' : 'INTERNAL';
    logger.error('unhandled error', { requestId, code, err });
    res.status(status).json({
      error: {
        code,
        message: status >= 500 ? 'Internal server error' : 'Invalid request',
        fieldErrors: {},
        requestId,
        details: {},
      },
    });
  };
}
