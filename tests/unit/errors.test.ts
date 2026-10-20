import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { errorHandler, notFoundHandler } from '../../src/middleware/errorHandler.ts';
import { requestId } from '../../src/middleware/requestId.ts';
import { AppError, validationError } from '../../src/shared/errors.ts';
import { silentLogger } from '../helpers/context.ts';
import { listen } from '../helpers/http.ts';

function buildApp() {
  const app = express();
  app.use(requestId());
  app.get('/boom', () => {
    throw new AppError('INTERNAL', 'secret internal detail');
  });
  app.get('/bad', () => {
    throw validationError({ email: 'required' });
  });
  app.get('/unavailable', () => {
    throw new AppError('SERVICE_UNAVAILABLE', 'We could not send email right now. Try again in a few minutes.');
  });
  app.get('/raw', () => {
    throw new Error('raw failure with internals');
  });
  app.use(notFoundHandler());
  app.use(errorHandler(silentLogger()));
  return app;
}

test('errors use the standard envelope and echo the request id', async () => {
  const server = await listen(buildApp());
  try {
    const res = await fetch(`${server.url}/nope`, { headers: { 'x-request-id': 'req-123' } });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('x-request-id'), 'req-123');
    const body = (await res.json()) as { error: Record<string, unknown> };
    assert.deepEqual(Object.keys(body), ['error']);
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.equal(body.error.requestId, 'req-123');
    assert.deepEqual(body.error.fieldErrors, {});
    assert.equal(typeof body.error.message, 'string');
  } finally {
    await server.close();
  }
});

test('validation errors return per-field errors with 422', async () => {
  const server = await listen(buildApp());
  try {
    const res = await fetch(`${server.url}/bad`);
    assert.equal(res.status, 422);
    const body = (await res.json()) as { error: { code: string; fieldErrors: Record<string, string> } };
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.equal(body.error.fieldErrors.email, 'required');
  } finally {
    await server.close();
  }
});

test('service unavailable errors expose a safe client message with 503', async () => {
  const server = await listen(buildApp());
  try {
    const res = await fetch(`${server.url}/unavailable`);
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'SERVICE_UNAVAILABLE');
    assert.equal(body.error.message, 'We could not send email right now. Try again in a few minutes.');
    assert.notEqual(body.error.message, 'Internal server error');
  } finally {
    await server.close();
  }
});

test('internal errors expose no message or stack', async () => {
  const server = await listen(buildApp());
  try {
    for (const path of ['/boom', '/raw']) {
      const res = await fetch(`${server.url}${path}`);
      assert.equal(res.status, 500);
      const body = (await res.json()) as { error: Record<string, unknown> };
      assert.equal(body.error.code, 'INTERNAL');
      assert.equal(body.error.message, 'Internal server error');
      assert.equal(body.error.details && (body.error.details as Record<string, unknown>).stack, undefined);
      assert.ok(!JSON.stringify(body).includes('secret internal detail'));
      assert.ok(!JSON.stringify(body).includes('internals'));
    }
  } finally {
    await server.close();
  }
});

test('a request id is generated when none is supplied', async () => {
  const server = await listen(buildApp());
  try {
    const res = await fetch(`${server.url}/nope`);
    const header = res.headers.get('x-request-id');
    assert.match(header ?? '', /^[0-9a-f-]{36}$/);
  } finally {
    await server.close();
  }
});
