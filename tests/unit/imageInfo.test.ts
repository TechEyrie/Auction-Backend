import test from 'node:test';
import assert from 'node:assert/strict';
import { detectExecutableMarkup, inspectImage, stripImageMetadata, ALLOWED_IMAGE_MIME } from '../../src/modules/media/imageInfo.ts';
import { html, jpeg, png, svg, webp } from '../helpers/images.ts';

test('a real PNG is identified with its true dimensions', () => {
  const info = inspectImage(png(600, 400));
  assert.deepEqual(info, { mime: 'image/png', width: 600, height: 400 });
});

test('JPEG and WebP headers are read without an image library', () => {
  assert.deepEqual(inspectImage(jpeg(1280, 720)), { mime: 'image/jpeg', width: 1280, height: 720 });
  assert.deepEqual(inspectImage(webp(800, 600)), { mime: 'image/webp', width: 800, height: 600 });
});

test('non-image content is not identified as an image', () => {
  assert.equal(inspectImage(Buffer.from('just some text', 'utf8')), null);
  assert.equal(inspectImage(Buffer.alloc(0)), null);
  assert.equal(inspectImage(svg()), null, 'an SVG must not pass as a raster image');
  assert.equal(inspectImage(html()), null);
});

test('markup payloads are rejected before any parsing', () => {
  assert.match(String(detectExecutableMarkup(svg())), /SVG/);
  assert.match(String(detectExecutableMarkup(html())), /HTML/);
  assert.match(String(detectExecutableMarkup(Buffer.from('  <?xml version="1.0"?>', 'utf8'))), /XML/);
  assert.equal(detectExecutableMarkup(png(2, 2)), null);
});

test('JPEG metadata segments are stripped and image data is preserved', () => {
  const original = jpeg(320, 240, { exif: true });
  assert.ok(original.includes(Buffer.from('GPS 25.2854', 'latin1')), 'fixture should carry EXIF GPS');

  const stripped = stripImageMetadata(original, 'image/jpeg');
  assert.ok(!stripped.includes(Buffer.from('GPS 25.2854', 'latin1')), 'EXIF GPS must be removed');
  assert.ok(!stripped.includes(Buffer.from('camera-model-here', 'latin1')));
  // Structure survives: still a JPEG at the same size, with the JFIF segment and scan intact.
  assert.deepEqual(inspectImage(stripped), { mime: 'image/jpeg', width: 320, height: 240 });
  assert.ok(stripped.includes(Buffer.from('JFIF', 'latin1')));
  assert.equal(stripped[stripped.length - 2], 0xff);
  assert.equal(stripped[stripped.length - 1], 0xd9);
  assert.ok(stripped.length < original.length);
});

test('PNG text chunks are stripped and the image still parses', () => {
  const original = png(64, 64, { text: 'GPS 25.2854,51.5310' });
  const stripped = stripImageMetadata(original, 'image/png');
  assert.ok(!stripped.includes(Buffer.from('GPS 25.2854', 'latin1')));
  assert.deepEqual(inspectImage(stripped), { mime: 'image/png', width: 64, height: 64 });
  assert.equal(stripped.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});

test('WebP EXIF chunks are removed and the XMP/EXIF flags cleared', () => {
  const original = webp(120, 90, { exif: true });
  assert.ok(original.includes(Buffer.from('GPS 25.2854', 'latin1')));

  const stripped = stripImageMetadata(original, 'image/webp');
  assert.ok(!stripped.includes(Buffer.from('GPS 25.2854', 'latin1')));
  assert.equal(stripped.subarray(12, 16).toString('latin1'), 'VP8X');
  assert.equal(stripped[20]! & 0x18, 0, 'EXIF/XMP presence bits must be cleared');
  assert.deepEqual(inspectImage(stripped), { mime: 'image/webp', width: 120, height: 90 });
  // RIFF size stays consistent with the new payload.
  assert.equal(stripped.readUInt32LE(4), stripped.length - 8);
});

test('the allowed type list is exactly the formats we can validate', () => {
  assert.deepEqual([...ALLOWED_IMAGE_MIME], ['image/jpeg', 'image/png', 'image/webp']);
});
