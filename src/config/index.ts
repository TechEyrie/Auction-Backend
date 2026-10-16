import { z } from 'zod';
import { MIN_BOOTSTRAP_TOKEN_LENGTH } from './bootstrapToken.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type AppConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  isTest: boolean;
  port: number;
  mongodbUri: string;
  mongodbDb: string;
  logLevel: LogLevel;
  corsOrigins: string[];
  trustProxy: boolean | number;
  bodyLimit: string;
  shutdownTimeoutMs: number;
  idempotencyTtlHours: number;
  // Auth / sessions
  sessionIdleMs: number;
  sessionAbsoluteMs: number;
  keepSignedInMs: number;
  cookieSecure: boolean;
  cookieDomain: string | undefined;
  /**
   * Cookie SameSite. `None` is required when the browser origin and API host are
   * different sites (e.g. Vercel frontend → Render API); `Lax` is correct for
   * same-site deploys and local http.
   */
  cookieSameSite: 'Lax' | 'None' | 'Strict';
  /** CHIPS: set with SameSite=None so Chrome still stores the third-party cookie. */
  cookiePartitioned: boolean;
  /** Base64 32-byte key for encrypting MFA secrets at rest. Null = MFA disabled. */
  mfaEncryptionKey: string | null;
  /** One-time token required to bootstrap the first super admin. Null = bootstrap disabled. */
  adminBootstrapToken: string | null;
  /** Published legal-document version. Null means no approved version exists yet (never invent one). */
  legalTermsVersion: string | null;
  rateLimitWindowMs: number;
  rateLimitMaxAttempts: number;
  mediaMaxBytes: number;
  mediaMaxFilesPerCollection: number;
  mediaMaxDimension: number;
  mediaStorageRoot: string;
  mediaAllowLocalFilesystem: boolean;
  paymentProvider: string | null;
  paymentWebhookSecret: string | null;
};

export class ConfigurationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'ConfigurationError';
    this.issues = issues;
  }
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(4000),
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required (transaction-capable MongoDB connection string)'),
  MONGODB_DB: z.string().min(1).default('araq_kahraman'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  TRUST_PROXY: z.string().default('false'),
  BODY_LIMIT: z.string().min(1).default('1mb'),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().positive().default(24),

  SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(60),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().positive().default(12),
  SESSION_KEEP_SIGNED_IN_DAYS: z.coerce.number().int().positive().default(30),
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  COOKIE_DOMAIN: z.string().optional(),
  /** lax | none | strict. Unset = auto (see resolveCookieSameSite). */
  COOKIE_SAME_SITE: z.enum(['lax', 'none', 'strict', 'Lax', 'None', 'Strict']).optional(),
  /** Override Partitioned; default true when SameSite=None. */
  COOKIE_PARTITIONED: z.enum(['true', 'false']).optional(),
  MFA_ENCRYPTION_KEY: z.string().optional(),
  ADMIN_BOOTSTRAP_TOKEN: z.string().optional(),
  PAYMENT_PROVIDER: z.string().optional(),
  PAYMENT_WEBHOOK_SECRET: z.string().optional(),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  LEGAL_TERMS_VERSION: z.string().optional(),

  /**
   * Media limits are explicit development defaults. The design sources disagree on the
   * attachment count (screenshots 15, frontend reference 10), so the value stays
   * configurable and production approval is tracked in OPEN_QUESTIONS.
   */
  MEDIA_MAX_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
  MEDIA_MAX_FILES_PER_COLLECTION: z.coerce.number().int().positive().max(50).default(10),
  MEDIA_MAX_DIMENSION: z.coerce.number().int().positive().default(6000),
  MEDIA_STORAGE_ROOT: z.string().min(1).default('var/media'),
  /** Explicit opt-in; without it the filesystem adapter refuses to run in production. */
  MEDIA_ALLOW_LOCAL_FILESYSTEM: z.enum(['true', 'false']).optional(),
});

function parseTrustProxy(raw: string): boolean | number {
  const v = raw.trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false' || v === '') return false;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? false : n;
}

/**
 * Cross-site SPA+API (HTTPS frontend origin, API on another host) cannot send
 * SameSite=Lax cookies on credentialed fetch — register/login then fail CSRF
 * double-submit. Default to None when Secure cookies are on and any allowed
 * origin is https. Same-site production should set COOKIE_SAME_SITE=lax.
 */
export function resolveCookieSameSite(input: {
  explicit?: string | undefined;
  cookieSecure: boolean;
  corsOrigins: readonly string[];
}): 'Lax' | 'None' | 'Strict' {
  const raw = input.explicit?.trim().toLowerCase();
  if (raw === 'lax') return 'Lax';
  if (raw === 'none') return 'None';
  if (raw === 'strict') return 'Strict';
  if (input.cookieSecure && input.corsOrigins.some((o) => o.startsWith('https://'))) {
    return 'None';
  }
  return 'Lax';
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  const issues: string[] = [];
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push(`${issue.path.join('.') || 'env'}: ${issue.message}`);
    }
  }

  const data = parsed.success ? parsed.data : undefined;
  const nodeEnv = data?.NODE_ENV ?? 'development';
  const corsOrigins = (data?.CORS_ORIGINS ?? env.CORS_ORIGINS ?? 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (corsOrigins.includes('*')) {
    issues.push('CORS_ORIGINS: wildcard "*" is not allowed (credentialed CORS must use explicit origins)');
  }
  if (corsOrigins.length === 0) {
    issues.push('CORS_ORIGINS: at least one explicit origin is required');
  }
    if (nodeEnv === 'production') {
    if (!(data?.MONGODB_URI ?? '').trim()) issues.push('MONGODB_URI: required in production');
    if (!(data?.MFA_ENCRYPTION_KEY ?? '').trim()) {
      issues.push('MFA_ENCRYPTION_KEY: required in production (privileged access requires MFA)');
    }
    const provider = (data?.PAYMENT_PROVIDER ?? '').trim();
    if (!provider || provider === 'manual' || provider === 'manual_placeholder') {
      issues.push('PAYMENT_PROVIDER: production rejects the manual placeholder. Set an approved gateway.');
    }
  }

  const bootstrapToken = (data?.ADMIN_BOOTSTRAP_TOKEN ?? '').trim();
  if (bootstrapToken && bootstrapToken.length < MIN_BOOTSTRAP_TOKEN_LENGTH) {
    issues.push(`ADMIN_BOOTSTRAP_TOKEN: must be at least ${MIN_BOOTSTRAP_TOKEN_LENGTH} characters`);
  }

  const mfaKey = (data?.MFA_ENCRYPTION_KEY ?? '').trim();
  if (mfaKey && Buffer.from(mfaKey, 'base64').length !== 32) {
    issues.push('MFA_ENCRYPTION_KEY: must be 32 bytes, base64-encoded');
  }

  const cookieSecure = data?.COOKIE_SECURE
    ? data.COOKIE_SECURE === 'true'
    : nodeEnv === 'production';
  const cookieSameSite = resolveCookieSameSite({
    explicit: data?.COOKIE_SAME_SITE,
    cookieSecure,
    corsOrigins,
  });
  if (cookieSameSite === 'None' && !cookieSecure) {
    issues.push('COOKIE_SAME_SITE=none requires COOKIE_SECURE=true (browsers reject SameSite=None without Secure)');
  }
  const cookiePartitioned =
    data?.COOKIE_PARTITIONED !== undefined
      ? data.COOKIE_PARTITIONED === 'true'
      : cookieSameSite === 'None';
  if (cookiePartitioned && !cookieSecure) {
    issues.push('COOKIE_PARTITIONED=true requires COOKIE_SECURE=true');
  }

  if (!data || issues.length > 0) {
    throw new ConfigurationError(issues.length > 0 ? issues : ['unknown configuration error']);
  }

  return {
    nodeEnv,
    isProduction: nodeEnv === 'production',
    isTest: nodeEnv === 'test',
    port: data.PORT,
    mongodbUri: data.MONGODB_URI,
    mongodbDb: data.MONGODB_DB,
    logLevel: data.LOG_LEVEL,
    corsOrigins,
    trustProxy: parseTrustProxy(data.TRUST_PROXY),
    bodyLimit: data.BODY_LIMIT,
    shutdownTimeoutMs: data.SHUTDOWN_TIMEOUT_MS,
    idempotencyTtlHours: data.IDEMPOTENCY_TTL_HOURS,
    sessionIdleMs: data.SESSION_IDLE_MINUTES * 60_000,
    sessionAbsoluteMs: data.SESSION_ABSOLUTE_HOURS * 3_600_000,
    keepSignedInMs: data.SESSION_KEEP_SIGNED_IN_DAYS * 86_400_000,
    cookieSecure,
    cookieDomain: data.COOKIE_DOMAIN?.trim() || undefined,
    cookieSameSite,
    cookiePartitioned,
    mfaEncryptionKey: mfaKey || null,
    adminBootstrapToken: (data.ADMIN_BOOTSTRAP_TOKEN ?? '').trim() || null,
    legalTermsVersion: (data.LEGAL_TERMS_VERSION ?? '').trim() || null,
    rateLimitWindowMs: data.RATE_LIMIT_WINDOW_SECONDS * 1000,
    rateLimitMaxAttempts: data.RATE_LIMIT_MAX_ATTEMPTS,
    mediaMaxBytes: data.MEDIA_MAX_BYTES,
    mediaMaxFilesPerCollection: data.MEDIA_MAX_FILES_PER_COLLECTION,
    mediaMaxDimension: data.MEDIA_MAX_DIMENSION,
    mediaStorageRoot: data.MEDIA_STORAGE_ROOT,
    mediaAllowLocalFilesystem: data.MEDIA_ALLOW_LOCAL_FILESYSTEM === 'true',
    paymentProvider: (data.PAYMENT_PROVIDER ?? '').trim() || null,
    paymentWebhookSecret: (data.PAYMENT_WEBHOOK_SECRET ?? '').trim() || null,
  };
}
