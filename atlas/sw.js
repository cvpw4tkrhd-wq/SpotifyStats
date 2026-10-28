// Network first, so new versions show up right away; falls back to the cache when offline.
// Your listening data is not stored here. It lives in IndexedDB.
const CACHE = 'listening-atlas-v1';
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', 'index.html', 'manifest.webmanifest'])));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return; // never touch third-party API calls
  e.respondWith(
    fetch(e.request)
      .then((r) => { if (r && r.status === 200) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return r; })
      .catch(() => caches.match(e.request))
  );
});
