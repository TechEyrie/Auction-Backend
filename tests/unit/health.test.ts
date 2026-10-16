import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../src/app.ts';
import { silentLogger, stubDb, stubMediaStorage, testConfig } from '../helpers/context.ts';
import { listen } from '../helpers/http.ts';

test('readiness is 200 when the dependency is healthy', async () => {
  const app = createApp({
    config: testConfig(),
    logger: silentLogger(),
    ping: async () => {},
    ...stubDb(),
    mediaStorage: stubMediaStorage(),
  });
  const server = await listen(app);
  try {
    assert.equal((await fetch(`${server.url}/readyz`)).status, 200);
    assert.equal((await fetch(`${server.url}/healthz`)).status, 200);
  } finally {
    await server.close();
  }
});

test('liveness stays 200 while readiness is 503 when the dependency fails', async () => {
  const app = createApp({
    config: testConfig(),
    logger: silentLogger(),
    ping: async () => {
      throw new Error('database down');
    },
    ...stubDb(),
    mediaStorage: stubMediaStorage(),
  });
  const server = await listen(app);
  try {
    assert.equal((await fetch(`${server.url}/healthz`)).status, 200);
    const ready = await fetch(`${server.url}/readyz`);
    assert.equal(ready.status, 503);
    const body = (await ready.json()) as { status: string };
    assert.equal(body.status, 'not_ready');
  } finally {
    await server.close();
  }
});
