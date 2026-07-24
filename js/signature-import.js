import {
  loadSourceImage, makeQuad, rotateQuad90, rotateQuadBy,
  SignatureExtractor, imageDataToDataURL, DEFAULT_PARAMS,
} from './signature-image.js';

const PREVIEW_MAX = 720;    // working resolution while the sliders move
const FINAL_MAX   = 1600;   // resolution of the saved stamp
// Both stages are a fixed box in the CSS: canvases are fitted inside it so the
// panes never reflow while a corner is being dragged.
const STAGE_W     = 420;
const STAGE_H     = 320;
const HANDLE_HIT  = 18;     // grab radius in display pixels

function fitInStage(width, height) {
  const scale = Math.min(1, STAGE_W / Math.max(width, 1), STAGE_H / Math.max(height, 1));
  return {
    width:  Math.max(1, Math.round(width  * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}

/**
 * Editor shown after picking an image: crop / rotate / de-skew on the left,
 * live extraction result on the right. Files are handled one at a time.
 */
export class SignatureImportEditor {
  constructor({ onSave, toast } = {}) {
    this.onSave = onSave || (() => {});
    this.toast  = toast  || (() => {});
    this.queue  = [];
    this.pending = null;
    this._bound = false;
  }

  get el() {
    return {
      drawView:   document.getElementById('sig-draw-view'),
      importView: document.getElementById('sig-import-view'),
      filename:   document.getElementById('imgedit-filename'),
      progress:   document.getElementById('imgedit-progress'),
      src:        document.getElementById('imgedit-src'),
      overlay:    document.getElementById('imgedit-overlay'),
      out:        document.getElementById('imgedit-out'),
      fine:       document.getElementById('imgedit-fine'),
      fineVal:    document.getElementById('imgedit-fine-val'),
      threshold:  document.getElementById('imgedit-threshold'),
      thresholdVal: document.getElementById('imgedit-threshold-val'),
      despeckle:  document.getElementById('imgedit-despeckle'),
      despeckleVal: document.getElementById('imgedit-despeckle-val'),
      ink:        document.getElementById('imgedit-ink'),
      stats:      document.getElementById('imgedit-stats'),
      busy:       document.getElementById('imgedit-busy'),
    };
  }

  /** Queue files and open the editor on the first one. */
  async start(files) {
    this.queue = Array.from(files);
    this.saved = 0;
    this.total = this.queue.length;
    this._bind();
    await this._next();
  }

  async _next() {
    const file = this.queue.shift();
    if (!file) return this._finish();

    const el = this.el;
    el.filename.textContent = file.name;
    el.progress.textContent = this.total > 1
      ? `${this.total - this.queue.length} of ${this.total}` : '';
    this._show(true);
    this._setBusy(true);

    try {
      this.source    = await loadSourceImage(file);
      this.extractor = new SignatureExtractor(this.source);
      this.baseQuad  = makeQuad(this.source.width, this.source.height);
      this.quad      = this.baseQuad;
      this.fine      = 0;
      this.params    = { ...DEFAULT_PARAMS, threshold: null, inkColor: null };
      this._layoutStage();
      const auto = this.extractor.autoThreshold(this._quad(), PREVIEW_MAX);
      this.params.threshold = auto;
      el.threshold.value    = Math.round(auto * 100);
      el.despeckle.value    = this.params.despeckle;
      el.fine.value         = 0;
      el.fineVal.textContent = '0°';
      this._render();
    } catch (err) {
      this.toast('Could not read image: ' + err.message);
      this._setBusy(false);
      await this._next();
    }
  }

  _finish() {
    this._show(false);
    this.source = this.extractor = null;
    if (this.saved) {
      this.toast(`${this.saved} signature${this.saved > 1 ? 's' : ''} imported`);
    }
  }

  /** Abandon the queue — used when the signature modal is closed mid-edit. */
  dismiss() {
    if (!this.source && !this.queue.length) return;
    this.queue = [];
    this.saved = 0;
    this._finish();
  }

  _show(on) {
    const el = this.el;
    el.drawView.classList.toggle('hidden', on);
    el.importView.classList.toggle('hidden', !on);
    document.getElementById('sig-modal').classList.toggle('importing', on);
  }

  _setBusy(on) {
    const busy = this.el.busy;
    if (busy) busy.classList.toggle('hidden', !on);
  }

  // ── Geometry ──────────────────────────────────────────────────────────────

  /** The quad actually sampled: user corners plus the straighten angle. */
  _quad() {
    return this.fine ? rotateQuadBy(this.quad, this.fine) : this.quad;
  }

  _layoutStage() {
    const { src, overlay } = this.el;
    const { width: w, height: h } = fitInStage(this.source.width, this.source.height);
    this.viewScale = w / this.source.width;

    for (const c of [src, overlay]) {
      c.width = w; c.height = h;
      c.style.width = w + 'px'; c.style.height = h + 'px';
    }
    src.getContext('2d').drawImage(this.source, 0, 0, w, h);
  }

  _drawOverlay() {
    const c = this.el.overlay;
    const ctx = c.getContext('2d');
    const q = this._quad().map(([x, y]) => [x * this.viewScale, y * this.viewScale]);
    ctx.clearRect(0, 0, c.width, c.height);

    // dim everything outside the selection
    ctx.fillStyle = 'rgba(15,23,42,.45)';
    ctx.beginPath();
    ctx.rect(0, 0, c.width, c.height);
    ctx.moveTo(q[0][0], q[0][1]);
    for (let i = q.length - 1; i >= 1; i--) ctx.lineTo(q[i][0], q[i][1]);
    ctx.closePath();
    ctx.fill('evenodd');

    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(q[0][0], q[0][1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(q[i][0], q[i][1]);
    ctx.closePath();
    ctx.stroke();

    // the top-left handle is filled so the output orientation is obvious
    q.forEach(([x, y], i) => {
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? '#2563eb' : '#ffffff';
      ctx.fill();
      ctx.stroke();
    });
  }

  /** CSS pixels → source pixels (the canvas may also be scaled down by CSS). */
  _cssToSource() {
    const r = this.el.overlay.getBoundingClientRect();
    return (r.width ? this.el.overlay.width / r.width : 1) / this.viewScale;
  }

  _pointerPos(e) {
    const r = this.el.overlay.getBoundingClientRect();
    const k = this._cssToSource();
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
  }

  _onPointerDown(e) {
    if (!this.source) return;
    const p = this._pointerPos(e);
    const q = this._quad();
    const hit = HANDLE_HIT * this._cssToSource();

    let idx = -1, bestDist = hit;
    q.forEach(([x, y], i) => {
      const d = Math.hypot(x - p.x, y - p.y);
      if (d <= bestDist) { bestDist = d; idx = i; }
    });

    if (idx === -1 && !pointInQuad(p, q)) return;
    e.preventDefault();
    this.el.overlay.setPointerCapture(e.pointerId);
    // Dragging edits the un-straightened quad, so bake the angle in first.
    if (this.fine) {
      this.quad = this._quad();
      this.fine = 0;
      this.el.fine.value = 0;
      this.el.fineVal.textContent = '0°';
    }
    this.drag = { idx, last: p };
  }

  _onPointerMove(e) {
    if (!this.drag) return;
    const p = this._pointerPos(e);
    const w = this.source.width, h = this.source.height;
    const clampX = v => Math.max(0, Math.min(w, v));
    const clampY = v => Math.max(0, Math.min(h, v));

    if (this.drag.idx >= 0) {
      this.quad = this.quad.map((pt, i) =>
        i === this.drag.idx ? [clampX(p.x), clampY(p.y)] : pt);
    } else {
      const dx = p.x - this.drag.last.x, dy = p.y - this.drag.last.y;
      this.quad = this.quad.map(([x, y]) => [clampX(x + dx), clampY(y + dy)]);
      this.drag.last = p;
    }
    this._render({ preview: true });
  }

  _onPointerUp(e) {
    if (!this.drag) return;
    this.drag = null;
    try { this.el.overlay.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    this._render();
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  /** Coalesce slider/drag updates into one render per animation frame. */
  _render({ preview = false } = {}) {
    this._pendingPreview = preview;
    if (this._frame) return;
    this._frame = requestAnimationFrame(() => {
      this._frame = null;
      this._renderNow(this._pendingPreview);
    });
  }

  _renderNow(preview) {
    if (!this.extractor) return;
    this._drawOverlay();

    const result = this.extractor.render(this._quad(), PREVIEW_MAX, this.params);
    const out = this.el.out;
    const fit = fitInStage(result.image.width, result.image.height);
    out.width  = fit.width;
    out.height = fit.height;
    out.style.width  = out.width + 'px';
    out.style.height = out.height + 'px';

    const tmp = document.createElement('canvas');
    tmp.width = result.image.width; tmp.height = result.image.height;
    tmp.getContext('2d').putImageData(result.image, 0, 0);
    const ctx = out.getContext('2d');
    ctx.clearRect(0, 0, out.width, out.height);
    ctx.drawImage(tmp, 0, 0, out.width, out.height);

    this.lastResult = result;
    if (!this.params.inkColor) this.el.ink.value = result.inkColor;
    this.el.thresholdVal.textContent = Math.round(this.params.threshold * 100) + '%';
    this.el.despeckleVal.textContent = this.params.despeckle;
    this.el.stats.textContent = preview
      ? ''
      : `${result.stats.kept} shape${result.stats.kept === 1 ? '' : 's'} kept · ` +
        `${result.stats.components - result.stats.kept} speck${result.stats.components - result.stats.kept === 1 ? '' : 's'} removed`;
    this._setBusy(false);
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  async _save() {
    if (!this.extractor) return;
    this._setBusy(true);
    // Re-run at full resolution with exactly the parameters shown in the preview.
    await new Promise(r => setTimeout(r, 0));
    const result = this.extractor.render(this._quad(), FINAL_MAX, this.params);
    this._setBusy(false);
    if (!result.stats.inkPixels) {
      this.toast('Nothing detected — lower the threshold or adjust the crop');
      return;
    }
    await this.onSave(imageDataToDataURL(result.image));
    this.saved++;
    await this._next();
  }

  async _saveUnprocessed() {
    if (!this.source) return;
    await this.onSave(this.source.toDataURL('image/png'));
    this.saved++;
    await this._next();
  }

  _reset() {
    this.quad = this.baseQuad;
    this.fine = 0;
    this.el.fine.value = 0;
    this.el.fineVal.textContent = '0°';
    this.params.threshold = this.extractor.autoThreshold(this._quad(), PREVIEW_MAX);
    this.params.despeckle = DEFAULT_PARAMS.despeckle;
    this.params.inkColor  = null;
    this.el.threshold.value = Math.round(this.params.threshold * 100);
    this.el.despeckle.value = this.params.despeckle;
    this._render();
  }

  _bind() {
    if (this._bound) return;
    this._bound = true;
    const el = this.el;

    el.overlay.addEventListener('pointerdown', e => this._onPointerDown(e));
    el.overlay.addEventListener('pointermove', e => this._onPointerMove(e));
    el.overlay.addEventListener('pointerup',   e => this._onPointerUp(e));
    el.overlay.addEventListener('pointercancel', e => this._onPointerUp(e));

    document.getElementById('imgedit-rot-ccw').onclick = () => {
      this.quad = rotateQuad90(this._quad(), -1); this.fine = 0; el.fine.value = 0;
      el.fineVal.textContent = '0°'; this._render();
    };
    document.getElementById('imgedit-rot-cw').onclick = () => {
      this.quad = rotateQuad90(this._quad(), 1); this.fine = 0; el.fine.value = 0;
      el.fineVal.textContent = '0°'; this._render();
    };
    el.fine.oninput = () => {
      this.fine = parseFloat(el.fine.value);
      el.fineVal.textContent = this.fine.toFixed(1).replace(/\.0$/, '') + '°';
      this._render({ preview: true });
    };
    el.fine.onchange = () => this._render();

    el.threshold.oninput = () => {
      this.params.threshold = parseInt(el.threshold.value, 10) / 100;
      this._render();
    };
    document.getElementById('imgedit-auto').onclick = () => {
      this.params.threshold = this.extractor.autoThreshold(this._quad(), PREVIEW_MAX);
      el.threshold.value = Math.round(this.params.threshold * 100);
      this._render();
    };
    el.despeckle.oninput = () => {
      this.params.despeckle = parseInt(el.despeckle.value, 10);
      this._render();
    };
    el.ink.oninput = () => { this.params.inkColor = el.ink.value; this._render(); };
    document.getElementById('imgedit-ink-auto').onclick  = () => {
      this.params.inkColor = null; this._render();
    };
    document.getElementById('imgedit-ink-black').onclick = () => {
      this.params.inkColor = '#111111'; el.ink.value = '#111111'; this._render();
    };

    document.getElementById('imgedit-reset').onclick  = () => this._reset();
    document.getElementById('imgedit-save').onclick   = () => this._save();
    document.getElementById('imgedit-raw').onclick    = () => this._saveUnprocessed();
    document.getElementById('imgedit-cancel').onclick = () => this._next();
  }
}

function pointInQuad(p, q) {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const [xi, yi] = q[i], [xj, yj] = q[j];
    if ((yi > p.y) !== (yj > p.y) &&
        p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
