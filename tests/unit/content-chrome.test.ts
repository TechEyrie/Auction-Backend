import test from 'node:test';
import assert from 'node:assert/strict';
import { chromePublishSchema, mergeChromeBody } from '../../src/modules/account/content-chrome.ts';

test('chrome publish accepts known header labels and rejects unknown fields', () => {
  const ok = chromePublishSchema.safeParse({
    key: 'header',
    en: { 'header.search': 'Find lots' },
    ar: { 'header.search': 'بحث' },
  });
  assert.equal(ok.success, true);
  const bad = chromePublishSchema.safeParse({
    key: 'header',
    en: { 'not.a.field': 'x' },
    ar: {},
  });
  assert.equal(bad.success, false);
});

test('chrome publish accepts known auth labels and rejects unknown fields', () => {
  const ok = chromePublishSchema.safeParse({
    key: 'auth',
    en: { 'auth.signIn.submit': 'Log in' },
    ar: { 'auth.signIn.submit': 'دخول' },
  });
  assert.equal(ok.success, true);
  const bad = chromePublishSchema.safeParse({
    key: 'auth',
    en: { 'auth.not.a.field': 'x' },
    ar: {},
  });
  assert.equal(bad.success, false);
});

test('chrome merge keeps other auth tabs when patching sign-in labels', () => {
  const merged = mergeChromeBody(
    { en: { 'auth.signIn.submit': 'Log in', 'auth.register.submit': 'Join' }, ar: {} },
    { en: { 'auth.signIn.submit': 'Sign in' }, ar: { 'auth.signIn.submit': '' } },
  );
  assert.equal(merged.en['auth.signIn.submit'], 'Sign in');
  assert.equal(merged.en['auth.register.submit'], 'Join');
  assert.equal(merged.ar['auth.signIn.submit'], undefined);
});

test('chrome publish accepts known help labels and rejects unknown fields', () => {
  const ok = chromePublishSchema.safeParse({
    key: 'help',
    en: { 'help.h1': 'Need a hand?' },
    ar: { 'help.h1': 'تحتاج مساعدة؟' },
  });
  assert.equal(ok.success, true);
  const bad = chromePublishSchema.safeParse({
    key: 'help',
    en: { 'help.unknown': 'x' },
    ar: {},
  });
  assert.equal(bad.success, false);
});
