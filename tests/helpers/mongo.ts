import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

/**
 * Prefer a real `mongod` binary already present on the machine (or supplied via
 * MONGOMS_SYSTEM_BINARY) so tests run without a network download. The returned
 * process is a real `mongod` replica set, so multi-document transactions work.
 */
export function findSystemBinary(version: string): string | undefined {
  if (process.env.MONGOMS_SYSTEM_BINARY) return process.env.MONGOMS_SYSTEM_BINARY;
  const cacheDir = path.join(os.homedir(), '.cache', 'mongodb-binaries');
  if (!existsSync(cacheDir)) return undefined;
  const candidates = readdirSync(cacheDir).filter(
    (f) => /^mongod/.test(f) && !f.endsWith('.downloading') && !f.endsWith('.lock'),
  );
  const preferred = candidates.find((f) => f.includes(version)) ?? candidates[0];
  return preferred ? path.join(cacheDir, preferred) : undefined;
}

export async function createReplSet(): Promise<MongoMemoryReplSet> {
  const version = process.env.MONGOMS_VERSION ?? '5.0.13';
  const systemBinary = findSystemBinary(version);
  return MongoMemoryReplSet.create({
    binary: systemBinary ? { systemBinary } : { version },
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
}
