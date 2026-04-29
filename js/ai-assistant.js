export class AIAssistant {
  constructor({ viewer, formMemory, visionApi, toast }) {
    this.viewer     = viewer;
    this.formMemory = formMemory;
    this.visionApi  = visionApi;
    this.toast      = toast;
    this.fields     = [];  // { pageNum, label, canonicalKey, type, required, suggestions, overlayEl, _panelInput }

    this._panel      = document.getElementById('ai-panel');
    this._fieldList  = document.getElementById('ai-field-list');
    this._statusEl   = document.getElementById('ai-status');
    this._footer     = document.getElementById('ai-footer');
    this._analyzeBtn = document.getElementById('ai-analyze');
    this._fillAllBtn = document.getElementById('ai-fill-all');
    this._log        = [];  // [{pageNum, prompt, response}]

    document.getElementById('ai-panel-close').onclick = () => this.hide();
    this._analyzeBtn.onclick = () => this.analyze();
    this._fillAllBtn.onclick = () => this.fillAll();
  }

  show() { this._panel.classList.remove('hidden'); }
  hide() { this._panel.classList.add('hidden'); }

  onPDFLoaded() {
    this.fields = [];
    this._log   = [];
    this._fieldList.innerHTML = '';
    this._footer.classList.add('hidden');
    this._removeConvEl();
    this._setStatus('Click Analyze to detect form fields.');
    this._analyzeBtn.disabled = false;
    this.show();
  }

  async analyze() {
    if (!this.visionApi?.apiKey) {
      this._setStatus('No API key — open Settings and enter your OpenRouter key.');
      return;
    }

    this._analyzeBtn.disabled = true;
    this.fields = [];
    this._log   = [];
    this._fieldList.innerHTML = '';
    this._footer.classList.add('hidden');
    this._removeConvEl();

    const pages = this.viewer.pages;

    for (let i = 0; i < pages.length; i++) {
      const pageNum = pages[i].num;
      this._setStatus(`Analyzing page ${i + 1} of ${pages.length}…`);
      try {
        const imageDataUrl = this.viewer.getPageImageDataUrl(pageNum);
        const { text }     = await this.viewer.getPageTextContent(pageNum);
        const userInfo     = localStorage.getItem('pdfsign_user_info') || '';
        const result       = await this.visionApi.analyzeFormPage(imageDataUrl, text, userInfo);

        this._log.push({ pageNum, imageDataUrl, prompt: result._prompt, response: result._raw });

        if (!result.isForm || !result.fields?.length) continue;

        const acroFields = this._getAcroFields(pageNum);

        for (const vf of result.fields) {
          let overlayEl = this._matchAcroField(acroFields, vf);

          if (!overlayEl && vf.inputPosition) {
            overlayEl = this.viewer.addDetectedFieldOverlay(
              pageNum, vf.label, vf.canonicalKey, vf.type,
              vf.inputPosition.top, vf.inputPosition.left,
            );
          }

          // AI-suggested value (from user info) takes top priority; history fills the rest
          const historyHints = await this.formMemory.getSuggestions(vf.canonicalKey);
          const suggestions  = [];
          if (vf.suggestedValue) {
            suggestions.push({ value: vf.suggestedValue, source: 'ai', score: 100 });
          }
          for (const h of historyHints) {
            if (!suggestions.some(s => s.value === h.value)) suggestions.push(h);
          }

          this.fields.push({
            pageNum,
            label:        vf.label,
            canonicalKey: vf.canonicalKey,
            type:         vf.type,
            required:     vf.required || false,
            suggestions,
            overlayEl,
            _panelInput:  null,
          });
        }
      } catch (err) {
        console.error(`[ai-assistant] Page ${pageNum}:`, err);
        this._log.push({ pageNum, imageDataUrl, prompt: null, response: `Error: ${err.message}` });
        this._setStatus(`Page ${pageNum} error: ${err.message}`);
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    this._renderFieldList();
    this._renderConversation();
    const n = this.fields.length;
    this._setStatus(n ? `${n} field${n !== 1 ? 's' : ''} detected.` : 'No form fields detected.');
    if (n) this._footer.classList.remove('hidden');
    this._analyzeBtn.disabled = false;
  }

  async fillAll() {
    let count = 0;
    for (const field of this.fields) {
      const value = field._panelInput?.value?.trim();
      if (value && field.overlayEl) {
        this._applyToOverlay(field, value, false);
        count++;
      }
    }
    this.toast?.(`${count} field${count !== 1 ? 's' : ''} filled`);
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  _getAcroFields(pageNum) {
    return Array.from(
      document.querySelectorAll(`.form-field-overlay[data-page-num="${pageNum}"]`)
    ).map(el => ({ el, fieldName: (el.dataset.fieldName || '').toLowerCase() }));
  }

  _matchAcroField(acroFields, vf) {
    const key = vf.canonicalKey.toLowerCase().replace(/[^a-z0-9]/g, '');
    const lbl = vf.label.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const a of acroFields) {
      const name = a.fieldName.replace(/[^a-z0-9]/g, '');
      if (name === key || name === lbl || name.includes(key) || key.includes(name)) {
        return a.el;
      }
    }
    return null;
  }

  _renderFieldList() {
    this._fieldList.innerHTML = '';
    if (!this.fields.length) return;

    // Group by page for multi-page PDFs
    const byPage = {};
    for (const f of this.fields) {
      (byPage[f.pageNum] = byPage[f.pageNum] || []).push(f);
    }

    for (const [pageNum, fields] of Object.entries(byPage)) {
      if (this.viewer.pages.length > 1) {
        const hdr = document.createElement('div');
        hdr.className   = 'ai-page-header';
        hdr.textContent = `Page ${pageNum}`;
        this._fieldList.appendChild(hdr);
      }
      for (const field of fields) {
        this._fieldList.appendChild(this._buildFieldItem(field));
      }
    }
  }

  _buildFieldItem(field) {
    const item = document.createElement('div');
    item.className = 'ai-field-item';

    // Label row
    const labelRow = document.createElement('div');
    labelRow.className = 'ai-field-label-row';

    const labelEl = document.createElement('span');
    labelEl.className   = 'ai-field-label';
    labelEl.textContent = field.label + (field.required ? ' *' : '');
    labelRow.appendChild(labelEl);

    if (field.suggestions[0]?.source === 'ai') {
      const badge = document.createElement('span');
      badge.className = 'ai-badge profile';
      badge.textContent = '★ from your info';
      labelRow.appendChild(badge);
    } else if (field.suggestions[0]?.source === 'history') {
      const badge = document.createElement('span');
      badge.className = 'ai-badge history';
      badge.textContent = `↺ used ${field.suggestions[0].score}×`;
      labelRow.appendChild(badge);
    }

    // Input row
    const inputRow = document.createElement('div');
    inputRow.className = 'ai-field-input-row';

    const input = document.createElement('input');
    input.type      = 'text';
    input.className = 'ai-field-input';

    if (field.suggestions.length) {
      // Unique datalist id to avoid collisions with multiple pages
      const dlId = `ai-dl-${field.canonicalKey}-${field.pageNum}`;
      const dl   = document.createElement('datalist');
      dl.id = dlId;
      for (const s of field.suggestions) {
        const opt = document.createElement('option');
        opt.value = s.value;
        dl.appendChild(opt);
      }
      input.setAttribute('list', dlId);
      input.value = field.suggestions[0].value;
      item.appendChild(dl);
    } else {
      input.placeholder = `Enter ${field.label.toLowerCase()}…`;
    }

    field._panelInput = input;

    const applyBtn = document.createElement('button');
    applyBtn.className   = 'btn-sm btn-secondary';
    applyBtn.textContent = 'Apply';
    applyBtn.onclick     = () => this._applyToOverlay(field, input.value.trim(), true);

    inputRow.appendChild(input);
    inputRow.appendChild(applyBtn);

    item.appendChild(labelRow);
    item.appendChild(inputRow);
    return item;
  }

  _applyToOverlay(field, value, showToast = true) {
    if (!value || !field.overlayEl) return;

    if (field.overlayEl.type === 'checkbox') {
      const v = value.toLowerCase();
      field.overlayEl.checked = v === 'yes' || v === 'true' || v === '1' || v === 'on' || v === 'x';
    } else {
      field.overlayEl.value = value;
    }

    this.formMemory.recordUsage(field.canonicalKey, field.label, value);

    // Brief highlight
    field.overlayEl.classList.add('field-applied');
    setTimeout(() => field.overlayEl?.classList.remove('field-applied'), 900);

    if (showToast) this.toast?.(`Applied: ${field.label}`);
  }

  _setStatus(msg) {
    this._statusEl.textContent = msg;
  }

  // ── Conversation log ─────────────────────────────────────────────────────────

  _removeConvEl() {
    document.getElementById('ai-conversation')?.remove();
  }

  _renderConversation() {
    this._removeConvEl();
    if (!this._log.length) return;

    const details = document.createElement('details');
    details.id        = 'ai-conversation';
    details.className = 'ai-conversation';

    const summary = document.createElement('summary');
    summary.className   = 'ai-conversation-summary';
    summary.textContent = `Conversation (${this._log.length} page${this._log.length !== 1 ? 's' : ''})`;
    details.appendChild(summary);

    for (const entry of this._log) {
      const pageLabel = this.viewer.pages.length > 1 ? `Page ${entry.pageNum}` : 'Prompt & response';

      const section = document.createElement('div');
      section.className = 'ai-conv-section';

      if (entry.imageDataUrl) {
        const thumb = document.createElement('div');
        thumb.className = 'ai-conv-thumb';
        const img = document.createElement('img');
        img.src = entry.imageDataUrl;
        img.alt = `Page ${entry.pageNum} sent to model`;
        thumb.appendChild(img);
        const cap = document.createElement('span');
        cap.textContent = `Page ${entry.pageNum} image sent to model`;
        thumb.appendChild(cap);
        section.appendChild(thumb);
      }

      if (entry.prompt) {
        section.appendChild(this._convBlock('user', pageLabel + ' — text prompt', entry.prompt));
      }
      if (entry.response) {
        const isError = entry.response.startsWith('Error:');
        let display = entry.response;
        try {
          display = JSON.stringify(JSON.parse(entry.response), null, 2);
        } catch {}
        section.appendChild(this._convBlock(isError ? 'error' : 'assistant', 'Model response', display));
      }

      details.appendChild(section);
    }

    // Insert before the field list
    this._fieldList.parentNode.insertBefore(details, this._fieldList);
  }

  _convBlock(role, label, text) {
    const wrap = document.createElement('div');
    wrap.className = `ai-conv-block ai-conv-${role}`;

    const lbl = document.createElement('div');
    lbl.className   = 'ai-conv-label';
    lbl.textContent = label;

    const pre = document.createElement('pre');
    pre.className   = 'ai-conv-pre';
    pre.textContent = text;

    wrap.appendChild(lbl);
    wrap.appendChild(pre);
    return wrap;
  }
}
