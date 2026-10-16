import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigurationError, loadConfig } from '../../src/config/index.ts';

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
