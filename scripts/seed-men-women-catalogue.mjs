/**
 * Archive existing inventory and seed 10 men/women lifestyle listings (7 live auctions + 3 fixed price).
 * Usage from backend/: node --env-file-if-exists=.env scripts/seed-men-women-catalogue.mjs
 */
import { generateTotp } from '../src/shared/totp.ts';
import { qarToMinor } from '../src/shared/money.ts';
import { downloadPhotoForListingTitle, uploadListingJpeg } from './lib/catalogue-product-photos.mjs';

const API = process.env.E2E_API ?? 'http://localhost:4000';
const STAFF_EMAIL = process.env.E2E_STAFF_EMAIL ?? 'operator.dev@example.com';
const STAFF_PASSWORD = process.env.E2E_STAFF_PASSWORD ?? 'DevOperator1';
const TOTP_SECRET = process.env.E2E_STAFF_TOTP ?? '5YQ2BFAT5HZJYPNXEF557HIXSMB7P3YL';
const ARCHIVE_REASON = 'Owner reset — men/women catalogue refresh';

const AUCTION_ENDS_IN_MS = 4 * 60 * 60 * 1000;
const STARTS_OFFSET_MS = 60 * 1000;

/** @type {Array<Record<string, unknown>>} */
const CATALOGUE = [
  {
    audience: 'men',
    title: "Men's Classic Chronograph Watch",
    categoryKey: 'electronics',
    listingMethod: 'auction',
    condition: 'used',
    attributes: { brand: 'other', model_name: 'Classic Chronograph' },
    startingQar: 800,
    incrementQar: 50,
  },
  {
    audience: 'men',
    title: "Men's Leather Bomber Jacket",
    categoryKey: 'clothing',
    listingMethod: 'auction',
    condition: 'used',
    attributes: {},
    startingQar: 450,
    incrementQar: 25,
  },
  {
    audience: 'men',
    title: "Men's Mountain Bike — 21-speed",
    categoryKey: 'sports',
    listingMethod: 'auction',
    condition: 'used',
    attributes: {},
    startingQar: 1_200,
    incrementQar: 50,
  },
  {
    audience: 'men',
    title: "Men's Running Sneakers — 450 QAR",
    categoryKey: 'clothing',
    listingMethod: 'fixed_price',
    condition: 'like_new',
    attributes: {},
    priceQar: 450,
  },
  {
    audience: 'men',
    title: "Men's Wool Overcoat",
    categoryKey: 'clothing',
    listingMethod: 'auction',
    condition: 'used',
    attributes: {},
    startingQar: 600,
    incrementQar: 40,
  },
  {
    audience: 'women',
    title: "Women's Rose-Gold Dress Watch",
    categoryKey: 'electronics',
    listingMethod: 'auction',
    condition: 'like_new',
    attributes: { brand: 'other', model_name: 'Rose-Gold Dress' },
    startingQar: 550,
    incrementQar: 35,
  },
  {
    audience: 'women',
    title: "Women's Evening Dress",
    categoryKey: 'clothing',
    listingMethod: 'auction',
    condition: 'like_new',
    attributes: {},
    startingQar: 400,
    incrementQar: 25,
  },
  {
    audience: 'women',
    title: "Women's Leather Crossbody Handbag — 1,250 QAR",
    categoryKey: 'general',
    listingMethod: 'fixed_price',
    condition: 'like_new',
    attributes: { item_condition: 'like-new', brand_name: 'Artisan' },
    priceQar: 1_250,
  },
  {
    audience: 'women',
    title: "Women's City Bicycle — step-through",
    categoryKey: 'sports',
    listingMethod: 'auction',
    condition: 'used',
    attributes: {},
    startingQar: 900,
    incrementQar: 45,
  },
  {
    audience: 'women',
    title: "Women's Block-Heel Sandals — 320 QAR",
    categoryKey: 'clothing',
    listingMethod: 'fixed_price',
    condition: 'new',
    attributes: {},
    priceQar: 320,
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

async function listAllAdmin(staff, status) {
  const all = [];
  let page = 1;
  const limit = 100;
  for (;;) {
    const res = await staff.get(`/api/admin/listings?status=${status}&page=${page}&limit=${limit}`);
    if (res.status !== 200) throw new Error(`list ${status} ${res.status} ${JSON.stringify(res.body)}`);
    const batch = res.body?.listings ?? [];
    all.push(...batch);
    const totalPages = res.body?.totalPages ?? 1;
    if (page >= totalPages) break;
    page += 1;
  }
  return all;
}

async function ensureListingMethods(staff, categoryKey, methodsNeeded) {
  const cats = await staff.get('/api/admin/categories');
  const category = (cats.body?.categories ?? []).find((c) => c.key === categoryKey);
  if (!category) throw new Error(`category ${categoryKey} missing — run seed`);
  const merged = [...new Set([...(category.listingMethods ?? []), ...methodsNeeded])];
  if (merged.length === (category.listingMethods ?? []).length) return;
  const enabled = await staff.patch(`/api/admin/categories/${categoryKey}`, {
    listingMethods: merged,
    expectedHierarchyVersion: category.hierarchyVersion,
  });
  if (enabled.status !== 200) {
    throw new Error(`patch category ${categoryKey} ${enabled.status} ${JSON.stringify(enabled.body)}`);
  }
}

async function ensureSeller(staff) {
  const sellersRes = await staff.get('/api/admin/sellers?status=active&limit=5');
  let seller = sellersRes.body?.sellers?.[0]?.sellerReference;
  if (!seller) {
    const created = await staff.post('/api/admin/sellers', {
      type: 'individual',
      displayName: 'Men/women catalogue seller',
      contact: { phone: `5555${String(Date.now()).slice(-6)}` },
      reason: 'seed-men-women-catalogue fixture',
    });
    if (created.status !== 201) throw new Error(`seller create ${created.status}`);
    const ref = created.body.seller.sellerReference;
    const activated = await staff.patch(`/api/admin/sellers/${ref}/status`, {
      status: 'active',
      reason: 'activate for catalogue seed',
    });
    if (activated.status !== 200) throw new Error(`seller activate ${activated.status}`);
    seller = ref;
  }
  return seller;
}

function descriptionFor(spec) {
  if (spec.listingMethod === 'fixed_price' && spec.priceQar) {
    return `Buy now for ${spec.priceQar.toLocaleString('en-QA')} QAR. ${spec.title.replace(/ — [\d,]+ QAR$/, '')} in great condition. Pickup in Doha.`;
  }
  return `Live auction listing: ${spec.title}. Well cared for; see photos. Located in Al Sadd, Doha.`;
}

async function createPublishedListing(staff, seller, spec) {
  const draft = await staff.post('/api/admin/listings', {
    sellerReference: seller,
    categoryKey: spec.categoryKey,
    listingMethod: spec.listingMethod,
    languageMode: 'en',
    audience: spec.audience,
    condition: spec.condition,
    title: { en: spec.title },
    description: { en: descriptionFor(spec) },
    attributes: spec.attributes ?? {},
    locationKey: 'qa-doha-al-sadd',
    ...(spec.listingMethod === 'fixed_price' && spec.priceQar ? { priceMinor: qarToMinor(spec.priceQar) } : {}),
  });
  if (draft.status !== 201) throw new Error(`draft ${draft.status} ${JSON.stringify(draft.body)}`);
  const ref = draft.body.listing.listingReference;
  let version = draft.body.listing.version;
  const collectionKey = draft.body.listing.mediaCollectionKey ?? `listing_${ref}`;

  const jpeg = await downloadPhotoForListingTitle(spec.title);
  const assetId = await uploadListingJpeg(staff, API, collectionKey, jpeg);

  const patched = await staff.patch(`/api/admin/listings/${ref}`, {
    expectedVersion: version,
    media: [{ assetId, alt: { en: spec.title } }],
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
    endsAt: new Date(now + AUCTION_ENDS_IN_MS).toISOString(),
  });
  if (created.status !== 201) throw new Error(`create auction ${created.status} ${JSON.stringify(created.body)}`);
  const lot = created.body.auction.lotReference;
  const opened = await staff.post(`/api/admin/auctions/${lot}/open`);
  if (opened.status !== 200) throw new Error(`open ${opened.status} ${JSON.stringify(opened.body)}`);
  if (opened.body.auction.status !== 'live') throw new Error(`expected live got ${opened.body.auction.status}`);
  return { lotReference: lot, endsAt: created.body.auction.endsAt ?? new Date(now + AUCTION_ENDS_IN_MS).toISOString() };
}

async function verifyPublicShelf() {
  const allRes = await fetch(`${API}/api/listings?limit=48`);
  const allBody = await allRes.json();
  const allListings = allBody.listings ?? [];

  const menRes = await fetch(`${API}/api/listings?audience=men&limit=48`);
  const menBody = await menRes.json();
  const womenRes = await fetch(`${API}/api/listings?audience=women&limit=48`);
  const womenBody = await womenRes.json();
  const auctionRes = await fetch(`${API}/api/listings?method=auction&limit=48`);
  const auctionBody = await auctionRes.json();
  const auctionListings = auctionBody.listings ?? [];

  const staleTitles = allListings.filter((l) => {
    const t = (l.title?.en ?? l.title ?? '').toLowerCase();
    return /lexus|iphone|land cruiser|toyota/i.test(t);
  });

  const liveAuctions = auctionListings.filter((l) => l.liveLotReference);

  return {
    publishedTotal: allBody.total ?? allListings.length,
    publishedCount: allListings.length,
    menCount: (menBody.listings ?? []).length,
    womenCount: (womenBody.listings ?? []).length,
    auctionLiveCount: liveAuctions.length,
    staleVehiclePhoneTitles: staleTitles.map((l) => l.listingReference),
    titles: allListings.map((l) => l.title?.en ?? l.title),
  };
}

async function main() {
  console.log('seed-men-women-catalogue against', API);
  const staff = await staffLogin();
  console.log('staff session ok');

  const toArchive = [];
  for (const status of ['published', 'draft']) {
    const batch = await listAllAdmin(staff, status);
    toArchive.push(...batch);
  }

  const archivedRefs = [];
  const archiveSkipped = [];
  const archiveErrors = [];

  for (const listing of toArchive) {
    const ref = listing.listingReference;
    if (listing.status === 'archived' || listing.archivedAt) {
      archiveSkipped.push(ref);
      continue;
    }
    const res = await staff.post(`/api/admin/listings/${ref}/archive`, { reason: ARCHIVE_REASON });
    if (res.status === 200) {
      archivedRefs.push(ref);
    } else {
      archiveErrors.push({ ref, status: res.status, body: res.body, listingStatus: listing.status });
    }
  }

  const seller = await ensureSeller(staff);
  const categoryKeys = [...new Set(CATALOGUE.map((s) => s.categoryKey))];
  const methodsByCategory = new Map();
  for (const spec of CATALOGUE) {
    const set = methodsByCategory.get(spec.categoryKey) ?? new Set();
    set.add(spec.listingMethod);
    methodsByCategory.set(spec.categoryKey, set);
  }
  for (const key of categoryKeys) {
    await ensureListingMethods(staff, key, [...(methodsByCategory.get(key) ?? [])]);
  }

  const created = [];
  for (const spec of CATALOGUE) {
    const listingReference = await createPublishedListing(staff, seller, spec);
    const row = {
      title: spec.title,
      listingReference,
      audience: spec.audience,
      listingMethod: spec.listingMethod,
      categoryKey: spec.categoryKey,
    };
    if (spec.listingMethod === 'auction') {
      const auction = await openLiveAuction(
        staff,
        listingReference,
        qarToMinor(spec.startingQar),
        qarToMinor(spec.incrementQar),
      );
      row.lotReference = auction.lotReference;
      row.endsAt = auction.endsAt;
      row.startingQar = spec.startingQar;
      row.incrementQar = spec.incrementQar;
    } else {
      row.priceQar = spec.priceQar;
    }
    created.push(row);
  }

  const verification = await verifyPublicShelf();

  const summary = {
    archivedCount: archivedRefs.length,
    archiveSkippedAlreadyArchived: archiveSkipped.length,
    archivedRefs,
    archiveErrors,
    created,
    verification,
    ok:
      verification.publishedCount >= 10 &&
      verification.menCount > 0 &&
      verification.womenCount > 0 &&
      verification.auctionLiveCount === 7 &&
      verification.staleVehiclePhoneTitles.length === 0,
  };

  console.log(JSON.stringify(summary, null, 2));
  if (archiveErrors.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
