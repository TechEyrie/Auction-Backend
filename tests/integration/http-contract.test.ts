import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createReplSet } from '../helpers/mongo.ts';
import { loadConfig, type AppConfig } from '../../src/config/index.ts';
import { connectDb, type DbHandle } from '../../src/db/connection.ts';
import { ensureIndexes } from '../../src/db/indexes.ts';
import { startServer, type RunningServer } from '../../src/server.ts';
import { createLogger } from '../../src/shared/logger.ts';
import { TestClient } from '../helpers/client.ts';

/**
 * HTTP CONTRACT checks under the *production* configuration path (`loadConfig` with
 * `NODE_ENV=production`), not `testConfig`.
 *
 * Why this file exists: the integration suites run with test overrides, so the
 * production config path (required env, `Secure` cookies, explicit origins, no
 * development reset token) had no standing coverage. These are HTTP-level assertions
 * about response headers and status codes.
 *
 * Scope boundary (do not overstate it): this proves what the server sends. It does NOT
 * prove browser behaviour — whether a browser actually stores/sends a `Secure` cookie,
 * renders a form, or follows a redirect is verified only by `scripts/browser-check.mjs`
 * (CDP-driven Chrome). Never cite this file as browser-rendering evidence.
 *
 * Isolation: an in-memory `mongod` replica set, a dedicated database name, a randomly
 * generated MFA key and an obviously fake bootstrap token. No external service, no real
 * secret, and nothing here may be pointed at a production database.
 */

const ORIGIN = 'http://localhost:3000';
const BOOTSTRAP_TOKEN = 'http-contract-test-token';

let replSet: MongoMemoryReplSet;
let handle: DbHandle;
let running: RunningServer;
let config: AppConfig;
let baseUrl: string;

before(async () => {
  replSet = await createReplSet();
  config = loadConfig({
    NODE_ENV: 'production',
    PORT: '0',
    MONGODB_URI: replSet.getUri(),
    MONGODB_DB: 'http_contract_test',
    CORS_ORIGINS: ORIGIN,
    LOG_LEVEL: 'error',
    MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
    PAYMENT_PROVIDER: 'approved-sandbox',
  });
  handle = await connectDb(config);
  await ensureIndexes(handle.db);
  running = await startServer({
    config,
    logger: createLogger('error', { write: () => true }),
    db: handle,
  });
  baseUrl = `http://127.0.0.1:${running.port}`;
});

after(async () => {
  if (running) await running.stop();
  else if (handle) await handle.close();
  if (replSet) await replSet.stop();
});

test('production configuration is what these checks assume', () => {
  assert.equal(config.isProduction, true);
  assert.equal(config.cookieSecure, true, 'production must set Secure cookies');
  assert.deepEqual(config.corsOrigins, [ORIGIN]);
});

test('session bootstrap issues the CSRF cookie and reports an anonymous session', async () => {
  const client = new TestClient(baseUrl);
  const res = await client.bootstrap();
  assert.equal(res.status, 200);
  assert.equal((res.body as { user: unknown }).user, null);
  assert.ok(client.csrfToken(), 'a CSRF token must be issued');

  const setCookies = res.headers.getSetCookie();
  const csrfCookie = setCookies.find((c) => c.startsWith('csrf='));
  assert.ok(csrfCookie, 'csrf cookie missing');
  assert.ok(!/HttpOnly/i.test(csrfCookie), 'the CSRF cookie must stay readable for double-submit');
  assert.match(csrfCookie, /SameSite=Lax/);
  assert.match(csrfCookie, /Secure/, 'production cookie must be Secure');
});

test('CORS echoes the configured origin with credentials, and only that origin', async () => {
  const allowed = await fetch(`${baseUrl}/api/auth/session`, { headers: { origin: ORIGIN } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');

  const unknownOrigin = await fetch(`${baseUrl}/api/auth/session`, {
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(unknownOrigin.headers.get('access-control-allow-origin'), null);
});

test('preflight allows the headers a browser actually sends', async () => {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'OPTIONS',
    headers: {
      origin: ORIGIN,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type,x-csrf-token,x-collection-key',
    },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  const allowed = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase();
  assert.match(allowed, /content-type/);
  assert.match(allowed, /x-csrf-token/, 'omitting x-csrf-token blocks every browser mutation');
  assert.match(allowed, /x-collection-key/, 'omitting x-collection-key blocks every browser media upload');
  assert.match(res.headers.get('access-control-allow-methods') ?? '', /POST/);
});

test('registration is customer-only and returns the session cookie header contract', async () => {
  const client = new TestClient(baseUrl);
  await client.bootstrap();
  const res = await client.post(
    '/api/auth/register',
    {
      fullName: 'Http Contract',
      phone: '55558888',
      password: 'contract password 1',
      termsAccepted: true,
      // Attempted privilege escalation / verification forgery must be discarded.
      roles: ['super_admin'],
      status: 'disabled',
      phoneVerifiedAt: new Date().toISOString(),
    },
    { origin: ORIGIN },
  );
  assert.equal(res.status, 201);
  const body = res.body as { user: { roles: string[]; status: string; phoneVerified: boolean; passwordHash?: string } };
  assert.deepEqual(body.user.roles, ['customer']);
  assert.equal(body.user.status, 'active');
  assert.equal(body.user.phoneVerified, false);
  assert.ok(!('passwordHash' in body.user), 'no password material in any response');

  const cookies = res.headers.getSetCookie();
  const sidCookie = cookies.find((c) => c.startsWith('sid='));
  assert.ok(sidCookie, 'session cookie missing');
  assert.match(sidCookie, /HttpOnly/);
  assert.match(sidCookie, /Secure/);
  assert.match(sidCookie, /SameSite=Lax/);
  // An ordinary browser-session cookie: no Max-Age until keep-me-signed-in is requested.
  assert.ok(!/Max-Age/i.test(sidCookie), `unexpected Max-Age on the default session cookie: ${sidCookie}`);

  const session = await client.get('/api/auth/session');
  assert.equal((session.body as { user: { phone: string } }).user.phone, '+97455558888');
});

test('keep-me-signed-in is what adds a persistent cookie lifetime', async () => {
  const client = new TestClient(baseUrl);
  await client.bootstrap();
  const res = await client.post('/api/auth/login', {
    identifier: '55558888',
    password: 'contract password 1',
    keepSignedIn: true,
  });
  assert.equal(res.status, 200);
  const sidCookie = res.headers.getSetCookie().find((c) => c.startsWith('sid=')) ?? '';
  assert.match(sidCookie, /Max-Age=\d+/);
});

test('mutation safety: origin, CSRF token and session binding are enforced over the wire', async () => {
  const anonymous = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(anonymous.status, 403, 'missing CSRF token must not be treated as a success');

  const client = new TestClient(baseUrl);
  await client.bootstrap();
  await client.post('/api/auth/login', { identifier: '55558888', password: 'contract password 1' });
  const token = client.csrfToken();

  const badOrigin = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: {
      origin: 'https://evil.example',
      'content-type': 'application/json',
      'x-csrf-token': token ?? '',
      cookie: `sid=${client.cookie('sid')}; csrf=${token}`,
    },
    body: '{}',
  });
  assert.equal(badOrigin.status, 403);

  const unbound = new TestClient(baseUrl);
  await unbound.bootstrap();
  await unbound.post('/api/auth/login', { identifier: '55558888', password: 'contract password 1' });
  unbound.setCsrfToken('not-the-bound-token');
  assert.equal((await unbound.post('/api/auth/logout', {})).status, 403);

  // Legitimate mutation still works, so the guard is not simply denying everything.
  assert.equal((await client.post('/api/auth/logout', {})).status, 200);
});

test('anonymous and under-privileged calls get 401 and 403, not data', async () => {
  const anonymous = await fetch(`${baseUrl}/api/admin/users`, { headers: { origin: ORIGIN } });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get('access-control-allow-origin'), ORIGIN);

  const customer = new TestClient(baseUrl);
  await customer.bootstrap();
  await customer.post('/api/auth/login', { identifier: '55558888', password: 'contract password 1' });
  assert.equal((await customer.get('/api/admin/users')).status, 403);
  assert.equal((await customer.get('/api/admin/me')).status, 403);
});

test('a media upload preflight is answered for the real browser request', async () => {
  // The admin media screen sends a raw image body with these three headers. If any of them
  // is missing from the preflight answer, the browser never sends the upload at all.
  const res = await fetch(`${baseUrl}/api/admin/media/upload`, {
    method: 'OPTIONS',
    headers: {
      origin: ORIGIN,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type,x-csrf-token,x-collection-key',
    },
  });
  const allowed = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase();
  assert.equal(res.status, 204);
  assert.match(allowed, /x-collection-key/);
  assert.match(res.headers.get('access-control-allow-methods') ?? '', /POST/);

  // And the POST itself is still refused: without a CSRF token the guard answers first.
  const anonymous = await fetch(`${baseUrl}/api/admin/media/upload`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'image/png', 'x-collection-key': 'contract' },
    body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  });
  assert.equal(anonymous.status, 403, 'no session and no CSRF token');

  // A visitor who has the double-submit cookie but no session gets past CSRF and is then
  // refused by auth, so the refusal is an authentication answer, not a CSRF accident.
  const visitor = new TestClient(baseUrl);
  await visitor.bootstrap();
  const sessionless = await visitor.request('POST', '/api/admin/media/upload', undefined, {
    headers: { 'content-type': 'image/png', 'x-collection-key': 'contract' },
  });
  assert.equal(sessionless.status, 401);
});

test('password recovery is generic in production and never leaks a token', async () => {
  const client = new TestClient(baseUrl);
  await client.bootstrap();

  const known = await client.post('/api/auth/password/forgot', { identifier: '55558888' }, { origin: ORIGIN });
  const unknown = await client.post('/api/auth/password/forgot', { identifier: '55559999' }, { origin: ORIGIN });

  assert.equal(known.status, 200);
  assert.equal(unknown.status, 200);
  assert.ok(!('devResetToken' in (known.body as object)), 'production must not return a reset token');
  assert.deepEqual(
    Object.keys(known.body as object).sort(),
    Object.keys(unknown.body as object).sort(),
    'known and unknown identifiers must be indistinguishable',
  );
});

test('readiness stays truthful while the database is up', async () => {
  const health = await fetch(`${baseUrl}/healthz`);
  const ready = await fetch(`${baseUrl}/readyz`);
  assert.equal(health.status, 200);
  assert.equal(ready.status, 200);
});

test('the OpenAPI document is served and stays valid JSON', async () => {
  const res = await fetch(`${baseUrl}/api/openapi.json`);
  assert.equal(res.status, 200);
  const doc = (await res.json()) as { openapi?: string };
  assert.match(String(doc.openapi), /^3\./);
});
