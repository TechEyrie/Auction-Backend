/**
 * Re-upload product images from frontend/public/product/ onto existing published listings.
 * Does not create listings or archive — media refresh only.
 *
 * Usage from backend/:
 *   $env:E2E_API="https://auction-backend-7zcn.onrender.com"
 *   node --env-file-if-exists=.env scripts/repair-public-product-media.mjs
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateTotp } from '../src/shared/totp.ts';
import { mimeForUpload, uploadListingImage } from './lib/catalogue-product-photos.mjs';

const API = process.env.E2E_API ?? 'https://auction-backend-7zcn.onrender.com';
const STAFF_EMAIL = process.env.E2E_STAFF_EMAIL ?? 'operator.dev@example.com';
const STAFF_PASSWORD = process.env.E2E_STAFF_PASSWORD ?? 'DevOperator1';
const TOTP_SECRET = process.env.E2E_STAFF_TOTP ?? '5YQ2BFAT5HZJYPNXEF557HIXSMB7P3YL';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PRODUCT_ROOT = join(SCRIPT_DIR, '../../frontend/public/product');

const RETRYABLE_STATUS = new Set([502, 503, 504]);
const MAX_ATTEMPTS = 5;

/** @type {Array<{ folder: string, title: string, coverPattern: RegExp }>} */
const PRODUCTS = [
  { folder: 'Al Majlis', title: 'Al Majlis', coverPattern: /thumbnail/i },
  { folder: 'Armario Printed Clutch', title: 'Armario Printed Clutch', coverPattern: /thumbnail/i },
  { folder: 'Gafla', title: 'Gafla', coverPattern: /thumbnail/i },
  { folder: 'Luxury Turab', title: 'Luxury Turab', coverPattern: /thumbnail/i },
  { folder: 'tasbih (misbah)', title: 'Tasbih (Misbah)', coverPattern: /thumbnail/i },
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

async function staffLogin() {
  const c = new Client();
  await c.get('/api/auth/session');
  const login = await c.post('/api/auth/login', { identifier: STAFF_EMAIL, password: STAFF_PASSWORD });
  if (login.status !== 200) {
    throw new Error(`staff login ${login.status} ${JSON.stringify(login.body)}`);
  }
  if (login.body?.mfaRequired) {
    const code = generateTotp(TOTP_SECRET);
    const mfa = await c.post('/api/auth/mfa/challenge', { code });
    if (mfa.status !== 200) throw new Error(`staff mfa ${mfa.status} ${JSON.stringify(mfa.body)}`);
  }
  return c;
}

async function listPublishedAdmin(staff) {
  const all = [];
  let page = 1;
  const limit = 100;
  for (;;) {
    const res = await staff.get(`/api/admin/listings?status=published&page=${page}&limit=${limit}`);
    if (res.status !== 200) throw new Error(`list published ${res.status} ${JSON.stringify(res.body)}`);
    const batch = res.body?.listings ?? [];
    all.push(...batch);
    const totalPages = res.body?.totalPages ?? 1;
    if (page >= totalPages) break;
    page += 1;
  }
  return all;
}

async function getAdminListing(staff, listingReference) {
  const res = await staff.get(`/api/admin/listings/${listingReference}`);
  if (res.status !== 200) throw new Error(`get listing ${listingReference} ${res.status}`);
  return res.body?.listing ?? res.body;
}

async function clearMediaCollection(staff, collectionKey) {
  const res = await staff.get(`/api/admin/media?collectionKey=${encodeURIComponent(collectionKey)}`);
  if (res.status !== 200) return;
  const assets = res.body?.assets ?? [];
  for (const asset of assets) {
    const del = await staff.delete(`/api/admin/media/${asset.assetId}`, {
      reason: 'repair-public-product-media reset collection before re-upload',
    });
    if (del.status !== 200) {
      console.warn(`delete ${asset.assetId} ${del.status}`);
    }
    await sleep(200);
  }
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

/**
 * @param {Client} staff
 * @param {string} collectionKey
 * @param {{ items: Array<{ name: string, buffer: Buffer, mime: string }>, coverFileName: string }} folder
 */
async function uploadAllMedia(staff, collectionKey, folder, opts = {}) {
  if (!opts.skipCollectionClear) await clearMediaCollection(staff, collectionKey);
  /** @type {Array<{ assetId: string, name: string }>} */
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

async function fetchMediaUrl(url) {
  return withRetry(`GET ${url.slice(0, 80)}`, () => fetch(url));
}

async function verifyListingMedia(listingReference, expectedMediaCount) {
  const detail = await withRetry('public listing', () => findPublicListing(listingReference));
  if (!detail) {
    return { ok: false, reason: 'not on public shelf', checks: [] };
  }
  const media = detail.media ?? [];
  const checks = [];
  for (const entry of media) {
    const url = entry.url?.startsWith('http') ? entry.url : `${API}${entry.url}`;
    const res = await fetchMediaUrl(url);
    checks.push({ assetId: entry.assetId, status: res.status, url });
  }
  const coverId = detail.coverAssetId ?? media[0]?.assetId;
  const coverEntry = media.find((m) => m.assetId === coverId) ?? media[0];
  let coverStatus = null;
  let coverUrl = null;
  if (coverEntry?.url) {
    coverUrl = coverEntry.url.startsWith('http') ? coverEntry.url : `${API}${coverEntry.url}`;
    const coverRes = await fetchMediaUrl(coverUrl);
    coverStatus = coverRes.status;
  }
  const allOk =
    media.length >= expectedMediaCount && checks.every((c) => c.status === 200) && coverStatus === 200;
  return {
    ok: allOk,
    mediaCount: media.length,
    coverAssetId: coverId,
    coverStatus,
    coverUrl,
    sampleStatus: checks[0]?.status ?? null,
    sampleUrl: checks[0]?.url ?? null,
    checks,
  };
}

/**
 * @param {Client} staff
 * @param {object} listing
 * @param {string} title
 * @param {{ items: Array<{ name: string, buffer: Buffer, mime: string }>, coverFileName: string }} folder
 */
async function detachListingMedia(staff, ref, version) {
  const detached = await staff.patch(`/api/admin/listings/${ref}`, {
    expectedVersion: version,
    media: [],
    coverAssetId: null,
  });
  if (detached.status !== 200) {
    throw new Error(`detach media ${ref} ${detached.status} ${JSON.stringify(detached.body)}`);
  }
  return detached.body.listing.version;
}

async function repairListingMedia(staff, listing, title, folder) {
  const ref = listing.listingReference;
  const fresh = await getAdminListing(staff, ref);
  let version = fresh.version ?? listing.version;
  const collectionKey = fresh.mediaCollectionKey ?? listing.mediaCollectionKey ?? `listing_${ref}`;

  version = await detachListingMedia(staff, ref, version);
  await clearMediaCollection(staff, collectionKey);

  const { uploaded, coverAssetId } = await uploadAllMedia(staff, collectionKey, folder, {
    skipCollectionClear: true,
  });
  const media = uploaded.map((u) => ({ assetId: u.assetId, alt: { en: title } }));

  const patched = await staff.patch(`/api/admin/listings/${ref}`, {
    expectedVersion: version,
    media,
    coverAssetId,
  });
  if (patched.status !== 200) {
    throw new Error(`patch ${ref} ${patched.status} ${JSON.stringify(patched.body)}`);
  }
  return ref;
}

async function main() {
  console.log('repair-public-product-media against', API);
  console.log('product root', PRODUCT_ROOT);

  const staff = await withRetry('staff login', () => staffLogin());
  console.log('staff session ok');

  const published = await listPublishedAdmin(staff);
  const byTitle = new Map(published.map((l) => [(l.title?.en ?? l.title ?? '').trim(), l]));

  /** @type {Array<Record<string, unknown>>} */
  const results = [];
  let allCovers200 = true;

  for (const spec of PRODUCTS) {
    console.log(`\n--- ${spec.title} ---`);
    const existing = byTitle.get(spec.title);
    if (!existing) {
      console.error(`no published listing for title "${spec.title}" — skipping (no create)`);
      results.push({ title: spec.title, ok: false, error: 'listing not found' });
      allCovers200 = false;
      continue;
    }

    const folder = await loadFolderImages(spec.folder, spec.coverPattern);
    const ref = existing.listingReference;
    console.log(`repair media on ${ref} (${folder.expectedCount} files)`);

    try {
      await repairListingMedia(staff, existing, spec.title, folder);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`repair failed: ${msg}`);
      results.push({ title: spec.title, listingReference: ref, ok: false, error: msg });
      allCovers200 = false;
      continue;
    }

    await sleep(800);
    const verify = await verifyListingMedia(ref, folder.expectedCount);
    if (verify.coverStatus !== 200) allCovers200 = false;

    results.push({
      title: spec.title,
      listingReference: ref,
      ok: verify.ok,
      mediaCount: verify.mediaCount,
      coverAssetId: verify.coverAssetId,
      coverHttpStatus: verify.coverStatus,
      sampleHttpStatus: verify.sampleStatus,
      sampleUrl: verify.sampleUrl,
      mediaChecks: verify.checks?.map((c) => ({ assetId: c.assetId, status: c.status })),
    });

    console.log(
      `done ${ref}: media=${verify.mediaCount} coverHTTP=${verify.coverStatus} sampleHTTP=${verify.sampleStatus}`,
    );
    await sleep(1_000);
  }

  const summary = {
    api: API,
    products: results,
    allFiveCoversHttp200: allCovers200 && results.length === PRODUCTS.length && results.every((r) => r.ok),
  };

  console.log('\n' + JSON.stringify(summary, null, 2));
  if (!summary.allFiveCoversHttp200) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
