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
import { io, type Socket } from 'socket.io-client';
import { signPaymentBody } from '../../src/modules/orders/service.ts';

let handle: DbHandle;
let running: RunningServer;
let config: AppConfig;
let baseUrl: string;
let admin: TestClient;
let customer: TestClient;
let other: TestClient;

before(async () => {
  config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    PORT: '0',
    MONGODB_DB: 'auctions_phase06',
    CORS_ORIGINS: 'http://localhost:3000',
    LOG_LEVEL: 'error',
    ADMIN_BOOTSTRAP_TOKEN: 'auction-integration-token',
  });
  handle = await connectDb(config);
  await ensureIndexes(handle.db);
  await handle.db.collection(COLLECTIONS.users).deleteMany({});
  await handle.db.collection(COLLECTIONS.sessions).deleteMany({});
  await bootstrapSuperAdmin(
    handle.db,
    { fullName: 'Catalog Admin', phone: '55557000', password: 'auction admin pw 1' },
    { expectedToken: 'auction-integration-token', confirmToken: 'auction-integration-token' },
  );
  running = await startServer({ config, logger: silentLogger(), db: handle });
  baseUrl = `http://127.0.0.1:${running.port}`;
  admin = new TestClient(baseUrl);
  await admin.bootstrap();
  const login = await admin.post('/api/auth/login', { identifier: '55557000', password: 'auction admin pw 1' });
  if (login.status !== 200) throw new Error(`admin login failed: ${JSON.stringify(login.body)}`);
  const enroll = await admin.post('/api/auth/mfa/enroll', {});
  if (enroll.status !== 200) throw new Error(`admin enroll failed: ${JSON.stringify(enroll.body)}`);
  const confirm = await admin.post('/api/auth/mfa/enroll/confirm', { code: generateTotp((enroll.body as { secret: string }).secret) });
  if (confirm.status !== 200) throw new Error(`admin confirm failed: ${JSON.stringify(confirm.body)}`);
  const auth = createAuthService({ db: handle.db, config, logger: silentLogger() });
  const ctx = { ip: null, userAgent: null };
  await auth.register({ fullName: 'Auction Customer', phone: '55557001', password: 'auction customer pw 1', termsAccepted: true }, ctx);
  await auth.register({ fullName: 'Auction Customer 2', phone: '55557002', password: 'auction customer pw 2', termsAccepted: true }, ctx);
  customer = new TestClient(baseUrl);
  other = new TestClient(baseUrl);
  await customer.bootstrap();
  await other.bootstrap();
  const c1 = await customer.post('/api/auth/login', { identifier: '55557001', password: 'auction customer pw 1' });
  const c2 = await other.post('/api/auth/login', { identifier: '55557002', password: 'auction customer pw 2' });
  if (c1.status !== 200 || c2.status !== 200) throw new Error('customer login failed');
  await satisfyCustomerMfa(customer);
  await satisfyCustomerMfa(other);
});

after(async () => {
  await running?.stop();
});

/** Push all bids on a lot outside the per-user cooldown window (integration tests only). */
async function clearBidCooldown(lot: string) {
  await handle.db.collection(COLLECTIONS.bids).updateMany(
    { lotReference: lot },
    { $set: { acceptedAt: new Date(Date.now() - 61_000) } },
  );
}

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
  assert.equal(opened.status, 200);
  return { lot, version: opened.body.auction.version, status: opened.body.auction.status };
}

test('admin auction list and detail by listing reference', async () => {
  const { lot } = await openAuction(60_000);
  const listed = await admin.get<{ auctions: Array<{ lotReference: string; listingReference: string }> }>(
    '/api/admin/auctions?listingReference=l_test&limit=50',
  );
  assert.equal(listed.status, 200);
  assert.ok(listed.body.auctions.some((row) => row.lotReference === lot));
  assert.ok(listed.body.auctions.every((row) => row.listingReference === 'l_test'));
  const detail = await admin.get<{ auction: { lotReference: string; closedAt: string | null } }>(`/api/admin/auctions/${lot}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.auction.lotReference, lot);
  assert.equal(detail.body.auction.closedAt, null);
});

test('F01 first, later and above-minimum bids', async () => {
  const { lot, version } = await openAuction(60_000);
  const first = await customer.post(`/api/auctions/${lot}/bids`, { amountMinor: 10000, expectedVersion: version });
  assert.equal(first.status, 201);
  const cooldown = await customer.post<{ error: { message: string; details: { retryAfterMs: number } } }>(
    `/api/auctions/${lot}/bids`,
    { amountMinor: 12000, expectedVersion: version + 1 },
  );
  assert.equal(cooldown.status, 422);
  assert.match(cooldown.body.error.message, /wait before bidding again/i);
  assert.ok(cooldown.body.error.details.retryAfterMs > 0);
  await clearBidCooldown(lot);
  const above = await customer.post(`/api/auctions/${lot}/bids`, { amountMinor: 12000, expectedVersion: version + 1 });
  assert.equal(above.status, 201);
  await clearBidCooldown(lot);
  const low = await customer.post(`/api/auctions/${lot}/bids`, { amountMinor: 12100, expectedVersion: version + 2 });
  assert.equal(low.status, 422);
});

test('bid cooldown rejects immediate repeat from same user', async () => {
  const { lot, version } = await openAuction(60_000);
  const first = await customer.post(`/api/auctions/${lot}/bids`, { amountMinor: 10000, expectedVersion: version });
  assert.equal(first.status, 201);
  const blocked = await customer.post<{ error: { details: { retryAfterMs: number; nextBidAt: string } } }>(
    `/api/auctions/${lot}/bids`,
    { amountMinor: 10500, expectedVersion: version + 1 },
  );
  assert.equal(blocked.status, 422);
  assert.ok(blocked.body.error.details.retryAfterMs <= 60_000);
  assert.ok(blocked.body.error.details.nextBidAt);
  const otherBid = await other.post(`/api/auctions/${lot}/bids`, { amountMinor: 10500, expectedVersion: version + 1 });
  assert.equal(otherBid.status, 201);
  await clearBidCooldown(lot);
  const afterCooldown = await customer.post(`/api/auctions/${lot}/bids`, { amountMinor: 11000, expectedVersion: version + 2 });
  assert.equal(afterCooldown.status, 201);
});

test('public auction GET links listing and recent bids', async () => {
  const { lot, version } = await openAuction(60_000);
  await customer.post(`/api/auctions/${lot}/bids`, { amountMinor: 10000, expectedVersion: version });
  const view = await customer.get<{ auction: { listingReference: string; recentBids: Array<{ bidderLabel: string; amountMinor: number; sequence: number; isMine?: boolean }> } }>(`/api/auctions/${lot}`);
  assert.equal(view.status, 200);
  assert.ok(view.body.auction.listingReference.length > 0);
  assert.equal(view.body.auction.recentBids.length, 1);
  const top = view.body.auction.recentBids[0];
  assert.ok(top);
  assert.equal(top.amountMinor, 10000);
  assert.match(top.bidderLabel, /^Bidder /);
  assert.equal(top.isMine, true);
  assert.equal(JSON.stringify(view.body).includes('userReference'), false);
});

test('admin can list all bids for a lot with user references', async () => {
  const { lot, version } = await openAuction(60_000);
  await customer.post(`/api/auctions/${lot}/bids`, { amountMinor: 10000, expectedVersion: version });
  await clearBidCooldown(lot);
  await other.post(`/api/auctions/${lot}/bids`, { amountMinor: 10500, expectedVersion: version + 1 });
  const denied = await customer.get(`/api/admin/auctions/${lot}/bids`);
  assert.equal(denied.status, 403);
  const listed = await admin.get<{ bids: Array<{ sequence: number; userReference: string; bidderLabel: string; fullName: string | null; amountMinor: number; acceptedAt: string }> }>(`/api/admin/auctions/${lot}/bids`);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.bids.length, 2);
  assert.deepEqual(listed.body.bids.map((row) => row.sequence).sort(), [1, 2]);
  assert.ok(listed.body.bids.every((row) => row.userReference.length > 0));
  assert.ok(listed.body.bids.every((row) => row.bidderLabel.startsWith('Bidder ')));
  assert.ok(listed.body.bids.some((row) => row.fullName && row.fullName.length > 0));
});

test('recent bids rank by highest amount and mark viewer bids', async () => {
  const { lot, version } = await openAuction(60_000);
  await customer.post(`/api/auctions/${lot}/bids`, { amountMinor: 10000, expectedVersion: version });
  await clearBidCooldown(lot);
  await other.post(`/api/auctions/${lot}/bids`, { amountMinor: 10500, expectedVersion: version + 1 });
  await clearBidCooldown(lot);
  await customer.post(`/api/auctions/${lot}/bids`, { amountMinor: 11000, expectedVersion: version + 2 });
  const mine = await customer.get<{ auction: { recentBids: Array<{ amountMinor: number; sequence: number; isMine?: boolean }> } }>(`/api/auctions/${lot}`);
  assert.equal(mine.status, 200);
  assert.deepEqual(
    mine.body.auction.recentBids.map((row) => row.amountMinor),
    [11000, 10500, 10000],
  );
  const topMine = mine.body.auction.recentBids.find((row) => row.amountMinor === 11000);
  assert.equal(topMine?.isMine, true);
  const stranger = await other.get<{ auction: { recentBids: Array<{ amountMinor: number; isMine?: boolean }> } }>(`/api/auctions/${lot}`);
  assert.equal(stranger.body.auction.recentBids[0]?.amountMinor, 11000);
  assert.equal(stranger.body.auction.recentBids.find((row) => row.amountMinor === 10500)?.isMine, true);
  assert.equal(stranger.body.auction.recentBids.find((row) => row.amountMinor === 10000)?.isMine, false);
});

test('F02 early, late, staff and unsafe bids fail', async () => {
  const future = await openAuction(120_000, 60_000);
  assert.equal(future.status, 'scheduled');
  const early = await customer.post(`/api/auctions/${future.lot}/bids`, { amountMinor: 10000, expectedVersion: future.version });
  assert.equal(early.status, 409);
  const live = await openAuction(60_000);
  await handle.db.collection(COLLECTIONS.auctions).updateOne({ lotReference: live.lot }, { $set: { endsAt: new Date(Date.now() - 1000) } });
  const late = await customer.post(`/api/auctions/${live.lot}/bids`, { amountMinor: 10000, expectedVersion: live.version });
  assert.equal(late.status, 409);
  const staff = await admin.post(`/api/auctions/${live.lot}/bids`, { amountMinor: 10000, expectedVersion: live.version });
  assert.equal(staff.status, 403);
  const bad = await customer.post(`/api/auctions/${live.lot}/bids`, { amountMinor: 1.5, expectedVersion: live.version });
  assert.equal(bad.status, 422);
});

test('F03 stale version conflicts with current state', async () => {
  const { lot, version } = await openAuction(60_000);
  await customer.post(`/api/auctions/${lot}/bids`, { amountMinor: 10000, expectedVersion: version });
  const stale = await customer.post<{ error: { details: { auction: { version: number } } } }>(`/api/auctions/${lot}/bids`, { amountMinor: 11000, expectedVersion: version });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.details.auction.version, version + 1);
});

test('F04 and F05 idempotency', async () => {
  const { lot, version } = await openAuction(60_000);
  const headers = { 'idempotency-key': `bid-${lot}` };
  const first = await customer.post(`/api/auctions/${lot}/bids`, { amountMinor: 10000, expectedVersion: version }, { headers });
  const replay = await customer.post(`/api/auctions/${lot}/bids`, { amountMinor: 10000, expectedVersion: version }, { headers });
  assert.equal(first.status, 201);
  assert.equal(replay.status, 200);
  const changed = await customer.post(`/api/auctions/${lot}/bids`, { amountMinor: 15000, expectedVersion: version + 1 }, { headers });
  assert.equal(changed.status, 409);
  const count = await handle.db.collection(COLLECTIONS.bids).countDocuments({ lotReference: lot });
  assert.equal(count, 1);
});

test('F07 F08 F09 concurrent bids keep one sequence', async () => {
  const { lot, version } = await openAuction(60_000);
  const attempts = await Promise.all(Array.from({ length: 100 }, () =>
    customer.post(`/api/auctions/${lot}/bids`, { amountMinor: 10000, expectedVersion: version })));
  assert.equal(attempts.filter((item) => item.status === 201).length, 1);
  let current = version + 1;
  for (let i = 0; i < 5; i += 1) {
    const bid = await other.post<{ auction: { version: number } }>(`/api/auctions/${lot}/bids`, { amountMinor: 10000 + (i + 1) * 500, expectedVersion: current });
    assert.equal(bid.status, 201);
    current = bid.body.auction.version;
    await clearBidCooldown(lot);
  }
  const rows = await handle.db.collection(COLLECTIONS.bids).find({ lotReference: lot }).sort({ sequence: 1 }).toArray();
  const auction = await handle.db.collection(COLLECTIONS.auctions).findOne({ lotReference: lot });
  assert.deepEqual(rows.map((row) => row.sequence), [1, 2, 3, 4, 5, 6]);
  assert.equal(auction?.bidCount, 6);
  assert.equal(auction?.currentAmountMinor, 10000 + 5 * 500);
});

test('F06 F10 F11 F12 close races and no-bid close', async () => {
  const empty = await openAuction(60_000);
  const closedEmpty = await admin.post<{ auction: { outcome: string; orderReference: string | null } }>(`/api/admin/auctions/${empty.lot}/close`, { reason: 'deadline', confirm: true });
  assert.equal(closedEmpty.body.auction.outcome, 'no_bids');
  assert.equal(closedEmpty.body.auction.orderReference, null);
  const again = await admin.post(`/api/admin/auctions/${empty.lot}/close`, { reason: 'deadline', confirm: true });
  assert.equal(again.status, 200);

  const live = await openAuction(60_000);
  const [bid, close] = await Promise.all([
    customer.post(`/api/auctions/${live.lot}/bids`, { amountMinor: 10000, expectedVersion: live.version }),
    admin.post(`/api/admin/auctions/${live.lot}/close`, { reason: 'deadline', confirm: true }),
  ]);
  const statuses = [bid.status, close.status].sort();
  assert.ok(statuses.includes(200) || statuses.includes(201));
  const auction = await handle.db.collection(COLLECTIONS.auctions).findOne({ lotReference: live.lot });
  const bidCount = await handle.db.collection(COLLECTIONS.bids).countDocuments({ lotReference: live.lot });
  assert.equal(auction?.status, 'closed');
  assert.equal(auction?.bidCount, bidCount);
  if (bidCount === 1) assert.equal(auction?.orderReference, `ord_${live.lot}`);
  if (bidCount === 0) assert.equal(auction?.winningUserReference, null);
});

test('F13 F14 late worker cannot accept a bid after the deadline', async () => {
  const live = await openAuction(60_000);
  await handle.db.collection(COLLECTIONS.auctions).updateOne({ lotReference: live.lot }, { $set: { endsAt: new Date(Date.now() - 5) } });
  const late = await customer.post(`/api/auctions/${live.lot}/bids`, { amountMinor: 10000, expectedVersion: live.version });
  assert.equal(late.status, 409);
  const reconciled = await admin.post<{ closed: string[] }>('/api/admin/auctions/reconcile');
  assert.equal(reconciled.status, 200);
  assert.ok(reconciled.body.closed.includes(live.lot));
  const after = await customer.post(`/api/auctions/${live.lot}/bids`, { amountMinor: 10000, expectedVersion: live.version + 1 });
  assert.notEqual(after.status, 201);
});

test('F15 F16 accepted bids stay immutable and reserves stay absent', async () => {
  const { lot, version } = await openAuction(60_000);
  await customer.post(`/api/auctions/${lot}/bids`, { amountMinor: 10000, expectedVersion: version });
  const edited = await admin.request('PATCH', `/api/admin/auctions/${lot}/bids/1`, { amountMinor: 1 });
  const removed = await admin.request('DELETE', `/api/admin/auctions/${lot}/bids/1`);
  assert.equal(edited.status, 405);
  assert.equal(removed.status, 405);
  const view = await customer.get<Record<string, unknown>>(`/api/auctions/${lot}`);
  assert.equal(JSON.stringify(view.body).includes('reserve'), false);
  assert.equal(JSON.stringify(view.body).includes('proxy'), false);
});

function connectSocket(): Promise<Socket> {
  const socket = io(baseUrl, { transports: ['websocket'], reconnection: false });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket timeout')), 8000);
    socket.on('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.on('connect_error', (err) => { clearTimeout(timer); reject(err); });
  });
}

test('G01 G03 G04 G05 G09 G11 live events follow the committed bid', async () => {
  const { lot, version } = await openAuction(60_000);
  const first = await connectSocket();
  const second = await connectSocket();
  const seen: Array<{ eventId: string; version: number; type: string; data: unknown }> = [];
  let left = 0;
  let right = 0;
  const take = (side: 'left' | 'right') => (event: { eventId: string; version: number; type: string; auctionId: string; data: unknown }) => {
    if (event.auctionId !== lot || event.type !== 'auction.bid.accepted') return;
    if (side === 'left') left += 1;
    else right += 1;
    if (!seen.some((row) => row.eventId === event.eventId)) seen.push(event);
  };
  first.on('auction', take('left'));
  second.on('auction', take('right'));
  first.emit('join', 'auctions');
  second.emit('join', lot);
  const refused = new Promise<string>((resolve) => first.once('join.error', (body: { message: string }) => resolve(body.message)));
  first.emit('join', 'user:someone-else');
  assert.equal(await refused, 'Room refused');
  const rejected = await customer.post(`/api/auctions/${lot}/bids`, { amountMinor: 1, expectedVersion: version });
  assert.equal(rejected.status, 422);
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(left + right, 0);
  const accepted = await customer.post(`/api/auctions/${lot}/bids`, { amountMinor: 10000, expectedVersion: version });
  assert.equal(accepted.status, 201);
  const deadline = Date.now() + 5000;
  while ((left < 1 || right < 1) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(left, 1);
  assert.equal(right, 1);
  assert.equal(seen.length, 1);
  const raw = JSON.stringify(seen);
  assert.equal(raw.includes('userReference'), false);
  assert.equal(raw.includes('reserve'), false);
  first.disconnect();
  second.disconnect();
  const again = await customer.get<{ auction: { version: number; endsAt: string } }>(`/api/auctions/${lot}`);
  assert.ok(again.body.auction.version >= version);
  assert.ok(again.body.auction.endsAt);
});

test('H01-H12 sold order, winner payment, and commission', async () => {
  const sold = await openAuction(60_000);
  const bid = await customer.post(`/api/auctions/${sold.lot}/bids`, { amountMinor: 10000, expectedVersion: sold.version });
  assert.equal(bid.status, 201);
  const closed = await admin.post<{ auction: { orderReference: string } }>(`/api/admin/auctions/${sold.lot}/close`, { reason: 'deadline', confirm: true });
  const orderReference = closed.body.auction.orderReference;
  assert.equal(orderReference, `ord_${sold.lot}`);
  await admin.post(`/api/admin/auctions/${sold.lot}/close`, { reason: 'deadline', confirm: true });
  assert.equal(await handle.db.collection(COLLECTIONS.orders).countDocuments({ orderReference }), 1);

  const stranger = await other.get(`/api/orders/${orderReference}`);
  assert.equal(stranger.status, 404);
  const owner = await customer.get<{ order: { winningPriceMinor: number; commissionAmountMinor: number } }>(`/api/orders/${orderReference}`);
  assert.equal(owner.status, 200);
  assert.equal(owner.body.order.winningPriceMinor, 10000);
  assert.equal(JSON.stringify(owner.body).includes('sellerNet'), false);
  assert.equal(JSON.stringify(owner.body).includes('commission'), false);

  const tampered = await customer.post<{ order: { paymentState: string; winningPriceMinor: number } }>('/api/payments/complete', {
    orderReference,
    amountMinor: 1,
    currency: 'USD',
    winnerUserReference: 'u_someone',
  });
  assert.equal(tampered.status, 200);
  assert.equal(tampered.body.order.paymentState, 'paid');
  assert.equal(tampered.body.order.winningPriceMinor, 10000);
  assert.equal(await handle.db.collection(COLLECTIONS.financialEntries).countDocuments({ orderReference }), 1);
  await customer.post('/api/payments/complete', { orderReference });
  assert.equal(await handle.db.collection(COLLECTIONS.financialEntries).countDocuments({ orderReference }), 1);

  const exact = await openAuction(60_000);
  await handle.db.collection(COLLECTIONS.auctions).updateOne({ lotReference: exact.lot }, { $set: { startingBidMinor: 200_000 } });
  const exactBid = await other.post(`/api/auctions/${exact.lot}/bids`, { amountMinor: 200_000, expectedVersion: exact.version });
  assert.equal(exactBid.status, 201);
  await admin.post(`/api/admin/auctions/${exact.lot}/close`, { reason: 'deadline', confirm: true });
  const exactOrder = await other.get(`/api/orders/ord_${exact.lot}`);
  assert.equal(JSON.stringify(exactOrder.body).includes('sellerNet'), false);
  const storedExact = await handle.db.collection(COLLECTIONS.orders).findOne({ orderReference: `ord_${exact.lot}` });
  assert.equal(storedExact?.sellerNetAmountMinor, 0);
  assert.equal(storedExact?.sellerNetStatus, 'blocked');
  assert.equal(storedExact?.commissionAmountMinor, 200_000);

  const payable = await openAuction(60_000);
  await customer.post(`/api/auctions/${payable.lot}/bids`, { amountMinor: 10000, expectedVersion: payable.version });
  await admin.post(`/api/admin/auctions/${payable.lot}/close`, { reason: 'deadline', confirm: true });
  const ref = `ord_${payable.lot}`;
  const payload = { orderReference: ref, amountMinor: 10000, currency: 'QAR', eventId: `evt-${payable.lot}`, status: 'succeeded' as const };
  const forged = await customer.post('/api/payments/webhooks/manual', payload, { headers: { 'x-payment-signature': 'nope' } });
  assert.equal(forged.status, 403);
  const mismatch = { ...payload, amountMinor: 50, eventId: `bad-${payable.lot}` };
  const mismatched = await customer.post('/api/payments/webhooks/manual', mismatch, { headers: { 'x-payment-signature': signPaymentBody('dev-payment-webhook-secret', mismatch) } });
  assert.equal(mismatched.status, 422);
  const signed = await customer.post('/api/payments/webhooks/manual', payload, { headers: { 'x-payment-signature': signPaymentBody('dev-payment-webhook-secret', payload) } });
  assert.equal(signed.status, 200);
  await customer.post('/api/payments/webhooks/manual', payload, { headers: { 'x-payment-signature': signPaymentBody('dev-payment-webhook-secret', payload) } });
  assert.equal(await handle.db.collection(COLLECTIONS.financialEntries).countDocuments({ orderReference: ref }), 1);
  const late = { ...payload, status: 'failed' as const, eventId: `late-${payable.lot}` };
  const lateResult = await customer.post<{ order: { paymentState: string } }>('/api/payments/webhooks/manual', late, { headers: { 'x-payment-signature': signPaymentBody('dev-payment-webhook-secret', late) } });
  assert.equal(lateResult.body.order.paymentState, 'paid');
  const reconciled = await admin.post('/api/payments/reconcile', { orderReference: ref, eventId: `evt-${payable.lot}`, status: 'succeeded' });
  assert.equal(reconciled.status, 200);
  assert.equal(await handle.db.collection(COLLECTIONS.financialEntries).countDocuments({ orderReference: ref }), 1);
  const stored = await handle.db.collection(COLLECTIONS.orders).findOne({ orderReference: ref });
  assert.equal(JSON.stringify(stored).includes('card'), false);
});

test('I01-I12 finance summary is platform revenue; seller settlements disabled', async () => {
  const denied = await customer.get('/api/admin/finance/summary');
  assert.equal(denied.status, 403);
  const summary = await admin.get<{
    definitions: { collectedRevenueMinor: string };
    collectedRevenueMinor: number;
    unpaidWins: number;
    unsettledPayableMinor: number;
  }>('/api/admin/finance/summary');
  assert.equal(summary.status, 200);
  assert.match(summary.body.definitions.collectedRevenueMinor, /platform revenue/i);
  assert.equal(summary.body.unsettledPayableMinor, 0);
  const before = summary.body.collectedRevenueMinor;

  const live = await openAuction(60_000);
  await customer.post(`/api/auctions/${live.lot}/bids`, { amountMinor: 15000, expectedVersion: live.version });
  await admin.post(`/api/admin/auctions/${live.lot}/close`, { reason: 'deadline', confirm: true });
  const orderReference = `ord_${live.lot}`;
  const unpaidSettle = await admin.post('/api/admin/finance/settlements', {
    orderReference,
    reason: 'seller payout attempt',
    confirm: true,
    amountMinor: 1,
  });
  assert.equal(unpaidSettle.status, 403);
  await customer.post('/api/payments/complete', { orderReference, amountMinor: 1 });
  const settled = await admin.post('/api/admin/finance/settlements', {
    orderReference,
    reason: 'seller payout attempt',
    confirm: true,
  });
  assert.equal(settled.status, 403);
  const reversed = await admin.post('/api/admin/finance/settlements/reverse', {
    orderReference,
    reason: 'reverse attempt',
    confirm: true,
  });
  assert.equal(reversed.status, 403);
  assert.equal(await handle.db.collection(COLLECTIONS.financialEntries).countDocuments({ eventId: `settle:${orderReference}` }), 0);

  const page = await admin.get<{
    total: number;
    orders: Array<{ amountPaidMinor: number; sourceLabel: string; listingTitle: string }>;
  }>(`/api/admin/finance/orders?paymentState=paid&q=${orderReference}&page=1&limit=5`);
  assert.equal(page.status, 200);
  assert.equal(page.body.total, 1);
  assert.equal(page.body.orders[0]?.amountPaidMinor, 15000);
  assert.equal(JSON.stringify(page.body).includes('sellerNet'), false);
  assert.equal(JSON.stringify(page.body).includes('settlement'), false);

  const exported = await admin.get<string>('/api/admin/finance/export');
  assert.equal(exported.status, 200);
  assert.equal(String(exported.body).includes('sellerNet'), false);
  assert.equal(String(exported.body).includes('=cmd'), false);
  const after = await admin.get<{ collectedRevenueMinor: number; unsettledPayableMinor: number }>('/api/admin/finance/summary');
  assert.ok(after.body.collectedRevenueMinor >= before + 15000);
  assert.equal(after.body.unsettledPayableMinor, 0);
});

test('J01-J12 account, enquiry, and published terms', async () => {
  const mine = await customer.get<{ profile: { publicReference: string }; bids: { lotReference: string }[]; orders: { orderReference: string }[] }>('/api/account');
  assert.equal(mine.status, 200);
  assert.equal(mine.headers.get('cache-control'), 'private, no-store');
  assert.ok(mine.body.bids.length >= 1);
  assert.ok(mine.body.orders.some((order) => order.orderReference.startsWith('ord_')));
  const stranger = await other.get<{ profile: { publicReference: string } }>('/api/account');
  assert.equal(stranger.body.profile?.publicReference === mine.body.profile.publicReference, false);
  const missing = await customer.get('/api/account/favorites');
  assert.equal(missing.status, 404);

  const published = await admin.post<{ version: number }>('/api/admin/content', { key: 'terms', text: 'Draft terms for acceptance. Not counsel-approved.' });
  assert.equal(published.status, 201);
  const updated = await admin.post<{ version: number }>('/api/admin/content', { key: 'terms', text: 'Updated draft terms. Not counsel-approved.' });
  const shown = await customer.get<{ version: number; body: string }>('/api/content/terms');
  assert.equal(shown.body.version, updated.body.version);
  assert.match(shown.body.body, /Updated draft/);
  const stale = await customer.post('/api/account/terms', { version: published.body.version });
  assert.equal(stale.status, 422);
  const accepted = await customer.post<{ termsVersion: string }>('/api/account/terms', { version: updated.body.version });
  assert.equal(accepted.body.termsVersion, String(updated.body.version));

  const sent = await customer.post<{ reference: string }>('/api/enquiries', {
    name: 'Buyer', email: 'buyer@example.com', subject: 'A listing', message: 'Please tell me about this lot.',
  });
  assert.equal(sent.status, 201);
  const inbox = await admin.get<{ enquiries: { reference: string }[] }>('/api/admin/enquiries');
  assert.equal(inbox.body.enquiries.some((item) => item.reference === sent.body.reference), true);
  const hidden = await customer.get('/api/admin/enquiries');
  assert.equal(hidden.status, 403);

  const sid = customer.cookie('sid');
  assert.ok(sid);
  const authed = io(baseUrl, { transports: ['websocket'], reconnection: false, extraHeaders: { cookie: `sid=${sid}` } });
  await new Promise<void>((resolve, reject) => {
    authed.once('connect', () => resolve());
    authed.once('connect_error', reject);
  });
  const before = Promise.race([
    new Promise<string>((resolve) => authed.once('join.error', () => resolve('refused'))),
    new Promise<string>((resolve) => setTimeout(() => resolve('joined'), 400)),
  ]);
  authed.emit('join', 'me');
  assert.equal(await before, 'joined');
  const dropped = new Promise<void>((resolve) => authed.once('disconnect', () => resolve()));
  await customer.post('/api/auth/logout');
  await dropped;
  const revokedSocket = io(baseUrl, { transports: ['websocket'], reconnection: false, extraHeaders: { cookie: `sid=${sid}` } });
  await new Promise<void>((resolve, reject) => {
    revokedSocket.once('connect', () => resolve());
    revokedSocket.once('connect_error', reject);
  });
  const refused = new Promise<string>((resolve) => revokedSocket.once('join.error', (body: { message: string }) => resolve(body.message)));
  revokedSocket.emit('join', 'me');
  assert.equal(await refused, 'Room refused');
  revokedSocket.disconnect();
});
