import { saveSignature, getSignatures, deleteSignature } from './storage.js';
import { SignaturePad } from './signature-pad.js';
import { PDFViewer }    from './pdf-viewer.js';
import { PDFEditor }    from './pdf-editor.js';

let viewer   = null;
let editor   = null;
let sigPad   = null;
let pdfBytes = null;       // original ArrayBuffer (kept for re-load into pdf-lib)
let selectedSigDataUrl = null;
let placementBanner    = null;

// ── Init ────────────────────────────────────────────────────────────────────

function init() {
  viewer = new PDFViewer(document.getElementById('pdf-pages'));
  sigPad = new SignaturePad(document.getElementById('sig-canvas'));

  document.getElementById('file-input').addEventListener('change', onFileSelected);
  document.getElementById('btn-signature').onclick   = openSigModal;
  document.getElementById('btn-place-sig').onclick   = startPlacement;
  document.getElementById('btn-add-text').onclick    = startTextMode;
  document.getElementById('btn-save').onclick        = savePDF;
  document.getElementById('sig-modal-close').onclick = closeSigModal;
  document.getElementById('sig-clear').onclick       = () => sigPad.clear();

  const lwSlider = document.getElementById('sig-linewidth');
  const lwVal    = document.getElementById('sig-linewidth-val');
  lwSlider.oninput = () => {
    sigPad.lineWidth   = parseFloat(lwSlider.value);
    lwVal.textContent  = lwSlider.value + 'px';
  };
  document.getElementById('sig-save').onclick        = onSaveSig;
  document.querySelector('.modal-backdrop').onclick  = closeSigModal;

  document.getElementById('sig-export').onclick      = exportSignatures;
  // Use both change and input — Android Chrome sometimes fires only one
  for (const id of ['sig-png-input', 'sig-json-input']) {
    const el = document.getElementById(id);
    el.addEventListener('change', id === 'sig-png-input' ? onImportPng : onImportJson);
    el.addEventListener('input',  id === 'sig-png-input' ? onImportPng : onImportJson);
  }

  const colorPicker = document.getElementById('sig-color');
  colorPicker.oninput = () => setColor(colorPicker.value);

  document.querySelectorAll('.color-swatch').forEach(btn => {
    btn.onclick = () => { colorPicker.value = btn.dataset.color; setColor(btn.dataset.color); };
  });

  // Mark first swatch active by default
  document.querySelector('.color-swatch').classList.add('active');

  viewer.onPlaceSignature = onSignaturePlaced;

  setupDropZone();
  renderSavedSigs();
}

// ── File handling ────────────────────────────────────────────────────────────

function setupDropZone() {
  const zone = document.getElementById('drop-zone');
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', ()  => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file?.type === 'application/pdf') loadFile(file);
  });
}

async function onFileSelected(e) {
  const file = e.target.files[0];
  if (file) await loadFile(file);
  e.target.value = '';
}

async function loadFile(file) {
  document.getElementById('file-name').textContent = file.name;
  pdfBytes = await file.arrayBuffer();

  document.getElementById('drop-zone').classList.add('hidden');
  document.getElementById('pdf-pages').classList.remove('hidden');

  toast('Loading…');
  await viewer.load(pdfBytes.slice(0));

  editor = new PDFEditor();
  await editor.load(pdfBytes.slice(0));

  document.getElementById('btn-signature').disabled  = false;
  document.getElementById('btn-place-sig').disabled  = false;
  document.getElementById('btn-add-text').disabled   = false;
  document.getElementById('btn-save').disabled       = false;
  toast('PDF loaded');
}

// ── Signature modal ──────────────────────────────────────────────────────────

function openSigModal() {
  document.getElementById('sig-modal').classList.remove('hidden');
  renderSavedSigs();
}

function closeSigModal() {
  document.getElementById('sig-modal').classList.add('hidden');
}

async function onSaveSig() {
  if (sigPad.isEmpty()) { toast('Draw a signature first'); return; }
  await saveSignature(sigPad.toDataURL());
  sigPad.clear();
  await renderSavedSigs();
  toast('Signature saved');
}

async function renderSavedSigs() {
  const sigs = await getSignatures();
  const container = document.getElementById('saved-sigs');
  container.innerHTML = '';

  if (!sigs.length) {
    container.innerHTML = '<p class="no-sigs">No saved signatures yet. Draw one above.</p>';
    return;
  }

  sigs.forEach(sig => {
    const item = document.createElement('div');
    item.className = 'sig-item' + (sig.dataUrl === selectedSigDataUrl ? ' selected' : '');

    const img = document.createElement('img');
    img.src = sig.dataUrl;
    img.alt = 'Saved signature';
    img.onclick = () => {
      selectedSigDataUrl = sig.dataUrl;
      container.querySelectorAll('.sig-item').forEach(el => el.classList.remove('selected'));
      item.classList.add('selected');
      toast('Signature selected — tap Place to stamp it');
    };

    const del = document.createElement('button');
    del.className = 'sig-item-del';
    del.innerHTML = '&times;';
    del.title = 'Delete';
    del.onclick = async e => {
      e.stopPropagation();
      if (selectedSigDataUrl === sig.dataUrl) selectedSigDataUrl = null;
      await deleteSignature(sig.id);
      await renderSavedSigs();
    };

    item.appendChild(img);
    item.appendChild(del);
    container.appendChild(item);
  });
}

// ── Placement mode ───────────────────────────────────────────────────────────

function startPlacement() {
  if (!selectedSigDataUrl) {
    openSigModal();
    toast('Select a signature first');
    return;
  }
  viewer.enablePlacementMode();

  if (!placementBanner) {
    placementBanner = document.createElement('div');
    placementBanner.className = 'placement-mode-banner';
    placementBanner.innerHTML = `
      <span>Tap the PDF where you want to place your signature</span>
      <button id="btn-cancel-place">Cancel</button>
    `;
    document.body.appendChild(placementBanner);
    document.getElementById('btn-cancel-place').onclick = cancelPlacement;
  }
}

function cancelPlacement() {
  viewer.disablePlacementMode();
  if (placementBanner) { placementBanner.remove(); placementBanner = null; }
}

// ── Free-text mode ───────────────────────────────────────────────────────────

let textBanner = null;

function startTextMode() {
  viewer.enableTextMode();
  if (!textBanner) {
    textBanner = document.createElement('div');
    textBanner.className = 'placement-mode-banner';
    textBanner.innerHTML = `
      <span>Tap the PDF where you want to add text</span>
      <button id="btn-cancel-text">Cancel</button>
    `;
    document.body.appendChild(textBanner);
    document.getElementById('btn-cancel-text').onclick = cancelTextMode;
  }
}

function cancelTextMode() {
  viewer.disableTextMode();
  if (textBanner) { textBanner.remove(); textBanner = null; }
}

function onSignaturePlaced(pageNum, pdfX, pdfY, pageInfo) {
  viewer.addSignatureOverlay(pageInfo, pdfX, pdfY, selectedSigDataUrl);
  cancelPlacement();
  toast('Signature placed — drag to reposition, resize with the handle');
}

// ── Save PDF ─────────────────────────────────────────────────────────────────

async function savePDF() {
  if (!editor) return;
  toast('Saving…');

  // Re-load editor from original bytes so previous saves don't stack
  editor = new PDFEditor();
  await editor.load(pdfBytes.slice(0));

  await editor.applyFormData(viewer.getFormData());
  await editor.applySignatures(viewer.getSignaturePlacements());
  editor.applyFreeText(viewer.getFreeTextAnnotations());

  const bytes    = await editor.getBytes();
  const blob     = new Blob([bytes], { type: 'application/pdf' });
  const origName = document.getElementById('file-name').textContent.replace(/\.pdf$/i, '');
  triggerDownload(URL.createObjectURL(blob), `${origName}_signed.pdf`);
  toast('PDF downloaded');
}

// ── Signature color ──────────────────────────────────────────────────────────

function setColor(hex) {
  sigPad.color = hex;
  document.querySelectorAll('.color-swatch').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.color === hex);
  });
}

// ── Signature import / export ────────────────────────────────────────────────

async function onImportPng(e) {
  const files = Array.from(e.target.files);
  if (!files.length) return;
  for (const file of files) {
    const dataUrl = await readFileAsDataUrl(file);
    const png = await normaliseImageToPng(dataUrl);
    await saveSignature(png);
  }
  e.target.value = '';  // clear only after reading
  await renderSavedSigs();
  toast(`${files.length} image${files.length > 1 ? 's' : ''} imported`);
}

async function onImportJson(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await readFileAsText(file);  // FileReader, not file.text()
    e.target.value = '';                       // clear only after reading
    const data = JSON.parse(text);
    const sigs  = Array.isArray(data) ? data : data.signatures;
    if (!Array.isArray(sigs)) throw new Error('Unrecognised format');
    for (const s of sigs) {
      if (s.dataUrl) await saveSignature(s.dataUrl);
    }
    await renderSavedSigs();
    toast(`${sigs.length} signature${sigs.length > 1 ? 's' : ''} imported`);
  } catch (err) {
    toast('Import failed: ' + err.message);
  }
}

async function exportSignatures() {
  const sigs = await getSignatures();
  if (!sigs.length) { toast('No signatures to export'); return; }
  const blob = new Blob([JSON.stringify({ signatures: sigs }, null, 2)], { type: 'application/json' });
  triggerDownload(URL.createObjectURL(blob), 'signatures.json');
  toast(`Exported ${sigs.length} signature${sigs.length > 1 ? 's' : ''}`);
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload  = () => resolve(r.result);
    r.onerror = reject;
    r.readAsText(file);
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload  = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function normaliseImageToPng(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

// ── Download helper (works on Android Chrome) ────────────────────────────────

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  // Small delay before cleanup so the browser has time to start the download
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
}

// ── Toast ────────────────────────────────────────────────────────────────────

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2400);
}

// ── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
