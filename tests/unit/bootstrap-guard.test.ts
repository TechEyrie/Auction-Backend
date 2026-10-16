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

test('production rejects the manual payment placeholder', () => {
  assert.throws(
    () => loadConfig({ ...PRODUCTION_BASE, PAYMENT_PROVIDER: 'manual' }),
    (err: unknown) => err instanceof ConfigurationError && /PAYMENT_PROVIDER/.test(err.message),
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
