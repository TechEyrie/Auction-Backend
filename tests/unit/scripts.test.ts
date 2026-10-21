import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('package.json exposes the documented commands', () => {
  const pkg = JSON.parse(readFileSync(path.join(backendDir, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  for (const name of ['dev', 'start', 'typecheck', 'build', 'test', 'seed', 'indexes']) {
    assert.ok(pkg.scripts[name], `missing script: ${name}`);
  }
});

test('CI workflow exists and runs the core checks', () => {
  const inPackage = path.join(backendDir, '.github', 'workflows', 'ci.yml');
  const inMonorepo = path.join(backendDir, '..', '.github', 'workflows', 'backend-ci.yml');
  const workflow = existsSync(inPackage) ? inPackage : inMonorepo;
  assert.ok(existsSync(workflow), 'backend CI workflow is missing');
  const yml = readFileSync(workflow, 'utf8');
  assert.match(yml, /npm run typecheck/);
  assert.match(yml, /npm test/);
});
