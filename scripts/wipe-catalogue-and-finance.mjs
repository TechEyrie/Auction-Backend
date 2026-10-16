/**
 * Destructive: clear catalogue, auction, media, enquiry, and finance collections.
 * Keeps users, sessions, sellers, taxonomy, locations, and content pages.
 *
 * Usage from backend/:
 *   node --env-file-if-exists=.env scripts/wipe-catalogue-and-finance.mjs --confirm-wipe-catalogue --db=araq_kahraman
 */
import { MongoClient } from 'mongodb';

const CONFIRM = '--confirm-wipe-catalogue';
const WIPE = [
  'listings',
  'auctions',
  'bids',
  'orders',
  'financial_entries',
  'payment_completions',
  'media_assets',
  'media_references',
  'enquiries',
  'outbox_events',
  'durable_jobs',
  'idempotency_records',
];

function argValue(prefix) {
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

async function main() {
  if (!process.argv.includes(CONFIRM)) {
    console.error(`Refusing: pass ${CONFIRM} to wipe catalogue/finance data.`);
    process.exit(2);
  }
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is required');
    process.exit(2);
  }
  const dbName =
    argValue('--db=') ??
    (() => {
      try {
        const path = new URL(uri).pathname.replace(/^\//, '');
        return path.split('?')[0] || process.env.MONGODB_DB || 'test';
      } catch {
        return process.env.MONGODB_DB || 'test';
      }
    })();

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  console.log(`Wiping catalogue/finance collections on database: ${dbName}`);

  const summary = {};
  for (const name of WIPE) {
    const result = await db.collection(name).deleteMany({});
    summary[name] = result.deletedCount;
    console.log(`  ${name}: deleted ${result.deletedCount}`);
  }

  await client.close();
  console.log('Done.', summary);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
