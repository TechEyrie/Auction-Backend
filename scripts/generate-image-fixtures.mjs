/**
 * Generate the genuine, encoder-produced image fixtures used by the media and listing tests.
 *
 * Why this exists: the hand-written fixtures in `tests/helpers/images.ts` are structurally valid
 * headers, not files a real encoder produced. Signature/header tests are enough to prove the server
 * reads a type and a dimension, but they say nothing about real baselines, real EXIF containers or
 * real decodability — so the media pipeline is also exercised against genuine encoder output.
 *
 * `sharp` is not a backend dependency. It happens to be present in `frontend/node_modules` as a
 * Next.js optional dependency, and this script borrows it in development only. Nothing at runtime
 * depends on it; the fixtures are committed to the repository.
 *
 * Usage (from the repository root):
 *   node backend/scripts/generate-image-fixtures.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

if (process.env.NODE_ENV === 'production') {
  process.stderr.write('Refusing to run: this is a development-only fixture generator.\n');
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const outDir = path.join(repoRoot, 'backend', 'tests', 'fixtures', 'images');

function loadSharp() {
  const candidates = [
    path.join(repoRoot, 'frontend', 'node_modules', 'sharp'),
    'sharp',
  ];
  const require = createRequire(import.meta.url);
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error('sharp is not available; install it in frontend/node_modules before regenerating fixtures');
}

/** A deterministic, non-uniform pattern so the encoder cannot produce a degenerate file. */
function pattern(width, height) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      pixels[offset] = (x * 7 + y * 3) % 256;
      pixels[offset + 1] = (x * 2 + y * 11) % 256;
      pixels[offset + 2] = (x * 13 + y * 5) % 256;
    }
  }
  return pixels;
}

const GPS_EXIF = 'GPS 25.2854,51.5310 camera-model-here';

const outputs = [
  { name: 'photo-640x480.png', format: 'png', width: 640, height: 480, withExif: true },
  { name: 'photo-800x600.jpg', format: 'jpeg', width: 800, height: 600, withExif: true },
  { name: 'photo-320x240.webp', format: 'webp', width: 320, height: 240, withExif: true },
  // Larger than the test configuration's 1200px per-side limit.
  { name: 'photo-2000x1500.jpg', format: 'jpeg', width: 2000, height: 1500, withExif: false },
];

const sharp = loadSharp();
mkdirSync(outDir, { recursive: true });

for (const output of outputs) {
  let pipeline = sharp(pattern(output.width, output.height), {
    raw: { width: output.width, height: output.height, channels: 3 },
  });
  if (output.withExif && output.format !== 'png') {
    pipeline = pipeline.withMetadata({ exif: { IFD0: { ImageDescription: GPS_EXIF } } });
  }
  const buffer = await pipeline.toFormat(output.format, { quality: 82 }).toBuffer();
  writeFileSync(path.join(outDir, output.name), buffer);
  process.stdout.write(`${output.name} ${buffer.length} bytes\n`);
}

// PNG text metadata is written by sharp via `withMetadata` only for some formats, so the PNG
// fixture additionally carries a real tEXt chunk inserted with correct CRCs.
function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

{
  const pngPath = path.join(outDir, 'photo-640x480.png');
  const png = (await import('node:fs')).readFileSync(pngPath);
  const iendStart = png.lastIndexOf(Buffer.from('IEND', 'latin1')) - 4;
  const withText = Buffer.concat([
    png.subarray(0, iendStart),
    chunk('tEXt', Buffer.from(`Comment\0${GPS_EXIF}`, 'latin1')),
    png.subarray(iendStart),
  ]);
  writeFileSync(pngPath, withText);
  process.stdout.write(`photo-640x480.png ${withText.length} bytes (tEXt metadata added)\n`);
}
