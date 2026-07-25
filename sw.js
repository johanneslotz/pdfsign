// ── AUTO-GENERATED: run scripts/generate-sw-precache.js to update ──
const CACHE = 'pdfsign-e049b5fe80';
const PRECACHE = [
  './',
  './css/style.css',
  './icon.svg',
  './index.html',
  './js/ai-assistant.js',
  './js/app.js',
  './js/form-memory.js',
  './js/pdf-editor.js',
  './js/pdf-viewer.js',
  './js/settings.js',
  './js/sign/orchestrator.js',
  './js/sign/tauri-provider.js',
  './js/signature-image.js',
  './js/signature-import.js',
  './js/signature-pad.js',
  './js/storage.js',
  './js/utils.js',
  './js/vision-api.js',
  './manifest.json',
  './vendor/pdf-lib.min.js',
  './vendor/pdfjs/pdf.min.js',
  './vendor/pdfjs/pdf.worker.min.js',
];
// ── END AUTO-GENERATED ──

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Only GET requests are cacheable, and only same-origin ones are ours to
  // cache — third-party API calls (e.g. the OpenRouter POST requests the AI
  // assistant makes) pass straight through untouched. All JS/CSS/PDF.js
  // dependencies are vendored (vendor/), not loaded from a CDN.
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Network-first, bypassing the HTTP cache, so a new deploy is never
  // shadowed by a stale cached JS/CSS file; fall back to the cache offline.
  e.respondWith(
    fetch(new Request(e.request, { cache: 'reload' }))
      .then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return r;
      })
      .catch(() => caches.match(e.request))
  );
});
