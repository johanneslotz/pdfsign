const LS_API_KEY   = 'pdfsign_openrouter_key';
const LS_MODEL     = 'pdfsign_openrouter_model';
const LS_USER_INFO = 'pdfsign_user_info';

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

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

function populateModelOptions(selectEl, models, selectedId) {
  selectEl.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value       = m.id;
    opt.textContent = m.label;
    selectEl.appendChild(opt);
  }
  if (selectedId && models.some(m => m.id === selectedId)) {
    selectEl.value = selectedId;
  }
}

function isVisionModel(model) {
  const modalities = model.architecture?.input_modalities;
  return Array.isArray(modalities) && modalities.includes('image');
}

async function fetchVisionModels(apiKey) {
  const response = await fetch(OPENROUTER_MODELS_URL, {
    headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {},
  });
  if (!response.ok) throw new Error(`OpenRouter returned ${response.status}`);
  const { data } = await response.json();
  return data
    .filter(isVisionModel)
    .map(m => ({ id: m.id, label: m.name || m.id }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function initSettingsModal(formMemory, onSave) {
  const modal         = document.getElementById('settings-modal');
  const backdrop      = modal.querySelector('.modal-backdrop');
  const closeBtn      = document.getElementById('settings-close');
  const saveBtn       = document.getElementById('settings-save');
  const apiKeyEl      = document.getElementById('setting-api-key');
  const modelEl       = document.getElementById('setting-model');
  const refreshBtn    = document.getElementById('setting-model-refresh');
  const refreshStatusEl = document.getElementById('setting-model-refresh-status');
  const userInfoEl    = document.getElementById('setting-user-info');

  let currentModels = MODELS;
  populateModelOptions(modelEl, currentModels);

  async function refreshModels() {
    refreshBtn.disabled = true;
    refreshStatusEl.textContent = 'Updating model list…';
    try {
      const models = await fetchVisionModels(apiKeyEl.value.trim());
      if (!models.length) throw new Error('no vision models returned');
      currentModels = models;
      populateModelOptions(modelEl, currentModels, modelEl.value);
      refreshStatusEl.textContent = `Updated — ${models.length} vision models available`;
    } catch (err) {
      refreshStatusEl.textContent = `Couldn't update models: ${err.message}`;
    } finally {
      refreshBtn.disabled = false;
    }
  }

  function open() {
    const { apiKey, model } = loadSettings();
    apiKeyEl.value    = apiKey;
    populateModelOptions(modelEl, currentModels, model);
    userInfoEl.value  = localStorage.getItem(LS_USER_INFO) || '';
    refreshStatusEl.textContent = '';
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
  closeBtn.onclick    = () => modal.classList.add('hidden');
  backdrop.onclick    = () => modal.classList.add('hidden');
  saveBtn.onclick     = save;
  refreshBtn.onclick  = refreshModels;
}
