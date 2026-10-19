import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createReplSet } from '../helpers/mongo.ts';
import { connectDb, type DbHandle } from '../../src/db/connection.ts';
import { COLLECTIONS, ensureIndexes } from '../../src/db/indexes.ts';
import { startServer, type RunningServer } from '../../src/server.ts';
import { silentLogger, testConfig } from '../helpers/context.ts';
import { TestClient } from '../helpers/client.ts';
import { sha256Hex } from '../../src/shared/crypto.ts';
import { generateTotp } from '../../src/shared/totp.ts';
import { bootstrapSuperAdmin } from '../../src/modules/admin/bootstrap.ts';

let replSet: MongoMemoryReplSet;
let handle: DbHandle;
let running: RunningServer;
let baseUrl: string;
let superSecret = '';
let superRecoveryCodes: string[] = [];
let pendingSuperadmin: TestClient;

const SUPER_PHONE = '55551000';
const SUPER_PW = 'super secret pw 1';
const FIXTURE_PW = 'fixture pass 123';
/** Matches the deployment token from `testEnv()`; bootstrapping needs an explicit operator token. */
const BOOTSTRAP_TOKEN = 'test-bootstrap-token';

async function loginClient(identifier: string, password: string): Promise<TestClient> {
  const client = new TestClient(baseUrl);
  await client.bootstrap();
  const res = await client.post('/api/auth/login', { identifier, password });
  assert.equal(res.status, 200, `login failed for ${identifier}: ${JSON.stringify(res.body)}`);
  return client;
}

async function registerClient(phone: string, password = FIXTURE_PW): Promise<TestClient> {
  const client = new TestClient(baseUrl);
  await client.bootstrap();
  const res = await client.post('/api/auth/register', {
    fullName: `Customer ${phone}`,
    phone,
    password,
    termsAccepted: true,
  });
  assert.equal(res.status, 201, `register failed for ${phone}: ${JSON.stringify(res.body)}`);
  return client;
}

async function sessionOf(client: TestClient): Promise<{ user: unknown; mfaRequired: boolean }> {
  const res = await client.get('/api/auth/session');
  return res.body as { user: unknown; mfaRequired: boolean };
}

async function refOf(client: TestClient): Promise<string> {
  const res = await client.get('/api/auth/session');
  return (res.body as { user: { publicReference: string } }).user.publicReference;
}

before(async () => {
  replSet = await createReplSet();
  handle = await connectDb({ mongodbUri: replSet.getUri(), mongodbDb: 'auth_test' });
  await ensureIndexes(handle.db);
  running = await startServer({ config: testConfig(), logger: silentLogger(), db: handle });
  baseUrl = `http://127.0.0.1:${running.port}`;

  await bootstrapSuperAdmin(
    handle.db,
    { fullName: 'Root Admin', phone: SUPER_PHONE, password: SUPER_PW },
    { confirmToken: BOOTSTRAP_TOKEN },
  );

  // Fixture customers for ownership tests.
  await registerClient('55555502');
  await registerClient('55555503');

  // Main satisfied admin client: login -> enroll -> confirm (confirm satisfies the session).
  const admin = await loginClient(SUPER_PHONE, SUPER_PW);
  const enroll = await admin.post('/api/auth/mfa/enroll', { currentPassword: SUPER_PW });
  superSecret = (enroll.body as { secret: string }).secret;
  const confirm = await admin.post('/api/auth/mfa/enroll/confirm', { code: generateTotp(superSecret) });
  superRecoveryCodes = (confirm.body as { recoveryCodes: string[] }).recoveryCodes;
  pendingSuperadmin = admin;
});

// Rate limits are real buckets in the shared database. Tests that assert exact
// budgets (C09) must start from a clean window, so clear the buckets between tests
// rather than loosening the limits.
beforeEach(async () => {
  await handle.db.collection(COLLECTIONS.rateLimits).deleteMany({});
});

after(async () => {
  if (running) await running.stop();
  else if (handle) await handle.close();
  if (replSet) await replSet.stop();
});

test('C01 register, session reload, logout and login round-trip', async () => {
  const client = new TestClient(baseUrl);
  await client.bootstrap();
  assert.equal((await sessionOf(client)).user ?? null, null);

  const reg = await client.post('/api/auth/register', {
    fullName: 'Noor Al Ali',
    phone: '55551234',
    password: 'correct horse 1',
    termsAccepted: true,
  });
  assert.equal(reg.status, 201);
  assert.equal((reg.body as { user: { roles: string[] } }).user.roles[0], 'customer');

  const session = await client.get('/api/auth/session');
  assert.equal((session.body as { user: { phone: string } }).user.phone, '+97455551234');

  await client.post('/api/auth/logout', {});
  assert.equal((await sessionOf(client)).user ?? null, null);

  const login = await client.post('/api/auth/login', { identifier: '55551234', password: 'correct horse 1' });
  assert.equal(login.status, 200);
  assert.equal((await sessionOf(client)).user !== null, true);
});

test('C02 password hashes are not returned and are stored hashed', async () => {
  const client = await registerClient('55550010');
  const ref = await refOf(client);
  const self = await client.get(`/api/users/${ref}`);
  assert.ok(!JSON.stringify(self.body).includes('passwordHash'));
  const raw = await handle.db.collection('users').findOne({ publicReference: ref });
  assert.match(String(raw?.passwordHash), /^scrypt\$/);
  assert.ok(!JSON.stringify(raw).includes('"secretEnc":"v1.'));
});

test('C03 anonymous protected call returns 401', async () => {
  const anon = new TestClient(baseUrl);
  await anon.bootstrap();
  assert.equal((await anon.get('/api/admin/me')).status, 401);
});

test('C04 authenticated but unauthorized role returns 403', async () => {
  const customer = await loginClient('55555502', FIXTURE_PW);
  assert.equal((await customer.get('/api/admin/users')).status, 403);
});

test('register refuses common and short passwords', async () => {
  const client = new TestClient(baseUrl);
  await client.bootstrap();
  const short = await client.post('/api/auth/register', {
    fullName: 'Weak Pass User',
    phone: '55550080',
    password: 'letmein1',
    termsAccepted: true,
  });
  assert.equal(short.status, 422);
  const common = await client.post('/api/auth/register', {
    fullName: 'Weak Pass User',
    phone: '55550081',
    email: 'weak.pass@example.com',
    password: 'password123',
    termsAccepted: true,
  });
  assert.equal(common.status, 422);
  const personal = await client.post('/api/auth/register', {
    fullName: 'Noor Al Ali',
    phone: '55550082',
    email: 'noor.house@example.com',
    password: 'NoorHouse99',
    termsAccepted: true,
  });
  assert.equal(personal.status, 422);
});

test('C05 public role/status/verification injection is rejected', async () => {
  const client = new TestClient(baseUrl);
  await client.bootstrap();
  const reg = await client.post('/api/auth/register', {
    fullName: 'Role Check User',
    phone: '55550011',
    password: 'inject me please',
    termsAccepted: true,
    roles: ['super_admin'],
    status: 'disabled',
    phoneVerifiedAt: new Date().toISOString(),
  });
  const user = (reg.body as { user: { roles: string[]; status: string; phoneVerified: boolean } }).user;
  assert.deepEqual(user.roles, ['customer']);
  assert.equal(user.status, 'active');
  assert.equal(user.phoneVerified, false);
});

test('C06 session expiry is enforced server-side and marks the session revoked', async () => {
  const client = await registerClient('55550012');
  const sid = client.cookie('sid');
  assert.ok(sid);
  await handle.db
    .collection('sessions')
    .updateOne({ tokenHash: sha256Hex(sid as string) }, { $set: { idleExpiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await sessionOf(client)).user ?? null, null);
  const session = await handle.db.collection('sessions').findOne({ tokenHash: sha256Hex(sid as string) });
  assert.ok(session?.revokedAt);
  assert.equal(session?.revokedReason, 'idle_timeout');
});

test('C07 CSRF: mutations require a valid token and an allowed origin', async () => {
  const noToken = new TestClient(baseUrl, false);
  await noToken.bootstrap();
  assert.equal((await noToken.post('/api/auth/login', { identifier: '55555502', password: 'x' })).status, 403);

  const client = new TestClient(baseUrl);
  await client.bootstrap();
  const badOrigin = await client.post(
    '/api/auth/login',
    { identifier: '55555502', password: 'wrong' },
    { origin: 'https://evil.example' },
  );
  assert.equal(badOrigin.status, 403);

  // Token not bound to the session is rejected.
  const rebound = new TestClient(baseUrl);
  await rebound.bootstrap();
  await rebound.post('/api/auth/login', { identifier: '55555502', password: FIXTURE_PW });
  rebound.setCsrfToken('not-the-bound-token-value');
  assert.equal((await rebound.post('/api/auth/logout', {})).status, 403);
});

test('C08 password reset is generic, single-use, expiring, and revokes sessions', async () => {
  const client = new TestClient(baseUrl);
  await client.bootstrap();
  await client.post('/api/auth/register', {
    fullName: 'Reset Fixture',
    phone: '55550013',
    password: 'original pass 1',
    termsAccepted: true,
  });

  const unknown = new TestClient(baseUrl);
  await unknown.bootstrap();
  const unknownRes = await unknown.post('/api/auth/password/forgot', { identifier: '55559999' });
  assert.equal(unknownRes.status, 200);
  assert.ok(!('devResetToken' in (unknownRes.body as object)));

  const forgot = await client.post('/api/auth/password/forgot', { identifier: '55550013' });
  const token = (forgot.body as { devResetToken?: string }).devResetToken;
  assert.ok(token);

  assert.equal(
    (await client.post('/api/auth/password/reset', { token: 'aaaaaaaaaaaaaaaaaaaa', password: 'new pass 12345' })).status,
    422,
  );

  // Expired token is rejected.
  const expired = await client.post('/api/auth/password/forgot', { identifier: '55550013' });
  const expiredToken = (expired.body as { devResetToken?: string }).devResetToken as string;
  await handle.db
    .collection('verification_challenges')
    .updateOne({ tokenHash: sha256Hex(expiredToken) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal(
    (await client.post('/api/auth/password/reset', { token: expiredToken, password: 'new pass 12345' })).status,
    422,
  );

  // Fresh token works once, then is rejected on reuse.
  const fresh = await client.post('/api/auth/password/forgot', { identifier: '55550013' });
  const freshToken = (fresh.body as { devResetToken?: string }).devResetToken as string;
  assert.equal((await client.post('/api/auth/password/reset', { token: freshToken, password: 'new pass 12345' })).status, 200);
  assert.equal((await client.post('/api/auth/password/reset', { token: freshToken, password: 'new pass 12345' })).status, 422);

  // Reset invalidates existing sessions.
  assert.equal((await sessionOf(client)).user ?? null, null);

  const relogin = new TestClient(baseUrl);
  await relogin.bootstrap();
  assert.equal((await relogin.post('/api/auth/login', { identifier: '55550013', password: 'new pass 12345' })).status, 200);
});

test('C09 rate limiting and trusted-proxy client IP handling', async () => {
  const limited = await startExtraServer({ RATE_LIMIT_MAX_ATTEMPTS: '2' });
  try {
    const client = new TestClient(limited.url);
    await client.bootstrap();
    const body = { identifier: '55555502', password: 'wrong password' };
    assert.equal((await client.post('/api/auth/login', body)).status, 401);
    assert.equal((await client.post('/api/auth/login', body)).status, 401);
    assert.equal((await client.post('/api/auth/login', body)).status, 429);
  } finally {
    await limited.stop();
  }

  const proxied = await startExtraServer({ RATE_LIMIT_MAX_ATTEMPTS: '1', TRUST_PROXY: '1' });
  try {
    const client = new TestClient(proxied.url);
    await client.bootstrap();
    const body = { identifier: '55555502', password: 'wrong password' };
    const a = await client.post('/api/auth/login', body, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    const b = await client.post('/api/auth/login', body, { headers: { 'x-forwarded-for': '203.0.113.10' } });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401); // different client IPs → independent buckets
  } finally {
    await proxied.stop();
  }
});

test('C10 return URLs cannot create open redirects', async () => {
  const client = new TestClient(baseUrl);
  await client.bootstrap();
  const cases: Array<[string, string]> = [
    ['https://evil.example/steal', '/'],
    ['//evil.example', '/'],
    ['/admin', '/admin'],
    ['javascript:alert(1)', '/'],
  ];
  for (const [input, expected] of cases) {
    const res = await client.post('/api/auth/login', {
      identifier: '55555502',
      password: FIXTURE_PW,
      returnTo: input,
    });
    assert.equal((res.body as { returnTo: string }).returnTo, expected, `for input ${input}`);
  }
});

test('C11 a customer cannot read another customer record', async () => {
  const owner = await loginClient('55555502', FIXTURE_PW);
  const other = await loginClient('55555503', FIXTURE_PW);
  const ownerRef = await refOf(owner);

  assert.equal((await owner.get(`/api/users/${ownerRef}`)).status, 200);
  assert.equal((await other.get(`/api/users/${ownerRef}`)).status, 403);
  assert.equal((await pendingSuperadmin.get(`/api/users/${ownerRef}`)).status, 200);
});

test('C12 admin bootstrap is one-time and MFA gates privileged access', async () => {
  // Bootstrapping always requires the operator token: a missing/weak token is refused outright.
  await assert.rejects(
    () => bootstrapSuperAdmin(handle.db, { fullName: 'Second', phone: '55551001', password: 'another secret 1' }),
    /operator token/i,
  );
  await assert.rejects(
    () => bootstrapSuperAdmin(
      handle.db,
      { fullName: 'Second', phone: '55551001', password: 'another secret 1' },
      { expectedToken: BOOTSTRAP_TOKEN, confirmToken: 'not-the-deployment-token' },
    ),
    /ADMIN_BOOTSTRAP_TOKEN does not match/i,
  );
  // Re-running bootstrap is refused (no public/default admin creation).
  await assert.rejects(
    () => bootstrapSuperAdmin(
      handle.db,
      { fullName: 'Second', phone: '55551001', password: 'another secret 1' },
      { expectedToken: BOOTSTRAP_TOKEN, confirmToken: BOOTSTRAP_TOKEN },
    ),
    /super admin already exists/i,
  );
  // Enroll requires reauthentication.
  const weak = await loginClient(SUPER_PHONE, SUPER_PW);
  assert.equal((await weak.post('/api/auth/mfa/enroll', { currentPassword: 'wrong' })).status, 403);

  // A pre-MFA session must not authorize privileged APIs.
  const preMfa = await loginClient(SUPER_PHONE, SUPER_PW);
  assert.equal((await sessionOf(preMfa)).mfaRequired, true);
  const preMfaDeny = await preMfa.get('/api/admin/me');
  assert.equal(preMfaDeny.status, 403);
  assert.equal((preMfaDeny.body as { error: { details: { code: string } } }).error.details.code, 'MFA_REQUIRED');

  // Challenge completes MFA and rotates the session credential.
  const oldSid = preMfa.cookie('sid');
  const codeStep1 = generateTotp(superSecret, Date.now() + 30_000);
  const challenge = await preMfa.post('/api/auth/mfa/challenge', { code: codeStep1 });
  assert.equal(challenge.status, 200, JSON.stringify(challenge.body));
  assert.notEqual(preMfa.cookie('sid'), oldSid);
  assert.equal((await preMfa.get('/api/admin/me')).status, 200);

  // Replaying the same accepted code in a new session is refused.
  const replay = await loginClient(SUPER_PHONE, SUPER_PW);
  assert.equal((await replay.post('/api/auth/mfa/challenge', { code: codeStep1 })).status, 409);

  // Recovery code is single-use and satisfies MFA for that session.
  const recoveryCode = superRecoveryCodes[0] as string;
  const recovery = await loginClient(SUPER_PHONE, SUPER_PW);
  assert.equal((await recovery.post('/api/auth/mfa/recovery', { code: recoveryCode })).status, 200);
  assert.equal((await recovery.get('/api/admin/me')).status, 200);
  const reuse = await loginClient(SUPER_PHONE, SUPER_PW);
  assert.equal((await reuse.post('/api/auth/mfa/recovery', { code: recoveryCode })).status, 422);
});

test('C13 last-super-admin protection holds under concurrent changes', async () => {
  // Promote fixture 55555503 to super admin, then give it a satisfied session.
  const actor = pendingSuperadmin;
  const otherRef = await refOf(await loginClient('55555503', FIXTURE_PW));
  assert.equal((await actor.patch(`/api/admin/users/${otherRef}/roles`, { roles: ['super_admin'] })).status, 200);

  const other = await loginClient('55555503', FIXTURE_PW);
  const enroll = await other.post('/api/auth/mfa/enroll', { currentPassword: FIXTURE_PW });
  const otherSecret = (enroll.body as { secret: string }).secret;
  await other.post('/api/auth/mfa/enroll/confirm', { code: generateTotp(otherSecret) });
  assert.equal((await other.get('/api/admin/me')).status, 200);

  const countActive = () =>
    handle.db.collection('users').countDocuments({ status: 'active', roles: 'super_admin' });
  assert.equal(await countActive(), 2);

  const myRef = await refOf(actor);
  const [demoteOther, demoteSelf] = await Promise.all([
    actor.patch(`/api/admin/users/${otherRef}/roles`, { roles: ['customer'] }),
    other.patch(`/api/admin/users/${myRef}/roles`, { roles: ['customer'] }),
  ]);
  const statuses = [demoteOther.status, demoteSelf.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  assert.equal(await countActive(), 1);

  // Direct attempt to demote the final super admin is refused. The survivor is whoever
  // kept the role: the loser of the pair is the request that returned 409.
  const survivor = demoteOther.status === 200 ? actor : other;
  const survivorRef = demoteOther.status === 200 ? myRef : otherRef;
  assert.equal((await survivor.patch(`/api/admin/users/${survivorRef}/roles`, { roles: ['customer'] })).status, 409);
});

async function startExtraServer(overrides: Record<string, string>): Promise<{ url: string; stop: () => Promise<void> }> {
  const db = await connectDb({ mongodbUri: replSet.getUri(), mongodbDb: 'auth_test' });
  const server = await startServer({ config: testConfig(overrides), logger: silentLogger(), db });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop() };
}
