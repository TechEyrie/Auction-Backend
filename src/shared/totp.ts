import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * RFC 6238 TOTP built on RFC 4226 HOTP, using node:crypto HMAC-SHA1.
 * The cryptographic primitive comes from Node core; only the standard algorithm
 * (with published test vectors) is implemented here — no custom crypto.
 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').toUpperCase().replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx < 0) throw new Error('invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

function hotp(secret: Buffer, counter: number, digits: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(buf).digest();
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const binary =
    ((digest[offset] as number) & 0x7f) << 24 |
    ((digest[offset + 1] as number) & 0xff) << 16 |
    ((digest[offset + 2] as number) & 0xff) << 8 |
    ((digest[offset + 3] as number) & 0xff);
  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

export const TOTP_STEP_SECONDS = 30;

export function generateTotp(secretBase32: string, atMs = Date.now(), digits = 6, step = TOTP_STEP_SECONDS): string {
  const counter = Math.floor(atMs / 1000 / step);
  return hotp(base32Decode(secretBase32), counter, digits);
}

/** Verify with a +/- window and constant-time comparison. */
export function verifyTotp(
  secretBase32: string,
  code: string,
  options: { atMs?: number; digits?: number; step?: number; window?: number } = {},
): boolean {
  const digits = options.digits ?? 6;
  const step = options.step ?? TOTP_STEP_SECONDS;
  const window = options.window ?? 1;
  const atMs = options.atMs ?? Date.now();
  if (!new RegExp(`^\\d{${digits}}$`).test(code)) return false;
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(atMs / 1000 / step);
  for (let i = -window; i <= window; i += 1) {
    const candidate = hotp(secret, counter + i, digits);
    if (candidate.length === code.length && timingSafeEqual(Buffer.from(candidate), Buffer.from(code))) {
      return true;
    }
  }
  return false;
}
