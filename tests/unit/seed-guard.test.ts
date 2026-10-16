import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSeedTarget, UnsafeSeedTargetError } from '../../scripts/seed.ts';

test('seed refuses production', () => {
  assert.throws(
    () => assertSeedTarget({ NODE_ENV: 'production', MONGODB_DB: 'app' }, ['--target=development']),
    UnsafeSeedTargetError,
  );
});

test('seed requires an explicit allow-listed target', () => {
  assert.throws(() => assertSeedTarget({ NODE_ENV: 'development' }, []), UnsafeSeedTargetError);
  assert.throws(
    () => assertSeedTarget({ NODE_ENV: 'development' }, ['--target=staging']),
    UnsafeSeedTargetError,
  );
});

test('seed refuses an obviously production database name', () => {
  assert.throws(
    () => assertSeedTarget({ NODE_ENV: 'development', MONGODB_DB: 'app_production' }, ['--target=development']),
    UnsafeSeedTargetError,
  );
});

test('seed allows explicit development and test targets', () => {
  assert.doesNotThrow(() => assertSeedTarget({ NODE_ENV: 'development', MONGODB_DB: 'app_dev' }, ['--target=development']));
  assert.doesNotThrow(() => assertSeedTarget({ NODE_ENV: 'test', MONGODB_DB: 'app_test' }, ['--target=test']));
});
