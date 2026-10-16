import { MongoClient, type ClientSession, type Db, type TransactionOptions } from 'mongodb';

export type DbHandle = {
  client: MongoClient;
  db: Db;
  ping(): Promise<void>;
  withTransaction<T>(fn: (session: ClientSession) => Promise<T>, options?: TransactionOptions): Promise<T>;
  close(): Promise<void>;
};

/** Majority read/write concerns so committed financial writes are durable and visible consistently. */
export const TX_OPTIONS: TransactionOptions = {
  readConcern: { level: 'majority' },
  writeConcern: { w: 'majority' },
};

export async function connectDb(input: { mongodbUri: string; mongodbDb: string }): Promise<DbHandle> {
  const client = new MongoClient(input.mongodbUri, {
    serverSelectionTimeoutMS: 5000,
    appName: 'araq-kahraman-backend',
  });
  await client.connect();
  const db = client.db(input.mongodbDb);

  let closed = false;

  return {
    client,
    db,
    async ping(): Promise<void> {
      if (closed) throw new Error('database connection is closed');
      await db.command({ ping: 1 });
    },
    withTransaction: async <T>(
      fn: (session: ClientSession) => Promise<T>,
      options: TransactionOptions = TX_OPTIONS,
    ): Promise<T> => {
      const session = client.startSession();
      try {
        let result!: T;
        await session.withTransaction(async () => {
          result = await fn(session);
        }, options);
        return result;
      } finally {
        await session.endSession();
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await client.close();
    },
  };
}

export function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;
}
