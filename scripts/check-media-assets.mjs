import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('MONGODB_URI required');
  process.exit(2);
}

const client = new MongoClient(uri);
await client.connect();
const db = client.db('araq_kahraman');
const ready = await db.collection('media_assets').countDocuments({ status: 'ready' });
const sample = await db
  .collection('media_assets')
  .find({ status: 'ready' })
  .project({ assetId: 1, storageKey: 1, status: 1, bytes: 1 })
  .limit(5)
  .toArray();
console.log(JSON.stringify({ ready, sample }, null, 2));
await client.close();
