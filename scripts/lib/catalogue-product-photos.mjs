/**
 * Unsplash JPEG URLs and download helpers for men/women catalogue listing photos.
 */

const UNSPLASH_SUFFIX = 'auto=format&fit=crop&w=1200&q=80';
const USER_AGENT = 'TechEyrie-AuctionMERN-dev-script/1.0 (+local catalogue photo refresh)';

/** Primary + fallback Unsplash image URLs per product theme (keyword order matters). */
export const PHOTO_RULES = [
  {
    keywords: ['chronograph'],
    primary: `https://images.unsplash.com/photo-1523275335684-37898b6baf30?${UNSPLASH_SUFFIX}`,
    fallback: `https://images.unsplash.com/photo-1523170335258-f5ed11844a49?${UNSPLASH_SUFFIX}`,
  },
  {
    keywords: ['bomber', 'jacket'],
    match: (t) => t.includes('bomber') || (t.includes('jacket') && t.includes("men")),
    primary: `https://images.unsplash.com/photo-1551028719-00167b16eac5?${UNSPLASH_SUFFIX}`,
    fallback: `https://images.unsplash.com/photo-1495105787522-5334e3ffa0ef?${UNSPLASH_SUFFIX}`,
  },
  {
    keywords: ['mountain bike'],
    match: (t) => t.includes('mountain') && t.includes('bike'),
    primary: `https://images.unsplash.com/photo-1576435728678-68d0fbf94e91?${UNSPLASH_SUFFIX}`,
    fallback: `https://images.unsplash.com/photo-1571068316344-75bc76f77890?${UNSPLASH_SUFFIX}`,
  },
  {
    keywords: ['sneaker', 'running'],
    match: (t) => t.includes('sneaker') || (t.includes('running') && t.includes('men')),
    primary: `https://images.unsplash.com/photo-1542291026-7eec264c27ff?${UNSPLASH_SUFFIX}`,
    fallback: `https://images.unsplash.com/photo-1606107557195-0e29a4b5b4aa?${UNSPLASH_SUFFIX}`,
  },
  {
    keywords: ['overcoat', 'wool'],
    match: (t) => t.includes('overcoat') || (t.includes('wool') && t.includes('coat')),
    primary: `https://images.unsplash.com/photo-1601925260368-ae2f83cf8b7f?${UNSPLASH_SUFFIX}`,
    fallback: `https://images.unsplash.com/photo-1522312346375-d1a52e2b99b3?${UNSPLASH_SUFFIX}`,
  },
  {
    keywords: ['dress watch', 'rose-gold'],
    match: (t) => (t.includes('dress') && t.includes('watch')) || t.includes('rose-gold'),
    primary: `https://images.unsplash.com/photo-1523170335258-f5ed11844a49?${UNSPLASH_SUFFIX}`,
    fallback: `https://images.unsplash.com/photo-1603252109303-2751441dd157?${UNSPLASH_SUFFIX}`,
  },
  {
    keywords: ['evening dress'],
    match: (t) => t.includes('evening') && t.includes('dress'),
    primary: `https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?${UNSPLASH_SUFFIX}`,
    fallback: `https://images.unsplash.com/photo-1566174053879-31528523f8ae?${UNSPLASH_SUFFIX}`,
  },
  {
    keywords: ['handbag', 'crossbody'],
    match: (t) => t.includes('handbag') || t.includes('crossbody'),
    primary: `https://images.unsplash.com/photo-1548036328-c9fa89d128fa?${UNSPLASH_SUFFIX}`,
    fallback: `https://images.unsplash.com/photo-1490481651871-ab68de25d43d?${UNSPLASH_SUFFIX}`,
  },
  {
    keywords: ['city bicycle', 'step-through'],
    match: (t) => (t.includes('city') && t.includes('bicycle')) || t.includes('step-through'),
    primary: `https://images.unsplash.com/photo-1571068316344-75bc76f77890?${UNSPLASH_SUFFIX}`,
    fallback: `https://images.unsplash.com/photo-1576435728678-68d0fbf94e91?${UNSPLASH_SUFFIX}`,
  },
  {
    keywords: ['sandal', 'block-heel'],
    match: (t) => t.includes('sandal') || t.includes('block-heel'),
    primary: `https://images.unsplash.com/photo-1543163521-1bf539c55dd2?${UNSPLASH_SUFFIX}`,
    fallback: `https://images.unsplash.com/photo-1460353581641-37baddab0fa2?${UNSPLASH_SUFFIX}`,
  },
];

const GENERIC_FALLBACK = `https://images.unsplash.com/photo-1441986300917-64674bd600d8?${UNSPLASH_SUFFIX}`;

/**
 * @param {string} title
 * @returns {{ primary: string, fallback: string, rule: string }}
 */
export function photoUrlsForTitle(title) {
  const t = (title ?? '').toLowerCase();
  for (const rule of PHOTO_RULES) {
    const matches =
      typeof rule.match === 'function'
        ? rule.match(t)
        : rule.keywords.every((kw) => t.includes(kw));
    if (matches) {
      return { primary: rule.primary, fallback: rule.fallback, rule: rule.keywords.join('+') };
    }
  }
  return { primary: GENERIC_FALLBACK, fallback: GENERIC_FALLBACK, rule: 'generic' };
}

function looksLikeImage(buf) {
  if (!buf || buf.length < 5 * 1024) return false;
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  return isJpeg || isPng;
}

/**
 * @param {string[]} urls
 * @returns {Promise<Buffer>}
 */
export async function downloadProductPhotoBytes(urls) {
  const tried = [];
  for (const url of urls) {
    if (!url || tried.includes(url)) continue;
    tried.push(url);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'image/jpeg,image/*' },
        redirect: 'follow',
      });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (looksLikeImage(buf)) return buf;
    } catch {
      /* try next */
    }
  }
  throw new Error(`download failed for URLs: ${tried.join(', ')}`);
}

/**
 * @param {string} title
 * @returns {Promise<Buffer>}
 */
export async function downloadPhotoForListingTitle(title) {
  const { primary, fallback } = photoUrlsForTitle(title);
  return downloadProductPhotoBytes([primary, fallback, GENERIC_FALLBACK]);
}

/**
 * @param {{ csrf: string | null, cookieHeader: () => string }} staff
 * @param {string} apiBase
 * @param {string} collectionKey
 * @param {Buffer} body
 */
export async function uploadListingJpeg(staff, apiBase, collectionKey, body) {
  const upload = await fetch(`${apiBase}/api/admin/media/upload`, {
    method: 'POST',
    headers: {
      'content-type': 'image/jpeg',
      'x-collection-key': collectionKey,
      'x-csrf-token': staff.csrf ?? '',
      cookie: staff.cookieHeader(),
    },
    body,
  });
  const uploadBody = await upload.json().catch(() => ({}));
  if (!upload.ok) {
    throw new Error(`media upload ${upload.status} ${JSON.stringify(uploadBody)}`);
  }
  const assetId = uploadBody.asset?.assetId;
  if (!assetId) throw new Error(`media upload missing assetId ${JSON.stringify(uploadBody)}`);
  return assetId;
}

/** Known catalogue titles from seed-men-women-catalogue.mjs */
export const CATALOGUE_TITLES = [
  "Men's Classic Chronograph Watch",
  "Men's Leather Bomber Jacket",
  "Men's Mountain Bike — 21-speed",
  "Men's Running Sneakers — 450 QAR",
  "Men's Wool Overcoat",
  "Women's Rose-Gold Dress Watch",
  "Women's Evening Dress",
  "Women's Leather Crossbody Handbag — 1,250 QAR",
  "Women's City Bicycle — step-through",
  "Women's Block-Heel Sandals — 320 QAR",
];

/**
 * @param {string} title
 * @returns {boolean}
 */
export function isCatalogueListingTitle(title) {
  const en = typeof title === 'string' ? title : title?.en ?? '';
  return CATALOGUE_TITLES.includes(en);
}
