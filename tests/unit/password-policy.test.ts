import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePassword, passwordPolicyMessage } from '../../src/shared/passwordPolicy.ts';

test('rejects short, common, sequential, repeated and personal passwords', () => {
  assert.equal(evaluatePassword('short').acceptable, false);
  assert.ok(evaluatePassword('password123').issues.includes('too_common'));
  assert.equal(evaluatePassword('Password1').acceptable, false);
  assert.ok(evaluatePassword('aaaaaaaaaa').issues.includes('repetitive'));
  assert.ok(evaluatePassword('abcdefghijk1').issues.includes('sequential'));
  assert.ok(
    evaluatePassword('NoorHouse99', { fullName: 'Noor Al Ali' }).issues.includes('personal'),
  );
  assert.ok(
    evaluatePassword('BuyerMail99!', { email: 'buyermail@example.com' }).issues.includes('personal'),
  );
  assert.equal(evaluatePassword('1234567890').acceptable, false);
});

test('accepts passphrases and mixed-class passwords used by fixtures', () => {
  assert.equal(evaluatePassword('correct horse 1').acceptable, true);
  assert.equal(evaluatePassword('fixture pass 123').acceptable, true);
  assert.equal(evaluatePassword('BuyerPass12').acceptable, true);
  assert.equal(evaluatePassword('super secret pw 1').acceptable, true);
  assert.equal(evaluatePassword('inject me please').acceptable, true);
  assert.ok(evaluatePassword('Tr0ub4dor&3horse').score >= 3);
});

test('policy message names the first blocking issue', () => {
  assert.match(passwordPolicyMessage(evaluatePassword('abc')), /at least 10/);
  assert.match(passwordPolicyMessage(evaluatePassword('password123')), /too common/);
});
