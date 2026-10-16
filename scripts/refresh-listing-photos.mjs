/**
 * Replace placeholder listing photos with real Unsplash JPEGs for published catalogue listings.
 * Usage from backend/: node --env-file-if-exists=.env scripts/refresh-listing-photos.mjs
 */
import { generateTotp } from '../src/shared/totp.ts';
import {
  CATALOGUE_TITLES,
  downloadPhotoForListingTitle,
  isCatalogueListingTitle,
  photoUrlsForTitle,
  uploadListingJpeg,
} from './lib/catalogue-product-photos.mjs';

const API = process.env.E2E_API ?? 'http://localhost:4000';
const STAFF_EMAIL = process.env.E2E_STAFF_EMAIL ?? 'operator.dev@example.com';
const STAFF_PASSWORD = process.env.E2E_STAFF_PASSWORD ?? 'DevOperator1';
const TOTP_SECRET = process.env.E2E_STAFF_TOTP ?? '5YQ2BFAT5HZJYPNXEF557HIXSMB7P3YL';

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

async function refreshListingPhoto(staff, listing) {
  const ref = listing.listingReference;
  const titleEn = listing.title?.en ?? listing.title ?? '';
  const collectionKey = listing.mediaCollectionKey ?? `listing_${ref}`;
  const version = listing.version;
  const { rule } = photoUrlsForTitle(titleEn);

  const jpeg = await downloadPhotoForListingTitle(titleEn);
  const assetId = await uploadListingJpeg(staff, API, collectionKey, jpeg);

  const patched = await staff.patch(`/api/admin/listings/${ref}`, {
    expectedVersion: version,
    media: [{ assetId, alt: { en: titleEn } }],
    coverAssetId: assetId,
  });
  if (patched.status !== 200) {
    throw new Error(`patch ${patched.status} ${JSON.stringify(patched.body)}`);
  }

  return { ref, titleEn, assetId, bytes: jpeg.length, rule };
}

async function verifyPublicMedia() {
  const res = await fetch(`${API}/api/listings?limit=48`);
  const body = await res.json();
  const listings = body.listings ?? [];
  const checks = [];
  for (const listing of listings) {
    const title = listing.title?.en ?? listing.title ?? '';
    if (!isCatalogueListingTitle(title)) continue;
    const media = listing.media?.[0];
    if (!media?.url) {
      checks.push({ title, ok: false, reason: 'no media url' });
      continue;
    }
    const url = media.url.startsWith('http') ? media.url : `${API}${media.url}`;
    const imgRes = await fetch(url);
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const ok = imgRes.ok && buf.length > 5 * 1024;
    checks.push({
      title,
      ok,
      status: imgRes.status,
      bytes: buf.length,
      contentType: imgRes.headers.get('content-type'),
    });
  }
  return { catalogueChecks: checks, publishedCount: listings.length };
}

async function main() {
  console.log('refresh-listing-photos against', API);
  const staff = await staffLogin();
  console.log('staff session ok');

  const published = await listPublishedAdmin(staff);
  const targets = published.filter((l) => isCatalogueListingTitle(l.title?.en ?? l.title));

  if (targets.length === 0) {
    console.warn('No published catalogue listings found; expected titles:', CATALOGUE_TITLES);
  }

  const results = [];
  let failures = 0;

  for (const listing of targets) {
    const ref = listing.listingReference;
    const title = listing.title?.en ?? listing.title ?? ref;
    try {
      const row = await refreshListingPhoto(staff, listing);
      console.log(`OK  ${ref}  ${title}  (${row.bytes} bytes, rule=${row.rule})`);
      results.push({ ...row, ok: true });
    } catch (err) {
      failures += 1;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`FAIL ${ref}  ${title}  ${message}`);
      results.push({ ref, titleEn: title, ok: false, error: message });
    }
  }

  const verification = await verifyPublicMedia();
  const summary = {
    targetCount: targets.length,
    refreshed: results.filter((r) => r.ok).length,
    failures,
    results,
    verification,
    ok:
      failures === 0 &&
      targets.length >= 10 &&
      verification.catalogueChecks.length >= 10 &&
      verification.catalogueChecks.every((c) => c.ok),
  };

  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
