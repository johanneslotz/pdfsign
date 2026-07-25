const { test, expect } = require('@playwright/test');
const path = require('path');
const fs   = require('fs');

const SAMPLE_PDF    = path.join(__dirname, '../fixtures/sample.pdf');
const FORM_PDF      = path.join(__dirname, '../fixtures/form.pdf');
const SIGNATURE_PNG = path.join(__dirname, '../fixtures/signature.png');
const PHOTO_PNG     = path.join(__dirname, '../fixtures/signature-photo.png');

// ── helpers ──────────────────────────────────────────────────────────────────

async function loadPDF(page, file = SAMPLE_PDF) {
  await page.waitForLoadState('networkidle');
  await page.locator('#file-input').setInputFiles(file);
  await expect(page.locator('.page-wrapper').first()).toBeVisible({ timeout: 15000 });
  // AI panel auto-opens after PDF load and can overlap toolbar buttons.
  await page.evaluate(() => {
    const panel = document.getElementById('ai-panel');
    if (panel) panel.classList.add('hidden');
  });
}

async function drawSignature(page) {
  const canvas = page.locator('#sig-canvas');
  const box    = await canvas.boundingBox();
  await page.mouse.move(box.x + 40,  box.y + 90);
  await page.mouse.down();
  for (let x = 40; x <= 260; x += 20)
    await page.mouse.move(box.x + x, box.y + 80 + Math.sin(x / 30) * 20, { steps: 3 });
  await page.mouse.up();
}

async function saveSignature(page) {
  await page.click('#btn-signature');
  await expect(page.locator('#sig-modal')).not.toHaveClass(/hidden/);
  await drawSignature(page);
  await page.click('#sig-save');
  await expect(page.locator('.sig-item').first()).toBeVisible();
}

// Opens the signature modal and feeds it an image, landing in the adjust editor.
async function openImportEditor(page, file = PHOTO_PNG) {
  await page.click('#btn-signature');
  await page.locator('#sig-png-input').setInputFiles(file);
  await expect(page.locator('#sig-import-view')).not.toHaveClass(/hidden/);
  // stats text is only written once a full (non-drag) render has completed
  await expect(page.locator('#imgedit-stats')).not.toBeEmpty({ timeout: 15000 });
}

// Drags the four selection corners inwards onto the sheet of paper, which is
// what a user does to leave the table top out of the crop.
async function cropToPaper(page) {
  const overlay = page.locator('#imgedit-overlay');
  await overlay.scrollIntoViewIfNeeded();

  const corners = [
    [[0.04, 0.04], [0.20, 0.20]],   // top-left
    [[0.96, 0.04], [0.80, 0.22]],   // top-right
    [[0.96, 0.96], [0.80, 0.80]],   // bottom-right
    [[0.04, 0.96], [0.20, 0.78]],   // bottom-left
  ];
  for (const [from, to] of corners) {
    const box = await overlay.boundingBox();
    const at  = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
    await page.mouse.move(...at(...from));
    await page.mouse.down();
    await page.mouse.move(...at(...to), { steps: 6 });
    await page.mouse.up();
  }
  await expect(page.locator('#imgedit-stats')).not.toBeEmpty({ timeout: 15000 });
}

// Reads a saved signature back out of the gallery and measures its pixels.
async function measureSavedSignature(page, index = 0) {
  return page.evaluate(async i => {
    const img = new Image();
    img.src = document.querySelectorAll('.sig-item img')[i].src;
    await img.decode();

    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height);

    let opaque = 0, clear = 0, r = 0, g = 0, b = 0;
    for (let p = 0; p < data.length; p += 4) {
      if (data[p + 3] > 200) { opaque++; r += data[p]; g += data[p + 1]; b += data[p + 2]; }
      else if (data[p + 3] === 0) clear++;
    }
    const alphaAt = (x, y) => data[(y * c.width + x) * 4 + 3];
    return {
      width: c.width, height: c.height, opaque, clear,
      ink: opaque ? [r / opaque, g / opaque, b / opaque].map(Math.round) : null,
      corners: [alphaAt(0, 0), alphaAt(c.width - 1, 0),
                alphaAt(0, c.height - 1), alphaAt(c.width - 1, c.height - 1)],
    };
  }, index);
}

async function selectFirstSignature(page) {
  await page.locator('.sig-item img').first().click();
  // Dismiss modal
  await page.click('#sig-modal-close');
}

// ── tests ─────────────────────────────────────────────────────────────────────

test.describe('Loading PDF', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/'); });

  test('shows drop-zone before any file is loaded', async ({ page }) => {
    await expect(page.locator('#drop-zone')).toBeVisible();
    await expect(page.locator('#pdf-pages')).toHaveClass(/hidden/);
  });

  test('renders pages after loading a PDF', async ({ page }) => {
    await loadPDF(page);
    await expect(page.locator('#drop-zone')).toBeHidden();
    await expect(page.locator('.page-wrapper').first()).toBeVisible();
  });

  test('enables toolbar buttons after loading', async ({ page }) => {
    await loadPDF(page);
    await expect(page.locator('#btn-signature')).toBeEnabled();
    await expect(page.locator('#btn-place-sig')).toBeEnabled();
    await expect(page.locator('#btn-add-text')).toBeEnabled();
    await expect(page.locator('#btn-save')).toBeEnabled();
  });

  test('renders form field overlays for PDFs with AcroForm', async ({ page }) => {
    await loadPDF(page, FORM_PDF);
    await expect(page.locator('.form-field-overlay').first()).toBeVisible();
  });

  // Simulates dropping a File with the given name/type/bytes onto the drop zone —
  // some sources (cloud-drive downloads, some OS file pickers) hand over a File
  // with an empty MIME type, so the app must fall back to the .pdf extension.
  async function dropFile(page, { name, type, bytes }) {
    // The service worker's install → controllerchange handler reloads the
    // page once on first visit; wait it out first or the drop races a reload.
    await page.waitForLoadState('networkidle');
    const b64 = Buffer.from(bytes).toString('base64');
    await page.evaluate(({ name, type, b64 }) => {
      const dt   = new DataTransfer();
      const file = new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], name, { type });
      dt.items.add(file);
      const event = new DragEvent('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: dt });
      document.getElementById('drop-zone').dispatchEvent(event);
    }, { name, type, b64 });
  }

  test('accepts a dropped PDF with no MIME type via its extension', async ({ page }) => {
    const bytes = fs.readFileSync(SAMPLE_PDF);
    await dropFile(page, { name: 'contract.pdf', type: '', bytes });
    await expect(page.locator('.page-wrapper').first()).toBeVisible({ timeout: 15000 });
  });

  test('rejects a dropped non-PDF file with an error message', async ({ page }) => {
    await dropFile(page, { name: 'photo.jpg', type: 'image/jpeg', bytes: Buffer.from([1, 2, 3]) });
    await expect(page.locator('#error-banner')).toBeVisible();
    await expect(page.locator('#error-banner-msg')).toContainText('photo.jpg');
    await expect(page.locator('#drop-zone')).toBeVisible();
  });
});

test.describe('Storage', () => {
  test('reuses a single IndexedDB connection across calls', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const opens = await page.evaluate(async () => {
      let count = 0;
      const realOpen = indexedDB.open.bind(indexedDB);
      indexedDB.open = (...args) => { count++; return realOpen(...args); };

      const { saveSignature, getSignatures, deleteSignature } = await import('/js/storage.js');
      const id = await saveSignature('data:image/png;base64,AA==');
      await getSignatures();
      await deleteSignature(id);
      await getSignatures();

      indexedDB.open = realOpen;
      return count;
    });

    // At most one open across 4 storage calls — 0 if the app's own init
    // already opened (and cached) the connection first, 1 if this was the
    // first call. Unmemoized, each of the 4 calls opens its own connection.
    expect(opens).toBeLessThanOrEqual(1);
  });
});

test.describe('Signature drawing', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await loadPDF(page);
  });

  test('opens signature modal', async ({ page }) => {
    await page.click('#btn-signature');
    await expect(page.locator('#sig-modal')).not.toHaveClass(/hidden/);
  });

  test('closes modal on backdrop click', async ({ page }) => {
    await page.click('#btn-signature');
    await page.locator('#sig-modal .modal-backdrop').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('#sig-modal')).toHaveClass(/hidden/);
  });

  test('saves a drawn signature', async ({ page }) => {
    await saveSignature(page);
    const count = await page.locator('.sig-item').count();
    expect(count).toBeGreaterThan(0);
  });

  test('clears the canvas', async ({ page }) => {
    await page.click('#btn-signature');
    await drawSignature(page);
    await page.click('#sig-clear');
    // Canvas should be blank — check that save button reports empty
    await page.click('#sig-save');
    await expect(page.locator('#toast')).toContainText(/draw/i);
  });

  test('line width slider changes stroke width', async ({ page }) => {
    await page.click('#btn-signature');
    await page.locator('#sig-linewidth').fill('8');
    await page.locator('#sig-linewidth').dispatchEvent('input');
    await expect(page.locator('#sig-linewidth-val')).toHaveText('8px');
  });

  test('color swatches update selected color', async ({ page }) => {
    await page.click('#btn-signature');
    const swatch = page.locator('.color-swatch').nth(1); // dark navy
    await swatch.click();
    await expect(swatch).toHaveClass(/active/);
  });
});

test.describe('Signature import / export', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await loadPDF(page);
  });

  test('imports a PNG as a signature', async ({ page }) => {
    await openImportEditor(page, SIGNATURE_PNG);
    await page.click('#imgedit-save');
    await expect(page.locator('.sig-item').first()).toBeVisible({ timeout: 5000 });
  });

  test('exports signatures as JSON and can re-import', async ({ page }) => {
    await saveSignature(page);

    // Export
    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#sig-export'),
    ]);
    expect(dl.suggestedFilename()).toBe('signatures.json');

    const dlPath = await dl.path();
    const json   = JSON.parse(fs.readFileSync(dlPath, 'utf8'));
    expect(json.signatures).toBeInstanceOf(Array);
    expect(json.signatures[0].dataUrl).toMatch(/^data:image\/png/);

    // Modal is still open from saveSignature — delete the sig directly
    await page.locator('.sig-item-del').first().click();
    await expect(page.locator('.no-sigs')).toBeVisible();

    // Re-import from the downloaded JSON (input is inside the already-open modal)
    await page.locator('#sig-json-input').setInputFiles(dlPath);
    await expect(page.locator('.sig-item').first()).toBeVisible({ timeout: 5000 });
  });

  // A single "change" event must import each signature exactly once — the
  // file input previously also fired on "input", double-saving every restore.
  test('importing a JSON backup does not duplicate signatures', async ({ page }) => {
    await page.click('#btn-signature');
    const jsonPath = path.join(__dirname, '../fixtures/one-signature.json');
    fs.writeFileSync(jsonPath, JSON.stringify({
      signatures: [{ dataUrl: 'data:image/png;base64,' +
        fs.readFileSync(SIGNATURE_PNG).toString('base64') }],
    }));

    await page.locator('#sig-json-input').setInputFiles(jsonPath);
    await expect(page.locator('.sig-item').first()).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(500);   // let any duplicate handler fire
    await expect(page.locator('.sig-item')).toHaveCount(1);

    fs.unlinkSync(jsonPath);
  });
});

test.describe('Photo import editor', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await loadPDF(page);
  });

  test('opens the editor instead of importing the photo as-is', async ({ page }) => {
    await openImportEditor(page);
    await expect(page.locator('#sig-draw-view')).toHaveClass(/hidden/);
    await expect(page.locator('#sig-item')).toHaveCount(0);
    await expect(page.locator('#imgedit-filename')).toHaveText('signature-photo.png');
  });

  test('extracts ink onto a transparent background', async ({ page }) => {
    await openImportEditor(page);
    await cropToPaper(page);
    await page.click('#imgedit-save');
    await expect(page.locator('.sig-item').first()).toBeVisible({ timeout: 15000 });

    const sig = await measureSavedSignature(page);
    // The wooden table and the paper are gone: corners fully transparent and
    // most of the image is empty, with only the strokes left behind.
    expect(sig.corners).toEqual([0, 0, 0, 0]);
    expect(sig.clear).toBeGreaterThan(sig.opaque * 2);
    expect(sig.opaque).toBeGreaterThan(500);
    // ink colour is sampled from the photo, so the blue pen stays blue
    expect(sig.ink[2]).toBeGreaterThan(sig.ink[0] + 30);
  });

  test('threshold slider changes the extracted result', async ({ page }) => {
    await openImportEditor(page);
    const snapshot = () => page.evaluate(() =>
      document.getElementById('imgedit-out').toDataURL());

    const before = await snapshot();
    await page.locator('#imgedit-threshold').fill('90');
    await page.locator('#imgedit-threshold').dispatchEvent('input');
    await expect(page.locator('#imgedit-threshold-val')).toHaveText('90%');
    expect(await snapshot()).not.toBe(before);

    // Auto puts it back on the detected threshold
    await page.click('#imgedit-auto');
    await expect(page.locator('#imgedit-threshold-val')).not.toHaveText('90%');
  });

  test('despeckle removes the dust specks', async ({ page }) => {
    await openImportEditor(page);
    const removed = async () => {
      const text = await page.locator('#imgedit-stats').textContent();
      return parseInt(/(\d+) speck/.exec(text)[1], 10);
    };
    expect(await removed()).toBeGreaterThan(10);

    await page.locator('#imgedit-despeckle').fill('0');
    await page.locator('#imgedit-despeckle').dispatchEvent('input');
    await expect(page.locator('#imgedit-despeckle-val')).toHaveText('0');
    expect(await removed()).toBe(0);
  });

  test('rotating 90° flips the result orientation', async ({ page }) => {
    await openImportEditor(page);
    const size = () => page.evaluate(() => {
      const c = document.getElementById('imgedit-out');
      return c.width / c.height;
    });

    const landscape = await size();
    expect(landscape).toBeGreaterThan(1);

    await page.click('#imgedit-rot-cw');
    await expect(page.locator('#imgedit-stats')).not.toBeEmpty();
    expect(await size()).toBeLessThan(1);
  });

  test('straighten slider reports its angle', async ({ page }) => {
    await openImportEditor(page);
    await page.locator('#imgedit-fine').fill('-4');
    await page.locator('#imgedit-fine').dispatchEvent('input');
    await expect(page.locator('#imgedit-fine-val')).toHaveText('-4°');
  });

  test('dragging a corner re-crops the result', async ({ page }) => {
    await openImportEditor(page);
    const snapshot = () => page.evaluate(() =>
      document.getElementById('imgedit-out').toDataURL());

    const before = await snapshot();
    await cropToPaper(page);
    expect(await snapshot()).not.toBe(before);
  });

  test('keeps the ink colour even when the crop catches the table', async ({ page }) => {
    // The default selection includes the wooden background — a single huge
    // edge-touching blob that must not drag the sampled ink colour brown.
    await openImportEditor(page);
    const ink = await page.locator('#imgedit-ink').inputValue();
    const [r, , b] = [1, 3, 5].map(i => parseInt(ink.slice(i, i + 2), 16));
    expect(b).toBeGreaterThan(r + 30);
  });

  test('cancel discards the photo without saving', async ({ page }) => {
    await openImportEditor(page);
    await page.click('#imgedit-cancel');
    await expect(page.locator('#sig-draw-view')).not.toHaveClass(/hidden/);
    await expect(page.locator('.no-sigs')).toBeVisible();
  });

  test('"use unprocessed" saves the original image untouched', async ({ page }) => {
    await openImportEditor(page);
    await page.click('#imgedit-raw');
    await expect(page.locator('.sig-item').first()).toBeVisible({ timeout: 15000 });

    const sig = await measureSavedSignature(page);
    expect(sig.clear).toBe(0);           // nothing was made transparent
    expect(sig.width).toBe(640);
  });

  test('handles several photos one after another', async ({ page }) => {
    await page.click('#btn-signature');
    await page.locator('#sig-png-input').setInputFiles([PHOTO_PNG, PHOTO_PNG]);
    await expect(page.locator('#imgedit-progress')).toHaveText('1 of 2');
    await page.click('#imgedit-save');
    await expect(page.locator('#imgedit-progress')).toHaveText('2 of 2', { timeout: 15000 });
    await page.click('#imgedit-save');
    await expect(page.locator('#sig-draw-view')).not.toHaveClass(/hidden/, { timeout: 15000 });
    await expect(page.locator('.sig-item')).toHaveCount(2);
  });
});

test.describe('AI form field matching', () => {
  // tokenize/tokensMatch are pure functions — exercised in-page since the app
  // ships as ES modules with no separate unit-test runner.
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');   // past the SW install reload
  });

  async function matches(page, fieldName, canonicalKey) {
    return page.evaluate(async ([fieldName, canonicalKey]) => {
      const { tokenize, tokensMatch } = await import('/js/ai-assistant.js');
      return tokensMatch(tokenize(fieldName), tokenize(canonicalKey));
    }, [fieldName, canonicalKey]);
  }

  test('does not match "name" against an unrelated field containing it as a substring', async ({ page }) => {
    expect(await matches(page, 'surname', 'name')).toBe(false);
    expect(await matches(page, 'username', 'name')).toBe(false);
    expect(await matches(page, 'firstname', 'name')).toBe(false);
    // Contrast: a field where "name" is a genuine separate word still matches.
    expect(await matches(page, 'company_name_confirmation', 'name')).toBe(true);
  });

  test('still matches a field genuinely composed of the same words', async ({ page }) => {
    expect(await matches(page, 'first_name', 'first_name')).toBe(true);
    expect(await matches(page, 'txtFirstName', 'first_name')).toBe(true);
    expect(await matches(page, 'field_first_name', 'first_name')).toBe(true);
    expect(await matches(page, 'name', 'name')).toBe(true);
  });
});

test.describe('Placing signature', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await loadPDF(page);
    await saveSignature(page);
    await selectFirstSignature(page);
  });

  test('shows placement banner when entering placement mode', async ({ page }) => {
    await page.click('#btn-place-sig');
    await expect(page.locator('.placement-mode-banner')).toBeVisible();
  });

  test('places signature overlay on click', async ({ page }) => {
    await page.click('#btn-place-sig');
    const wrapper = page.locator('.page-wrapper').first();
    const box     = await wrapper.boundingBox();
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.4);
    await expect(page.locator('.sig-overlay')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.placement-mode-banner')).toBeHidden();
  });

  test('cancels placement mode', async ({ page }) => {
    await page.click('#btn-place-sig');
    await page.locator('#btn-cancel-place').click();
    await expect(page.locator('.placement-mode-banner')).toBeHidden();
  });

  test('removes overlay with the Remove button', async ({ page }) => {
    await page.click('#btn-place-sig');
    const wrapper = page.locator('.page-wrapper').first();
    const box     = await wrapper.boundingBox();
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.4);
    await expect(page.locator('.sig-overlay')).toBeVisible({ timeout: 5000 });
    await page.locator('.sig-overlay-btn').click();
    await expect(page.locator('.sig-overlay')).toBeHidden();
  });
});

test.describe('Free-text annotations', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await loadPDF(page);
  });

  test('shows text placement banner', async ({ page }) => {
    await page.click('#btn-add-text');
    await expect(page.locator('.placement-mode-banner')).toBeVisible();
  });

  test('places editable text input on click', async ({ page }) => {
    await page.click('#btn-add-text');
    const wrapper = page.locator('.page-wrapper').first();
    const box     = await wrapper.boundingBox();
    await page.mouse.click(box.x + 100, box.y + 150);
    await expect(page.locator('.free-text-overlay')).toBeVisible();
  });

  test('accepts typed text', async ({ page }) => {
    await page.click('#btn-add-text');
    const wrapper = page.locator('.page-wrapper').first();
    const box     = await wrapper.boundingBox();
    await page.mouse.click(box.x + 100, box.y + 150);
    await page.locator('.free-text-overlay').fill('Hello PDF');
    await expect(page.locator('.free-text-overlay')).toHaveValue('Hello PDF');
  });

  // A freshly typed overlay is still focused — the state it is always in when
  // the user reaches to move it.
  test('drags a placed text overlay the full distance', async ({ page }) => {
    await page.click('#btn-add-text');
    const wrapper = page.locator('.page-wrapper').first();
    const box     = await wrapper.boundingBox();
    await page.mouse.click(box.x + 100, box.y + 150);

    const overlay = page.locator('.free-text-overlay');
    await overlay.fill('Drag me');
    await expect(overlay).toBeFocused();

    const before = await overlay.boundingBox();
    await page.mouse.move(before.x + 20, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + 20 + 120, before.y + before.height / 2 + 60, { steps: 10 });
    await page.mouse.up();

    // The whole gesture must land, not just the pixels before focus kicked in.
    const after = await overlay.boundingBox();
    expect(after.x - before.x).toBeGreaterThan(110);
    expect(after.y - before.y).toBeGreaterThan(50);

    // PDF coordinates follow the move, so the text saves where it is shown.
    const pdf = await overlay.evaluate(el => [+el.dataset.pdfX, +el.dataset.pdfY]);
    expect(pdf[0]).toBeGreaterThan(100);
    // Dragging leaves edit mode rather than dropping straight back into it.
    await expect(overlay).not.toBeFocused();
  });

  test('clicking a placed text overlay puts it back into edit mode', async ({ page }) => {
    await page.click('#btn-add-text');
    const wrapper = page.locator('.page-wrapper').first();
    const box     = await wrapper.boundingBox();
    await page.mouse.click(box.x + 100, box.y + 150);

    const overlay = page.locator('.free-text-overlay');
    await overlay.fill('Edit me');
    await page.locator('#pdf-pages').click({ position: { x: 5, y: 5 } });
    await expect(overlay).not.toBeFocused();

    await overlay.click();
    await expect(overlay).toBeFocused();
  });
});

test.describe('Save PDF', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await loadPDF(page);
  });

  test('downloads PDF with _signed suffix', async ({ page }) => {
    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#btn-save'),
    ]);
    expect(dl.suggestedFilename()).toMatch(/^sample_signed\.pdf$/);
  });

  test('saves PDF with placed signature', async ({ page }) => {
    await saveSignature(page);
    await selectFirstSignature(page);
    await page.click('#btn-place-sig');

    const wrapper = page.locator('.page-wrapper').first();
    const box     = await wrapper.boundingBox();
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await expect(page.locator('.sig-overlay')).toBeVisible({ timeout: 5000 });

    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#btn-save'),
    ]);
    const bytes = fs.readFileSync(await dl.path());
    // Valid PDF starts with %PDF
    expect(bytes.slice(0, 4).toString()).toBe('%PDF');
    expect(dl.suggestedFilename()).toMatch(/_signed\.pdf$/);
  });

  test('saves PDF with free-text annotation', async ({ page }) => {
    await page.click('#btn-add-text');
    const wrapper = page.locator('.page-wrapper').first();
    const box     = await wrapper.boundingBox();
    await page.mouse.click(box.x + 80, box.y + 200);
    await page.locator('.free-text-overlay').fill('Test annotation');

    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#btn-save'),
    ]);
    const bytes = fs.readFileSync(await dl.path());
    expect(bytes.slice(0, 4).toString()).toBe('%PDF');
  });

  test('shows an error and recovers when saving fails', async ({ page }) => {
    // Force pdf-lib's PNG embedding to fail, simulating any mid-save error.
    await page.evaluate(() => {
      PDFLib.PDFDocument.prototype.embedPng = async () => { throw new Error('boom'); };
    });

    await saveSignature(page);
    await selectFirstSignature(page);
    await page.click('#btn-place-sig');
    const wrapper = page.locator('.page-wrapper').first();
    const box     = await wrapper.boundingBox();
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await expect(page.locator('.sig-overlay')).toBeVisible({ timeout: 5000 });

    await page.click('#btn-save');
    await expect(page.locator('#error-banner')).toBeVisible();
    await expect(page.locator('#error-banner-msg')).toContainText('boom');
    // The button must not be left stuck disabled after a failed save.
    await expect(page.locator('#btn-save')).toBeEnabled();
  });
});
