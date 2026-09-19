#!/usr/bin/env node
// Generates public/icons/icon-192.png and icon-512.png with pure Node (zlib):
// a navy rounded-square background with a white "J" drawn from a tiny bitmap
// font, so no image tooling is needed. Run: node scripts/generate-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const BG = [10, 10, 12]; // #0a0a0c
const FG = [245, 245, 247]; // #f5f5f7

// 5x7 glyph for "J" (1 = filled)
const J = ["11111", "00100", "00100", "00100", "00100", "10100", "01100"];

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const radius = Math.round(size * 0.22);
  const cell = size / 9; // glyph occupies a 5x7 grid centred in a 9x9 layout
  const gx0 = size / 2 - (5 * cell) / 2;
  const gy0 = size / 2 - (7 * cell) / 2;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      // rounded corners → transparent
      const cx = x < radius ? radius - x : x >= size - radius ? x - (size - radius - 1) : 0;
      const cy = y < radius ? radius - y : y >= size - radius ? y - (size - radius - 1) : 0;
      const outside = cx * cx + cy * cy > radius * radius;
      let rgb = BG;
      let alpha = outside ? 0 : 255;
      const gxi = Math.floor((x - gx0) / cell);
      const gyi = Math.floor((y - gy0) / cell);
      if (!outside && gxi >= 0 && gxi < 5 && gyi >= 0 && gyi < 7 && J[gyi][gxi] === "1") rgb = FG;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = rgb[0];
      raw[o + 1] = rgb[1];
      raw[o + 2] = rgb[2];
      raw[o + 3] = alpha;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

mkdirSync("public/icons", { recursive: true });
for (const s of [180, 192, 512]) writeFileSync(`public/icons/icon-${s}.png`, png(s));
process.stderr.write("icons written\n");
