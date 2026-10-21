import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigurationError, loadConfig } from '../../src/config/index.ts';
import { MIN_BOOTSTRAP_TOKEN_LENGTH } from '../../src/config/bootstrapToken.ts';

const PRODUCTION_BASE = {
  NODE_ENV: 'production',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/?replicaSet=rs0',
  CORS_ORIGINS: 'https://example.com',
  MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  PAYMENT_PROVIDER: 'approved-sandbox',
};

test('production allows manual or missing PAYMENT_PROVIDER', () => {
  assert.doesNotThrow(() => loadConfig({ ...PRODUCTION_BASE, PAYMENT_PROVIDER: 'manual' }));
  const { PAYMENT_PROVIDER: _omit, ...withoutProvider } = PRODUCTION_BASE;
  assert.doesNotThrow(() => loadConfig(withoutProvider));
});

test('production still requires MongoDB and MFA when PAYMENT_PROVIDER is manual', () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://example.com',
        PAYMENT_PROVIDER: 'manual',
      }),
    (err: unknown) =>
      err instanceof ConfigurationError && err.issues.some((i) => i.includes('MONGODB_URI')),
  );

  const { MFA_ENCRYPTION_KEY: _omit, ...withoutMfa } = PRODUCTION_BASE;
  assert.throws(
    () => loadConfig({ ...withoutMfa, PAYMENT_PROVIDER: 'manual' }),
    (err: unknown) =>
      err instanceof ConfigurationError && err.issues.some((i) => i.startsWith('MFA_ENCRYPTION_KEY')),
  );
});

test('production starts without a bootstrap token while ADMIN_BOOTSTRAP is paused', () => {
  const config = loadConfig(PRODUCTION_BASE);
  assert.equal(config.adminBootstrapToken, null);
});

test('a weak bootstrap token is rejected at configuration time', () => {
  assert.throws(
    () => loadConfig({ ...PRODUCTION_BASE, ADMIN_BOOTSTRAP_TOKEN: 'short' }),
    (err: unknown) =>
      err instanceof ConfigurationError && err.issues.some((i) => i.startsWith('ADMIN_BOOTSTRAP_TOKEN')),
  );

  const config = loadConfig({ ...PRODUCTION_BASE, ADMIN_BOOTSTRAP_TOKEN: 'a-deployment-token-value' });
  assert.equal(config.adminBootstrapToken, 'a-deployment-token-value');
  assert.ok(config.adminBootstrapToken.length >= MIN_BOOTSTRAP_TOKEN_LENGTH);
});
