// Generates a 512x512 source icon (terminal aesthetic: black bg, white pixel bloom)
// as a raw PNG with no dependencies, for use with `tauri icon`.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const W = 512, H = 512;
const px = new Uint8Array(W * H * 4);

function set(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}
function rect(x0, y0, w, h, r, g, b, a = 255) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(x, y, r, g, b, a);
}

// black background
rect(0, 0, W, H, 0, 0, 0);
// white border frame (terminal window)
const bw = 14;
rect(24, 24, W - 48, bw, 255, 255, 255);
rect(24, H - 24 - bw, W - 48, bw, 255, 255, 255);
rect(24, 24, bw, H - 48, 255, 255, 255);
rect(W - 24 - bw, 24, bw, H - 48, 255, 255, 255);

// pixel "bloom": plus/flower of squares in the center
const c = 256, s = 56, gap = 12;
const cells = [
  [0, 0], [-1, 0], [1, 0], [0, -1], [0, 1],
];
for (const [dx, dy] of cells) {
  rect(c - s / 2 + dx * (s + gap), c - s / 2 + dy * (s + gap), s, s, 255, 255, 255);
}
// gray corner accents
for (const [dx, dy] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) {
  rect(c - s / 2 + dx * (s + gap) + s / 4, c - s / 2 + dy * (s + gap) + s / 4, s / 2, s / 2, 110, 110, 110);
}
// blinking cursor block bottom-left inside frame
rect(64, H - 120, 40, 56, 255, 255, 255);

// --- encode PNG ---
function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ table[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0;
  Buffer.from(px.buffer, y * W * 4, W * 4).copy(raw, y * (W * 4 + 1) + 1);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync(new URL("../icon.png", import.meta.url), png);
console.log("icon.png written");
