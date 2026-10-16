import test from 'node:test';
import assert from 'node:assert/strict';
import type { Response } from 'express';
import { loadConfig } from '../../src/config/index.ts';
import { setCsrfCookie, setSessionCookie } from '../../src/modules/auth/cookies.ts';
import { randomBytes } from 'node:crypto';

function captureCookies(configEnv: Record<string, string>) {
  const config = loadConfig({
    NODE_ENV: 'production',
    MONGODB_URI: 'mongodb://localhost:27017',
    MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    PAYMENT_PROVIDER: 'approved-sandbox',
    ADMIN_BOOTSTRAP_TOKEN: 'cookie-unit-bootstrap-tok',
    ...configEnv,
  });
  const headers: string[] = [];
  const res = {
    append(_name: string, value: string) {
      headers.push(value);
    },
  } as unknown as Response;
  setCsrfCookie(res, config, 'csrf-token-value');
  setSessionCookie(res, config, 'sid-token-value');
  return { config, headers };
}

test('same-site http CORS keeps Lax without Partitioned', () => {
  const { config, headers } = captureCookies({ CORS_ORIGINS: 'http://localhost:3000' });
  assert.equal(config.cookieSameSite, 'Lax');
  assert.equal(config.cookiePartitioned, false);
  for (const h of headers) {
    assert.match(h, /SameSite=Lax/);
    assert.match(h, /Secure/);
    assert.ok(!/Partitioned/i.test(h));
  }
});

test('Vercel-style https CORS sets SameSite=None; Secure; Partitioned', () => {
  const { config, headers } = captureCookies({
    CORS_ORIGINS: 'https://araq-kahraman.vercel.app',
  });
  assert.equal(config.cookieSameSite, 'None');
  assert.equal(config.cookiePartitioned, true);
  assert.equal(headers.length, 2);
  for (const h of headers) {
    assert.match(h, /SameSite=None/);
    assert.match(h, /Secure/);
    assert.match(h, /Partitioned/);
  }
  assert.match(headers[0]!, /^csrf=/);
  assert.ok(!/HttpOnly/i.test(headers[0]!));
  assert.match(headers[1]!, /^sid=/);
  assert.match(headers[1]!, /HttpOnly/);
});
