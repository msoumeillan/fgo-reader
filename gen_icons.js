// Génère docs/icon-192.png et docs/icon-512.png sans dépendance :
// fond bleu nuit, anneau et losange dorés (style emblème FGO).
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixels) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filtre "None"
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8 bits, RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function makeIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const ringR = size * 0.36;
  const ringW = size * 0.045;
  const diamond = size * 0.17;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c, dy = y - c;
      const d = Math.sqrt(dx * dx + dy * dy);
      // fond : dégradé radial bleu nuit
      const t = Math.min(1, d / c);
      let r = 13 + (2 - 13) * t, g = 24 + (5 - 24) * t, b = 64 + (16 - 64) * t, a = 255;
      // anneau doré
      const ringDist = Math.abs(d - ringR);
      if (ringDist < ringW) {
        const k = 1 - ringDist / ringW;
        r = r + (212 - r) * k; g = g + (175 - g) * k; b = b + (85 - b) * k;
      }
      // losange doré central
      const man = Math.abs(dx) + Math.abs(dy);
      if (man < diamond) {
        const k = Math.min(1, (diamond - man) / (size * 0.02));
        r = r + (255 - r) * k; g = g + (224 - g) * k; b = b + (138 - b) * k;
      }
      const i = (y * size + x) * 4;
      px[i] = Math.round(r); px[i + 1] = Math.round(g); px[i + 2] = Math.round(b); px[i + 3] = a;
    }
  }
  return encodePng(size, px);
}

for (const size of [192, 512]) {
  const out = path.join(__dirname, "docs", `icon-${size}.png`);
  fs.writeFileSync(out, makeIcon(size));
  console.log(`OK ${out}`);
}
