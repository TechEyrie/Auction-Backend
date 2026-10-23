import test from 'node:test';
import assert from 'node:assert/strict';
import { redactMailBodyPreview } from '../../src/modules/mail/redact.ts';

test('redactMailBodyPreview strips six-digit OTP codes', () => {
  const text = 'Your sign-in code is:\n\n123456\n\nExpires soon.';
  assert.equal(redactMailBodyPreview(text), 'Your sign-in code is:\n\n[redacted]\n\nExpires soon.');
});

test('redactMailBodyPreview strips long verification tokens', () => {
  const token = 'a'.repeat(32);
  const text = `Verify: ${token} and also ${token}`;
  const out = redactMailBodyPreview(text);
  assert.ok(!out.includes(token));
  assert.equal(out, 'Verify: [redacted] and also [redacted]');
});

test('redactMailBodyPreview truncates very long previews', () => {
  const text = 'ok '.repeat(200);
  assert.equal(redactMailBodyPreview(text).length, 500);
});
