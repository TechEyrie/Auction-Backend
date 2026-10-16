import test from 'node:test';
import assert from 'node:assert/strict';
import { base32Decode, base32Encode, generateTotp, verifyTotp } from '../../src/shared/totp.ts';

// RFC 6238 uses the ASCII secret "12345678901234567890" for the SHA-1 vectors.
const SECRET_ASCII = '12345678901234567890';
const SECRET_BASE32 = base32Encode(Buffer.from(SECRET_ASCII, 'ascii'));

test('base32 round-trips', () => {
  assert.equal(base32Encode(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
});

test('matches RFC 6238 SHA-1 vectors (8 digits)', () => {
  const vectors: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
  ];
  for (const [seconds, expected] of vectors) {
    assert.equal(generateTotp(SECRET_BASE32, seconds * 1000, 8), expected, `at ${seconds}s`);
  }
});

test('verify accepts the current window and rejects stale or malformed codes', () => {
  const at = 1_700_000_000_000;
  const code = generateTotp(SECRET_BASE32, at);
  assert.equal(verifyTotp(SECRET_BASE32, code, { atMs: at }), true);
  assert.equal(verifyTotp(SECRET_BASE32, code, { atMs: at + 30_000 }), true);
  assert.equal(verifyTotp(SECRET_BASE32, code, { atMs: at + 120_000 }), false);
  assert.equal(verifyTotp(SECRET_BASE32, 'abc123', { atMs: at }), false);
  assert.equal(verifyTotp(SECRET_BASE32, '000000', { atMs: at }), false);
});
