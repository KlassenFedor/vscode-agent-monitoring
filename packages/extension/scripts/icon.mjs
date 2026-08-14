// Draws `resources/icon.png`, the 128×128 the Marketplace shows.
//
// Written by hand rather than exported from a design tool so the icon is reproducible
// from the repository alone: the same pulse as `resources/pulse.svg`, which is the
// activity-bar glyph, on a background dark enough to survive both editor themes.
//
//   node scripts/icon.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

const SIZE = 128;
const RADIUS = 26;
const BACKGROUND = [17, 27, 38, 255];
const STROKE = [86, 197, 248, 255];
const STROKE_WIDTH = 9;
const SAMPLES = 3;

// The polyline of pulse.svg, in its 24-unit viewBox, mapped into a padded square.
const VIEWBOX_POINTS = [
  [2, 12],
  [6, 12],
  [9, 4],
  [13, 20],
  [16, 12],
  [22, 12],
];
const scale = (SIZE - 32) / 24;
const points = VIEWBOX_POINTS.map(([x, y]) => [16 + x * scale, 16 + y * scale]);

const pixels = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    // Supersampling: the only anti-aliasing there is, and enough for one glyph.
    let inside = 0;
    let onStroke = 0;
    for (let sy = 0; sy < SAMPLES; sy += 1) {
      for (let sx = 0; sx < SAMPLES; sx += 1) {
        const px = x + (sx + 0.5) / SAMPLES;
        const py = y + (sy + 0.5) / SAMPLES;
        if (insideRoundedSquare(px, py)) inside += 1;
        if (distanceToPolyline(px, py) <= STROKE_WIDTH / 2) onStroke += 1;
      }
    }

    const total = SAMPLES * SAMPLES;
    const background = blend([0, 0, 0, 0], BACKGROUND, inside / total);
    const colour = blend(background, STROKE, (onStroke / total) * (inside / total));
    pixels.set(colour, (y * SIZE + x) * 4);
  }
}

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'icon.png');
writeFileSync(file, encodePng(pixels, SIZE, SIZE));
console.log(`wrote ${file}`);

function insideRoundedSquare(x, y) {
  const dx = Math.max(RADIUS - x, 0, x - (SIZE - RADIUS));
  const dy = Math.max(RADIUS - y, 0, y - (SIZE - RADIUS));
  return dx * dx + dy * dy <= RADIUS * RADIUS;
}

function distanceToPolyline(x, y) {
  let best = Infinity;
  for (let index = 0; index + 1 < points.length; index += 1) {
    best = Math.min(best, distanceToSegment(x, y, points[index], points[index + 1]));
  }
  return best;
}

function distanceToSegment(x, y, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / lengthSquared));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

function blend(under, over, alpha) {
  return under.map((value, index) => Math.round(value + (over[index] - value) * alpha));
}

function encodePng(rgba, width, height) {
  // One filter byte per scanline, filter type 0: the image is tiny and this keeps the
  // encoder to what it has to be.
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
