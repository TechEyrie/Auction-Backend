/**
 * Unsplash JPEG URLs and download helpers for Qatari accessories catalogue photos.
 */

const UNSPLASH_SUFFIX = 'auto=format&fit=crop&w=1200&q=80';
const USER_AGENT = 'TechEyrie-AuctionMERN-dev-script/1.0 (+local catalogue photo refresh)';

/** Primary + fallback Unsplash image URLs per product theme. */
export const PHOTO_RULES = [
  {
    keywords: ['misbaha', 'tasbeeh', 'prayer beads'],
    match: (t) => t.includes('misbaha') || t.includes('tasbeeh') || t.includes('prayer beads'),
    primary: `https://images.unsplash.com/photo-1606760227091-3dd870d97f1d?${UNSPLASH_SUFFIX}`,
    fallback: `https://images.unsplash.com/photo-1515562141207-7a88fb7ce338?${UNSPLASH_SUFFIX}`,
  },
  {
    keywords: ['oud oil', 'attar'],
    match: (t) => t.includes('oud oil') || t.includes('attar'),
    primary: `https://images.unsplash.com/photo-1541643600914-78b084683601?${UNSPLASH_SUFFIX}`,
    fallback: `https://images.unsplash.com/photo-1594035910387-fea47794261f?${UNSPLASH_SUFFIX}`,
  },
  {
    keywords: ['bakhoor', 'incense'],
    match: (t) => t.includes('bakhoor') || t.includes('incense'),
    primary: `https://images.unsplash.com/photo-1608571423902-eed4a5ad8108?${UNSPLASH_SUFFIX}`,
    fallback: `https://images.unsplash.com/photo-1615634260167-c8cdede054de?${UNSPLASH_SUFFIX}`,
  },
  {
    keywords: ['mabkhara', 'burner'],
    match: (t) => t.includes('mabkhara') || t.includes('burner'),
    primary: `https://images.unsplash.com/photo-1615634260167-c8cdede054de?${UNSPLASH_SUFFIX}`,
    fallback: `https://images.unsplash.com/photo-1608571423902-eed4a5ad8108?${UNSPLASH_SUFFIX}`,
  },
  {
    keywords: ['cufflink', 'khanjar'],
    match: (t) => t.includes('cufflink') || t.includes('khanjar'),
    primary: `https://images.unsplash.com/photo-1617038260897-41a1f14a8ca0?${UNSPLASH_SUFFIX}`,
    fallback: `https://images.unsplash.com/photo-1599643478518-a784e5dc4c8f?${UNSPLASH_SUFFIX}`,
  },
  {
    keywords: ['bisht', 'cloak'],
    match: (t) => t.includes('bisht') || t.includes('cloak'),
    primary: `https://images.unsplash.com/photo-1558171813-4c08810b2247?${UNSPLASH_SUFFIX}`,
    fallback: `https://images.unsplash.com/photo-1594938298603-c8148c4dae35?${UNSPLASH_SUFFIX}`,
  },
  {
    keywords: ['bangle', 'gold'],
    match: (t) => t.includes('bangle') || (t.includes('gold') && t.includes('set')),
    primary: `https://images.unsplash.com/photo-1611591437281-460bfbe1220a?${UNSPLASH_SUFFIX}`,
    fallback: `https://images.unsplash.com/photo-1515562141207-7a88fb7ce338?${UNSPLASH_SUFFIX}`,
  },
  {
    keywords: ['clutch', 'embroidered'],
    match: (t) => t.includes('clutch') || t.includes('embroidered'),
    primary: `https://images.unsplash.com/photo-1566150905458-1bf1fc113f0d?${UNSPLASH_SUFFIX}`,
    fallback: `https://images.unsplash.com/photo-1584917865442-de89df76afd3?${UNSPLASH_SUFFIX}`,
  },
  {
    keywords: ['perfume', 'rose oud'],
    match: (t) => t.includes('perfume') || t.includes('rose oud'),
    primary: `https://images.unsplash.com/photo-1594035910387-fea47794261f?${UNSPLASH_SUFFIX}`,
    fallback: `https://images.unsplash.com/photo-1541643600914-78b084683601?${UNSPLASH_SUFFIX}`,
  },
  {
    keywords: ['pearl', 'necklace'],
    match: (t) => t.includes('pearl') || t.includes('necklace'),
    primary: `https://images.unsplash.com/photo-1599643478518-a784e5dc4c8f?${UNSPLASH_SUFFIX}`,
    fallback: `https://images.unsplash.com/photo-1515562141207-7a88fb7ce338?${UNSPLASH_SUFFIX}`,
  },
];

const GENERIC_FALLBACK = `https://images.unsplash.com/photo-1515562141207-7a88fb7ce338?${UNSPLASH_SUFFIX}`;

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
  'Amber Misbaha (Tasbeeh) — 99 beads',
  'Qatari Oud Oil Attar Set',
  'Silver Khanjar Cufflinks',
  "Men's Bisht Cloak — black & gold",
  'Brass Mabkhara (Incense Burner)',
  'Gold-Tone Bangles Set',
  'Embroidered Abaya Clutch',
  'Rose Oud Perfume — 50 ml',
  'Qatari Pearl Necklace',
  'Bakhoor Gift Box',
];

/**
 * @param {string} title
 * @returns {boolean}
 */
export function isCatalogueListingTitle(title) {
  const en = typeof title === 'string' ? title : title?.en ?? '';
  return CATALOGUE_TITLES.includes(en);
}
