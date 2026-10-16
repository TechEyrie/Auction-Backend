import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageKitStorage, type ImageKitStorageClient } from '../../src/modules/media/storage-imagekit.ts';

function mockClient(overrides?: Partial<ImageKitStorageClient>): ImageKitStorageClient {
  const files = new Map<string, { url: string; bytes: Buffer }>();
  return {
    upload: async ({ file, fileName }) => {
      const fileId = `file_${fileName}`;
      const url = `https://cdn.example/${fileName}`;
      files.set(fileId, { url, bytes: file });
      return { fileId, url, filePath: `/folder/${fileName}` };
    },
    getFileDetails: async (fileId) => {
      const entry = files.get(fileId);
      if (!entry) throw new Error('missing');
      return { url: entry.url };
    },
    deleteFile: async (fileId) => {
      files.delete(fileId);
    },
    ...overrides,
  };
}

test('ImageKit storage put returns ik:fileId key and publicUrl', async () => {
  const storage = createImageKitStorage({
    urlEndpoint: 'https://ik.imagekit.io/demo',
    publicKey: 'public',
    privateKey: 'private',
    folder: '/araq-kahraman/listings',
    client: mockClient(),
  });
  const put = await storage.put('media/2026/01/abc-m_test.jpg', Buffer.from('pixels'));
  assert.equal(put.key, 'ik:file_abc-m_test.jpg');
  assert.equal(put.publicUrl, 'https://cdn.example/abc-m_test.jpg');
  assert.equal(await storage.exists(put.key), true);
  await storage.delete(put.key);
  assert.equal(await storage.exists(put.key), false);
});

test('ImageKit storage get downloads bytes from the CDN URL', async () => {
  const bytes = Buffer.from('hello-image');
  const client = mockClient();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), 'https://cdn.example/m_abc');
    return new Response(bytes, { status: 200 });
  };
  const storage = createImageKitStorage({
    urlEndpoint: 'https://ik.imagekit.io/demo',
    publicKey: 'public',
    privateKey: 'private',
    folder: '/test',
    client,
  });
  const put = await storage.put('staging/m_abc', bytes);
  const read = await storage.get(put.key);
  assert.deepEqual(read, bytes);
  globalThis.fetch = originalFetch;
});
