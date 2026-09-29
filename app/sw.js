// My Caddie service worker: app shell works offline; data calls always go to the network.
const CACHE = 'mycaddie-v2';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'config.js', 'recommend.js', 'strategy.js', 'manifest.webmanifest', 'icon-192.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const sameOrigin = u.origin === self.location.origin;
  const cdn = /cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net/.test(u.host);
  const tiles = /arcgisonline\.com/.test(u.host);
  if (!sameOrigin && !cdn && !tiles) return; // Supabase, OSM APIs: network only
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (sameOrigin) { // network first so updates show up at once
      try { const r = await fetch(e.request); if (r.ok) cache.put(e.request, r.clone()); return r; }
      catch { return (await cache.match(e.request)) || Response.error(); }
    }
    const hit = await cache.match(e.request); if (hit) return hit; // cache first for CDN and map tiles
    const r = await fetch(e.request); if (r.ok || r.type === 'opaque') cache.put(e.request, r.clone()); return r;
  })());
});
