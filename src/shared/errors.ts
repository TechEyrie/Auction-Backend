export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'INTERNAL'
  | 'SERVICE_UNAVAILABLE'
  | 'CONFIGURATION_ERROR';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 422,
  NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  SERVICE_UNAVAILABLE: 503,
  CONFIGURATION_ERROR: 500,
};

export type AppErrorOptions = {
  fieldErrors?: Record<string, string>;
  details?: Record<string, unknown>;
  cause?: unknown;
  /** Force a message to be returned to the client (default: only for < 500). */
  expose?: boolean;
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly fieldErrors: Record<string, string>;
  readonly details: Record<string, unknown>;
  readonly expose: boolean;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.fieldErrors = options.fieldErrors ?? {};
    this.details = options.details ?? {};
    this.expose = options.expose ?? this.status < 500;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export function notFound(message = 'Resource not found'): AppError {
  return new AppError('NOT_FOUND', message);
}

export function validationError(fieldErrors: Record<string, string>, message = 'Validation failed'): AppError {
  return new AppError('VALIDATION_ERROR', message, { fieldErrors });
}

export function conflict(message: string, details?: Record<string, unknown>): AppError {
  return new AppError('CONFLICT', message, { details });
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
