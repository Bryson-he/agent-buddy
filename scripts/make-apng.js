// Joins recorded frames into one animated PNG (APNG), which GitHub and every
// current browser play like a GIF, in full colour and with no extra packages.
//
//   npx electron . --record-dir=rec          (records the story with sample agents)
//   node scripts/make-apng.js rec docs/images/demo.png
//
// Each frame stores only the rectangle that changed since the one before, and
// identical frames in a row are merged, so pauses and still areas cost nothing.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const [dir, out] = process.argv.slice(2);
if (!dir || !out) { console.error("usage: node scripts/make-apng.js <frames dir> <out.png>"); process.exit(1); }

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc(buf) { let c = 0xffffffff; for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

let BPP = 4; // bytes per pixel: 4 for RGBA, 3 for RGB (written when nothing is see-through)

/** Decodes an 8-bit RGB or RGBA PNG (what Electron's capturePage writes) to raw pixels. */
function decode(buf) {
  let at = 8, ihdr = null;
  const idat = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString("ascii", at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") ihdr = Buffer.from(data);
    if (type === "IDAT") idat.push(data);
    at += 12 + len;
  }
  const width = ihdr.readUInt32BE(0), height = ihdr.readUInt32BE(4);
  if (ihdr[8] !== 8 || (ihdr[9] !== 6 && ihdr[9] !== 2) || ihdr[12] !== 0) throw new Error("expected 8-bit RGB or RGBA, not interlaced");
  BPP = ihdr[9] === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * BPP;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= BPP ? px[dst + x - BPP] : 0;
      const b = y > 0 ? px[dst + x - stride] : 0;
      const c = x >= BPP && y > 0 ? px[dst + x - stride - BPP] : 0;
      let v = raw[src + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[dst + x] = v & 0xff;
    }
  }
  return { ihdr, width, height, px };
}

/** Compresses a rectangle of pixels, each row stored as its difference from the row above. */
function encodeRect(px, width, r) {
  const stride = r.w * BPP;
  const raw = Buffer.alloc((stride + 1) * r.h);
  for (let y = 0; y < r.h; y++) {
    const row = ((r.y + y) * width + r.x) * BPP;
    const o = y * (stride + 1);
    raw[o] = y === 0 ? 0 : 2; // filter: none for the first row, "up" after that
    for (let x = 0; x < stride; x++) raw[o + 1 + x] = y === 0 ? px[row + x] : (px[row + x] - px[row + x - width * BPP]) & 0xff;
  }
  return zlib.deflateSync(raw, { level: 9 });
}

/** The smallest rectangle holding every pixel that differs between two frames, or null. */
function changedRect(a, b, width, height) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * BPP;
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || (BPP === 4 && a[i + 3] !== b[i + 3])) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

const files = fs.readdirSync(dir).filter((f) => /^frame-\d+\.png$/.test(f)).sort();
const times = JSON.parse(fs.readFileSync(path.join(dir, "times.json"), "utf8"));
if (files.length < 2) { console.error("no frames in " + dir); process.exit(1); }

const first = decode(fs.readFileSync(path.join(dir, files[0])));
const { width, height } = first;
const kept = [{ t: times[0], rect: { x: 0, y: 0, w: width, h: height }, data: encodeRect(first.px, width, { x: 0, y: 0, w: width, h: height }) }];
let prev = first.px;
for (let i = 1; i < files.length; i++) {
  const next = decode(fs.readFileSync(path.join(dir, files[i])));
  if (!next.ihdr.equals(first.ihdr)) throw new Error(`${files[i]} has a different size or colour type from the first frame`);
  const { px } = next;
  const rect = changedRect(prev, px, width, height);
  if (rect) kept.push({ t: times[i], rect, data: encodeRect(px, width, rect) });
  prev = px;
}
const end = times[times.length - 1] + 80;
kept.forEach((k, i) => { k.ms = Math.max(20, (i + 1 < kept.length ? kept[i + 1].t : end) - k.t); });
kept[kept.length - 1].ms += 1200; // hold the last frame before it loops

const parts = [SIG, chunk("IHDR", first.ihdr)];
const actl = Buffer.alloc(8);
actl.writeUInt32BE(kept.length, 0); // frames
actl.writeUInt32BE(0, 4);           // loop for ever
parts.push(chunk("acTL", actl));

let seq = 0;
kept.forEach((k, i) => {
  const fctl = Buffer.alloc(26);
  fctl.writeUInt32BE(seq++, 0);
  fctl.writeUInt32BE(k.rect.w, 4);
  fctl.writeUInt32BE(k.rect.h, 8);
  fctl.writeUInt32BE(k.rect.x, 12);
  fctl.writeUInt32BE(k.rect.y, 16);
  fctl.writeUInt16BE(Math.round(k.ms), 20); // delay = ms / 1000
  fctl.writeUInt16BE(1000, 22);
  fctl[24] = 0; // leave the frame in place for the next one
  fctl[25] = 0; // replace the rectangle outright (the capture has no see-through pixels to blend)
  parts.push(chunk("fcTL", fctl));
  if (i === 0) parts.push(chunk("IDAT", k.data));
  else {
    const n = Buffer.alloc(4);
    n.writeUInt32BE(seq++, 0);
    parts.push(chunk("fdAT", Buffer.concat([n, k.data])));
  }
});
parts.push(chunk("IEND", Buffer.alloc(0)));

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat(parts));
const total = kept.reduce((s, k) => s + k.ms, 0);
console.log(`${out}: ${kept.length} frames (from ${files.length}), ${(total / 1000).toFixed(1)} s, ${width}x${height}, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
