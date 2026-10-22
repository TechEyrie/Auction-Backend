import type { Db } from 'mongodb';
import { bootstrapSuperAdmin } from '../../src/modules/admin/bootstrap.ts';
import { generateTotp } from '../../src/shared/totp.ts';
import { TestClient } from './client.ts';

export type AdminFixture = {
  client: TestClient;
  phone: string;
  password: string;
  publicReference: string;
};

/**
 * A ready-to-use, MFA-satisfied super admin.
 *
 * The phase 03 flow is deliberately not short-circuited: bootstrap, sign in, enroll, confirm —
 * so every catalog test runs against a session that really passed the privilege gate.
 */
export async function createAdminFixture(options: {
  db: Db;
  baseUrl: string;
  phone: string;
  password: string;
  bootstrapToken: string;
  origin?: string;
}): Promise<AdminFixture> {
  await bootstrapSuperAdmin(
    options.db,
    { fullName: 'Catalog Admin', phone: options.phone, password: options.password },
    { expectedToken: options.bootstrapToken, confirmToken: options.bootstrapToken },
  );
  const client = new TestClient(options.baseUrl);
  await client.bootstrap();
  const login = await client.post('/api/auth/login', { identifier: options.phone, password: options.password });
  if (login.status !== 200) throw new Error(`admin login failed: ${JSON.stringify(login.body)}`);
  const enroll = await client.post('/api/auth/mfa/enroll', {});
  if (enroll.status !== 200) throw new Error(`admin enroll failed: ${JSON.stringify(enroll.body)}`);
  const secret = (enroll.body as { secret: string }).secret;
  const confirm = await client.post('/api/auth/mfa/enroll/confirm', { code: generateTotp(secret) });
  if (confirm.status !== 200) throw new Error(`admin confirm failed: ${JSON.stringify(confirm.body)}`);
  const session = await client.get('/api/auth/session');
  const user = (session.body as { user: { publicReference: string } | null }).user;
  if (!user) throw new Error('admin session was not established');
  return { client, phone: options.phone, password: options.password, publicReference: user.publicReference };
}

export async function verifyCustomerEmail(client: TestClient, devVerifyToken: string): Promise<void> {
  const res = await client.post('/api/auth/email/verify', { token: devVerifyToken });
  if (res.status !== 200) throw new Error(`email verify failed: ${JSON.stringify(res.body)}`);
}

/** Complete the emailed login OTP for a customer session (dev adapter returns the code). */
export async function completeCustomerLoginOtp(client: TestClient, devLoginOtp?: string): Promise<void> {
  let code = devLoginOtp;
  if (!code) {
    const resend = await client.post('/api/auth/login/otp/resend', {});
    if (resend.status !== 200) throw new Error(`login OTP resend failed: ${JSON.stringify(resend.body)}`);
    code = (resend.body as { devLoginOtp?: string }).devLoginOtp;
  }
  if (!code) throw new Error('customer fixture missing devLoginOtp');
  const res = await client.post('/api/auth/login/otp', { code });
  if (res.status !== 200) throw new Error(`login OTP failed: ${JSON.stringify(res.body)}`);
}

/** Enroll and confirm TOTP so customer-only MFA gates pass. */
export async function satisfyCustomerMfa(client: TestClient): Promise<string> {
  const enroll = await client.post('/api/auth/mfa/enroll', {});
  if (enroll.status !== 200) throw new Error(`customer enroll failed: ${JSON.stringify(enroll.body)}`);
  const secret = (enroll.body as { secret: string }).secret;
  const confirm = await client.post('/api/auth/mfa/enroll/confirm', { code: generateTotp(secret) });
  if (confirm.status !== 200) throw new Error(`customer confirm failed: ${JSON.stringify(confirm.body)}`);
  return secret;
}

/** A plain signed-in customer with MFA satisfied, for permission checks. */
export async function createCustomerFixture(options: {
  baseUrl: string;
  phone: string;
  password: string;
  origin?: string;
}): Promise<TestClient> {
  const client = new TestClient(options.baseUrl);
  await client.bootstrap();
  const register = await client.post('/api/auth/register', {
    fullName: `Catalog Customer ${options.phone}`,
    phone: options.phone,
    email: `fixture.${options.phone.replace(/\D/g, '')}@example.test`,
    password: options.password,
    termsAccepted: true,
  });
  if (register.status !== 201) throw new Error(`customer fixture failed: ${JSON.stringify(register.body)}`);
  const devVerifyToken = (register.body as { devVerifyToken?: string }).devVerifyToken;
  if (!devVerifyToken) throw new Error('customer fixture missing devVerifyToken');
  await verifyCustomerEmail(client, devVerifyToken);
  const login = await client.post('/api/auth/login', {
    identifier: options.phone,
    password: options.password,
  });
  if (login.status !== 200) throw new Error(`customer fixture login failed: ${JSON.stringify(login.body)}`);
  await completeCustomerLoginOtp(client, (login.body as { devLoginOtp?: string }).devLoginOtp);
  return client;
}
