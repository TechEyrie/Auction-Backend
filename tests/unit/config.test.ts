import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigurationError, loadConfig, resolveCookieSameSite } from '../../src/config/index.ts';
import { randomBytes } from 'node:crypto';

test('missing required configuration fails with a clear aggregated message', () => {
  assert.throws(
    () => loadConfig({}),
    (err: unknown) => {
      assert.ok(err instanceof ConfigurationError);
      assert.match(err.message, /MONGODB_URI/);
      assert.ok(err.issues.some((i) => i.startsWith('MONGODB_URI')));
      return true;
    },
  );
});

test('valid configuration is parsed into typed values', () => {
  const config = loadConfig({
    NODE_ENV: 'development',
    PORT: '4100',
    MONGODB_URI: 'mongodb://localhost:27017',
    MONGODB_DB: 'app',
    CORS_ORIGINS: 'http://localhost:3000, https://example.com',
    TRUST_PROXY: '2',
  });
  assert.equal(config.port, 4100);
  assert.equal(config.isProduction, false);
  assert.deepEqual(config.corsOrigins, ['http://localhost:3000', 'https://example.com']);
  assert.equal(config.trustProxy, 2);
  assert.equal(config.mongodbDb, 'app');
});

test('wildcard CORS origin is rejected', () => {
  assert.throws(
    () => loadConfig({ MONGODB_URI: 'mongodb://localhost:27017', CORS_ORIGINS: '*' }),
    (err: unknown) => err instanceof ConfigurationError && /wildcard/.test(err.message),
  );
});

test('production requires MongoDB and explicit origins', () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: 'production', CORS_ORIGINS: '' }),
    (err: unknown) => err instanceof ConfigurationError,
  );
});

test('resolveCookieSameSite: Lax for local http; None when Secure + https CORS', () => {
  assert.equal(
    resolveCookieSameSite({ cookieSecure: false, corsOrigins: ['http://localhost:3000'] }),
    'Lax',
  );
  assert.equal(
    resolveCookieSameSite({
      cookieSecure: true,
      corsOrigins: ['http://localhost:3000'],
    }),
    'Lax',
  );
  assert.equal(
    resolveCookieSameSite({
      cookieSecure: true,
      corsOrigins: ['https://app.vercel.app'],
    }),
    'None',
  );
  assert.equal(
    resolveCookieSameSite({
      explicit: 'lax',
      cookieSecure: true,
      corsOrigins: ['https://app.vercel.app'],
    }),
    'Lax',
  );
});

test('production with https CORS auto-selects SameSite=None and Partitioned', () => {
  const config = loadConfig({
    NODE_ENV: 'production',
    MONGODB_URI: 'mongodb://localhost:27017',
    CORS_ORIGINS: 'https://techeyrie.vercel.app',
    MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    PAYMENT_PROVIDER: 'approved-sandbox',
    ADMIN_BOOTSTRAP_TOKEN: 'production-bootstrap-token',
  });
  assert.equal(config.cookieSecure, true);
  assert.equal(config.cookieSameSite, 'None');
  assert.equal(config.cookiePartitioned, true);
});

test('MEDIA_DRIVER=imagekit requires ImageKit credentials', () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: 'development',
        MONGODB_URI: 'mongodb://localhost:27017',
        MEDIA_DRIVER: 'imagekit',
      }),
    (err: unknown) =>
      err instanceof ConfigurationError &&
      err.issues.some((issue) => issue.includes('IMAGEKIT_URL_ENDPOINT')) &&
      err.issues.some((issue) => issue.includes('IMAGEKIT_PUBLIC_KEY')) &&
      err.issues.some((issue) => issue.includes('IMAGEKIT_PRIVATE_KEY')),
  );
});

test('COOKIE_SAME_SITE=none without Secure is rejected', () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: 'development',
        MONGODB_URI: 'mongodb://localhost:27017',
        COOKIE_SECURE: 'false',
        COOKIE_SAME_SITE: 'none',
      }),
    (err: unknown) => err instanceof ConfigurationError && /COOKIE_SAME_SITE=none requires/.test(err.message),
  );
});
