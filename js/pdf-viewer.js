import { debugLog } from './utils.js';

export class PDFViewer {
  constructor(container) {
    this.container = container;
    this.pdfDoc = null;
    this.pages = [];
    this.placementMode = false;
    this.textMode      = false;
    this.onPlaceSignature = null;
    this._sigOverlayData  = new WeakMap();
  }

  async load(arrayBuffer) {
    this.container.innerHTML = '';
    this.pages = [];
    debugLog('PDF.js: loading document…');
    this.pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    debugLog(`PDF.js: ${this.pdfDoc.numPages} page(s) found`);
    for (let i = 1; i <= this.pdfDoc.numPages; i++) {
      try {
        await this._renderPage(i);
      } catch (err) {
        console.error(`[pdfsign] Page ${i} render failed:`, err);
        const wrapper = document.createElement('div');
        wrapper.className = 'page-wrapper page-render-error';
        wrapper.textContent = `Page ${i} failed to render: ${err.message}`;
        this.container.appendChild(wrapper);
      }
    }
  }

  async _renderPage(num) {
    debugLog(`Rendering page ${num}…`);
    const pdfPage = await this.pdfDoc.getPage(num);
    const containerWidth = Math.min(this.container.clientWidth - 32, 1000) || 800;
    const naturalVP = pdfPage.getViewport({ scale: 1 });
    const scale = containerWidth / naturalVP.width;
    const viewport = pdfPage.getViewport({ scale });
    debugLog(`Page ${num}: ${Math.round(naturalVP.width)}×${Math.round(naturalVP.height)}pt → scale ${scale.toFixed(2)} → ${Math.round(viewport.width)}×${Math.round(viewport.height)}px`);

    const wrapper = document.createElement('div');
    wrapper.className = 'page-wrapper';
    wrapper.style.width  = viewport.width  + 'px';
    wrapper.style.height = viewport.height + 'px';

    const canvas = document.createElement('canvas');
    canvas.width  = viewport.width;
    canvas.height = viewport.height;
    wrapper.appendChild(canvas);
    this.container.appendChild(wrapper);

    await pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    const info = { canvas, wrapper, num, scale, viewport, naturalVP, pdfPage };
    this.pages.push(info);

    wrapper.addEventListener('click', e => this._onPageClick(e, info));
    wrapper.addEventListener('touchend', e => {
      if (this.placementMode || this.textMode) {
        e.preventDefault();
        this._onPageClick(e.changedTouches[0], info);
      }
    }, { passive: false });

    await this._overlayFormFields(info);
  }

  async _overlayFormFields(info) {
    const { pdfPage, viewport, wrapper, num } = info;
    const annotations = await pdfPage.getAnnotations();

    for (const a of annotations) {
      if (a.subtype !== 'Widget') continue;
      const [x1, y1, x2, y2] = a.rect;

      // Convert PDF corners → viewport coords (Y flipped)
      const [sx1, sy1] = viewport.convertToViewportPoint(x1, y2);
      const [sx2, sy2] = viewport.convertToViewportPoint(x2, y1);
      const left   = Math.min(sx1, sx2);
      const top    = Math.min(sy1, sy2);
      const width  = Math.abs(sx2 - sx1);
      const height = Math.abs(sy2 - sy1);

      let el;
      if (a.fieldType === 'Tx') {
        el = a.multiLine ? document.createElement('textarea') : document.createElement('input');
        if (!a.multiLine) el.type = 'text';
        el.value = a.fieldValue || '';
      } else if (a.fieldType === 'Btn' && a.checkBox) {
        el = document.createElement('input');
        el.type = 'checkbox';
        el.checked = !!a.fieldValue && a.fieldValue !== 'Off';
      } else if (a.fieldType === 'Ch') {
        el = document.createElement('select');
        for (const opt of (a.options || [])) {
          const o = document.createElement('option');
          o.value = opt.exportValue;
          o.textContent = opt.displayValue;
          if (a.fieldValue === opt.exportValue) o.selected = true;
          el.appendChild(o);
        }
      } else {
        continue;
      }

      el.className = 'form-field-overlay';
      Object.assign(el.style, {
        position: 'absolute', left: left + 'px', top: top + 'px',
        width: width + 'px', height: height + 'px',
      });
      el.dataset.fieldName = a.fieldName;
      el.dataset.fieldType = a.fieldType;
      el.dataset.pageNum   = num;
      wrapper.appendChild(el);
    }
  }

  _onPageClick(e, info) {
    const rect   = info.canvas.getBoundingClientRect();
    const clickX = (e.clientX - rect.left) * (info.canvas.width  / rect.width);
    const clickY = (e.clientY - rect.top)  * (info.canvas.height / rect.height);
    const pdfX   = clickX / info.scale;
    const pdfY   = info.naturalVP.height - clickY / info.scale;

    if (this.placementMode && this.onPlaceSignature) {
      this.onPlaceSignature(info.num, pdfX, pdfY, info);
    } else if (this.textMode) {
      this._addFreeTextOverlay(info, pdfX, pdfY, clickX, clickY);
      this.disableTextMode();
    }
  }

  _addFreeTextOverlay(info, pdfX, pdfY, canvasX, canvasY) {
    const input = document.createElement('input');
    input.type  = 'text';
    input.className = 'free-text-overlay';
    input.placeholder = 'Type here…';
    Object.assign(input.style, {
      position: 'absolute',
      left:     canvasX + 'px',
      top:      canvasY + 'px',
    });
    input.dataset.pageNum = info.num;
    input.dataset.pdfX    = pdfX;
    input.dataset.pdfY    = pdfY;
    info.wrapper.appendChild(input);
    input.focus();

    // Make draggable via the same approach as signatures
    this._makeDraggableInput(input, info);
  }

  /**
   * A text overlay is both draggable and editable, so the gesture itself has
   * to say which one it is: a press that travels is a drag, a press that stays
   * put is a click into the text.
   *
   * Focus cannot be the test. A freshly placed overlay is focused so the user
   * can type, and the browser focuses it again on every mousedown, so keying
   * off focus leaves the overlay permanently unmovable.
   */
  _makeDraggableInput(el, info) {
    const DRAG_SLOP = 4;   // px of travel before a press counts as a drag
    let drag = null;

    el.addEventListener('pointerdown', e => {
      if (e.button) return;   // primary button (or touch/pen) only
      drag = {
        id: e.pointerId, moved: false,
        ox: e.clientX, oy: e.clientY,
        ol: parseFloat(el.style.left) || 0,
        ot: parseFloat(el.style.top)  || 0,
      };
    });

    el.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.ox, dy = e.clientY - drag.oy;
      if (!drag.moved) {
        if (Math.hypot(dx, dy) < DRAG_SLOP) return;
        drag.moved = true;
        el.blur();                          // don't select the text while dragging it
        el.setPointerCapture(e.pointerId);
      }
      this._positionOverlay(el, info, drag.ol + dx, drag.ot + dy);
    });

    const end = e => {
      if (!drag || e.pointerId !== drag.id) return;
      const moved = drag.moved;
      drag = null;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      // A drag ends with a click event; swallow it so the overlay doesn't drop
      // straight back into edit mode.
      if (moved) el.addEventListener('click', ev => {
        ev.preventDefault(); ev.stopPropagation();
      }, { once: true, capture: true });
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  /** Move an overlay to a canvas position, keeping its PDF coordinates in step. */
  _positionOverlay(el, info, left, top) {
    el.style.left = left + 'px';
    el.style.top  = top + 'px';
    el.dataset.pdfX = left / info.scale;
    el.dataset.pdfY = info.naturalVP.height - top / info.scale;
  }

  getFreeTextAnnotations() {
    return Array.from(this.container.querySelectorAll('.free-text-overlay'))
      .filter(el => el.value.trim())
      .map(el => ({
        pageNum:  parseInt(el.dataset.pageNum),
        pdfX:     parseFloat(el.dataset.pdfX),
        pdfY:     parseFloat(el.dataset.pdfY),
        text:     el.value,
        fontSize: parseInt(getComputedStyle(el).fontSize) || 14,
      }));
  }

  enableTextMode() {
    this.textMode = true;
    this.container.style.cursor = 'text';
  }

  disableTextMode() {
    this.textMode = false;
    this.container.style.cursor = '';
  }

  addSignatureOverlay(info, pdfX, pdfY, sigDataUrl, displayWidth = 150) {
    const img = new Image();
    img.src = sigDataUrl;
    img.onload = () => {
      const aspect  = img.naturalWidth / img.naturalHeight;
      const dispW   = displayWidth;
      const dispH   = Math.round(dispW / aspect);
      const canvasX = Math.round(pdfX * info.scale);
      const canvasY = Math.round((info.naturalVP.height - pdfY) * info.scale);

      const overlay = document.createElement('div');
      overlay.className = 'sig-overlay';
      Object.assign(overlay.style, {
        left: canvasX + 'px',
        top:  canvasY + 'px',
        width:  dispW + 'px',
        height: dispH + 'px',
      });

      const imgEl = document.createElement('img');
      imgEl.src = sigDataUrl;
      overlay.appendChild(imgEl);

      // Controls bar
      const ctrl = document.createElement('div');
      ctrl.className = 'sig-overlay-controls';

      const delBtn = document.createElement('button');
      delBtn.className = 'sig-overlay-btn btn-danger';
      delBtn.textContent = 'Remove';
      delBtn.onclick = () => overlay.remove();
      ctrl.appendChild(delBtn);

      overlay.appendChild(ctrl);

      // Resize handle
      const handle = document.createElement('div');
      handle.className = 'sig-resize-handle';
      overlay.appendChild(handle);

      info.wrapper.appendChild(overlay);

      this._sigOverlayData.set(overlay, { sigDataUrl, pageNum: info.num, info });
      this._makeDraggable(overlay, info);
      this._makeResizable(overlay, handle, info, aspect);
    };
  }

  _makeDraggable(el, info) {
    let ox, oy, ol, ot;

    const start = (cx, cy) => {
      ol = parseInt(el.style.left);
      ot = parseInt(el.style.top);
      ox = cx; oy = cy;
    };
    const move = (cx, cy) => {
      el.style.left = (ol + cx - ox) + 'px';
      el.style.top  = (ot + cy - oy) + 'px';
    };

    el.addEventListener('mousedown', e => {
      if (e.target.closest('button, .sig-resize-handle')) return;
      e.preventDefault();
      start(e.clientX, e.clientY);
      const mm = ev => move(ev.clientX, ev.clientY);
      const mu = () => { document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); };
      document.addEventListener('mousemove', mm);
      document.addEventListener('mouseup', mu);
    });

    el.addEventListener('touchstart', e => {
      if (e.target.closest('button, .sig-resize-handle')) return;
      e.preventDefault();
      start(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });

    el.addEventListener('touchmove', e => {
      e.preventDefault();
      move(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });
  }

  _makeResizable(el, handle, info, aspect) {
    let startX, startW;

    const start = (cx) => {
      startX = cx;
      startW = parseInt(el.style.width);
    };
    const move = (cx) => {
      const newW = Math.max(40, startW + (cx - startX));
      const newH = Math.round(newW / aspect);
      el.style.width  = newW + 'px';
      el.style.height = newH + 'px';
    };

    handle.addEventListener('mousedown', e => {
      e.stopPropagation(); e.preventDefault();
      start(e.clientX);
      const mm = ev => move(ev.clientX);
      const mu = () => { document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); };
      document.addEventListener('mousemove', mm);
      document.addEventListener('mouseup', mu);
    });

    handle.addEventListener('touchstart', e => {
      e.stopPropagation(); e.preventDefault();
      start(e.touches[0].clientX);
    }, { passive: false });

    handle.addEventListener('touchmove', e => {
      e.preventDefault();
      move(e.touches[0].clientX);
    }, { passive: false });
  }

  getSignaturePlacements() {
    return Array.from(this.container.querySelectorAll('.sig-overlay'))
      .map(overlay => {
        const data = this._sigOverlayData.get(overlay);
        if (!data) return null;
        const { info } = data;
        const left  = parseInt(overlay.style.left);
        const top   = parseInt(overlay.style.top);
        const dispW = parseInt(overlay.style.width);
        const dispH = parseInt(overlay.style.height);
        const pdfX  = left  / info.scale;
        const pdfY  = info.naturalVP.height - top / info.scale;
        const pdfW  = dispW / info.scale;
        const pdfH  = dispH / info.scale;
        return { pageNum: data.pageNum, pdfX, pdfY, pdfW, pdfH, sigDataUrl: data.sigDataUrl };
      })
      .filter(Boolean);
  }

  getFormData() {
    const result = {};
    this.container.querySelectorAll('.form-field-overlay:not(.detected-field-overlay)').forEach(el => {
      const pn = parseInt(el.dataset.pageNum);
      if (!result[pn]) result[pn] = [];
      const value = el.type === 'checkbox' ? (el.checked ? 'Yes' : 'Off') : el.value;
      result[pn].push({ fieldName: el.dataset.fieldName, fieldType: el.dataset.fieldType, value });
    });
    return result;
  }

  // AI-detected fields with no matching AcroForm widget aren't real form fields —
  // they get drawn as free text onto the page instead of written via pdf-lib's form API.
  getDetectedFieldData() {
    return Array.from(this.container.querySelectorAll('.detected-field-overlay'))
      .filter(el => el.dataset.fieldType === 'checkbox' ? el.checked : el.value.trim())
      .map(el => ({
        pageNum:  parseInt(el.dataset.pageNum),
        pdfX:     parseFloat(el.dataset.pdfX),
        pdfY:     parseFloat(el.dataset.pdfY),
        text:     el.dataset.fieldType === 'checkbox' ? 'X' : el.value,
        fontSize: parseInt(getComputedStyle(el).fontSize) || 12,
      }));
  }

  enablePlacementMode() {
    this.placementMode = true;
    this.container.style.cursor = 'crosshair';
  }

  disablePlacementMode() {
    this.placementMode = false;
    this.container.style.cursor = '';
  }

  // ── AI assistant helpers ─────────────────────────────────────────────────────

  getPageImageDataUrl(pageNum, quality = 0.85) {
    const info = this.pages.find(p => p.num === pageNum);
    return info ? info.canvas.toDataURL('image/jpeg', quality) : null;
  }

  async getPageTextContent(pageNum) {
    const info = this.pages.find(p => p.num === pageNum);
    if (!info) return { items: [], text: '' };
    const content = await info.pdfPage.getTextContent();
    const text    = content.items.map(i => i.str).join(' ');
    return { items: content.items, text };
  }

  // Places a new editable overlay at a position given as page percentages (0–100).
  addDetectedFieldOverlay(pageNum, label, canonicalKey, fieldType, topPct, leftPct) {
    const info = this.pages.find(p => p.num === pageNum);
    if (!info) return null;

    // Models sometimes return pixel coordinates instead of 0-100 percentages — normalize
    const top  = topPct  > 100 ? (topPct  / info.canvas.height) * 100 : topPct;
    const left = leftPct > 100 ? (leftPct / info.canvas.width)  * 100 : leftPct;

    const canvasX = (left / 100) * info.canvas.width;
    const canvasY = (top  / 100) * info.canvas.height;

    let el;
    if (fieldType === 'checkbox') {
      el      = document.createElement('input');
      el.type = 'checkbox';
    } else if (fieldType === 'textarea') {
      el = document.createElement('textarea');
    } else {
      el      = document.createElement('input');
      el.type = fieldType === 'date'   ? 'date'
              : fieldType === 'number' ? 'number'
              : fieldType === 'email'  ? 'email'
              : (fieldType === 'phone' || fieldType === 'tel') ? 'tel'
              : 'text';
    }

    const isCheckbox = fieldType === 'checkbox';
    const width  = isCheckbox ? 20 : Math.round(Math.min(240, info.canvas.width * 0.28));
    const height = fieldType === 'textarea' ? 56 : isCheckbox ? 20 : 24;

    el.className = 'form-field-overlay detected-field-overlay';
    el.dataset.fieldName = canonicalKey;
    el.dataset.fieldType = fieldType;
    el.dataset.pageNum   = pageNum;
    el.dataset.pdfX      = canvasX / info.scale;
    el.dataset.pdfY      = info.naturalVP.height - canvasY / info.scale;
    el.title = label;
    if (!isCheckbox) el.placeholder = label;

    Object.assign(el.style, {
      position: 'absolute',
      left:     canvasX + 'px',
      top:      canvasY + 'px',
      width:    width  + 'px',
      height:   height + 'px',
    });

    info.wrapper.appendChild(el);
    return el;
  }
}
