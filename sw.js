/* Mong La Food PWA service worker — network-first for code (never stale),
   cache-first for images. Version the CACHE name on every deploy. */
const CACHE = 'mongla-food-v157';
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  const p = url.pathname;
  const isCode = p.endsWith('.html') || p.endsWith('.js') || p.endsWith('.css') || p.endsWith('/') || p.endsWith('/mongla-food');
  if (isCode) {
    // Network-first: always fresh JS/CSS/HTML, cache fallback when offline.
    e.respondWith(
      fetch(e.request).then((r) => {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return r;
      }).catch(() => caches.match(e.request))
    );
  } else {
    // Cache-first for images/icons.
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return r;
      }))
    );
  }
});
