import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptSecret, encryptSecret, randomToken, safeEqualHex, sha256Hex } from '../../src/shared/crypto.ts';
import { hashPassword, verifyPassword } from '../../src/shared/password.ts';

const KEY = Buffer.alloc(32, 3).toString('base64');

test('sha256 and constant-time hex comparison', () => {
  const a = sha256Hex('session-token');
  assert.equal(a.length, 64);
  assert.equal(safeEqualHex(a, sha256Hex('session-token')), true);
  assert.equal(safeEqualHex(a, sha256Hex('other')), false);
  assert.equal(safeEqualHex(a, 'short'), false);
});

test('AES-256-GCM secret encryption round-trips and detects tampering', () => {
  const payload = encryptSecret('JBSWY3DPEHPK3PXP', KEY);
  assert.match(payload, /^v1\./);
  assert.equal(decryptSecret(payload, KEY), 'JBSWY3DPEHPK3PXP');
  const parts = payload.split('.');
  parts[3] = `${parts[3]}AA`;
  assert.throws(() => decryptSecret(parts.join('.'), KEY));
  assert.throws(() => encryptSecret('x', Buffer.alloc(8).toString('base64')));
});

test('unknown token format is refused', () => {
  assert.throws(() => decryptSecret('v2.a.b.c', KEY));
});

test('random tokens are URL-safe and unique', () => {
  const a = randomToken(32);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(a, randomToken(32));
});

test('scrypt password hashing verifies correctly and rejects wrong input', async () => {
  const stored = await hashPassword('correct horse battery staple');
  assert.match(stored, /^scrypt\$\d+\$\d+\$\d+\$/);
  assert.equal(await verifyPassword('correct horse battery staple', stored), true);
  assert.equal(await verifyPassword('wrong password', stored), false);
  assert.equal(await verifyPassword('anything', 'not-a-valid-hash'), false);
});
