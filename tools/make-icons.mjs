/**
 * Dependency-free PNG icon generator.
 *
 * Chrome only accepts raster icons, and pulling in an image library for four
 * small squares is not a trade worth making, so this writes valid PNGs directly
 * (signature + IHDR + IDAT + IEND, with zlib from Node's standard library).
 *
 * Rendering is 4x supersampled and box-filtered down, which is what keeps the
 * rounded corners and the glyph clean at 16px.
 */

import zlib from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- geometry helpers -------------------------------------------------------

function insideRoundedSquare(x, y, size, radius) {
  const min = radius;
  const max = size - radius;
  const cx = x < min ? min : x > max ? max : x;
  const cy = y < min ? min : y > max ? max : y;
  if (x >= 0 && x <= size && y >= 0 && y <= size) {
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  }
  return false;
}

function insideTriangle(px, py, size) {
  // A play glyph: reads clearly even at 16px, and says "animated" without
  // needing legible lettering.
  const ax = size * 0.375;
  const ay = size * 0.29;
  const bx = size * 0.375;
  const by = size * 0.71;
  const cx = size * 0.735;
  const cy = size * 0.5;

  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

const FROM = [0x58, 0x65, 0xf2]; // blurple
const TO = [0xb4, 0x54, 0xf0]; // violet

function renderIcon(size) {
  const scale = 4;
  const big = size * scale;
  const supersampled = Buffer.alloc(big * big * 4);
  const radius = big * 0.225;

  for (let y = 0; y < big; y += 1) {
    for (let x = 0; x < big; x += 1) {
      const index = (y * big + x) * 4;
      const px = x + 0.5;
      const py = y + 0.5;

      if (!insideRoundedSquare(px, py, big, radius)) {
        supersampled[index + 3] = 0;
        continue;
      }

      if (insideTriangle(px, py, big)) {
        supersampled[index] = 0xff;
        supersampled[index + 1] = 0xff;
        supersampled[index + 2] = 0xff;
        supersampled[index + 3] = 0xff;
        continue;
      }

      const t = (px / big) * 0.45 + (py / big) * 0.55;
      supersampled[index] = Math.round(FROM[0] + (TO[0] - FROM[0]) * t);
      supersampled[index + 1] = Math.round(FROM[1] + (TO[1] - FROM[1]) * t);
      supersampled[index + 2] = Math.round(FROM[2] + (TO[2] - FROM[2]) * t);
      supersampled[index + 3] = 0xff;
    }
  }

  // Box-filter down, weighting colour by alpha so edges do not darken.
  const out = Buffer.alloc(size * size * 4);
  const samples = scale * scale;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          const si = ((y * scale + sy) * big + (x * scale + sx)) * 4;
          const alpha = supersampled[si + 3];
          r += supersampled[si] * alpha;
          g += supersampled[si + 1] * alpha;
          b += supersampled[si + 2] * alpha;
          a += alpha;
        }
      }
      const di = (y * size + x) * 4;
      if (a === 0) {
        out[di] = 0;
        out[di + 1] = 0;
        out[di + 2] = 0;
        out[di + 3] = 0;
      } else {
        out[di] = Math.round(r / a);
        out[di + 1] = Math.round(g / a);
        out[di + 2] = Math.round(b / a);
        out[di + 3] = Math.round(a / samples);
      }
    }
  }

  return encodePng(size, size, out);
}

export function writeIcons(outDir, sizes = [16, 32, 48, 128]) {
  mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const size of sizes) {
    const file = join(outDir, `icon-${size}.png`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, renderIcon(size));
    written.push(file);
  }
  return written;
}

export { renderIcon, encodePng };
