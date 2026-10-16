/**
 * Publish five frontend/public/product folders via ImageKit-backed media upload.
 * Usage from backend/:
 *   $env:E2E_API="http://localhost:4000"
 *   node --env-file-if-exists=.env scripts/seed-imagekit-catalogue.mjs
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateTotp } from '../src/shared/totp.ts';
import { qarToMinor } from '../src/shared/money.ts';
import { mimeForUpload, uploadListingImage } from './lib/catalogue-product-photos.mjs';

const API = process.env.E2E_API ?? 'http://localhost:4000';
const STAFF_EMAIL = process.env.E2E_STAFF_EMAIL ?? 'operator.dev@example.com';
const STAFF_PASSWORD = process.env.E2E_STAFF_PASSWORD ?? 'DevOperator1';
const TOTP_SECRET = process.env.E2E_STAFF_TOTP ?? '5YQ2BFAT5HZJYPNXEF557HIXSMB7P3YL';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PRODUCT_ROOT = join(SCRIPT_DIR, '../../frontend/public/product');

const AUCTION_ENDS_IN_MS = 14 * 24 * 60 * 60 * 1000;
const STARTS_OFFSET_MS = 2 * 60 * 1000;
const RETRYABLE_STATUS = new Set([502, 503, 504]);
const MAX_ATTEMPTS = 5;
const LOCATION_KEY = 'qa-doha-al-sadd';

/** @type {Array<{
 *   folder: string,
 *   title: string,
 *   audience: 'men' | 'women',
 *   listingMethod: 'auction' | 'fixed_price',
 *   coverPattern: RegExp,
 *   description: string,
 *   startingQar?: number,
 *   incrementQar?: number,
 *   priceQar?: number,
 * }>} */
const PRODUCTS = [
  {
    folder: 'Al Majlis',
    title: 'Al Majlis',
    audience: 'men',
    listingMethod: 'auction',
    startingQar: 100,
    incrementQar: 10,
    coverPattern: /thumbnail/i,
    description:
      'Traditional Gulf majlis accessory piece suited for a Qatari sitting room or diwaniya. Rich detailing and practical scale for coffee service or display. Condition is new; buyer arranges pickup in Al Sadd, Doha.',
  },
  {
    folder: 'Armario Printed Clutch',
    title: 'Armario Printed Clutch',
    audience: 'women',
    listingMethod: 'auction',
    startingQar: 100,
    incrementQar: 10,
    coverPattern: /thumbnail/i,
    description:
      'Statement printed clutch for evening wear and special occasions across Doha. Compact interior for phone and essentials; new with tags. Pickup in Al Sadd, Doha — ideal for weddings, galas, and National Day events.',
  },
  {
    folder: 'Gafla',
    title: 'Gafla',
    audience: 'men',
    listingMethod: 'auction',
    startingQar: 100,
    incrementQar: 10,
    coverPattern: /thumbnail/i,
    description:
      'Classic Qatari gafla (traditional carry pouch) in new condition — a practical Gulf accessory for daily wear or gifting. Photographs show weave, closure, and scale. Collection in Al Sadd, Doha.',
  },
  {
    folder: 'Luxury Turab',
    title: 'Luxury Turab',
    audience: 'women',
    listingMethod: 'fixed_price',
    priceQar: 280,
    coverPattern: /thumbnail/i,
    description:
      'Luxury turab (headscarf) with refined finish for modest dress and formal Gulf style. New; suitable for work, majlis visits, or Friday gatherings. Pickup arranged in Al Sadd, Doha.',
  },
  {
    folder: 'tasbih (misbah)',
    title: 'Tasbih (Misbah)',
    audience: 'men',
    listingMethod: 'fixed_price',
    priceQar: 150,
    coverPattern: /thumbnail/i,
    description:
      'Handheld tasbih (misbah prayer beads) for daily dhikr and Ramadan use. Comfortable weight and smooth beads; new. A thoughtful gift from a Doha seller — pickup in Al Sadd.',
  },
];

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @template T
 * @param {string} label
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withRetry(label, fn) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const status = Number(msg.match(/\b(50[234])\b/)?.[1]);
      const retryable =
        RETRYABLE_STATUS.has(status) || /502|503|504|fetch failed|ECONNRESET|ETIMEDOUT/i.test(msg);
      if (!retryable || attempt === MAX_ATTEMPTS) throw err;
      const waitMs = 2_000 * attempt;
      console.warn(`${label}: attempt ${attempt}/${MAX_ATTEMPTS} failed (${msg.slice(0, 140)}); retry in ${waitMs}ms`);
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

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
    const res = await withRetry(`${method} ${path}`, () =>
      fetch(`${API}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }),
    );
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
  delete(path, body) {
    return this.request('DELETE', path, body);
  }
}

async function waitForApiReady() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${API}/healthz`);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await sleep(2_000);
  }
  throw new Error(`API not ready at ${API}/healthz within 120s`);
}

async function staffLogin() {
  const c = new Client();
  await c.get('/api/auth/session');
  const login = await c.post('/api/auth/login', { identifier: STAFF_EMAIL, password: STAFF_PASSWORD });
  if (login.status !== 200) {
    throw new Error(
      `staff login ${login.status} ${JSON.stringify(login.body)} — check users or run grant-dev-operator`,
    );
  }
  if (login.body?.mfaRequired) {
    const code = generateTotp(TOTP_SECRET);
    const mfa = await c.post('/api/auth/mfa/challenge', { code });
    if (mfa.status !== 200) throw new Error(`staff mfa ${mfa.status} ${JSON.stringify(mfa.body)}`);
  }
  return c;
}

async function ensureListingMethods(staff) {
  const cats = await staff.get('/api/admin/categories');
  const category = (cats.body?.categories ?? []).find((c) => c.key === 'general');
  if (!category) throw new Error('category general missing');
  const merged = [...new Set([...(category.listingMethods ?? []), 'fixed_price', 'auction'])];
  if (merged.length === (category.listingMethods ?? []).length) return;
  const enabled = await staff.patch(`/api/admin/categories/general`, {
    listingMethods: merged,
    expectedHierarchyVersion: category.hierarchyVersion,
  });
  if (enabled.status !== 200) {
    throw new Error(`patch category general ${enabled.status} ${JSON.stringify(enabled.body)}`);
  }
}

async function ensureSeller(staff) {
  const sellersRes = await staff.get('/api/admin/sellers?status=active&limit=5');
  let seller = sellersRes.body?.sellers?.[0]?.sellerReference;
  if (!seller) {
    const created = await staff.post('/api/admin/sellers', {
      type: 'individual',
      displayName: 'ImageKit catalogue seller',
      contact: { phone: `5555${String(Date.now()).slice(-6)}` },
      reason: 'seed-imagekit-catalogue fixture',
    });
    if (created.status !== 201) throw new Error(`seller create ${created.status}`);
    const ref = created.body.seller.sellerReference;
    const activated = await staff.patch(`/api/admin/sellers/${ref}/status`, {
      status: 'active',
      reason: 'activate for ImageKit catalogue seed',
    });
    if (activated.status !== 200) throw new Error(`seller activate ${activated.status}`);
    seller = ref;
  }
  return seller;
}

async function resolveLocationKey(staff) {
  const res = await staff.get('/api/admin/locations');
  if (res.status !== 200) throw new Error(`locations ${res.status}`);
  const locations = res.body?.locations ?? [];
  const sadd = locations.find((l) => l.key === LOCATION_KEY && l.active !== false);
  if (sadd) return sadd.key;
  throw new Error(`location ${LOCATION_KEY} not found in admin catalogue`);
}

/**
 * @param {string} folderName
 * @param {RegExp} coverPattern
 */
async function loadFolderImages(folderName, coverPattern) {
  const dir = join(PRODUCT_ROOT, folderName);
  const entries = await readdir(dir);
  const imageFiles = entries.filter((f) => /\.(jpe?g|png|webp)$/i.test(f));
  if (imageFiles.length === 0) throw new Error(`no images in ${dir}`);
  const coverFile = imageFiles.find((f) => coverPattern.test(f));
  if (!coverFile) throw new Error(`cover not found in ${folderName} (pattern ${coverPattern})`);
  const rest = imageFiles.filter((f) => f !== coverFile).sort((a, b) => a.localeCompare(b, 'en'));
  const orderedNames = [coverFile, ...rest];
  /** @type {Array<{ name: string, buffer: Buffer, mime: 'image/jpeg' | 'image/png' | 'image/webp' }>} */
  const items = [];
  for (const name of orderedNames) {
    const path = join(dir, name);
    const buffer = await readFile(path);
    const mime = mimeForUpload(buffer, path);
    items.push({ name, buffer, mime });
  }
  return { items, coverFileName: coverFile, expectedCount: items.length };
}

async function clearMediaCollection(staff, collectionKey) {
  const res = await staff.get(`/api/admin/media?collectionKey=${encodeURIComponent(collectionKey)}`);
  if (res.status !== 200) return;
  const assets = res.body?.assets ?? [];
  for (const asset of assets) {
    const del = await staff.delete(`/api/admin/media/${asset.assetId}`, {
      reason: 'seed-imagekit-catalogue reset collection before upload',
    });
    if (del.status !== 200) console.warn(`delete ${asset.assetId} ${del.status}`);
    await sleep(200);
  }
}

/**
 * @param {Client} staff
 * @param {string} collectionKey
 * @param {{ items: Array<{ name: string, buffer: Buffer, mime: string }>, coverFileName: string }} folder
 */
async function uploadAllMedia(staff, collectionKey, folder) {
  await clearMediaCollection(staff, collectionKey);
  /** @type {Array<{ assetId: string, name: string, publicUrl?: string }>} */
  const uploaded = [];
  let coverAssetId = null;
  for (const item of folder.items) {
    const assetId = await withRetry(`upload ${item.name}`, () =>
      uploadListingImage(staff, API, collectionKey, item.buffer, item.mime),
    );
    uploaded.push({ assetId, name: item.name });
    if (item.name === folder.coverFileName) coverAssetId = assetId;
    await sleep(400);
  }
  if (!coverAssetId) throw new Error('cover asset missing after upload');
  return { uploaded, coverAssetId };
}

async function openLiveAuction(staff, listingReference, startingBidMinor, incrementMinor) {
  return withRetry(`open auction ${listingReference}`, async () => {
    const now = Date.now();
    const startsAt = new Date(now - STARTS_OFFSET_MS).toISOString();
    const endsAt = new Date(now + AUCTION_ENDS_IN_MS).toISOString();
    const created = await staff.post('/api/admin/auctions', {
      listingReference,
      startingBidMinor,
      incrementMinor,
      startsAt,
      endsAt,
    });
    if (created.status !== 201) throw new Error(`create auction ${created.status} ${JSON.stringify(created.body)}`);
    const lot = created.body.auction.lotReference;
    const opened = await staff.post(`/api/admin/auctions/${lot}/open`);
    if (opened.status !== 200) throw new Error(`open ${opened.status} ${JSON.stringify(opened.body)}`);
    if (opened.body.auction.status !== 'live') throw new Error(`expected live got ${opened.body.auction.status}`);
    return {
      lotReference: lot,
      startsAt: created.body.auction.startsAt ?? startsAt,
      endsAt: created.body.auction.endsAt ?? endsAt,
    };
  });
}

async function createAndPublish(staff, seller, locationKey, spec, folder) {
  return withRetry(`publish ${spec.title}`, async () => {
    const draft = await staff.post('/api/admin/listings', {
      sellerReference: seller,
      categoryKey: 'general',
      listingMethod: spec.listingMethod,
      languageMode: 'en',
      audience: spec.audience,
      condition: 'new',
      title: { en: spec.title },
      description: { en: spec.description },
      attributes: { item_condition: 'new' },
      locationKey,
      ...(spec.listingMethod === 'fixed_price' && spec.priceQar != null
        ? { priceMinor: qarToMinor(spec.priceQar) }
        : {}),
    });
    if (draft.status !== 201) throw new Error(`draft ${draft.status} ${JSON.stringify(draft.body)}`);
    const ref = draft.body.listing.listingReference;
    let version = draft.body.listing.version;
    const collectionKey = draft.body.listing.mediaCollectionKey ?? `listing_${ref}`;

    const { uploaded, coverAssetId } = await uploadAllMedia(staff, collectionKey, folder);
    const media = uploaded.map((u) => ({ assetId: u.assetId, alt: { en: spec.title } }));

    const patched = await staff.patch(`/api/admin/listings/${ref}`, {
      expectedVersion: version,
      media,
      coverAssetId,
    });
    if (patched.status !== 200) throw new Error(`patch ${patched.status} ${JSON.stringify(patched.body)}`);
    version = patched.body.listing.version;

    const pub = await staff.post(`/api/admin/listings/${ref}/publish`, { expectedVersion: version });
    if (pub.status !== 200) throw new Error(`publish ${pub.status} ${JSON.stringify(pub.body)}`);

    return { listingReference: ref, uploaded, coverAssetId };
  });
}

async function enrichMediaUrls(staff, uploaded) {
  const out = [];
  for (const row of uploaded) {
    const res = await staff.get(`/api/admin/media/${row.assetId}`);
    const url = res.body?.asset?.publicUrl ?? res.body?.asset?.url ?? null;
    out.push({ ...row, publicUrl: url, adminStatus: res.status });
  }
  return out;
}

async function findPublicListing(listingReference) {
  let page = 1;
  for (;;) {
    const res = await fetch(`${API}/api/listings?limit=48&page=${page}`);
    if (!res.ok) return null;
    const body = await res.json();
    const hit = (body.listings ?? []).find((l) => l.listingReference === listingReference);
    if (hit) return hit;
    const totalPages = body.totalPages ?? 1;
    if (page >= totalPages) return null;
    page += 1;
  }
}

async function verifyListingMedia(listingReference, expectedMediaCount) {
  const detail = await findPublicListing(listingReference);
  if (!detail) return { ok: false, reason: 'not on public shelf' };
  const media = detail.media ?? [];
  const checks = [];
  for (const entry of media) {
    const url = entry.url?.startsWith('http') ? entry.url : `${API}${entry.url}`;
    const res = await fetch(url);
    checks.push({
      assetId: entry.assetId,
      url: entry.url,
      fetchStatus: res.status,
      imageKit: /ik\.imagekit\.io/i.test(entry.url ?? url),
    });
  }
  const imageKitCount = checks.filter((c) => c.imageKit).length;
  return {
    ok:
      media.length >= expectedMediaCount &&
      checks.every((c) => c.fetchStatus === 200) &&
      (imageKitCount > 0 || checks.length > 0),
    listingReference,
    listingMethod: detail.listingMethod,
    liveLotReference: detail.liveLotReference ?? null,
    mediaCount: media.length,
    sampleMediaUrl: media[0]?.url ?? null,
    checks,
  };
}

async function main() {
  console.log('seed-imagekit-catalogue against', API);
  console.log('product root', PRODUCT_ROOT);

  await waitForApiReady();
  console.log('API ready');

  const staff = await withRetry('staff login', () => staffLogin());
  console.log('staff session ok');

  const locationKey = await resolveLocationKey(staff);
  console.log('locationKey', locationKey);

  await ensureListingMethods(staff);
  const seller = await ensureSeller(staff);

  /** @type {Array<Record<string, unknown>>} */
  const results = [];

  for (const spec of PRODUCTS) {
    console.log(`\n--- ${spec.title} (${spec.listingMethod}) ---`);
    const folder = await loadFolderImages(spec.folder, spec.coverPattern);
    const { listingReference, uploaded, coverAssetId } = await createAndPublish(
      staff,
      seller,
      locationKey,
      spec,
      folder,
    );
    const mediaWithUrls = await enrichMediaUrls(staff, uploaded);

    const row = {
      title: spec.title,
      listingReference,
      listingMethod: spec.listingMethod,
      coverAssetId,
      mediaCount: uploaded.length,
      sampleAdminPublicUrl: mediaWithUrls[0]?.publicUrl ?? null,
      sampleUploadAssetId: uploaded[0]?.assetId,
    };

    if (spec.listingMethod === 'auction') {
      const auction = await openLiveAuction(
        staff,
        listingReference,
        qarToMinor(spec.startingQar ?? 100),
        qarToMinor(spec.incrementQar ?? 10),
      );
      row.lotReference = auction.lotReference;
      row.startsAt = auction.startsAt;
      row.endsAt = auction.endsAt;
      row.startingQar = spec.startingQar;
      row.incrementQar = spec.incrementQar;
    } else {
      row.priceQar = spec.priceQar;
    }

    const verify = await verifyListingMedia(listingReference, folder.expectedCount);
    row.verify = verify;
    results.push(row);
    await sleep(1_000);
  }

  const shelfRes = await fetch(`${API}/api/listings?limit=10`);
  const shelfStatus = shelfRes.status;
  const shelf = await shelfRes.json();

  const summary = {
    api: API,
    locationKey,
    seller,
    shelf: { httpStatus: shelfStatus, total: shelf.total ?? (shelf.listings ?? []).length },
    products: results,
    ok:
      shelfStatus === 200 &&
      (shelf.total ?? 0) === 5 &&
      results.length === 5 &&
      results.filter((r) => r.listingMethod === 'auction').every((r) => r.lotReference) &&
      results.every((r) => r.verify?.ok),
  };

  console.log('\n' + JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
