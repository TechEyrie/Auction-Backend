import type { ClientSession, Db } from 'mongodb';
import type { AppConfig } from '../../src/config/index.ts';
import { loadConfig } from '../../src/config/index.ts';
import { createLogger, type Logger } from '../../src/shared/logger.ts';

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({ ...testEnv(), ...overrides });
}

export function silentLogger(): Logger {
  return createLogger('error', { write: () => true });
}

/** Test environment values including a valid MFA key and bootstrap token. */
export function testEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: 'test',
    PORT: '0',
    MONGODB_URI: 'mongodb://127.0.0.1:27017/?replicaSet=rs0',
    CORS_ORIGINS: 'http://localhost:3000',
    MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    ADMIN_BOOTSTRAP_TOKEN: 'test-bootstrap-token',
    MEDIA_DRIVER: 'local',
    ...overrides,
  };
}

/** In-memory storage stub so unit tests never touch the filesystem. */
export function stubMediaStorage(): import('../../src/modules/media/storage.ts').MediaStorage {
  const files = new Map<string, Buffer>();
  return {
    driver: 'memory',
    put: async (key, bytes) => {
      files.set(key, bytes);
      return { key };
    },
    get: async (key) => {
      const value = files.get(key);
      if (!value) throw new Error(`missing key ${key}`);
      return value;
    },
    delete: async (key) => void files.delete(key),
    exists: async (key) => files.has(key),
  };
}

/** Stub database dependencies for tests that never touch persistence. */
export function stubDb(): {
  db: Db;
  withTransaction: <T>(fn: (session: ClientSession) => Promise<T>) => Promise<T>;
} {
  return {
    db: {} as Db,
    withTransaction: async () => {
      throw new Error('withTransaction is not available in this test');
    },
  };
}
