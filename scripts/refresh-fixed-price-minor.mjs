/**
 * One-shot: set priceMinor + availability on published fixed-price catalogue rows.
 * Run from backend/: node scripts/refresh-fixed-price-minor.mjs
 */
import { loadConfig } from '../src/config/index.ts';
import { connectDb } from '../src/db/connection.ts';
import { COLLECTIONS } from '../src/db/indexes.ts';
import { qarToMinor } from '../src/shared/money.ts';

const TITLE_PRICE = [
  [/450\s*QAR/i, 450],
  [/1[,.]?250\s*QAR/i, 1250],
  [/320\s*QAR/i, 320],
];

function priceFromTitle(titleEn) {
  if (!titleEn) return null;
  for (const [pattern, qar] of TITLE_PRICE) {
    if (pattern.test(titleEn)) return qarToMinor(qar);
  }
  return null;
}

const config = loadConfig(process.env);
const { db, client } = await connectDb(config);
try {
  const cursor = db.collection(COLLECTIONS.listings).find({
    listingMethod: 'fixed_price',
    status: 'published',
  });
  let updated = 0;
  for await (const doc of cursor) {
    const titleEn = doc.title?.en ?? '';
    const priceMinor = typeof doc.priceMinor === 'number' && doc.priceMinor > 0
      ? doc.priceMinor
      : priceFromTitle(titleEn);
    const patch = {
      ...(priceMinor ? { priceMinor } : {}),
      availability: doc.availability === 'sold' ? 'sold' : 'available',
    };
    await db.collection(COLLECTIONS.listings).updateOne({ listingReference: doc.listingReference }, { $set: patch });
    updated += 1;
    console.log(doc.listingReference, titleEn.slice(0, 48), patch);
  }
  console.log(`Updated ${updated} fixed-price listing(s).`);
} finally {
  await client.close();
}
