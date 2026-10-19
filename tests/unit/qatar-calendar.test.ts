import test from 'node:test';
import assert from 'node:assert/strict';
import { qatarMonthUtcBounds } from '../../src/shared/qatarCalendar.ts';

test('October 2026 Qatar month starts at 2026-09-30T21:00:00.000Z', () => {
  const { start, endExclusive } = qatarMonthUtcBounds(2026, 10);
  assert.equal(start.toISOString(), '2026-09-30T21:00:00.000Z');
  assert.equal(endExclusive.toISOString(), '2026-10-31T21:00:00.000Z');
});

test('December rolls into January next year', () => {
  const { start, endExclusive } = qatarMonthUtcBounds(2026, 12);
  assert.equal(start.toISOString(), '2026-11-30T21:00:00.000Z');
  assert.equal(endExclusive.toISOString(), '2026-12-31T21:00:00.000Z');
});
