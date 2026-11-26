const C = 'sammelo-v13';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './privacidad.html', './config.js', './offline.js', './artistas.js'];
// Librería de Supabase y fuente: se guardan al instalar para que la app abra sin internet desde la primera vez.
const REMOTE = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/dist/umd/supabase.min.js',
  'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;800&display=swap'
];
const CDN = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(C).then(c => Promise.allSettled([
      ...SHELL.map(u => c.add(u)),
      ...REMOTE.map(u => c.add(new Request(u, { mode: 'cors', credentials: 'omit' })))
    ])).then(() => self.skipWaiting())
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
  // Si la red no responde en 4 s (por ejemplo Wi-Fi sin internet), se abre la copia guardada en vez de quedarse esperando.
  if (r.mode === 'navigate') {
    e.respondWith((async () => {
      const saved = () => caches.match('./index.html').then(x => x || caches.match('./'));
      const has = await saved();
      const ctl = new AbortController();
      const t = has ? setTimeout(() => ctl.abort(), 4000) : null;
      try {
        const res = await fetch(r, { signal: ctl.signal });
        if (res.ok && u.origin === location.origin && /(\/|index\.html)$/.test(u.pathname)) {
          const copy = res.clone();
          caches.open(C).then(c => c.put('./index.html', copy)).catch(() => {});
        }
        return res;
      } catch (_) {
        return has || Response.error();
      } finally { if (t) clearTimeout(t); }
    })());
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
