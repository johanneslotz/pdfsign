const { test, expect } = require('@playwright/test');
const path = require('path');
const fs   = require('fs');

const SAMPLE_PDF    = path.join(__dirname, '../fixtures/sample.pdf');
const FORM_PDF      = path.join(__dirname, '../fixtures/form.pdf');
const SIGNATURE_PNG = path.join(__dirname, '../fixtures/signature.png');

// ── helpers ──────────────────────────────────────────────────────────────────

async function loadPDF(page, file = SAMPLE_PDF) {
  await page.locator('#file-input').setInputFiles(file);
  await expect(page.locator('.page-wrapper').first()).toBeVisible({ timeout: 15000 });
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
    await page.locator('.modal-backdrop').click({ position: { x: 5, y: 5 } });
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
    await page.click('#btn-signature');
    await page.locator('#sig-png-input').setInputFiles(SIGNATURE_PNG);
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
});
