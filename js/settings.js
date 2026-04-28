const LS_API_KEY   = 'pdfsign_openrouter_key';
const LS_MODEL     = 'pdfsign_openrouter_model';
const LS_USER_INFO = 'pdfsign_user_info';

export const MODELS = [
  { id: 'google/gemini-2.5-pro',           label: 'Gemini 2.5 Pro ★ best vision' },
  { id: 'google/gemini-2.0-flash-001',     label: 'Gemini 2.0 Flash (recommended)' },
  { id: 'anthropic/claude-opus-4-5',       label: 'Claude Opus 4.5' },
  { id: 'anthropic/claude-sonnet-4-5',     label: 'Claude Sonnet 4.5' },
  { id: 'anthropic/claude-3.5-haiku',      label: 'Claude 3.5 Haiku' },
  { id: 'openai/gpt-4o',                   label: 'GPT-4o' },
  { id: 'openai/gpt-4o-mini',              label: 'GPT-4o mini' },
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
  const modal       = document.getElementById('settings-modal');
  const backdrop    = modal.querySelector('.modal-backdrop');
  const closeBtn    = document.getElementById('settings-close');
  const saveBtn     = document.getElementById('settings-save');
  const apiKeyEl    = document.getElementById('setting-api-key');
  const modelEl     = document.getElementById('setting-model');
  const userInfoEl  = document.getElementById('setting-user-info');

  // Populate model dropdown once
  for (const m of MODELS) {
    const opt = document.createElement('option');
    opt.value       = m.id;
    opt.textContent = m.label;
    modelEl.appendChild(opt);
  }

  function open() {
    const { apiKey, model } = loadSettings();
    apiKeyEl.value    = apiKey;
    modelEl.value     = model;
    userInfoEl.value  = localStorage.getItem(LS_USER_INFO) || '';
    modal.classList.remove('hidden');
    userInfoEl.focus();
  }

  function save() {
    saveAPISettings(apiKeyEl.value.trim(), modelEl.value);
    localStorage.setItem(LS_USER_INFO, userInfoEl.value);
    modal.classList.add('hidden');
    if (onSave) onSave({ apiKey: apiKeyEl.value.trim(), model: modelEl.value });
  }

  document.getElementById('btn-settings').onclick = open;
  closeBtn.onclick  = () => modal.classList.add('hidden');
  backdrop.onclick  = () => modal.classList.add('hidden');
  saveBtn.onclick   = save;
}
