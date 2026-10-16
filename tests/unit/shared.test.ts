import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../../src/shared/errors.ts';
import { assertMinorAmount, formatMinor, qarToMinor } from '../../src/shared/money.ts';
import { isValidIsoTimestamp } from '../../src/shared/time.ts';

test('money uses integer minor units', () => {
  assert.equal(qarToMinor('3,400'), 340000);
  assert.equal(qarToMinor(215000), 21500000);
  assert.equal(formatMinor(340000), '3,400.00 QAR');
  assert.throws(() => assertMinorAmount(1.5), AppError);
  assert.throws(() => assertMinorAmount(-1), AppError);
});

test('timestamps must be explicit UTC ISO instants', () => {
  assert.equal(isValidIsoTimestamp('2026-10-14T12:00:00Z'), true);
  assert.equal(isValidIsoTimestamp('2026-10-14T12:00:00.123Z'), true);
  assert.equal(isValidIsoTimestamp('2026-10-14T12:00:00+03:00'), false);
  assert.equal(isValidIsoTimestamp('not-a-date'), false);
});
