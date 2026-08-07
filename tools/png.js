// A minimal PNG reader — just enough to let `tools/lint.js` look at the pixels
// of the generated icons and prove they are not blank or half-painted.
//
// Dependency-free on purpose (node's zlib does the only hard part). It handles
// the one flavour of PNG that `tools/genicons.mjs` emits: 8-bit RGBA, no
// interlacing, no palette. Anything else throws rather than guessing.

import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * @returns {{width:number, height:number, pixels:Buffer}} `pixels` is RGBA,
 *          4 bytes per pixel, row-major, top-left origin.
 */
export function readPNG(path) {
  const buf = readFileSync(path);
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error(`${path}: not a PNG`);

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];

  for (let at = 8; at + 8 <= buf.length; ) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString("ascii", at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + length);

    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    at += 12 + length; // length + type + body + crc
  }

  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(`${path}: expected 8-bit RGBA non-interlaced (got depth ${bitDepth}, color type ${colorType}, interlace ${interlace})`);
  }

  return { width, height, pixels: unfilter(inflateSync(Buffer.concat(idat)), width, height) };
}

// PNG stores each row with a one-byte filter that predicts from the pixel to
// the left (a), above (b), and above-left (c). Undo it in place.
function unfilter(raw, width, height) {
  const BPP = 4;
  const stride = width * BPP;
  const out = Buffer.alloc(height * stride);

  for (let y = 0, at = 0; y < height; y++) {
    const filter = raw[at++];
    const row = raw.subarray(at, at + stride);
    at += stride;

    for (let x = 0; x < stride; x++) {
      const a = x >= BPP ? out[y * stride + x - BPP] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= BPP && y > 0 ? out[(y - 1) * stride + x - BPP] : 0;
      let value = row[x];

      switch (filter) {
        case 0: break;
        case 1: value += a; break;
        case 2: value += b; break;
        case 3: value += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: throw new Error(`unknown PNG row filter ${filter}`);
      }
      out[y * stride + x] = value & 0xff;
    }
  }
  return out;
}

/** Alpha of the pixel at (x, y), 0–255. */
export function alphaAt({ width, pixels }, x, y) {
  return pixels[(y * width + x) * 4 + 3];
}

/** `[r, g, b, a]` at (x, y). */
export function pixelAt({ width, pixels }, x, y) {
  const at = (y * width + x) * 4;
  return [pixels[at], pixels[at + 1], pixels[at + 2], pixels[at + 3]];
}
