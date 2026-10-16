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
  const enroll = await client.post('/api/auth/mfa/enroll', { currentPassword: options.password });
  if (enroll.status !== 200) throw new Error(`admin enroll failed: ${JSON.stringify(enroll.body)}`);
  const secret = (enroll.body as { secret: string }).secret;
  const confirm = await client.post('/api/auth/mfa/enroll/confirm', { code: generateTotp(secret) });
  if (confirm.status !== 200) throw new Error(`admin confirm failed: ${JSON.stringify(confirm.body)}`);
  const session = await client.get('/api/auth/session');
  const user = (session.body as { user: { publicReference: string } | null }).user;
  if (!user) throw new Error('admin session was not established');
  return { client, phone: options.phone, password: options.password, publicReference: user.publicReference };
}

/** A plain signed-in customer, for permission checks. */
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
    password: options.password,
    termsAccepted: true,
  });
  if (register.status !== 201) throw new Error(`customer fixture failed: ${JSON.stringify(register.body)}`);
  return client;
}
