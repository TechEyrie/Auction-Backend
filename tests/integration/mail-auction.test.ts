import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, type AppConfig } from '../../src/config/index.ts';
import { connectDb, type DbHandle } from '../../src/db/connection.ts';
import { COLLECTIONS, ensureIndexes } from '../../src/db/indexes.ts';
import { startServer, type RunningServer } from '../../src/server.ts';
import { silentLogger } from '../helpers/context.ts';
import { TestClient } from '../helpers/client.ts';
import { createAuthService } from '../../src/modules/auth/service.ts';
import { bootstrapSuperAdmin } from '../../src/modules/admin/bootstrap.ts';
import { generateTotp } from '../../src/shared/totp.ts';
import { satisfyCustomerMfa } from '../helpers/authFixture.ts';
import { MAIL_JOB_TYPES } from '../../src/modules/mail/jobs.ts';
import { processMailJobs } from '../../src/modules/mail/processJobs.ts';
import { mailCaptures } from '../../src/shared/mail.ts';

const CUSTOMER_EMAIL = 'bidder.55557001@example.test';
const LISTING_TITLE = 'Silk Abaya';
const LISTING_REFERENCE = 'l_test';

function assertCustomerMailCopy(mail: { subject: string; text: string }, options?: { productLink?: boolean }) {
  assert.match(mail.subject, new RegExp(LISTING_TITLE, 'i'));
  assert.match(mail.text, new RegExp(LISTING_TITLE, 'i'));
  if (options?.productLink) {
    assert.match(mail.text, new RegExp(`/product/${LISTING_REFERENCE}`));
  }
  assert.doesNotMatch(mail.subject, /\blot\b/i);
  assert.doesNotMatch(mail.text, /\blot\b/i);
  assert.doesNotMatch(mail.subject, /lot_/i);
  assert.doesNotMatch(mail.text, /lot_/i);
}

let handle: DbHandle;
let running: RunningServer;
let config: AppConfig;
let baseUrl: string;
let admin: TestClient;
let customer: TestClient;

before(async () => {
  config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    PORT: '0',
    MONGODB_DB: 'mail_auction_test',
    CORS_ORIGINS: 'http://localhost:3000',
    LOG_LEVEL: 'error',
    ADMIN_BOOTSTRAP_TOKEN: 'mail-auction-integration-token',
  });
  handle = await connectDb(config);
  await ensureIndexes(handle.db);
  await handle.db.collection(COLLECTIONS.users).deleteMany({});
  await handle.db.collection(COLLECTIONS.sessions).deleteMany({});
  await handle.db.collection(COLLECTIONS.listings).deleteMany({ listingReference: 'l_test' });
  await handle.db.collection(COLLECTIONS.listings).insertOne({
    listingReference: 'l_test',
    slug: 'silk-abaya',
    title: { en: 'Silk Abaya', ar: null },
  });
  await bootstrapSuperAdmin(
    handle.db,
    { fullName: 'Mail Auction Admin', phone: '55558000', password: 'mail auction admin pw 1' },
    { expectedToken: 'mail-auction-integration-token', confirmToken: 'mail-auction-integration-token' },
  );
  running = await startServer({ config, logger: silentLogger(), db: handle });
  baseUrl = `http://127.0.0.1:${running.port}`;
  admin = new TestClient(baseUrl);
  await admin.bootstrap();
  const login = await admin.post('/api/auth/login', { identifier: '55558000', password: 'mail auction admin pw 1' });
  if (login.status !== 200) throw new Error(`admin login failed: ${JSON.stringify(login.body)}`);
  const enroll = await admin.post('/api/auth/mfa/enroll', {});
  if (enroll.status !== 200) throw new Error(`admin enroll failed: ${JSON.stringify(enroll.body)}`);
  const confirm = await admin.post('/api/auth/mfa/enroll/confirm', {
    code: generateTotp((enroll.body as { secret: string }).secret),
  });
  if (confirm.status !== 200) throw new Error(`admin confirm failed: ${JSON.stringify(confirm.body)}`);
  const auth = createAuthService({ db: handle.db, config, logger: silentLogger() });
  const ctx = { ip: null, userAgent: null };
  const reg = await auth.register(
    {
      fullName: 'Mail Auction Customer',
      phone: '55558001',
      email: CUSTOMER_EMAIL,
      password: 'z9hybridpw57',
      termsAccepted: true,
    },
    ctx,
  );
  await auth.verifyEmail(reg.verifyToken);
  customer = new TestClient(baseUrl);
  await customer.bootstrap();
  const c1 = await customer.post('/api/auth/login', { identifier: '55558001', password: 'z9hybridpw57' });
  if (c1.status !== 200) throw new Error('customer login failed');
  await satisfyCustomerMfa(customer);
});

after(async () => {
  await running?.stop();
});

async function openAuction(endsInMs: number, startsInMs = -1000) {
  const now = Date.now();
  const created = await admin.post<{ auction: { lotReference: string; version: number } }>('/api/admin/auctions', {
    listingReference: 'l_test',
    startingBidMinor: 10000,
    incrementMinor: 500,
    startsAt: new Date(now + startsInMs).toISOString(),
    endsAt: new Date(now + endsInMs).toISOString(),
  });
  assert.equal(created.status, 201);
  const lot = created.body.auction.lotReference;
  const opened = await admin.post<{ auction: { status: string; version: number } }>(`/api/admin/auctions/${lot}/open`);
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  return { lot, version: opened.body.auction.version };
}

test('processMailJobs captures winner and lot-ending mail in test mode', async () => {
  mailCaptures.length = 0;

  const endsInMs = 40 * 60 * 1000;
  const { lot, version } = await openAuction(endsInMs);
  const bid = await customer.post(`/api/auctions/${lot}/bids`, { amountMinor: 10000, expectedVersion: version });
  assert.equal(bid.status, 201);

  const liveRow = await handle.db.collection(COLLECTIONS.auctions).findOne({ lotReference: lot });
  assert.ok(liveRow?.endsAt);
  const endsAt = liveRow.endsAt as Date;
  const endingDue = new Date(endsAt.getTime() - 30 * 60 * 1000 + 1000);
  const endingProcessed = await processMailJobs({
    db: handle.db,
    config,
    owner: 'mail-auction-ending',
    now: endingDue,
  });
  assert.ok(endingProcessed >= 1);
  assert.equal(mailCaptures.length, 1);
  const endingMail = mailCaptures[0];
  assert.ok(endingMail);
  assert.equal(endingMail.to, CUSTOMER_EMAIL);
  assert.match(endingMail.subject, /ending soon/i);
  assert.match(endingMail.text, /high bidder/i);
  assertCustomerMailCopy(endingMail, { productLink: true });
  const endingLog = await handle.db.collection(COLLECTIONS.emailLogs).findOne({
    purpose: MAIL_JOB_TYPES.lotEnding,
    to: CUSTOMER_EMAIL,
  });
  assert.equal(endingLog?.listingReference, LISTING_REFERENCE);
  assert.equal(endingLog?.lotReference, lot);

  const closed = await admin.post<{ auction: { orderReference: string } }>(
    `/api/admin/auctions/${lot}/close`,
    { reason: 'deadline', confirm: true },
  );
  assert.equal(closed.status, 200);
  const orderReference = closed.body.auction.orderReference;
  assert.ok(orderReference);

  const jobs = await handle.db
    .collection(COLLECTIONS.durableJobs)
    .find({ key: lot, type: { $in: [MAIL_JOB_TYPES.winnerWon, MAIL_JOB_TYPES.winnerAction] } })
    .toArray();
  assert.equal(jobs.length, 2);
  const won = jobs.find((row) => row.type === MAIL_JOB_TYPES.winnerWon);
  const action = jobs.find((row) => row.type === MAIL_JOB_TYPES.winnerAction);
  assert.ok(won && action);

  await handle.db.collection(COLLECTIONS.durableJobs).updateOne(
    { jobId: won.jobId },
    { $set: { runAfter: new Date(0) } },
  );
  await handle.db.collection(COLLECTIONS.durableJobs).updateOne(
    { jobId: action.jobId },
    { $set: { runAfter: new Date(1) } },
  );

  const beforeWinner = mailCaptures.length;
  const winnerProcessed = await processMailJobs({ db: handle.db, config, owner: 'mail-auction-winner', now: new Date() });
  assert.ok(winnerProcessed >= 2);
  assert.equal(mailCaptures.length, beforeWinner + 2);
  const wonMail = mailCaptures[beforeWinner];
  const actionMail = mailCaptures[beforeWinner + 1];
  assert.ok(wonMail);
  assert.ok(actionMail);
  assert.match(wonMail.subject, /You won the auction for Silk Abaya/i);
  assert.match(actionMail.subject, /Reminder: complete payment for Silk Abaya/i);
  assertCustomerMailCopy(wonMail, { productLink: true });
  assertCustomerMailCopy(actionMail, { productLink: true });
  assert.doesNotMatch(actionMail.text, /\/account/);
  assert.doesNotMatch(wonMail.text, /\/account/);

  const wonLog = await handle.db.collection(COLLECTIONS.emailLogs).findOne({
    purpose: MAIL_JOB_TYPES.winnerWon,
    to: CUSTOMER_EMAIL,
  });
  assert.equal(wonLog?.listingReference, LISTING_REFERENCE);
  assert.equal(wonLog?.lotReference, lot);

  const paid = await customer.post('/api/payments/complete', { orderReference });
  assert.equal(paid.status, 200);

  await handle.db.collection(COLLECTIONS.durableJobs).updateOne(
    { jobId: action.jobId },
    {
      $set: {
        state: 'pending',
        runAfter: new Date(0),
        leaseOwner: null,
        leaseUntil: null,
        completedAt: null,
      },
    },
  );
  const beforePaidRetry = mailCaptures.length;
  const paidRetryProcessed = await processMailJobs({
    db: handle.db,
    config,
    owner: 'mail-auction-paid-skip',
    now: new Date(),
  });
  assert.ok(paidRetryProcessed >= 1);
  assert.equal(mailCaptures.length, beforePaidRetry);

  const { lot: noBidLot } = await openAuction(endsInMs);
  const noBidRow = await handle.db.collection(COLLECTIONS.auctions).findOne({ lotReference: noBidLot });
  assert.ok(noBidRow?.endsAt);
  const noBidDue = new Date((noBidRow.endsAt as Date).getTime() - 30 * 60 * 1000 + 1000);
  const beforeNoBid = mailCaptures.length;
  await processMailJobs({ db: handle.db, config, owner: 'mail-auction-no-bid', now: noBidDue });
  assert.equal(mailCaptures.length, beforeNoBid);
  const noBidEndingJob = await handle.db.collection(COLLECTIONS.durableJobs).findOne({
    type: MAIL_JOB_TYPES.lotEnding,
    key: noBidLot,
  });
  assert.ok(noBidEndingJob);
  assert.notEqual(noBidEndingJob.state, 'succeeded');

  const { lot: closedLot } = await openAuction(endsInMs);
  const closedEarly = await admin.post(`/api/admin/auctions/${closedLot}/close`, { reason: 'deadline', confirm: true });
  assert.equal(closedEarly.status, 200);
  const closedRow = await handle.db.collection(COLLECTIONS.auctions).findOne({ lotReference: closedLot });
  assert.ok(closedRow?.endsAt);
  const closedDue = new Date((closedRow.endsAt as Date).getTime() - 30 * 60 * 1000 + 1000);
  const beforeClosedEnding = mailCaptures.length;
  await processMailJobs({ db: handle.db, config, owner: 'mail-auction-closed-ending', now: closedDue });
  assert.equal(mailCaptures.length, beforeClosedEnding);
});
