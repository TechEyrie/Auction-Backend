/**
 * Image inspection without an image library.
 *
 * Byte-level and dependency-free on purpose: we need to prove (a) the bytes really are the
 * type the client claimed, (b) how large the image is before storing it, (c) that the container
 * is complete rather than a truncated prefix, and (d) that embedded metadata (EXIF/XMP/text
 * chunks, which can carry GPS coordinates) is removed.
 *
 * **Assurance level (do not overstate it):** signature, header and container-integrity checks.
 * For PNG the IHDR checksum is verified and the chunk chain must be well formed and end exactly
 * at IEND; JPEG must carry its end-of-image marker; WebP's declared RIFF size must match the
 * file. That catches truncation and header corruption, which is what a hostile or broken upload
 * actually looks like in practice. **It does not decode pixel data**, so a file whose entropy
 * stream is corrupt but whose container is complete can still be accepted, and nothing here
 * detects malicious payloads. Decoding/re-encoding (or antivirus scanning) needs a codec/engine
 * dependency and an explicit approval; see docs/OPEN_QUESTIONS.md OQ-49.
 */

export const ALLOWED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AllowedImageMime = (typeof ALLOWED_IMAGE_MIME)[number];

export type ImageInfo = { mime: AllowedImageMime; width: number; height: number };

/**
 * Executable/markup payloads that must never be accepted as images, even when the client
 * declares an image content type. Checked before signature parsing so the message is honest.
 */
export function detectExecutableMarkup(buffer: Buffer): string | null {
  const head = buffer.subarray(0, 2048).toString('latin1').trim().toLowerCase();
  if (head.startsWith('<svg') || head.includes('<svg')) return 'SVG is markup, not an image upload';
  if (head.startsWith('<?xml')) return 'XML documents are not accepted as images';
  if (head.startsWith('<!doctype html') || head.startsWith('<html') || head.includes('<script')) {
    return 'HTML documents are not accepted as images';
  }
  return null;
}

function parsePng(buffer: Buffer): ImageInfo | null {
  if (buffer.length < 24) return null;
  const signature = buffer.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') return null;
  if (buffer.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  return { mime: 'image/png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function parseJpeg(buffer: Buffer): ImageInfo | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= buffer.length) {
    if (buffer[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buffer[i + 1] as number;
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9) return null;
    const length = buffer.readUInt16BE(i + 2);
    if (length < 2) return null;
    const payload = i + 4;
    if (JPEG_SOF.has(marker)) {
      if (payload + 5 > buffer.length) return null;
      return { mime: 'image/jpeg', height: buffer.readUInt16BE(payload + 1), width: buffer.readUInt16BE(payload + 3) };
    }
    if (marker === 0xda) return null; // scan started, no frame header found
    i = i + 2 + length;
  }
  return null;
}

function parseWebp(buffer: Buffer): ImageInfo | null {
  if (buffer.length < 30) return null;
  if (buffer.subarray(0, 4).toString('latin1') !== 'RIFF') return null;
  if (buffer.subarray(8, 12).toString('latin1') !== 'WEBP') return null;
  const fourcc = buffer.subarray(12, 16).toString('latin1');
  const payload = 20;
  if (fourcc === 'VP8X') {
    if (buffer.length < payload + 10) return null;
    const width = 1 + (buffer[payload + 4]! | (buffer[payload + 5]! << 8) | (buffer[payload + 6]! << 16));
    const height = 1 + (buffer[payload + 7]! | (buffer[payload + 8]! << 8) | (buffer[payload + 9]! << 16));
    return { mime: 'image/webp', width, height };
  }
  if (fourcc === 'VP8L') {
    if (buffer.length < payload + 5 || buffer[payload] !== 0x2f) return null;
    const bits = buffer.readUInt32LE(payload + 1);
    return { mime: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (fourcc === 'VP8 ') {
    if (buffer.length < payload + 10) return null;
    const start = buffer.subarray(payload + 3, payload + 6).toString('hex');
    if (start !== '9d012a') return null;
    return {
      mime: 'image/webp',
      width: buffer.readUInt16LE(payload + 6) & 0x3fff,
      height: buffer.readUInt16LE(payload + 8) & 0x3fff,
    };
  }
  return null;
}

/** Identify the real type and dimensions from the bytes. Never trusts the declared MIME. */
export function inspectImage(buffer: Buffer): ImageInfo | null {
  return parsePng(buffer) ?? parseJpeg(buffer) ?? parseWebp(buffer);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] as number);
  return (crc ^ -1) >>> 0;
}

/**
 * Verify that the container is complete and internally consistent.
 *
 * Returns a human-readable reason when the file is truncated or corrupt, or `null` when the
 * container checks out. A reason is a validation failure (422), never a storage outage.
 */
export function verifyImageIntegrity(buffer: Buffer, mime: AllowedImageMime): string | null {
  if (mime === 'image/png') return verifyPng(buffer);
  if (mime === 'image/jpeg') {
    // A JPEG without its end-of-image marker was cut off in transit.
    if (buffer[buffer.length - 2] !== 0xff || buffer[buffer.length - 1] !== 0xd9) {
      return 'JPEG is truncated (no end-of-image marker)';
    }
    return null;
  }

  // WebP: the RIFF container declares its total size, so a mismatch means a partial file.
  const declared = buffer.readUInt32LE(4) + 8;
  if (declared > buffer.length) return 'WebP is truncated (the declared size exceeds the file)';
  if (declared < buffer.length) return 'WebP has unexpected trailing data';
  return null;
}

function verifyPng(buffer: Buffer): string | null {
  if (buffer.length < 33) return 'PNG is truncated';
  if (buffer.subarray(12, 16).toString('latin1') !== 'IHDR') return 'PNG is missing its header chunk';
  const ihdrLength = buffer.readUInt32BE(8);
  if (ihdrLength !== 13) return 'PNG header chunk has an unexpected length';
  const storedCrc = buffer.readUInt32BE(8 + 8 + ihdrLength);
  if (storedCrc !== crc32(buffer.subarray(12, 8 + 8 + ihdrLength))) {
    return 'PNG header checksum does not match (corrupt or truncated file)';
  }

  let sawImageData = false;
  let i = 8;
  while (i + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(i);
    const type = buffer.subarray(i + 4, i + 8).toString('latin1');
    const end = i + 12 + length;
    if (end > buffer.length) return 'PNG is truncated (a chunk runs past the end of the file)';
    if (type === 'IDAT') sawImageData = true;
    i = end;
    if (type === 'IEND') {
      if (!sawImageData) return 'PNG has no image data';
      if (i !== buffer.length) return 'PNG has unexpected trailing data after its end marker';
      return null;
    }
  }
  return 'PNG is missing its end marker (truncated file)';
}

/**
 * Remove metadata containers that commonly carry privacy data (GPS in EXIF, author names in
 * XMP/text chunks). Image data is copied byte-for-byte, so dimensions are unaffected.
 */
export function stripImageMetadata(buffer: Buffer, mime: AllowedImageMime): Buffer {
  if (mime === 'image/jpeg') return stripJpeg(buffer);
  if (mime === 'image/png') return stripPng(buffer);
  return stripWebp(buffer);
}

function stripJpeg(buffer: Buffer): Buffer {
  const out: Buffer[] = [buffer.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= buffer.length) {
    if (buffer[i] !== 0xff) {
      out.push(buffer.subarray(i));
      break;
    }
    const marker = buffer[i + 1] as number;
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(buffer.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) {
      // Everything from the scan onwards is entropy-coded image data: copy verbatim.
      out.push(buffer.subarray(i));
      break;
    }
    const length = buffer.readUInt16BE(i + 2);
    const end = i + 2 + length;
    if (end > buffer.length) {
      out.push(buffer.subarray(i));
      break;
    }
    const isMetadata = marker === 0xfe || (marker >= 0xe1 && marker <= 0xef);
    if (!isMetadata) out.push(buffer.subarray(i, end));
    i = end;
  }
  return Buffer.concat(out);
}

const PNG_METADATA_CHUNKS = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

function stripPng(buffer: Buffer): Buffer {
  const out: Buffer[] = [buffer.subarray(0, 8)];
  let i = 8;
  while (i + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(i);
    const end = i + 12 + length;
    if (end > buffer.length) break;
    const type = buffer.subarray(i + 4, i + 8).toString('latin1');
    if (!PNG_METADATA_CHUNKS.has(type)) out.push(buffer.subarray(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  return Buffer.concat(out);
}

const WEBP_METADATA_CHUNKS = new Set(['EXIF', 'XMP ']);

function stripWebp(buffer: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let i = 12;
  while (i + 8 <= buffer.length) {
    const fourcc = buffer.subarray(i, i + 4).toString('latin1');
    const size = buffer.readUInt32LE(i + 4);
    const end = i + 8 + size + (size % 2);
    if (end > buffer.length) break;
    if (!WEBP_METADATA_CHUNKS.has(fourcc)) {
      const chunk = Buffer.from(buffer.subarray(i, i + 8 + size));
      if (fourcc === 'VP8X') {
        // Clear the EXIF (0x08) and XMP (0x10) presence flags in the extended header.
        chunk[8] = (chunk[8] ?? 0) & ~0x18;
      }
      chunks.push(chunk);
    }
    i = end;
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, body]);
}
