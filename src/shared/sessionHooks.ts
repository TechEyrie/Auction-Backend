type Hook = (sessionId: string) => void;
let hook: Hook = () => undefined;

/** Realtime registers this. Auth calls it after a session is revoked. */
export function setSessionRevokedHook(fn: Hook): void {
  hook = fn;
}

export function sessionRevoked(sessionId: string): void {
  hook(sessionId);
}
