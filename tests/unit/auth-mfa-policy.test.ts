import test from 'node:test';
import assert from 'node:assert/strict';
import { requiresMfa } from '../../src/modules/auth/service.ts';
import type { UserDoc } from '../../src/modules/auth/models.ts';

function user(roles: UserDoc['roles']): UserDoc {
  const now = new Date();
  return {
    publicReference: 'u_test',
    fullName: 'Test',
    phoneE164: null,
    emailNormalized: 't@example.com',
    passwordHash: 'x',
    status: 'active',
    roles,
    phoneVerifiedAt: null,
    emailVerifiedAt: null,
    preferredLocale: 'en',
    termsVersion: null,
    termsAcceptedAt: now,
    lastLoginAt: null,
    suspension: null,
    mfa: { enabled: false, secretEnc: null, confirmedAt: null, recoveryCodes: [], lastStep: null },
    createdAt: now,
    updatedAt: now,
  };
}

test('requiresMfa is mandatory for customers', () => {
  assert.equal(requiresMfa(user(['customer'])), true);
});

test('requiresMfa is off for super_admin (staff MFA deferred)', () => {
  assert.equal(requiresMfa(user(['super_admin'])), false);
});
