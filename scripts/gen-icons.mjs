/**
 * Icon generator.
 *
 * Chrome does not accept SVG for extension icons, so the four PNGs are drawn
 * here with a tiny signed-distance-field renderer and encoded with zlib - no
 * image dependencies, no binary assets checked into the repository.
 *
 * The design is a shield with a "prohibited" glyph: quiet, recognisable at 16px,
 * and it reads the same in light and dark toolbars.
 */

import zlib from 'node:zlib';
import fs from 'node:fs/promises';
import path from 'node:path';

const SIZES = [16, 32, 48, 128];
const SAMPLES = 4; // 4x4 supersampling for anti-aliasing

const SHIELD_COLOR = [79, 70, 229]; // indigo-600
const GLYPH_COLOR = [255, 255, 255];

/** Rounded box signed distance, p in [-1,1]^2. */
function sdRoundBox(px, py, hx, hy, r) {
  const qx = Math.abs(px) - hx + r;
  const qy = Math.abs(py) - hy + r;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - r;
}

/** Shield: a rounded box whose lower half tapers to a point. */
function shieldDistance(px, py) {
  // y is 1 at the top, -1 at the bottom.
  const taperStart = 0.15;
  let halfWidth = 1;
  if (py < taperStart) {
    halfWidth = Math.max(0, (py + 1) / (taperStart + 1));
  }
  return Math.max(sdRoundBox(px, py, 1, 1, 0.34), Math.abs(px) - halfWidth);
}

function circleDistance(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}

function segmentDistance(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const length = vx * vx + vy * vy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / length));
  return Math.hypot(wx - t * vx, wy - t * vy);
}

/** Returns the RGBA colour of one output pixel. */
function shade(x, y, size) {
  const scale = (size - 1) / 2;
  let covered = 0;
  let glyph = 0;
  for (let sy = 0; sy < SAMPLES; sy++) {
    for (let sx = 0; sx < SAMPLES; sx++) {
      const px = ((x + (sx + 0.5) / SAMPLES) - scale) / scale;
      const py = (scale - (y + (sy + 0.5) / SAMPLES)) / scale;

      if (shieldDistance(px, py) <= 0) covered++;

      // The "prohibited" glyph: a ring plus a diagonal bar.
      const ring = Math.abs(circleDistance(px, py, 0, 0.04, 0.42)) - 0.075;
      const bar = segmentDistance(px, py, -0.3, -0.34, 0.3, 0.42) - 0.075;
      if (ring <= 0 || bar <= 0) glyph++;
    }
  }

  const samples = SAMPLES * SAMPLES;
  const shieldAlpha = covered / samples;
  const glyphAlpha = glyph / samples;
  if (shieldAlpha === 0 && glyphAlpha === 0) return [0, 0, 0, 0];

  // Composite the glyph over the shield, then the shield over transparency.
  const rgb = [...SHIELD_COLOR];
  for (let channel = 0; channel < 3; channel++) {
    rgb[channel] = GLYPH_COLOR[channel] * glyphAlpha + rgb[channel] * (1 - glyphAlpha);
  }
  const alpha = glyphAlpha + shieldAlpha * (1 - glyphAlpha);
  return [...rgb.map((value) => Math.round(value)), Math.round(alpha * 255)];
}

/* ----------------------------- PNG encoding ---------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixels[y * size + x];
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
      raw[offset++] = a;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export async function generateIcons(outDir) {
  await fs.mkdir(outDir, { recursive: true });
  for (const size of SIZES) {
    const pixels = [];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        pixels.push(shade(x, y, size));
      }
    }
    const png = encodePng(size, pixels);
    await fs.writeFile(path.join(outDir, `icon${size}.png`), png);
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const outDir = process.argv[2] ?? path.join(process.cwd(), 'dist', 'icons');
  generateIcons(outDir).then(() => console.log(`Wrote icons to ${outDir}`));
}
