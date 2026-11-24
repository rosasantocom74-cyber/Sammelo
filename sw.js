const C = 'sammelo-v11';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];
const CDN = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

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
    e.respondWith(fetch(r, { cache: 'no-store' }).catch(() => caches.match('./index.html')));
    return;
  }

  // Librería de Supabase y fuentes: se guardan la primera vez para que la app abra sin internet.
  if (CDN.includes(u.hostname)) {
    e.respondWith(
      caches.open(C).then(async c => {
        const hit = await c.match(u.href);
        const net = fetch(u.href, { mode: 'cors', credentials: 'omit' })
          .then(res => { if (res.ok) c.put(u.href, res.clone()); return res; })
          .catch(() => hit);
        return hit || net;
      })
    );
    return;
  }

  // Archivos propios (iconos, manifest). Supabase, audio y letras siempre van a la red.
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
