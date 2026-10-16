import test from 'node:test';
import assert from 'node:assert/strict';
import { openApiDocument, validateOpenApiDocument, type OpenApiDocument } from '../../src/openapi/openapi.ts';

test('the shipped OpenAPI document is structurally valid', () => {
  assert.deepEqual(validateOpenApiDocument(openApiDocument), []);
  assert.ok(openApiDocument.paths['/healthz']);
  assert.ok(openApiDocument.paths['/readyz']);
});

test('invalid documents are reported', () => {
  const broken: OpenApiDocument = {
    openapi: '2.0',
    info: { title: '', version: '' },
    paths: { nope: {} },
  };
  const issues = validateOpenApiDocument(broken);
  assert.ok(issues.some((i) => /3\.x/.test(i)));
  assert.ok(issues.some((i) => /title/.test(i)));
  assert.ok(issues.some((i) => /start with/.test(i)));
});
