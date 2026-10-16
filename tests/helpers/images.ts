import { deflateSync } from 'node:zlib';

/**
 * Image fixtures built by hand.
 *
 * PNG is a genuine, decodable file (real IHDR/IDAT/IEND with correct CRCs). JPEG and WebP
 * fixtures are structurally valid headers — enough to exercise signature, dimension and
 * metadata handling without shipping binary blobs in the repository. No real WebP/JPEG
 * *encoder* is available in this environment, which is recorded as a test limitation.
 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] as number);
  return (crc ^ -1) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

export function png(width: number, height: number, options: { text?: string; headerOnly?: boolean } = {}): Buffer {
  const chunks: Buffer[] = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  chunks.push(pngChunk('IHDR', ihdr));
  if (options.text) chunks.push(pngChunk('tEXt', Buffer.from(`Comment\0${options.text}`, 'latin1')));
  if (!options.headerOnly) {
    const raw = Buffer.alloc(height * (1 + width * 3));
    chunks.push(pngChunk('IDAT', deflateSync(raw)));
  }
  chunks.push(pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length + 2, 0);
  return Buffer.concat([Buffer.from([0xff, marker]), length, payload]);
}

export function jpeg(width: number, height: number, options: { exif?: boolean } = {}): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  parts.push(jpegSegment(0xe0, Buffer.from('JFIF\0\x01\x02', 'latin1')));
  if (options.exif !== false) {
    parts.push(
      jpegSegment(
        0xe1,
        Buffer.concat([
          Buffer.from('Exif\0\0', 'latin1'),
          Buffer.from('GPS 25.2854,51.5310 camera-model-here', 'latin1'),
        ]),
      ),
    );
  }
  const sof = Buffer.alloc(15);
  sof[0] = 8;
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = 3;
  parts.push(jpegSegment(0xc0, sof));
  parts.push(Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 2, 3, 0, 0, 0, 0]));
  parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

function riffChunk(fourcc: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(fourcc, 0, 'latin1');
  header.writeUInt32LE(payload.length, 4);
  const padding = payload.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([header, payload, padding]);
}

export function webp(width: number, height: number, options: { exif?: boolean } = {}): Buffer {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = options.exif ? 0x08 : 0x00;
  vp8x.writeUIntLE(width - 1, 4, 3);
  vp8x.writeUIntLE(height - 1, 7, 3);
  const chunks = [riffChunk('VP8X', vp8x)];
  if (options.exif) chunks.push(riffChunk('EXIF', Buffer.from('GPS 25.2854,51.5310', 'latin1')));
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, body]);
}

export function svg(): Buffer {
  return Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'utf8');
}

export function html(): Buffer {
  return Buffer.from('<!doctype html><html><body>not an image</body></html>', 'utf8');
}
