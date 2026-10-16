import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import type { AppConfig } from './config/index.ts';
import type { Db } from 'mongodb';
import { parseCookies, SESSION_COOKIE } from './modules/auth/cookies.ts';
import { sha256Hex } from './shared/crypto.ts';
import * as authRepo from './modules/auth/repository.ts';
import { capabilitiesFor } from './modules/auth/roles.ts';
import { requiresMfa } from './modules/auth/service.ts';
import { claimEvents, markPublished, reclaimExpiredLeases } from './modules/outbox/repository.ts';
import { setSessionRevokedHook } from './shared/sessionHooks.ts';

const PUBLIC_TYPES = new Set(['bid.accepted', 'auction.closed', 'auction.started']);

function wireType(type: string): string {
  return type === 'bid.accepted' ? 'auction.bid.accepted' : type;
}

/** Public rooms only. Private rooms are chosen from the session, never from the client id. */
export function attachRealtime(http: HttpServer, deps: { db: Db; config: AppConfig }): () => void {
  const io = new Server(http, {
    cors: { origin: deps.config.corsOrigins, credentials: true },
    maxHttpBufferSize: 8_000,
    connectionStateRecovery: { maxDisconnectionDuration: 60_000 },
  });

  const bySession = new Map<string, Set<import('socket.io').Socket>>();
  setSessionRevokedHook((sessionId) => {
    for (const socket of bySession.get(sessionId) ?? []) socket.disconnect(true);
    bySession.delete(sessionId);
  });

  io.use(async (socket, next) => {
    try {
      const token = parseCookies(socket.handshake.headers.cookie)[SESSION_COOKIE];
      socket.data.userRef = null;
      socket.data.staff = false;
      socket.data.sessionId = null;
      if (!token) return next();
      const session = await authRepo.findSessionByTokenHash(deps.db, sha256Hex(token));
      const now = Date.now();
      if (!session || session.revokedAt || session.idleExpiresAt.getTime() <= now || session.absoluteExpiresAt.getTime() <= now) {
        return next();
      }
      const user = await authRepo.findUserById(deps.db, session.userId);
      if (!user || user.status !== 'active') return next();
      socket.data.userRef = user.publicReference;
      const mfaOk = !requiresMfa(user) || session.mfaSatisfied; // TEMP: honor requiresMfa while MFA off
      socket.data.staff = mfaOk && capabilitiesFor(user.roles).has('admin.access');
      socket.data.sessionId = String(session._id);
      next();
    } catch (err) {
      next(err instanceof Error ? err : new Error('auth failed'));
    }
  });

  io.on('connection', (socket) => {
    const sessionId = socket.data.sessionId as string | null;
    if (sessionId) {
      const group = bySession.get(sessionId) ?? new Set();
      group.add(socket);
      bySession.set(sessionId, group);
      socket.on('disconnect', () => group.delete(socket));
    }
    socket.on('join', (room: unknown) => {
      if (room === 'auctions') {
        socket.join('auctions');
        return;
      }
      if (typeof room === 'string' && /^lot_[a-f0-9]+$/.test(room)) {
        socket.join(`auction:${room}`);
        return;
      }
      if (room === 'me' && socket.data.userRef) {
        socket.join(`user:${socket.data.userRef}`);
        return;
      }
      if (room === 'admin' && socket.data.staff) {
        socket.join('admin');
        return;
      }
      socket.emit('join.error', { message: 'Room refused' });
    });
  });

  const timer = setInterval(() => {
    void dispatch(io, deps.db).catch(() => undefined);
  }, 400);
  timer.unref?.();

  return () => {
    clearInterval(timer);
    io.close();
  };
}

async function dispatch(io: Server, db: Db): Promise<void> {
  await reclaimExpiredLeases(db, { limit: 20 });
  const events = await claimEvents(db, { limit: 20, leaseMs: 10_000 });
  for (const event of events) {
    if (PUBLIC_TYPES.has(event.type)) {
      const data = {
        amountMinor: event.payload.amountMinor ?? null,
        sequence: event.payload.sequence ?? null,
        status: event.payload.status ?? null,
        outcome: event.payload.outcome ?? null,
      };
      io.to('auctions').to(`auction:${event.aggregateId}`).emit('auction', {
        eventId: event.eventId,
        type: wireType(event.type),
        auctionId: event.aggregateId,
        version: event.aggregateVersion,
        occurredAt: event.createdAt.toISOString(),
        data,
      });
    }
    await markPublished(db, event.eventId);
  }
}
