import { PROFILE_FIELDS } from './form-memory.js';

const LS_API_KEY = 'pdfsign_openrouter_key';
const LS_MODEL   = 'pdfsign_openrouter_model';

export const MODELS = [
  { id: 'google/gemini-2.0-flash-001',     label: 'Gemini 2.0 Flash (recommended)' },
  { id: 'anthropic/claude-3.5-haiku',      label: 'Claude 3.5 Haiku' },
  { id: 'openai/gpt-4o-mini',              label: 'GPT-4o mini' },
  { id: 'anthropic/claude-3.5-sonnet',     label: 'Claude 3.5 Sonnet' },
  { id: 'openai/gpt-4o',                   label: 'GPT-4o' },
  { id: 'google/gemini-2.0-pro-exp-02-05', label: 'Gemini 2.0 Pro' },
];

export function loadSettings() {
  return {
    apiKey: localStorage.getItem(LS_API_KEY) || '',
    model:  localStorage.getItem(LS_MODEL)   || MODELS[0].id,
  };
}

function saveAPISettings(apiKey, model) {
  localStorage.setItem(LS_API_KEY, apiKey);
  localStorage.setItem(LS_MODEL,   model);
}

export function initSettingsModal(formMemory, onSave) {
  const modal     = document.getElementById('settings-modal');
  const backdrop  = modal.querySelector('.modal-backdrop');
  const closeBtn  = document.getElementById('settings-close');
  const saveBtn   = document.getElementById('settings-save');
  const apiKeyEl  = document.getElementById('setting-api-key');
  const modelEl   = document.getElementById('setting-model');
  const profileEl = document.getElementById('profile-fields');

  // Populate model dropdown once
  for (const m of MODELS) {
    const opt = document.createElement('option');
    opt.value       = m.id;
    opt.textContent = m.label;
    modelEl.appendChild(opt);
  }

  async function renderProfile() {
    const saved = await formMemory.getUserProfile();
    profileEl.innerHTML = '';
    for (const field of PROFILE_FIELDS) {
      const row = document.createElement('div');
      row.className = 'profile-field-row';

      const lbl = document.createElement('label');
      lbl.htmlFor     = `pf-${field.key}`;
      lbl.textContent = field.label;

      let input;
      if (field.type === 'select') {
        input = document.createElement('select');
        for (const opt of field.options) {
          const o = document.createElement('option');
          o.value = opt; o.textContent = opt || '—';
          input.appendChild(o);
        }
        input.value = saved[field.key]?.value || '';
      } else {
        input = document.createElement('input');
        input.type        = field.type;
        input.placeholder = field.label;
        input.value       = saved[field.key]?.value || '';
      }
      input.id        = `pf-${field.key}`;
      input.className = 'profile-input';

      row.appendChild(lbl);
      row.appendChild(input);
      profileEl.appendChild(row);
    }
  }

  async function open() {
    const { apiKey, model } = loadSettings();
    apiKeyEl.value = apiKey;
    modelEl.value  = model;
    await renderProfile();
    modal.classList.remove('hidden');
  }

  async function save() {
    const apiKey = apiKeyEl.value.trim();
    const model  = modelEl.value;
    saveAPISettings(apiKey, model);

    const fields = PROFILE_FIELDS.map(f => ({
      key:   f.key,
      label: f.label,
      value: document.getElementById(`pf-${f.key}`)?.value ?? '',
    }));
    await formMemory.saveUserProfile(fields);

    modal.classList.add('hidden');
    if (onSave) onSave({ apiKey, model });
  }

  document.getElementById('btn-settings').onclick = open;
  closeBtn.onclick  = () => modal.classList.add('hidden');
  backdrop.onclick  = () => modal.classList.add('hidden');
  saveBtn.onclick   = save;
}
