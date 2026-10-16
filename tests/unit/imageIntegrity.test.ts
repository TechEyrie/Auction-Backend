import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectImage, stripImageMetadata, verifyImageIntegrity } from '../../src/modules/media/imageInfo.ts';
import { png } from '../helpers/images.ts';

/**
 * Integrity tests against fixtures a real encoder produced (`scripts/generate-image-fixtures.mjs`).
 *
 * These are deliberately about the **container**: completeness, chunk structure, header checksum.
 * The last test in this file pins the ceiling of that assurance — a container-complete file with
 * garbage entropy data still passes, because no decoder runs. Do not read these tests as proof of
 * decodability or of malware safety.
 */

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'images');
const fixture = (name: string) => readFileSync(path.join(fixturesDir, name));

const FIXTURES = [
  { file: 'photo-640x480.png', mime: 'image/png' as const, width: 640, height: 480 },
  { file: 'photo-800x600.jpg', mime: 'image/jpeg' as const, width: 800, height: 600 },
  { file: 'photo-320x240.webp', mime: 'image/webp' as const, width: 320, height: 240 },
  { file: 'photo-2000x1500.jpg', mime: 'image/jpeg' as const, width: 2000, height: 1500 },
];

test('encoder-produced fixtures are identified with their real type and dimensions', () => {
  for (const entry of FIXTURES) {
    const bytes = fixture(entry.file);
    const info = inspectImage(bytes);
    assert.ok(info, `${entry.file} should be identified`);
    assert.equal(info.mime, entry.mime, entry.file);
    assert.equal(info.width, entry.width, entry.file);
    assert.equal(info.height, entry.height, entry.file);
    assert.equal(verifyImageIntegrity(bytes, entry.mime), null, `${entry.file} should be intact`);
  }
});

test('a truncated fixture is refused with a reason, never stored', () => {
  const pngBytes = fixture('photo-640x480.png');
  const jpegBytes = fixture('photo-800x600.jpg');
  const webpBytes = fixture('photo-320x240.webp');

  const truncatedPng = pngBytes.subarray(0, Math.floor(pngBytes.length / 3));
  const truncatedJpeg = jpegBytes.subarray(0, jpegBytes.length - 2);
  const truncatedWebp = webpBytes.subarray(0, Math.floor(webpBytes.length / 2));

  // The header still parses (that is exactly why a signature check alone is not enough) ...
  assert.ok(inspectImage(truncatedPng));
  assert.ok(inspectImage(truncatedJpeg));
  assert.ok(inspectImage(truncatedWebp));

  // ... and the integrity check is what catches the incomplete file.
  assert.match(String(verifyImageIntegrity(truncatedPng, 'image/png')), /truncated|end marker/i);
  assert.match(String(verifyImageIntegrity(truncatedJpeg, 'image/jpeg')), /truncated/i);
  assert.match(String(verifyImageIntegrity(truncatedWebp, 'image/webp')), /truncated/i);
});

test('a corrupted PNG header checksum is refused', () => {
  const bytes = Buffer.from(fixture('photo-640x480.png'));
  bytes[17] = bytes[17]! ^ 0xff; // flip a byte inside IHDR width without fixing the CRC
  assert.match(String(verifyImageIntegrity(bytes, 'image/png')), /checksum/i);
});

test('trailing data after the container end is refused', () => {
  const pngBytes = Buffer.concat([fixture('photo-640x480.png'), Buffer.from('garbage')]);
  assert.match(String(verifyImageIntegrity(pngBytes, 'image/png')), /trailing/i);

  // For JPEG the end-of-image marker is required as the final two bytes, so bytes appended after
  // it are refused too (the container no longer ends where it says it does).
  const jpegBytes = Buffer.concat([fixture('photo-800x600.jpg'), Buffer.from('garbage')]);
  assert.match(String(verifyImageIntegrity(jpegBytes, 'image/jpeg')), /truncated/i);

  const webpBytes = Buffer.concat([fixture('photo-320x240.webp'), Buffer.alloc(4)]);
  assert.match(String(verifyImageIntegrity(webpBytes, 'image/webp')), /trailing/i);
});

test('a PNG without image data is refused', () => {
  const headerOnly = png(64, 64, { headerOnly: true });
  assert.ok(inspectImage(headerOnly), 'the header parses');
  assert.match(String(verifyImageIntegrity(headerOnly, 'image/png')), /no image data|end marker/i);
});

test('metadata stripping removes real EXIF/GPS data and leaves an intact container', () => {
  for (const entry of FIXTURES.filter((item) => item.width < 1000)) {
    const bytes = fixture(entry.file);
    assert.ok(bytes.includes(Buffer.from('GPS 25.2854', 'latin1')), `${entry.file} should carry the fixture GPS text`);
    const stripped = stripImageMetadata(bytes, entry.mime);
    assert.ok(!stripped.includes(Buffer.from('GPS 25.2854', 'latin1')), `${entry.file} leaked GPS after stripping`);
    assert.equal(verifyImageIntegrity(stripped, entry.mime), null, `${entry.file} must stay intact after stripping`);
    const info = inspectImage(stripped);
    assert.equal(info?.width, entry.width, `${entry.file} dimensions must survive stripping`);
    assert.equal(info?.height, entry.height);
  }
});

test('the assurance ceiling is pinned: container-complete does not mean decodable', () => {
  // Real JPEG container, garbage entropy data after the scan starts. No decoder runs here, so the
  // file passes — this is the honest boundary of the implemented assurance level.
  const real = fixture('photo-800x600.jpg');
  const scanStart = real.indexOf(Buffer.from([0xff, 0xda]));
  assert.ok(scanStart > 0);
  const tampered = Buffer.concat([real.subarray(0, scanStart), Buffer.alloc(2048, 0x7f), Buffer.from([0xff, 0xd9])]);
  assert.ok(inspectImage(tampered), 'the header still parses');
  assert.equal(verifyImageIntegrity(tampered, 'image/jpeg'), null, 'nothing decodes the entropy stream');
});
