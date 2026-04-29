const CACHE = 'pdfsign-v11';
const PRECACHE = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/storage.js',
  './js/signature-pad.js',
  './js/pdf-viewer.js',
  './js/pdf-editor.js',
  './js/form-memory.js',
  './js/vision-api.js',
  './js/settings.js',
  './js/ai-assistant.js',
  './manifest.json',
  './icon.svg',
];

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
  // CDN resources (pdf.js, pdf-lib): cache-first — URLs are version-pinned
  if (e.request.url.includes('cdnjs') || e.request.url.includes('unpkg')) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(r => {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
          return r;
        });
      })
    );
    return;
  }

  // Local assets: network-first, bypass HTTP cache so we never serve stale JS/CSS
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
