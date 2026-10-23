import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

/**
 * Prefer a real `mongod` binary already present on the machine (or supplied via
 * MONGOMS_SYSTEM_BINARY) so tests run without a network download. The returned
 * process is a real `mongod` replica set, so multi-document transactions work.
 *
 * Default 7.x: GitHub ubuntu-24.04 / OpenSSL 3 (Mongo 5.x needs libssl 1.1). Override with
 * MONGOMS_VERSION or MONGOMS_SYSTEM_BINARY.
 */
export function findSystemBinary(version: string): string | undefined {
  if (process.env.MONGOMS_SYSTEM_BINARY) return process.env.MONGOMS_SYSTEM_BINARY;
  const cacheDir = path.join(os.homedir(), '.cache', 'mongodb-binaries');
  if (!existsSync(cacheDir)) return undefined;
  const candidates = readdirSync(cacheDir).filter(
    (f) => /^mongod/.test(f) && !f.endsWith('.downloading') && !f.endsWith('.lock'),
  );
  const match = candidates.find((f) => f.includes(version));
  return match ? path.join(cacheDir, match) : undefined;
}

export async function createReplSet(): Promise<MongoMemoryReplSet> {
  const version = process.env.MONGOMS_VERSION ?? '7.0.14';
  const systemBinary = findSystemBinary(version);
  return MongoMemoryReplSet.create({
    binary: systemBinary ? { systemBinary } : { version },
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
}
