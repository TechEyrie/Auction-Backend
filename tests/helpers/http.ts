import { createServer } from 'node:http';
import type { Express } from 'express';

export type TestHttpServer = { url: string; close: () => Promise<void> };

export async function listen(app: Express): Promise<TestHttpServer> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
