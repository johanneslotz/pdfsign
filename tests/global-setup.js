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
};

// Builds a tiny valid PNG with a dark stroke line on transparent background
function buildMinimalPNG(w, h) {
  const crc32 = makeCRC32();

  function chunk(type, data) {
    const len  = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc  = Buffer.alloc(4); crc.writeInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  }

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  ihdr[10] = ihdr[11] = ihdr[12] = 0;

  // Raw pixel rows: RGBA — dark pixel on transparent background
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 4); // filter byte + pixels
    for (let x = 0; x < w; x++) {
      const isDark = (y === Math.floor(h / 2));
      row[1 + x * 4]     = isDark ? 30  : 0;  // R
      row[1 + x * 4 + 1] = isDark ? 41  : 0;  // G
      row[1 + x * 4 + 2] = isDark ? 59  : 0;  // B
      row[1 + x * 4 + 3] = isDark ? 255 : 0;  // A
    }
    rows.push(row);
  }
  const raw  = Buffer.concat(rows);
  const zlib = require('zlib');
  const idat = zlib.deflateSync(raw);

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
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
