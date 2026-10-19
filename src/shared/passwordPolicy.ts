/**
 * Password strength used at registration and reset.
 *
 * Login never re-applies this: existing accounts keep signing in with whatever
 * hash they already have. The browser meter uses the same rules as this file
 * (`frontend/lib/passwordPolicy.ts`) — keep them in lockstep.
 */

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;
export const PASSWORD_ACCEPTABLE_SCORE = 2;

export type PasswordIssue =
  | 'too_short'
  | 'too_long'
  | 'too_common'
  | 'personal'
  | 'low_variety'
  | 'repetitive'
  | 'sequential';

export type PasswordScore = 0 | 1 | 2 | 3 | 4;

export type PasswordStrength = {
  score: PasswordScore;
  label: 'too-weak' | 'weak' | 'fair' | 'good' | 'strong';
  acceptable: boolean;
  issues: PasswordIssue[];
  classes: number;
};

export type PasswordContext = {
  email?: string | null;
  fullName?: string | null;
};

const COMMON = new Set([
  'password',
  'password1',
  'password12',
  'password123',
  'passw0rd',
  'passwd',
  'p@ssword',
  'p@ssw0rd',
  'qwerty',
  'qwerty123',
  'qwertyuiop',
  'asdfgh',
  'asdfghjkl',
  'zxcvbn',
  'zxcvbnm',
  '123456',
  '1234567',
  '12345678',
  '123456789',
  '1234567890',
  '111111',
  '11111111',
  '000000',
  'abc123',
  'abcd1234',
  'letmein',
  'welcome',
  'welcome1',
  'welcome123',
  'admin',
  'admin123',
  'administrator',
  'root',
  'toor',
  'login',
  'master',
  'monkey',
  'dragon',
  'sunshine',
  'princess',
  'football',
  'baseball',
  'iloveyou',
  'starwars',
  'shadow',
  'trustno1',
  'whatever',
  'hello123',
  'changeme',
  'secret',
  'secret123',
  'pass1234',
  'pass12345',
  'qatar',
  'qatar123',
  'doha',
  'doha123',
  'doha2024',
  'doha2025',
  'doha2026',
  'arabia',
  'auction',
  'auctions',
  'araq',
  'kahraman',
  'araqkahraman',
]);

const ISSUE_MESSAGE: Record<PasswordIssue, string> = {
  too_short: `must be at least ${PASSWORD_MIN_LENGTH} characters`,
  too_long: `must be at most ${PASSWORD_MAX_LENGTH} characters`,
  too_common: 'is too common — choose something people would not guess',
  personal: 'must not include your name or email',
  low_variety: 'mix letters with numbers or symbols',
  repetitive: 'must not repeat the same character',
  sequential: 'must not be a keyboard or number sequence',
};

export function passwordIssueMessage(issue: PasswordIssue): string {
  return ISSUE_MESSAGE[issue];
}

function fold(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function characterClasses(password: string): number {
  let count = 0;
  if (/\p{Ll}/u.test(password)) count += 1;
  if (/\p{Lu}/u.test(password)) count += 1;
  if (/\p{Nd}/u.test(password)) count += 1;
  if (/[^\p{L}\p{Nd}]/u.test(password)) count += 1;
  return count;
}

function uniqueCount(password: string): number {
  return new Set([...password]).size;
}

function isCommonPassword(password: string): boolean {
  const folded = fold(password);
  if (!folded) return false;
  if (COMMON.has(folded) || COMMON.has(password.trim().toLowerCase())) return true;
  for (const word of COMMON) {
    if (word.length < 5) continue;
    if (folded === word) return true;
    if (folded.startsWith(word) && /^\d+$/.test(folded.slice(word.length))) return true;
    if (folded.endsWith(word) && /^\d+$/.test(folded.slice(0, -word.length))) return true;
  }
  return false;
}

function personalTokens(ctx: PasswordContext | undefined): string[] {
  const tokens: string[] = [];
  const email = ctx?.email?.trim().toLowerCase() ?? '';
  const local = email.split('@')[0] ?? '';
  if (local.replace(/[^a-z0-9]/g, '').length >= 4) tokens.push(local);
  const name = ctx?.fullName?.trim() ?? '';
  for (const part of name.split(/[\s,.\-_]+/)) {
    if (part.replace(/[^a-zA-Z0-9]/g, '').length >= 4) tokens.push(part);
  }
  return tokens;
}

function containsPersonal(password: string, ctx: PasswordContext | undefined): boolean {
  const folded = fold(password);
  if (folded.length < 4) return false;
  const tokens = personalTokens(ctx).map((token) => fold(token)).filter((token) => token.length >= 4);
  for (const [index, needle] of tokens.entries()) {
    if (index === 0 && folded.startsWith(needle)) return true;
    if (needle.length >= 6 && folded.includes(needle)) return true;
  }
  if (tokens.length >= 2) {
    const joined = tokens.join('');
    if (joined.length >= 6 && folded.includes(joined)) return true;
  }
  return false;
}

function hasRepeatRun(password: string): boolean {
  return /(.)\1{3,}/u.test(password);
}

function hasSequence(password: string): boolean {
  const folded = fold(password);
  if (folded.length < 5) return false;
  const run = (alphabet: string, size: number): boolean => {
    const reverse = [...alphabet].reverse().join('');
    for (const line of [alphabet, reverse]) {
      for (let i = 0; i <= line.length - size; i += 1) {
        if (folded.includes(line.slice(i, i + size))) return true;
      }
    }
    return false;
  };
  if (run('abcdefghijklmnopqrstuvwxyz', 5)) return true;
  if (run('qwertyuiopasdfghjklzxcvbnm', 5)) return true;
  if (run('0123456789', 6)) return true;
  return false;
}

function clampScore(value: number): PasswordScore {
  if (value <= 0) return 0;
  if (value >= 4) return 4;
  return value as PasswordScore;
}

function labelFor(score: PasswordScore): PasswordStrength['label'] {
  if (score <= 0) return 'too-weak';
  if (score === 1) return 'weak';
  if (score === 2) return 'fair';
  if (score === 3) return 'good';
  return 'strong';
}

export function evaluatePassword(password: string, ctx: PasswordContext = {}): PasswordStrength {
  const issues: PasswordIssue[] = [];
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) issues.push('too_short');
  if (typeof password === 'string' && password.length > PASSWORD_MAX_LENGTH) issues.push('too_long');

  const classes = typeof password === 'string' ? characterClasses(password) : 0;
  const unique = typeof password === 'string' ? uniqueCount(password) : 0;
  const common = typeof password === 'string' && isCommonPassword(password);
  const personal = typeof password === 'string' && containsPersonal(password, ctx);
  const repetitive = typeof password === 'string' && hasRepeatRun(password);
  const sequential = typeof password === 'string' && hasSequence(password);

  if (common) issues.push('too_common');
  if (personal) issues.push('personal');
  if (password.length >= PASSWORD_MIN_LENGTH && classes < 2) issues.push('low_variety');
  if (repetitive) issues.push('repetitive');
  if (sequential) issues.push('sequential');

  let raw = 0;
  if (password.length >= PASSWORD_MIN_LENGTH) raw += 1;
  if (password.length >= 14) raw += 1;
  if (classes >= 3) raw += 1;
  if (classes >= 4) raw += 1;
  if (unique >= 8 && unique * 2 >= password.length) raw += 1;
  if (common || personal) raw = 0;
  else {
    if (repetitive) raw -= 1;
    if (sequential) raw -= 1;
    if (classes < 2) raw = Math.min(raw, 1);
  }

  const rawScore = clampScore(raw);
  const acceptable =
    issues.length === 0 &&
    rawScore >= PASSWORD_ACCEPTABLE_SCORE &&
    password.length >= PASSWORD_MIN_LENGTH &&
    password.length <= PASSWORD_MAX_LENGTH;
  const score = acceptable ? rawScore : clampScore(Math.min(rawScore, 1));

  return { score, label: labelFor(score), acceptable, issues, classes };
}

export function passwordPolicyMessage(result: PasswordStrength): string {
  const first = result.issues[0];
  if (first) return passwordIssueMessage(first);
  if (!result.acceptable) return 'is not strong enough';
  return '';
}
