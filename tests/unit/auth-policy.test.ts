import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITIES, capabilitiesFor, isStaff, ROLE_CAPABILITIES, ROLES } from '../../src/modules/auth/roles.ts';
import { safeInternalPath } from '../../src/shared/returnUrl.ts';
import { normalizeEmail, normalizePhoneE164 } from '../../src/shared/normalize.ts';
import { AppError } from '../../src/shared/errors.ts';
import { readBootstrapEnv } from '../../scripts/bootstrap-admin.ts';

test('capability matrix grants capabilities by role, never by isAdmin alone', () => {
  assert.deepEqual([...capabilitiesFor(['customer'])], []);
  assert.equal(ROLE_CAPABILITIES.auction_manager.includes('inventory.manage'), true);
  assert.equal(ROLE_CAPABILITIES.finance_manager.includes('settlements.manage'), true);
  assert.equal(ROLE_CAPABILITIES.support_content_manager.includes('users.manage'), true);
  assert.equal(capabilitiesFor(['auction_manager']).size, CAPABILITIES.length);
  assert.equal(capabilitiesFor(['super_admin']).size, CAPABILITIES.length);
  assert.equal(capabilitiesFor(['auction_manager', 'finance_manager']).has('settlements.manage'), true);
  for (const role of ROLES) {
    for (const cap of ROLE_CAPABILITIES[role]) assert.equal(capabilitiesFor([role]).has(cap), true);
  }
  assert.equal(isStaff(['customer']), false);
  assert.equal(isStaff(['customer', 'finance_manager']), true);
});

test('safeInternalPath blocks open redirects', () => {
  assert.equal(safeInternalPath('/admin'), '/admin');
  assert.equal(safeInternalPath('https://evil.example'), '/');
  assert.equal(safeInternalPath('//evil.example'), '/');
  assert.equal(safeInternalPath('/\\evil'), '/');
  assert.equal(safeInternalPath('javascript:alert(1)'), '/');
  assert.equal(safeInternalPath('/ok?a=1'), '/ok?a=1');
  assert.equal(safeInternalPath(42), '/');
});

test('identifier normalization is consistent and strict', () => {
  assert.equal(normalizePhoneE164('+97455551234'), '+97455551234');
  assert.equal(normalizePhoneE164('5555 1234'), '+97455551234');
  assert.equal(normalizePhoneE164('97455551234'), '+97455551234');
  assert.throws(() => normalizePhoneE164('123'), AppError);
  assert.equal(normalizeEmail('  A@Example.COM '), 'a@example.com');
  assert.equal(normalizeEmail(''), null);
  assert.throws(() => normalizeEmail('nope'), AppError);
});

test('bootstrap CLI refuses to run without explicit environment values', () => {
  assert.throws(() => readBootstrapEnv({}), /missing/i);
  assert.throws(() => readBootstrapEnv({ ADMIN_BOOTSTRAP_NAME: 'A', ADMIN_BOOTSTRAP_PHONE: '+97455551234' }), /ADMIN_BOOTSTRAP_PASSWORD/);
  // The operator token is required too: bootstrapping must be an explicit, credentialed act.
  assert.throws(
    () =>
      readBootstrapEnv({
        ADMIN_BOOTSTRAP_NAME: 'Root Admin',
        ADMIN_BOOTSTRAP_PHONE: '+97455551234',
        ADMIN_BOOTSTRAP_PASSWORD: 'a strong password',
      }),
    /ADMIN_BOOTSTRAP_TOKEN/,
  );
  const ok = readBootstrapEnv({
    ADMIN_BOOTSTRAP_NAME: 'Root Admin',
    ADMIN_BOOTSTRAP_PHONE: '+97455551234',
    ADMIN_BOOTSTRAP_PASSWORD: 'a strong password',
    ADMIN_BOOTSTRAP_TOKEN: 'a-deployment-token-value',
  });
  assert.equal(ok.phone, '+97455551234');
  assert.equal(ok.confirmToken, 'a-deployment-token-value');
});
