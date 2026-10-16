/**
 * One-shot: archive test auction inventory, seed fresh live lots for manual/E2E bidding.
 * Usage from backend/: node --env-file-if-exists=.env scripts/reset-live-auctions.mjs
 */
import { generateTotp } from '../src/shared/totp.ts';
import { qarToMinor } from '../src/shared/money.ts';

const API = process.env.E2E_API ?? 'http://localhost:4000';
const WEB = process.env.E2E_WEB ?? 'http://localhost:3000';
const STAFF_EMAIL = process.env.E2E_STAFF_EMAIL ?? 'operator.dev@example.com';
const STAFF_PASSWORD = process.env.E2E_STAFF_PASSWORD ?? 'DevOperator1';
const TOTP_SECRET = process.env.E2E_STAFF_TOTP ?? '5YQ2BFAT5HZJYPNXEF557HIXSMB7P3YL';
const ARCHIVE_REASON = 'Owner reset — clearing test inventory';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const ENDS_IN_MS = 26 * 60 * 60 * 1000;
const STARTS_OFFSET_MS = 60 * 1000;

const NEW_LISTINGS = [
  {
    title: '2021 Toyota Land Cruiser — Live auction',
    categoryKey: 'vehicles',
    attributes: { make: 'Toyota', model: 'Land Cruiser', year: 2021, condition: 'used' },
    startingQar: 100,
    incrementQar: 10,
  },
  {
    title: 'iPhone 15 Pro — Live auction',
    categoryKey: 'electronics',
    attributes: { brand: 'apple', model_name: 'iPhone 15 Pro', storage: 256 },
    startingQar: 250,
    incrementQar: 25,
  },
  {
    title: '2020 Lexus LX — Live auction',
    categoryKey: 'vehicles',
    attributes: { make: 'Lexus', model: 'LX', year: 2020, condition: 'used' },
    startingQar: 500,
    incrementQar: 50,
  },
];

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
      try {
        value = decodeURIComponent(value);
      } catch {
        /* keep */
      }
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
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  }
  get(path) {
    return this.request('GET', path);
  }
  post(path, body, opts) {
    return this.request('POST', path, body, opts);
  }
  patch(path, body) {
    return this.request('PATCH', path, body);
  }
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

function shouldArchive(listing) {
  if (listing.status !== 'published') return false;
  if (listing.listingMethod === 'auction') return true;
  const title = listing.title?.en ?? listing.title?.ar ?? '';
  return /e2e/i.test(title);
}

async function listAllPublished(staff) {
  const all = [];
  let page = 1;
  const limit = 100;
  for (;;) {
    const res = await staff.get(`/api/admin/listings?status=published&page=${page}&limit=${limit}`);
    if (res.status !== 200) throw new Error(`list listings ${res.status} ${JSON.stringify(res.body)}`);
    const batch = res.body?.listings ?? [];
    all.push(...batch);
    const totalPages = res.body?.totalPages ?? 1;
    if (page >= totalPages) break;
    page += 1;
  }
  return all;
}

async function ensureAuctionOnCategory(staff, categoryKey) {
  const cats = await staff.get('/api/admin/categories');
  const category = (cats.body?.categories ?? []).find((c) => c.key === categoryKey);
  if (!category) throw new Error(`category ${categoryKey} missing — run seed`);
  if ((category.listingMethods ?? []).includes('auction')) return;
  const enabled = await staff.patch(`/api/admin/categories/${categoryKey}`, {
    listingMethods: [...new Set([...(category.listingMethods ?? []), 'auction'])],
    expectedHierarchyVersion: category.hierarchyVersion,
  });
  if (enabled.status !== 200) {
    throw new Error(`enable auction on ${categoryKey} ${enabled.status} ${JSON.stringify(enabled.body)}`);
  }
}

async function ensureSeller(staff) {
  const sellersRes = await staff.get('/api/admin/sellers?status=active&limit=5');
  let seller = sellersRes.body?.sellers?.[0]?.sellerReference;
  if (!seller) {
    const created = await staff.post('/api/admin/sellers', {
      type: 'individual',
      displayName: 'Live auction fixture seller',
      contact: { phone: `5555${String(Date.now()).slice(-6)}` },
      reason: 'reset-live-auctions fixture',
    });
    if (created.status !== 201) throw new Error(`seller create ${created.status}`);
    const ref = created.body.seller.sellerReference;
    const activated = await staff.patch(`/api/admin/sellers/${ref}/status`, {
      status: 'active',
      reason: 'activate for live lots',
    });
    if (activated.status !== 200) throw new Error(`seller activate ${activated.status}`);
    seller = ref;
  }
  return seller;
}

async function createPublishedListing(staff, seller, spec) {
  const draft = await staff.post('/api/admin/listings', {
    sellerReference: seller,
    categoryKey: spec.categoryKey,
    listingMethod: 'auction',
    languageMode: 'en',
    title: { en: spec.title },
    description: { en: `Published for live bidding: ${spec.title}` },
    attributes: spec.attributes,
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
    media: [{ assetId, alt: { en: 'Listing photo' } }],
    coverAssetId: assetId,
  });
  if (patched.status !== 200) throw new Error(`patch ${patched.status} ${JSON.stringify(patched.body)}`);
  version = patched.body.listing.version;

  const pub = await staff.post(`/api/admin/listings/${ref}/publish`, { expectedVersion: version });
  if (pub.status !== 200) throw new Error(`publish ${pub.status} ${JSON.stringify(pub.body)}`);
  return ref;
}

async function openLiveAuction(staff, listingReference, startingBidMinor, incrementMinor) {
  const now = Date.now();
  const created = await staff.post('/api/admin/auctions', {
    listingReference,
    startingBidMinor,
    incrementMinor,
    startsAt: new Date(now - STARTS_OFFSET_MS).toISOString(),
    endsAt: new Date(now + ENDS_IN_MS).toISOString(),
  });
  if (created.status !== 201) throw new Error(`create auction ${created.status} ${JSON.stringify(created.body)}`);
  const lot = created.body.auction.lotReference;
  const opened = await staff.post(`/api/admin/auctions/${lot}/open`);
  if (opened.status !== 200) throw new Error(`open ${opened.status} ${JSON.stringify(opened.body)}`);
  if (opened.body.auction.status !== 'live') throw new Error(`expected live got ${opened.body.auction.status}`);
  return lot;
}

async function verifyPublicAuctionShelf() {
  const res = await fetch(`${API}/api/listings?method=auction&limit=48`);
  const body = await res.json();
  const listings = body.listings ?? [];
  const withoutLive = listings.filter((l) => !l.liveLotReference);
  return {
    total: body.total ?? listings.length,
    count: listings.length,
    allHaveLiveLot: withoutLive.length === 0,
    withoutLiveRefs: withoutLive.map((l) => l.listingReference),
  };
}

async function main() {
  console.log('reset-live-auctions against', API);
  const staff = await staffLogin();
  console.log('staff session ok');

  const published = await listAllPublished(staff);
  const targets = published.filter(shouldArchive);
  const archivedRefs = [];
  const archiveErrors = [];

  for (const listing of targets) {
    const ref = listing.listingReference;
    const res = await staff.post(`/api/admin/listings/${ref}/archive`, { reason: ARCHIVE_REASON });
    if (res.status === 200) {
      archivedRefs.push(ref);
    } else {
      archiveErrors.push({ ref, status: res.status, body: res.body });
    }
  }

  const seller = await ensureSeller(staff);
  const categoryKeys = [...new Set(NEW_LISTINGS.map((s) => s.categoryKey))];
  for (const key of categoryKeys) {
    await ensureAuctionOnCategory(staff, key);
  }

  const created = [];
  for (const spec of NEW_LISTINGS) {
    const listingReference = await createPublishedListing(staff, seller, spec);
    const lot = await openLiveAuction(
      staff,
      listingReference,
      qarToMinor(spec.startingQar),
      qarToMinor(spec.incrementQar),
    );
    created.push({
      title: spec.title,
      listingReference,
      lotReference: lot,
      lotUrl: `${WEB}/lot/${lot}`,
    });
  }

  const shelf = await verifyPublicAuctionShelf();

  const summary = {
    archivedCount: archivedRefs.length,
    archivedRefs,
    archiveErrors,
    newListings: created,
    publicAuctionShelf: shelf,
    note:
      shelf.allHaveLiveLot && shelf.count === created.length
        ? 'GET /api/listings?method=auction returns only live auction listings (backend filter active).'
        : shelf.withoutLiveRefs.length > 0
          ? 'Some auction-method listings in the public API lack liveLotReference — restart backend if filter code was recently added, or stale lots remain.'
          : `Public shelf shows ${shelf.count} listing(s); expected ${created.length} after filter.`,
  };

  console.log(JSON.stringify(summary, null, 2));
  for (const row of created) {
    console.log(row.lotUrl);
  }

  if (archiveErrors.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
