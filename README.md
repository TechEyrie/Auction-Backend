# Araq & Kahraman — Backend

Express + strict TypeScript API, MongoDB (transaction-capable), Socket.IO-ready foundation.

Runtime executes TypeScript directly via Node's native type stripping, so there is **no emit
step**: `npm run build` is the strict production type gate, and `npm test` runs `.ts` tests
directly. Requires Node `>=22.18.0`.

## Commands (from `backend/`)

| Command | Purpose |
|---|---|
| `npm run dev` | Start with watch + `.env` (`node --watch src/server.ts`) |
| `npm start` | Start once |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Strict type gate (see note above) |
| `npm test` | Unit + real-MongoDB integration tests |
| `npm run test:unit` | Unit tests only (what GitHub CI runs) |
| `npm run test:integration` | Integration tests only (needs local mongod) |
| `npm run indexes` | Create/refresh foundational indexes |
| `npm run seed -- --target=development` | Guarded seed (refuses production/unknown targets) |

## Configuration

Copy `.env.example` to `.env`. `MONGODB_URI` is required and must point at a
transaction-capable MongoDB (replica set). Startup fails fast with a clear message when
required configuration is missing. Never commit `.env` and never place secrets in
`NEXT_PUBLIC_*` variables.

## Integration tests

GitHub CI runs `npm run typecheck` and `npm run test:unit` only — no mongod download.
`npm run test:integration` (and full `npm test`) still boot a real replica set via
`mongodb-memory-server` on your machine. Override with `MONGOMS_VERSION` / `MONGOMS_SYSTEM_BINARY`.

## Endpoints (foundation)

- `GET /healthz` — liveness (200 while the process answers)
- `GET /readyz` — readiness (200, or 503 when MongoDB is unavailable)
- `GET /api/openapi.json` — OpenAPI 3.1 document
