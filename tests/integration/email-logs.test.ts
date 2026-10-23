import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createReplSet } from '../helpers/mongo.ts';
import { connectDb, type DbHandle } from '../../src/db/connection.ts';
import { COLLECTIONS, ensureIndexes } from '../../src/db/indexes.ts';
import { startServer, type RunningServer } from '../../src/server.ts';
import { silentLogger, testConfig } from '../helpers/context.ts';
import { TestClient } from '../helpers/client.ts';
import { generateTotp } from '../../src/shared/totp.ts';
import { bootstrapSuperAdmin } from '../../src/modules/admin/bootstrap.ts';
import { completeCustomerLoginOtp } from '../helpers/authFixture.ts';
import { mailCaptures } from '../../src/shared/mail.ts';

let replSet: MongoMemoryReplSet;
let handle: DbHandle;
let running: RunningServer;
let baseUrl: string;
let adminClient: TestClient;

const SUPER_PHONE = '55552000';
const SUPER_PW = 'super secret pw 2';
const FIXTURE_PW = 'fixture pass 123';
const BOOTSTRAP_TOKEN = 'test-bootstrap-token';

function fixtureEmail(phone: string): string {
  return `c${phone.replace(/\D/g, '')}@example.test`;
}

before(async () => {
  replSet = await createReplSet();
  handle = await connectDb({ mongodbUri: replSet.getUri(), mongodbDb: 'email_logs_test' });
  await ensureIndexes(handle.db);
  running = await startServer({ config: testConfig(), logger: silentLogger(), db: handle });
  baseUrl = `http://127.0.0.1:${running.port}`;

  await bootstrapSuperAdmin(
    handle.db,
    { fullName: 'Email Log Admin', phone: SUPER_PHONE, password: SUPER_PW },
    { confirmToken: BOOTSTRAP_TOKEN },
  );

  adminClient = new TestClient(baseUrl);
  await adminClient.bootstrap();
  const login = await adminClient.post('/api/auth/login', { identifier: SUPER_PHONE, password: SUPER_PW });
  assert.equal(login.status, 200);
  const enroll = await adminClient.post('/api/auth/mfa/enroll', {});
  const secret = (enroll.body as { secret: string }).secret;
  await adminClient.post('/api/auth/mfa/enroll/confirm', { code: generateTotp(secret) });
});

after(async () => {
  if (running) await running.stop();
  else if (handle) await handle.close();
  if (replSet) await replSet.stop();
});

test('login OTP send persists email log; admin can list; customer cannot', async () => {
  mailCaptures.length = 0;
  await handle.db.collection(COLLECTIONS.emailLogs).deleteMany({});

  const customer = new TestClient(baseUrl);
  await customer.bootstrap();
  const reg = await customer.post('/api/auth/register', {
    fullName: 'Log Customer',
    phone: '55552101',
    email: fixtureEmail('55552101'),
    password: FIXTURE_PW,
    termsAccepted: true,
  });
  assert.equal(reg.status, 201);
  const devVerifyToken = (reg.body as { devVerifyToken?: string }).devVerifyToken;
  assert.ok(devVerifyToken);
  assert.equal((await customer.post('/api/auth/email/verify', { token: devVerifyToken })).status, 200);

  const login = await customer.post('/api/auth/login', { identifier: '55552101', password: FIXTURE_PW });
  assert.equal(login.status, 200);
  assert.ok(mailCaptures.some((m) => m.subject === 'Your sign-in code'));

  const stored = await handle.db.collection(COLLECTIONS.emailLogs).find({ purpose: 'login_otp' }).toArray();
  assert.equal(stored.length, 1);
  const row = stored[0]!;
  assert.equal(row.status, 'sent');
  assert.equal(row.to, fixtureEmail('55552101'));
  assert.equal(row.subject, 'Your sign-in code');

  const denied = await customer.get('/api/admin/email-logs');
  assert.ok(denied.status === 401 || denied.status === 403);

  const list = await adminClient.get('/api/admin/email-logs?limit=10');
  assert.equal(list.status, 200);
  const rows = (list.body as { emailLogs: Array<{ purpose: string; status: string; to: string }> }).emailLogs;
  assert.ok(rows.some((row) => row.purpose === 'login_otp' && row.status === 'sent' && row.to === fixtureEmail('55552101')));

  await completeCustomerLoginOtp(customer, (login.body as { devLoginOtp?: string }).devLoginOtp);
});

test('email log list supports q filter on subject', async () => {
  const list = await adminClient.get('/api/admin/email-logs?q=sign-in&limit=5');
  assert.equal(list.status, 200);
  const rows = (list.body as { emailLogs: Array<{ subject: string }> }).emailLogs;
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((row) => /sign-in/i.test(row.subject) || row.subject.includes('sign')));
});
