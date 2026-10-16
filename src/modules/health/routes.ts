import { Router } from 'express';

export type HealthDeps = {
  ping: () => Promise<void>;
};

/**
 * Liveness (`/healthz`): the process is up — always 200 while it can answer.
 * Readiness (`/readyz`): dependencies are usable — 503 when MongoDB is unreachable.
 */
export function healthRouter(deps: HealthDeps): Router {
  const router = Router();
  const startedAt = Date.now();

  router.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', uptimeMs: Date.now() - startedAt });
  });

  router.get('/readyz', async (_req, res) => {
    try {
      await deps.ping();
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'not_ready', reason: 'database_unavailable' });
    }
  });

  return router;
}
