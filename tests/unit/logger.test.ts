import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, redact, REDACTED } from '../../src/shared/logger.ts';

test('redacts sensitive keys recursively', () => {
  const out = redact({
    user: { password: 'p', nested: { token: 't', name: 'ok' } },
    authorization: 'Bearer abc',
    cookie: 'sid=1',
    apiKey: 'k',
    attempts: 3,
  }) as Record<string, unknown>;
  assert.equal((out.user as Record<string, unknown>).password, REDACTED);
  assert.equal(
    ((out.user as Record<string, unknown>).nested as Record<string, unknown>).token,
    REDACTED,
  );
  assert.equal(((out.user as Record<string, unknown>).nested as Record<string, unknown>).name, 'ok');
  assert.equal(out.authorization, REDACTED);
  assert.equal(out.cookie, REDACTED);
  assert.equal(out.apiKey, REDACTED);
  assert.equal(out.attempts, 3);
});

test('createLogger emits redacted JSON and honours the level', () => {
  const lines: string[] = [];
  const logger = createLogger('info', {
    write: (chunk: string) => {
      lines.push(chunk);
      return true;
    },
  });
  logger.debug('should be filtered');
  logger.info('hello', { password: 'secret', userId: 'u1' });

  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0] as string) as Record<string, unknown>;
  assert.equal(record.msg, 'hello');
  assert.equal(record.password, REDACTED);
  assert.equal(record.userId, 'u1');
  assert.equal(record.level, 'info');
});
