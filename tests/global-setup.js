// Generates fixture files used by all tests
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fs   = require('fs');
const path = require('path');

const FIXTURES = path.join(__dirname, 'fixtures');

module.exports = async function globalSetup() {
  fs.mkdirSync(FIXTURES, { recursive: true });

  // ── plain PDF ──────────────────────────────────────────────────────────────
  const plain = await PDFDocument.create();
  const font  = await plain.embedFont(StandardFonts.Helvetica);
  const page  = plain.addPage([612, 792]);
  page.drawText('PDF Sign – test document', { x: 50, y: 720, size: 22, font });
  page.drawText('Page 1',                   { x: 50, y: 680, size: 14, font, color: rgb(0.4,0.4,0.4) });
  fs.writeFileSync(path.join(FIXTURES, 'sample.pdf'), Buffer.from(await plain.save()));

  // ── PDF with AcroForm text field ──────────────────────────────────────────
  const formDoc  = await PDFDocument.create();
  const formFont = await formDoc.embedFont(StandardFonts.Helvetica);
  const formPage = formDoc.addPage([612, 792]);
  formPage.drawText('Name:', { x: 50, y: 700, size: 14, font: formFont });
  const form      = formDoc.getForm();
  const nameField = form.createTextField('name');
  nameField.addToPage(formPage, { x: 120, y: 685, width: 250, height: 24 });
  fs.writeFileSync(path.join(FIXTURES, 'form.pdf'), Buffer.from(await formDoc.save()));

  // ── minimal PNG (20×8 dark-on-transparent, simulates a drawn signature) ──
  const W = 20, H = 8;
  // Build a minimal PNG manually (IHDR + IDAT + IEND)
  const png = buildMinimalPNG(W, H);
  fs.writeFileSync(path.join(FIXTURES, 'signature.png'), png);

  // ── synthetic "photo of a signature" for the import editor ────────────────
  // Blue ink on tilted paper over a dark table, with an illumination gradient
  // and dust specks — the conditions a plain threshold slider cannot handle.
  fs.writeFileSync(path.join(FIXTURES, 'signature-photo.png'), buildPhotoPNG(640, 440));
};

// ── Synthetic signature photo ───────────────────────────────────────────────

function buildPhotoPNG(w, h) {
  const rand = mulberry32(20240724);
  const angle = 4 * Math.PI / 180;          // paper is slightly tilted
  const pw = 460, ph = 300;                 // paper size in its own coords
  const cx = w / 2, cy = h / 2;
  const cos = Math.cos(angle), sin = Math.sin(angle);

  // Paper-local ink coverage, drawn once and then sampled per pixel.
  const ink = new Float32Array(pw * ph);
  const stamp = (x, y, r) => {
    for (let dy = -r - 1; dy <= r + 1; dy++) {
      for (let dx = -r - 1; dx <= r + 1; dx++) {
        const px = Math.round(x + dx), py = Math.round(y + dy);
        if (px < 0 || py < 0 || px >= pw || py >= ph) continue;
        const cov = Math.max(0, Math.min(1, r - Math.hypot(x - px, y - py) + 0.5));
        const i = py * pw + px;
        if (cov > ink[i]) ink[i] = cov;
      }
    }
  };
  // a scrawled name plus an underline flourish
  for (let t = 0; t <= 1; t += 0.0008) {
    stamp(60 + 330 * t, 170 - 60 * Math.sin(t * 7.5) - 45 * t, 3.2);
    stamp(80 + 300 * t, 215 + 26 * Math.sin(t * 3.1 + 1.2), 2.4);
  }
  for (let t = 0; t <= 1; t += 0.001) {
    const a = t * Math.PI * 2;
    stamp(120 + 34 * Math.cos(a), 120 + 22 * Math.sin(a), 2.6);
  }
  // dust and paper grain the despeckle pass should remove
  for (let n = 0; n < 90; n++) stamp(20 + rand() * (pw - 40), 20 + rand() * (ph - 40), 0.7);

  const rgb = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy;
      const lx = dx * cos + dy * sin + pw / 2;   // into paper coords
      const ly = -dx * sin + dy * cos + ph / 2;
      const o = (y * w + x) * 3;

      if (lx < 0 || ly < 0 || lx >= pw || ly >= ph) {
        const grain = Math.sin(x * 0.35) * 6 + rand() * 8;   // wooden table
        rgb[o] = 122 + grain; rgb[o + 1] = 96 + grain; rgb[o + 2] = 70 + grain;
        continue;
      }
      const u = lx / pw, v = ly / ph;
      // uneven lighting: falls off to the right and bottom, plus a shadow band
      const shadow = 34 * Math.exp(-Math.pow((u - 0.16) / 0.1, 2));
      const paper  = 252 - 40 * u - 22 * v - shadow + (rand() - 0.5) * 5;
      const cov    = ink[(ly | 0) * pw + (lx | 0)];
      rgb[o]     = paper * (1 - cov) + 52 * cov * (paper / 252);
      rgb[o + 1] = paper * (1 - cov) + 74 * cov * (paper / 252);
      rgb[o + 2] = paper * (1 - cov) + 168 * cov * (paper / 252);
    }
  }
  return encodePNG(w, h, rgb, 2);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Encode raw samples as a PNG. colorType 2 = RGB, 6 = RGBA. */
function encodePNG(w, h, samples, colorType) {
  const zlib = require('zlib');
  const bpp  = colorType === 6 ? 4 : 3;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = colorType;

  const rows = [];
  for (let y = 0; y < h; y++) {
    rows.push(Buffer.concat([
      Buffer.from([0]),                                     // no row filter
      samples.subarray(y * w * bpp, (y + 1) * w * bpp),
    ]));
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const crc32 = makeCRC32();
  const len   = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body  = Buffer.concat([Buffer.from(type), data]);
  const crc   = Buffer.alloc(4); crc.writeInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// Builds a tiny valid PNG with a dark stroke line on transparent background
function buildMinimalPNG(w, h) {
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const isDark = (y === Math.floor(h / 2));
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      rgba[o]     = isDark ? 30  : 0;
      rgba[o + 1] = isDark ? 41  : 0;
      rgba[o + 2] = isDark ? 59  : 0;
      rgba[o + 3] = isDark ? 255 : 0;
    }
  }
  return encodePNG(w, h, rgba, 6);
}

function makeCRC32() {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c;
  }
  return buf => {
    let crc = -1;
    for (const b of buf) crc = table[(crc ^ b) & 0xFF] ^ (crc >>> 8);
    return (crc ^ -1) | 0;
  };
}
