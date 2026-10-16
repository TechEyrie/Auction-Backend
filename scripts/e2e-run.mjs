/**
 * Dual-actor E2E against local servers (docs/E2E_TEST_PLAN.md order: 8→7→2→3→1→6→4→5→9→10).
 * Usage from backend/: node --env-file-if-exists=.env scripts/e2e-run.mjs
 *
 * Env: E2E_API, E2E_STAFF_EMAIL, E2E_STAFF_PASSWORD, E2E_STAFF_TOTP
 */
import { generateTotp } from '../src/shared/totp.ts';

const API = process.env.E2E_API ?? 'http://localhost:4000';
const STAFF_EMAIL = process.env.E2E_STAFF_EMAIL ?? 'operator.dev@example.com';
const STAFF_PASSWORD = process.env.E2E_STAFF_PASSWORD ?? 'DevOperator1';
const TOTP_SECRET = process.env.E2E_STAFF_TOTP ?? '5YQ2BFAT5HZJYPNXEF557HIXSMB7P3YL';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

class Client {
  constructor() {
    this.cookies = new Map();
    this.csrf = null;
  }
  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async request(method, path, body, opts = {}) {
    const headers = { ...(opts.headers ?? {}) };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const cookie = this.cookieHeader();
    if (cookie) headers.cookie = cookie;
    if (this.csrf) headers['x-csrf-token'] = this.csrf;
    const res = await fetch(`${API}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const raw of setCookies) {
      const pair = raw.split(';')[0] ?? '';
      const idx = pair.indexOf('=');
      if (idx < 0) continue;
      const name = pair.slice(0, idx);
      let value = pair.slice(idx + 1);
      try { value = decodeURIComponent(value); } catch { /* keep */ }
      if (value === '') {
        this.cookies.delete(name);
        if (name === 'csrf') this.csrf = null;
      } else {
        this.cookies.set(name, value);
        if (name === 'csrf') this.csrf = value;
      }
    }
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: res.status, body: parsed };
  }
  get(path) { return this.request('GET', path); }
  post(path, body, opts) { return this.request('POST', path, body, opts); }
  patch(path, body) { return this.request('PATCH', path, body); }
}

const results = [];
function record(id, result, notes) {
  results.push({ id, result, notes });
  console.log(`[${result}] ${id}: ${notes}`);
}

async function staffLogin() {
  const c = new Client();
  await c.get('/api/auth/session');
  const login = await c.post('/api/auth/login', { identifier: STAFF_EMAIL, password: STAFF_PASSWORD });
  if (login.status !== 200) throw new Error(`staff login ${login.status} ${JSON.stringify(login.body)}`);
  if (login.body?.mfaRequired) {
    const code = generateTotp(TOTP_SECRET);
    const mfa = await c.post('/api/auth/mfa/challenge', { code });
    if (mfa.status !== 200) throw new Error(`staff mfa ${mfa.status} ${JSON.stringify(mfa.body)}`);
  }
  return c;
}

async function registerCustomer(label) {
  const c = new Client();
  await c.get('/api/auth/session');
  const email = `e2e.${label}.${Date.now()}@example.com`;
  const reg = await c.post('/api/auth/register', {
    fullName: `E2E ${label}`,
    email,
    password: 'BuyerPass12',
    termsAccepted: true,
  });
  if (reg.status !== 201) throw new Error(`register ${label} ${reg.status} ${JSON.stringify(reg.body)}`);
  return { client: c, email };
}

async function ensureFixtures(staff) {
  const sellersRes = await staff.get('/api/admin/sellers?status=active&limit=5');
  let seller = sellersRes.body?.sellers?.[0]?.sellerReference;
  if (!seller) {
    const created = await staff.post('/api/admin/sellers', {
      type: 'individual',
      displayName: 'E2E Seller',
      contact: { phone: `5555${String(Date.now()).slice(-6)}` },
      reason: 'E2E fixture seller',
    });
    if (created.status !== 201) throw new Error(`seller create ${created.status}`);
    const ref = created.body.seller.sellerReference;
    const activated = await staff.patch(`/api/admin/sellers/${ref}/status`, {
      status: 'active',
      reason: 'E2E activate',
    });
    if (activated.status !== 200) throw new Error(`seller activate ${activated.status}`);
    seller = ref;
  }

  const cats = await staff.get('/api/admin/categories');
  const vehicles = (cats.body?.categories ?? []).find((c) => c.key === 'vehicles');
  if (!vehicles) throw new Error('vehicles category missing — run seed');
  if (!(vehicles.listingMethods ?? []).includes('auction')) {
    const enabled = await staff.patch('/api/admin/categories/vehicles', {
      listingMethods: [...new Set([...(vehicles.listingMethods ?? []), 'auction'])],
      expectedHierarchyVersion: vehicles.hierarchyVersion,
    });
    if (enabled.status !== 200) throw new Error(`enable auction ${enabled.status} ${JSON.stringify(enabled.body)}`);
  }

  return { seller, category: 'vehicles' };
}

async function createPublishedListing(staff, seller, category, title) {
  const draft = await staff.post('/api/admin/listings', {
    sellerReference: seller,
    categoryKey: category,
    listingMethod: 'auction',
    languageMode: 'en',
    title: { en: title },
    description: { en: `Full description for ${title} so it passes validation.` },
    attributes: { make: 'Toyota', model: 'Land Cruiser', year: 2021, condition: 'used' },
    locationKey: 'qa-doha-al-sadd',
  });
  if (draft.status !== 201) throw new Error(`draft ${draft.status} ${JSON.stringify(draft.body)}`);
  const ref = draft.body.listing.listingReference;
  let version = draft.body.listing.version;
  const collectionKey = draft.body.listing.mediaCollectionKey ?? `listing_${ref}`;

  const upload = await fetch(`${API}/api/admin/media/upload`, {
    method: 'POST',
    headers: {
      'content-type': 'image/png',
      'x-collection-key': collectionKey,
      'x-csrf-token': staff.csrf,
      cookie: staff.cookieHeader(),
    },
    body: PNG,
  });
  const uploadBody = await upload.json().catch(() => ({}));
  if (!upload.ok) throw new Error(`media ${upload.status} ${JSON.stringify(uploadBody)}`);
  const assetId = uploadBody.asset.assetId;

  const patched = await staff.patch(`/api/admin/listings/${ref}`, {
    expectedVersion: version,
    media: [{ assetId, alt: { en: 'E2E photo' } }],
    coverAssetId: assetId,
  });
  if (patched.status !== 200) throw new Error(`patch ${patched.status} ${JSON.stringify(patched.body)}`);
  version = patched.body.listing.version;

  const pub = await staff.post(`/api/admin/listings/${ref}/publish`, { expectedVersion: version });
  if (pub.status !== 200) throw new Error(`publish ${pub.status} ${JSON.stringify(pub.body)}`);
  return pub.body.listing.listingReference;
}

/** endsInMs > 0 → live window; use close() for early close. */
async function openAuction(staff, listingReference, startingBidMinor, incrementMinor, endsInMs) {
  const now = Date.now();
  const created = await staff.post('/api/admin/auctions', {
    listingReference,
    startingBidMinor,
    incrementMinor,
    startsAt: new Date(now - 1000).toISOString(),
    endsAt: new Date(now + endsInMs).toISOString(),
  });
  if (created.status !== 201) throw new Error(`create auction ${created.status} ${JSON.stringify(created.body)}`);
  const lot = created.body.auction.lotReference;
  const opened = await staff.post(`/api/admin/auctions/${lot}/open`);
  if (opened.status !== 200) throw new Error(`open ${opened.status} ${JSON.stringify(opened.body)}`);
  if (opened.body.auction.status !== 'live') throw new Error(`expected live got ${opened.body.auction.status}`);
  return { lot, version: opened.body.auction.version };
}

async function forceClose(staff, lot) {
  const closed = await staff.post(`/api/admin/auctions/${lot}/close`, { reason: 'deadline', confirm: true });
  if (closed.status === 200) return closed.body.auction;
  // Already closed by reconcile worker
  const get = await staff.get(`/api/auctions/${lot}`).catch(() => null);
  if (get?.status === 200) return get.body.auction;
  const pub = await fetch(`${API}/api/auctions/${lot}`);
  return (await pub.json()).auction;
}

async function waitClosed(lot, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${API}/api/auctions/${lot}`);
    const body = await res.json();
    if (body.auction?.status === 'closed') return body.auction;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`lot ${lot} did not close`);
}

async function bid(customer, lot, amountMinor, expectedVersion) {
  return customer.post(`/api/auctions/${lot}/bids`, { amountMinor, expectedVersion }, {
    headers: { 'idempotency-key': crypto.randomUUID() },
  });
}

async function main() {
  console.log('E2E against', API);
  const staff = await staffLogin();
  record('staff-login', 'PASS', 'MFA session ok');
  const { seller, category } = await ensureFixtures(staff);
  record('fixtures', 'PASS', `seller=${seller} category=${category}`);

  const A = await registerCustomer('a');
  const B = await registerCustomer('b');
  record('register-ab', 'PASS', `${A.email} / ${B.email}`);

  // Scenario 8 — enquiry + publish + bid
  try {
    const enq = await A.client.post('/api/enquiries', {
      name: 'E2E A',
      email: A.email,
      subject: 'About a listing',
      message: 'Please prepare this for auction testing.',
    });
    if (enq.status !== 201) throw new Error(`enq ${enq.status} ${JSON.stringify(enq.body)}`);
    const inbox = await staff.get('/api/admin/enquiries');
    if (!(inbox.body.enquiries ?? []).some((e) => e.reference === enq.body.reference)) {
      throw new Error('enquiry not in inbox');
    }
    const listing8 = await createPublishedListing(staff, seller, category, `E2E S8 ${Date.now()}`);
    const { lot: lot8, version: v8 } = await openAuction(staff, listing8, 10000, 1000, 3_600_000);
    const b8 = await bid(A.client, lot8, 10000, v8);
    if (b8.status !== 201) throw new Error(`bid ${b8.status} ${JSON.stringify(b8.body)}`);
    record('S08', 'PASS', `enq=${enq.body.reference} lot=${lot8}`);
  } catch (err) {
    record('S08', 'FAIL', String(err.message ?? err));
  }

  // Scenario 7 — staff cannot bid
  try {
    const listing7 = await createPublishedListing(staff, seller, category, `E2E S7 ${Date.now()}`);
    const { lot: lot7, version: v7 } = await openAuction(staff, listing7, 10000, 1000, 3_600_000);
    const staffBid = await bid(staff, lot7, 10000, v7);
    if (staffBid.status === 201) throw new Error('staff bid was accepted');
    const custBid = await bid(A.client, lot7, 10000, v7);
    if (custBid.status !== 201) throw new Error(`customer bid ${custBid.status} ${JSON.stringify(custBid.body)}`);
    record('S07', 'PASS', `staff=${staffBid.status} customer=201 lot=${lot7}`);
  } catch (err) {
    record('S07', 'FAIL', String(err.message ?? err));
  }

  // Scenario 2 — bid race
  try {
    const listing2 = await createPublishedListing(staff, seller, category, `E2E S2 ${Date.now()}`);
    const { lot: lot2, version: v2 } = await openAuction(staff, listing2, 50000, 5000, 3_600_000);
    const a2 = await bid(A.client, lot2, 50000, v2);
    if (a2.status !== 201) throw new Error(`A ${a2.status} ${JSON.stringify(a2.body)}`);
    const state = await A.client.get(`/api/auctions/${lot2}`);
    const vNow = state.body.auction.version;
    const low = await bid(B.client, lot2, 50500, vNow);
    if (low.status === 201) throw new Error('below-minimum accepted');
    const ok = await bid(B.client, lot2, 55000, vNow);
    if (ok.status !== 201) throw new Error(`B high ${ok.status} ${JSON.stringify(ok.body)}`);
    const acctA = await A.client.get('/api/account');
    const aBids = JSON.stringify(acctA.body.bids ?? []);
    if (!aBids.includes(lot2)) throw new Error('A bids missing lot');
    record('S02', 'PASS', `lot=${lot2} low=${low.status} high=201 current=55000`);
  } catch (err) {
    record('S02', 'FAIL', String(err.message ?? err));
  }

  // Scenario 3 — outbid
  try {
    const listing3 = await createPublishedListing(staff, seller, category, `E2E S3 ${Date.now()}`);
    const { lot: lot3, version: v3 } = await openAuction(staff, listing3, 20000, 2000, 3_600_000);
    const a3 = await bid(A.client, lot3, 20000, v3);
    if (a3.status !== 201) throw new Error(`A ${a3.status}`);
    const st = await A.client.get(`/api/auctions/${lot3}`);
    const b3 = await bid(B.client, lot3, 22000, st.body.auction.version);
    if (b3.status !== 201) throw new Error(`B ${b3.status} ${JSON.stringify(b3.body)}`);
    const after = await A.client.get(`/api/auctions/${lot3}`);
    if (after.body.auction.currentAmountMinor !== 22000) {
      throw new Error(`price=${after.body.auction.currentAmountMinor}`);
    }
    record('S03', 'PASS', `lot=${lot3} current=22000`);
  } catch (err) {
    record('S03', 'FAIL', String(err.message ?? err));
  }

  // Scenario 1 — golden path
  try {
    const listing1 = await createPublishedListing(staff, seller, category, `E2E S1 ${Date.now()}`);
    const { lot: lot1, version: v1 } = await openAuction(staff, listing1, 10000, 1000, 3_600_000);
    const b1 = await bid(A.client, lot1, 10000, v1);
    if (b1.status !== 201) throw new Error(`bid ${b1.status} ${JSON.stringify(b1.body)}`);
    await forceClose(staff, lot1);
    const closed = await waitClosed(lot1);
    const ord = closed.orderReference;
    if (!ord) throw new Error('no order');
    const pay = await A.client.post('/api/payments/complete', { orderReference: ord });
    if (pay.status !== 200) throw new Error(`pay ${pay.status} ${JSON.stringify(pay.body)}`);
    const settle = await staff.post('/api/admin/finance/settlements', {
      orderReference: ord, reason: 'E2E bank transfer recorded', confirm: true,
    });
    if (settle.status !== 201 && settle.status !== 200) {
      throw new Error(`settle ${settle.status} ${JSON.stringify(settle.body)}`);
    }
    const again = await staff.post('/api/admin/finance/settlements', {
      orderReference: ord, reason: 'E2E duplicate', confirm: true,
    });
    if (again.status === 201 || again.status === 200) throw new Error('duplicate settle accepted');
    record('S01', 'PASS', `lot=${lot1} ord=${ord} settle=${settle.status} dup=${again.status}`);
  } catch (err) {
    record('S01', 'FAIL', String(err.message ?? err));
  }

  // Scenario 6 — stranger order
  try {
    const listing6 = await createPublishedListing(staff, seller, category, `E2E S6 ${Date.now()}`);
    const { lot: lot6, version: v6 } = await openAuction(staff, listing6, 10000, 1000, 3_600_000);
    await bid(A.client, lot6, 10000, v6);
    await forceClose(staff, lot6);
    const closed = await waitClosed(lot6);
    const ord = closed.orderReference;
    const owner = await A.client.get(`/api/orders/${ord}`);
    const stranger = await B.client.get(`/api/orders/${ord}`);
    if (owner.status !== 200) throw new Error(`owner ${owner.status}`);
    if (stranger.status !== 404) throw new Error(`stranger ${stranger.status}`);
    const fin = await staff.get(`/api/admin/finance/orders?q=${encodeURIComponent(ord)}&limit=5`);
    if (fin.status !== 200 || (fin.body.total ?? 0) < 1) throw new Error('staff finance missing order');
    record('S06', 'PASS', `ord=${ord} owner=200 stranger=404`);
  } catch (err) {
    record('S06', 'FAIL', String(err.message ?? err));
  }

  // Scenario 4 — unpaid settle refused
  try {
    const listing4 = await createPublishedListing(staff, seller, category, `E2E S4 ${Date.now()}`);
    const { lot: lot4, version: v4 } = await openAuction(staff, listing4, 15000, 1500, 3_600_000);
    await bid(A.client, lot4, 15000, v4);
    await forceClose(staff, lot4);
    const closed = await waitClosed(lot4);
    const ord = closed.orderReference;
    const early = await staff.post('/api/admin/finance/settlements', {
      orderReference: ord, reason: 'too early unpaid', confirm: true,
    });
    if (early.status === 201 || early.status === 200) throw new Error('settled unpaid');
    await A.client.post('/api/payments/complete', { orderReference: ord });
    const settle = await staff.post('/api/admin/finance/settlements', {
      orderReference: ord, reason: 'paid then settled', confirm: true,
    });
    if (settle.status !== 201 && settle.status !== 200) {
      throw new Error(`settle ${settle.status} ${JSON.stringify(settle.body)}`);
    }
    record('S04', 'PASS', `ord=${ord} unpaid=${early.status} settle=${settle.status}`);
  } catch (err) {
    record('S04', 'FAIL', String(err.message ?? err));
  }

  // Scenario 5 — QAR 2000 commission block
  try {
    const listing5 = await createPublishedListing(staff, seller, category, `E2E S5 ${Date.now()}`);
    const { lot: lot5, version: v5 } = await openAuction(staff, listing5, 200000, 10000, 3_600_000);
    await bid(A.client, lot5, 200000, v5);
    await forceClose(staff, lot5);
    const closed = await waitClosed(lot5);
    const ord = closed.orderReference;
    await A.client.post('/api/payments/complete', { orderReference: ord });
    const settle = await staff.post('/api/admin/finance/settlements', {
      orderReference: ord, reason: 'should be blocked at 2000', confirm: true,
    });
    if (settle.status === 201 || settle.status === 200) throw new Error('settled blocked commission');
    record('S05', 'PASS', `ord=${ord} settle=${settle.status}`);
  } catch (err) {
    record('S05', 'FAIL', String(err.message ?? err));
  }

  // Scenario 9 — settle + reverse
  try {
    const listing9 = await createPublishedListing(staff, seller, category, `E2E S9 ${Date.now()}`);
    const { lot: lot9, version: v9 } = await openAuction(staff, listing9, 10000, 1000, 3_600_000);
    await bid(A.client, lot9, 10000, v9);
    await forceClose(staff, lot9);
    const closed = await waitClosed(lot9);
    const ord = closed.orderReference;
    await A.client.post('/api/payments/complete', { orderReference: ord });
    const settle = await staff.post('/api/admin/finance/settlements', {
      orderReference: ord, reason: 'settle before reverse', confirm: true,
    });
    if (settle.status !== 201 && settle.status !== 200) {
      throw new Error(`settle ${settle.status} ${JSON.stringify(settle.body)}`);
    }
    const rev = await staff.post('/api/admin/finance/settlements/reverse', {
      orderReference: ord, reason: 'wrong seller account', confirm: true,
    });
    if (rev.status !== 200) throw new Error(`reverse ${rev.status} ${JSON.stringify(rev.body)}`);
    const order = await A.client.get(`/api/orders/${ord}`);
    if (order.body.order.paymentState !== 'paid') {
      throw new Error(`payment=${order.body.order.paymentState}`);
    }
    record('S09', 'PASS', `ord=${ord} reverse=${rev.status} payment=paid`);
  } catch (err) {
    record('S09', 'FAIL', String(err.message ?? err));
  }

  // Scenario 10 — mini transaction + account
  try {
    const listing10 = await createPublishedListing(staff, seller, category, `E2E S10 ${Date.now()}`);
    const { lot: lot10, version: v10 } = await openAuction(staff, listing10, 12000, 1200, 3_600_000);
    await bid(A.client, lot10, 12000, v10);
    await forceClose(staff, lot10);
    const closed = await waitClosed(lot10);
    await A.client.post('/api/payments/complete', { orderReference: closed.orderReference });
    const acct = await A.client.get('/api/account');
    if (acct.status !== 200) throw new Error('account');
    if (!JSON.stringify(acct.body).includes(closed.orderReference)) {
      throw new Error('order missing from account');
    }
    record('S10', 'PASS', `ord=${closed.orderReference}`);
  } catch (err) {
    record('S10', 'FAIL', String(err.message ?? err));
  }

  const pass = results.filter((r) => r.result === 'PASS').length;
  const fail = results.filter((r) => r.result === 'FAIL').length;
  console.log(JSON.stringify({ pass, fail, results }, null, 2));
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
