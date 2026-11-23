const C = 'sammelo-v8';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(C).then(c => Promise.allSettled(SHELL.map(u => c.add(u)))).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);

  // Páginas: red primero, y si no hay internet, la copia guardada.
  if (r.mode === 'navigate') {
    e.respondWith(fetch(r).catch(() => caches.match('./index.html')));
    return;
  }

  // Solo archivos propios (iconos, manifest). Supabase, audio y letras siempre van a la red.
  if (u.origin === location.origin && /\.(png|webmanifest|js)$/.test(u.pathname) && !u.pathname.endsWith('sw.js')) {
    e.respondWith(
      caches.match(r).then(hit => {
        const net = fetch(r).then(res => {
          if (res.ok) { const copy = res.clone(); caches.open(C).then(c => c.put(r, copy)); }
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
  }
});
