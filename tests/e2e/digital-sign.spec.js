const { test, expect } = require('@playwright/test');
const path = require('path');

const SAMPLE_PDF = path.join(__dirname, '../fixtures/sample.pdf');

// ── Tauri mock helper ─────────────────────────────────────────────────────────

/**
 * Call before page.goto() to inject a window.__TAURI__ stub.
 * invokeMap maps command name → return value (or Error to throw).
 */
async function injectTauriMock(page, invokeMap) {
  await page.addInitScript((map) => {
    window.__TAURI__ = {
      core: {
        invoke: async (cmd, _args) => {
          if (!(cmd in map)) throw new Error('unmocked command: ' + cmd);
          const v = map[cmd];
          if (v && v.__error) throw new Error(v.__error);
          return v;
        },
      },
    };
  }, invokeMap);
}

function errEntry(msg) { return { __error: msg }; }

const FAKE_CERT = {
  slot_id: 0,
  label: 'User certificate',
  subject: 'CN=Jane Smith,O=Test Org,C=DE',
  issuer: 'CN=Test CA',
  serial: 'DEADBEEF',
  not_after: '2030-01-01T00:00:00Z',
  cert_der: [0, 1, 2, 3],
};

const SIGNED_PDF_RESPONSE = {
  signed_pdf: Array.from(Buffer.from('%PDF-1.4\n%test\n%%EOF\n')),
};

async function loadPDF(page, file = SAMPLE_PDF) {
  await page.locator('#file-input').setInputFiles(file);
  await expect(page.locator('.page-wrapper').first()).toBeVisible({ timeout: 15000 });
}

// ── Browser-mode (no window.__TAURI__) ───────────────────────────────────────

test.describe('Digital sign — browser mode', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await loadPDF(page);
  });

  test('button is visible after PDF load', async ({ page }) => {
    await expect(page.locator('#btn-sign-digital')).toBeVisible();
  });

  test('button is disabled before any PDF is loaded', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#btn-sign-digital')).toBeDisabled();
  });

  test('click shows desktop-only toast, not the modal', async ({ page }) => {
    await page.click('#btn-sign-digital');
    await expect(page.locator('#toast')).toBeVisible();
    await expect(page.locator('#toast')).toContainText(/desktop app/i);
    await expect(page.locator('#sign-digital-modal')).toHaveClass(/hidden/);
  });
});

// ── Tauri mode — cert list loads successfully ─────────────────────────────────

test.describe('Digital sign modal — certs found', () => {
  test.beforeEach(async ({ page }) => {
    await injectTauriMock(page, {
      list_smartcard_certs: [FAKE_CERT],
      sign_pdf:             SIGNED_PDF_RESPONSE,
      save_pdf_dialog:      true,
    });
    await page.goto('/');
    await loadPDF(page);
  });

  test('opens modal on button click', async ({ page }) => {
    await page.click('#btn-sign-digital');
    await expect(page.locator('#sign-digital-modal')).not.toHaveClass(/hidden/);
  });

  test('populates dropdown with certificate', async ({ page }) => {
    await page.click('#btn-sign-digital');
    await expect(
      page.locator('#sign-cert-select option', { hasText: 'Jane Smith' })
    ).toBeVisible({ timeout: 5000 });
  });

  test('closes on Cancel', async ({ page }) => {
    await page.click('#btn-sign-digital');
    await page.click('#sign-digital-cancel');
    await expect(page.locator('#sign-digital-modal')).toHaveClass(/hidden/);
  });

  test('closes on X button', async ({ page }) => {
    await page.click('#btn-sign-digital');
    await page.click('#sign-digital-close');
    await expect(page.locator('#sign-digital-modal')).toHaveClass(/hidden/);
  });

  test('closes on backdrop click', async ({ page }) => {
    await page.click('#btn-sign-digital');
    await page.locator('#sign-digital-modal .modal-backdrop')
      .click({ position: { x: 5, y: 5 } });
    await expect(page.locator('#sign-digital-modal')).toHaveClass(/hidden/);
  });

  test('clears PIN field when modal is closed and reopened', async ({ page }) => {
    await page.click('#btn-sign-digital');
    await page.locator('#sign-pin').fill('1234');
    await page.click('#sign-digital-cancel');
    await page.click('#btn-sign-digital');
    await expect(page.locator('#sign-pin')).toHaveValue('');
  });

  test('submit without selecting a cert shows error', async ({ page }) => {
    await page.click('#btn-sign-digital');
    // Nullify the cert list so validation fails
    await page.evaluate(() => {
      document.getElementById('sign-cert-select')._certs = null;
    });
    await page.click('#sign-digital-submit');
    await expect(page.locator('#sign-digital-error')).not.toHaveClass(/hidden/);
    await expect(page.locator('#sign-digital-error')).toContainText(/certificate/i);
  });

  test('submit with empty PIN shows error', async ({ page }) => {
    await page.click('#btn-sign-digital');
    await expect(
      page.locator('#sign-cert-select option', { hasText: 'Jane Smith' })
    ).toBeVisible({ timeout: 5000 });
    await page.locator('#sign-cert-select').selectOption({ index: 0 });
    // Leave PIN empty
    await page.click('#sign-digital-submit');
    await expect(page.locator('#sign-digital-error')).not.toHaveClass(/hidden/);
    await expect(page.locator('#sign-digital-error')).toContainText(/PIN/i);
  });

  test('successful sign closes modal and shows toast', async ({ page }) => {
    await page.click('#btn-sign-digital');
    await expect(
      page.locator('#sign-cert-select option', { hasText: 'Jane Smith' })
    ).toBeVisible({ timeout: 5000 });
    await page.locator('#sign-cert-select').selectOption({ index: 0 });
    await page.locator('#sign-pin').fill('1234');
    await page.click('#sign-digital-submit');
    await expect(page.locator('#sign-digital-modal')).toHaveClass(/hidden/, { timeout: 8000 });
    await expect(page.locator('#toast')).toContainText(/signed/i);
  });
});

// ── Tauri mode — no certificates on token ────────────────────────────────────

test.describe('Digital sign modal — no certs', () => {
  test.beforeEach(async ({ page }) => {
    await injectTauriMock(page, { list_smartcard_certs: [] });
    await page.goto('/');
    await loadPDF(page);
  });

  test('shows "no signing certificates found" in dropdown', async ({ page }) => {
    await page.click('#btn-sign-digital');
    await expect(page.locator('#sign-cert-select')).toContainText(
      /no signing certificates/i, { timeout: 5000 }
    );
  });
});

// ── Tauri mode — OpenSC not installed ────────────────────────────────────────

test.describe('Digital sign modal — OpenSC missing', () => {
  test.beforeEach(async ({ page }) => {
    await injectTauriMock(page, {
      list_smartcard_certs: errEntry('load /usr/lib/opensc-pkcs11.so: cannot open shared object file'),
    });
    await page.goto('/');
    await loadPDF(page);
  });

  test('shows OpenSC install prompt', async ({ page }) => {
    await page.click('#btn-sign-digital');
    const err = page.locator('#sign-digital-error');
    await expect(err).not.toHaveClass(/hidden/, { timeout: 5000 });
    await expect(err).toContainText(/OpenSC/i);
  });

  test('install prompt contains a download link', async ({ page }) => {
    await page.click('#btn-sign-digital');
    const link = page.locator('#sign-digital-error a');
    await expect(link).toBeVisible({ timeout: 5000 });
    await expect(link).toHaveAttribute('href', /OpenSC/);
    await expect(link).toHaveAttribute('target', '_blank');
  });

  test('shows apt install hint', async ({ page }) => {
    await page.click('#btn-sign-digital');
    await expect(page.locator('#sign-digital-error')).toContainText(
      /apt install opensc/i, { timeout: 5000 }
    );
  });
});

// ── Tauri mode — generic backend error (not OpenSC) ──────────────────────────

test.describe('Digital sign modal — generic error', () => {
  test.beforeEach(async ({ page }) => {
    await injectTauriMock(page, {
      list_smartcard_certs: errEntry('PKCS#11 token not present'),
    });
    await page.goto('/');
    await loadPDF(page);
  });

  test('shows raw error message', async ({ page }) => {
    await page.click('#btn-sign-digital');
    const err = page.locator('#sign-digital-error');
    await expect(err).not.toHaveClass(/hidden/, { timeout: 5000 });
    await expect(err).toContainText(/PKCS#11 token not present/);
  });

  test('does not show OpenSC install link for non-load errors', async ({ page }) => {
    await page.click('#btn-sign-digital');
    await expect(page.locator('#sign-digital-error')).not.toHaveClass(/hidden/, { timeout: 5000 });
    await expect(page.locator('#sign-digital-error a')).toHaveCount(0);
  });
});

// ── Tauri mode — sign_pdf fails (wrong PIN etc.) ──────────────────────────────

test.describe('Digital sign modal — sign failure', () => {
  test.beforeEach(async ({ page }) => {
    await injectTauriMock(page, {
      list_smartcard_certs: [FAKE_CERT],
      sign_pdf:             errEntry('PIN rejected: CKR_PIN_INCORRECT'),
    });
    await page.goto('/');
    await loadPDF(page);
  });

  test('shows error and keeps modal open for retry', async ({ page }) => {
    await page.click('#btn-sign-digital');
    await expect(
      page.locator('#sign-cert-select option', { hasText: 'Jane Smith' })
    ).toBeVisible({ timeout: 5000 });
    await page.locator('#sign-cert-select').selectOption({ index: 0 });
    await page.locator('#sign-pin').fill('wrongpin');
    await page.click('#sign-digital-submit');
    const err = page.locator('#sign-digital-error');
    await expect(err).not.toHaveClass(/hidden/, { timeout: 8000 });
    await expect(err).toContainText(/PIN rejected/i);
    await expect(page.locator('#sign-digital-modal')).not.toHaveClass(/hidden/);
    await expect(page.locator('#sign-digital-submit')).toBeEnabled();
  });
});
