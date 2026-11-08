// Generates the PWA icons (PNG) without external tools: a teal tile with a white check-clipboard glyph.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "app", "public", "icons");
mkdirSync(outDir, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function png(size, pad) {
  const px = Buffer.alloc(size * (size * 4 + 1));
  const teal = [15, 118, 110, 255], white = [255, 255, 255, 255], clear = [0, 0, 0, 0];
  const r = size * 0.18;
  for (let y = 0; y < size; y++) {
    px[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      // rounded tile (full bleed for maskable)
      const inset = pad ? 0 : 0;
      const dx = Math.max(r - x, 0, x - (size - 1 - r)), dy = Math.max(r - y, 0, y - (size - 1 - r));
      let c = pad || dx * dx + dy * dy <= r * r ? teal : clear;
      const s = pad ? 0.62 : 0.78; // glyph scale (maskable keeps a safe zone)
      const gx = (u - 0.5) / s + 0.5, gy = (v - 0.5) / s + 0.5;
      // clipboard body
      const inBody = gx > 0.24 && gx < 0.76 && gy > 0.2 && gy < 0.86;
      const inInner = gx > 0.29 && gx < 0.71 && gy > 0.27 && gy < 0.81;
      const inClip = gx > 0.38 && gx < 0.62 && gy > 0.14 && gy < 0.26;
      if ((inBody && !inInner) || inClip) c = white;
      // check mark
      const d1 = Math.abs((gy - 0.6) - (gx - 0.36)) / Math.SQRT2, on1 = gx > 0.35 && gx < 0.47 && d1 < 0.035;
      const d2 = Math.abs((gy - 0.66) + (gx - 0.46)) / Math.SQRT2, on2 = gx > 0.45 && gx < 0.66 && d2 < 0.035;
      if (on1 || on2) c = white;
      void inset;
      px.set(c, y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(px)), chunk("IEND", Buffer.alloc(0))]);
}
writeFileSync(join(outDir, "icon-192.png"), png(192, false));
writeFileSync(join(outDir, "icon-512.png"), png(512, false));
writeFileSync(join(outDir, "icon-maskable-512.png"), png(512, true));
console.log("icons written to", outDir);
