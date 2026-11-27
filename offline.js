/* Sammelo · MODO SIN CONEXIÓN (descargas)
   ------------------------------------------------------------------
   Este archivo es lo ÚNICO que agrega la función offline. No reemplaza código de la app:
   se «engancha» a sus funciones al arrancar (ver install() al final) y, si este archivo
   falla o se borra, Sammelo funciona exactamente como antes.

   Qué hace:
   1. Botón «Descargar» (menú ⋯ de cada canción, pantalla de reproducción y pestaña Descargas).
   2. Guarda el audio dentro del almacenamiento privado de la app (IndexedDB). No aparece en la
      galería ni en «Descargas» del teléfono, y la app lo lee desde ahí.
   3. Si una canción está descargada, SIEMPRE se reproduce desde el teléfono (no gasta datos).
   4. Si abres la app sin internet, entra en «modo sin conexión» con tu música descargada.
   5. Pestaña «Descargas»: descargar favoritas / toda la biblioteca / una lista, ver espacio, borrar. */
(function () {
  'use strict';

  var DBN = 'sammelo-offline';          // base de datos PROPIA (no toca la 'sammelo' de la app)
  var OFF = { mode: false, have: new Map(), rows: new Map(), uid: null, supported: !!(window.indexedDB && window.fetch && window.Blob) };
  window.SammeloOffline = OFF;

  var DL = { q: [], cur: null, total: 0, done: 0, failed: [], paused: false, hold: null, ctl: null, why: '', running: false, lastUi: 0, strikes: 0 };
  OFF.dl = DL;
  var sid = function (x) { return String(x); };
  var $q = function (s) { return document.querySelector(s); };
  var $$q = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
  var esc2 = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  /* ---------- tamaños ---------- */
  function fmtSize(b) {
    b = +b || 0;
    var n = function (v, d) { return v.toLocaleString('es', { maximumFractionDigits: d }); };
    if (b >= 1073741824) return n(b / 1073741824, 2) + ' GB';
    if (b >= 1048576) return n(b / 1048576, 1) + ' MB';
    return n(Math.max(1, b / 1024), 0) + ' KB';
  }

  /* ---------- IndexedDB ---------- */
  var dbP = null;
  function idb() {
    if (dbP) return dbP;
    dbP = new Promise(function (res) {
      try {
        var r = indexedDB.open(DBN, 1);
        r.onupgradeneeded = function () {
          var d = r.result;
          var s = d.createObjectStore('songs', { keyPath: 'k' }); s.createIndex('uid', 'uid');
          d.createObjectStore('audio', { keyPath: 'k' });
          var t = d.createObjectStore('thumbs', { keyPath: 'k' }); t.createIndex('uid', 'uid');
          d.createObjectStore('meta', { keyPath: 'k' });
        };
        r.onsuccess = function () { res(r.result); };
        r.onerror = r.onblocked = function () { res(null); };
      } catch (e) { res(null); }
    });
    return dbP;
  }
  function reqP(r) { return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }
  async function store(name, mode) { var d = await idb(); if (!d) throw new Error('nodb'); return d.transaction(name, mode || 'readonly').objectStore(name); }
  async function metaGet(k) { try { var r = await reqP((await store('meta')).get(k)); return r ? r.v : null; } catch (e) { return null; } }
  async function metaSet(k, v) { try { await reqP((await store('meta', 'readwrite')).put({ k: k, v: v })); } catch (e) { /* sin espacio o sin IDB: se ignora */ } }

  async function loadHave(uid) {
    if (OFF.uid !== uid) { OFF.have = new Map(); OFF.rows = new Map(); OFF.uid = uid; }
    if (!uid) return;
    try {
      var all = await reqP((await store('songs')).index('uid').getAll(uid));
      var h = new Map(), r = new Map();
      all.forEach(function (x) { h.set(x.id, { size: x.size, at: x.at }); r.set(x.id, x.row); });
      OFF.have = h; OFF.rows = r;
    } catch (e) { /* sin IDB: no hay descargas */ }
  }

  /* ---------- reproducción local: blob: URL ---------- */
  var urls = new Map();       // id -> blob:URL (los más recientes al final)
  function inUse(u) {
    try { return [A1, A2, warm].some(function (a) { return a && a.src === u; }); } catch (e) { return false; }
  }
  function trimUrls() {
    if (urls.size <= 8) return;
    for (var kv of urls) {
      if (urls.size <= 8) break;
      if (!inUse(kv[1])) { try { URL.revokeObjectURL(kv[1]); } catch (e) { } urls.delete(kv[0]); }
    }
  }
  async function localUrl(id) {
    id = sid(id);
    if (!OFF.have.has(id)) return null;
    if (urls.has(id)) { var u0 = urls.get(id); urls.delete(id); urls.set(id, u0); return u0; }
    try {
      var rec = await reqP((await store('audio')).get(OFF.uid + ':' + id));
      if (!rec || !rec.blob || !rec.blob.size) return null;
      var u = URL.createObjectURL(rec.blob);
      urls.set(id, u); trimUrls();
      return u;
    } catch (e) { return null; }
  }

  /* ---------- guardar / borrar ---------- */
  async function putSong(uid, s, blob, thumb) {
    var d = await idb(); if (!d) throw new Error('nodb');
    return new Promise(function (res, rej) {
      var t = d.transaction(['songs', 'audio', 'thumbs'], 'readwrite'), k = uid + ':' + sid(s.id);
      var row = JSON.parse(JSON.stringify(s)), at = Date.now();
      t.objectStore('audio').put({ k: k, blob: blob });
      if (thumb) t.objectStore('thumbs').put({ k: k, uid: uid, blob: thumb }); else t.objectStore('thumbs').delete(k);
      t.objectStore('songs').put({ k: k, uid: uid, id: sid(s.id), row: row, size: blob.size, at: at });
      t.oncomplete = function () { res({ size: blob.size, at: at, row: row }); };
      t.onerror = function () { rej(t.error); };
      t.onabort = function () { rej(t.error || new Error('abort')); };
    });
  }
  async function removeSongs(ids) {
    ids = ids.map(sid).filter(function (i) { return OFF.have.has(i); });
    if (!ids.length) return;
    var d = await idb(); if (!d) return;
    await new Promise(function (res) {
      var t = d.transaction(['songs', 'audio', 'thumbs'], 'readwrite');
      ids.forEach(function (id) { var k = OFF.uid + ':' + id; t.objectStore('songs').delete(k); t.objectStore('audio').delete(k); t.objectStore('thumbs').delete(k); });
      t.oncomplete = t.onerror = t.onabort = function () { res(); };
    });
    ids.forEach(function (id) {
      OFF.have.delete(id); OFF.rows.delete(id);
      var u = urls.get(id); if (u && !inUse(u)) { try { URL.revokeObjectURL(u); } catch (e) { } } urls.delete(id);
    });
    if (OFF.mode) {
      songs = songs.filter(function (s) { return !OFF.have.size ? false : OFF.have.has(sid(s.id)); });
      OFF.offSongs = songs;
    }
    ui(true);
    if (OFF.mode && (view === 'lib' || view === 'home' || view === 'fav')) render();
  }
  async function purgeUser(uid) {
    if (!uid) return;
    await loadHave(uid);
    await removeSongs(Array.from(OFF.have.keys()));
    await metaSet('last', null);
  }

  /* ---------- sesión guardada (la que deja Supabase en el teléfono) ---------- */
  function storedSession() {
    try {
      var ref = '';
      try { ref = new URL(cfg.url).hostname.split('.')[0]; } catch (e) { }
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (/^sb-.+-auth-token$/.test(k)) keys.push(k); }
      keys.sort(function (a) { return ref && a === 'sb-' + ref + '-auth-token' ? -1 : 1; });
      for (var j = 0; j < keys.length; j++) {
        var v = JSON.parse(localStorage.getItem(keys[j]) || 'null');
        var u = v && (v.user || (v.currentSession && v.currentSession.user));
        if (u && u.id) return { uid: u.id };
      }
    } catch (e) { }
    return null;
  }

  /* ---------- instantánea de la cuenta (para poder abrir sin internet) ---------- */
  async function saveSnap() {
    if (!me || !me.id || OFF.mode) return;
    try {
      await metaSet('last', {
        uid: me.id,
        user: { id: me.id, email: me.email, created_at: me.created_at, user_metadata: me.user_metadata || {} },
        prof: JSON.parse(JSON.stringify(prof || {})),
        favs: Array.from(favs || []),
        at: Date.now()
      });
    } catch (e) { }
  }

  /* ---------- MODO SIN CONEXIÓN ---------- */
  async function bootOffline() {
    if (OFF.mode || OFF.booting) return OFF.mode;
    OFF.booting = true;
    try {
      var snap = await metaGet('last'), st = storedSession();
      if (!snap || !st || snap.uid !== st.uid) return false;
      await loadHave(snap.uid);
      if (!OFF.have.size) return false;
      var th = new Map();
      try {
        (await reqP((await store('thumbs')).index('uid').getAll(snap.uid))).forEach(function (x) {
          if (x.blob) th.set(x.k.slice(snap.uid.length + 1), URL.createObjectURL(x.blob));
        });
      } catch (e) { }
      var list = Array.from(OFF.rows.entries()).map(function (kv) {
        var o = Object.assign({}, kv[1]); o.thumbnail_url = th.get(kv[0]) || null; return o;
      }).sort(function (a, b) { return String(b.created_at || '').localeCompare(String(a.created_at || '')); });
      OFF.mode = true; OFF.offSongs = list;
      me = snap.user; loadedFor = me.id;
      prof = Object.assign({}, snap.prof, { role: 'user' });   // sin panel Admin sin conexión
      songs = list; favs = new Set((snap.favs || []).filter(function (id) { return OFF.have.has(sid(id)); })); lists = []; artImgs = null;
      try { recent = JSON.parse(localStorage.getItem('rc:' + me.id) || '[]'); } catch (e) { recent = []; }
      meta = me.user_metadata || {}; if (meta.accent) { prefs.accent = meta.accent; applyPrefs(); }
      loadStats();
      view = 'off'; coll = null; curList = null;
      shell(); render(); if (qi < 0) restorePb();
      ui(true);
      return true;
    } catch (e) { OFF.mode = false; return false; }
    finally { OFF.booting = false; }
  }

  /* ---------- descargas ---------- */
  var MIMES = { mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', webm: 'audio/webm', opus: 'audio/ogg', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac' };
  function mimeFor(s, headerType) {
    var h = String(headerType || '').split(';')[0].trim().toLowerCase();
    if (/^audio\//.test(h) || h === 'video/mp4' || h === 'video/webm') return h;
    var m = /\.([a-z0-9]+)(?:\?|$)/i.exec(String(s.storage_path || ''));
    return (m && MIMES[m[1].toLowerCase()]) || 'audio/mpeg';
  }
  function findSong(id) { id = sid(id); return songs.find(function (x) { return sid(x.id) === id; }) || null; }
  function estBytes(s) {
    var tot = 0, dur = 0;
    OFF.have.forEach(function (v, id) { var r = OFF.rows.get(id); if (r && r.duration_seconds) { tot += v.size; dur += r.duration_seconds; } });
    var bps = dur > 120 ? tot / dur : 20000;
    return (s.duration_seconds || 240) * bps;
  }
  function holdReason() {
    if (navigator.onLine === false) return 'offline';
    var c = navigator.connection;
    if (prefWifi() && c && c.type === 'cellular') return 'wifi';
    return null;
  }
  var prefWifi = function () { try { return localStorage.getItem('off:wifi') === '1'; } catch (e) { return false; } };

  async function persistAsk() {
    try { if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch (e) { }
  }

  function enqueue(ids, quiet) {
    if (OFF.mode) { toast('Conéctate a internet para descargar música.'); return 0; }
    if (!OFF.supported) { toast('Este navegador no permite guardar música sin conexión.'); return 0; }
    var n = 0;
    ids.forEach(function (raw) {
      var id = sid(raw);
      if (OFF.have.has(id) || DL.q.indexOf(id) >= 0 || (DL.cur && DL.cur.id === id) || !findSong(id)) return;
      DL.q.push(id); n++;
    });
    if (!n) { if (!quiet) toast('Esa música ya está descargada.'); return 0; }
    DL.total += n; DL.failed = []; DL.paused = false; DL.strikes = 0;
    persistAsk();
    toast(n === 1 ? 'Descargando 1 canción…' : 'Descargando ' + n + ' canciones…');
    ui(true); kick();
    return n;
  }
  function dequeue(id) {
    id = sid(id);
    var i = DL.q.indexOf(id);
    if (i >= 0) { DL.q.splice(i, 1); DL.total = Math.max(0, DL.total - 1); }
    else if (DL.cur && DL.cur.id === id) { DL.why = 'skip'; if (DL.ctl) DL.ctl.abort(); }
    ui(true);
  }

  async function kick() {
    if (DL.running) return;
    DL.running = true;
    try {
      while (DL.q.length && !DL.paused) {
        var why = holdReason();
        if (why) { DL.hold = why; break; }
        DL.hold = null;
        var id = DL.q.shift(), r = await downloadOne(id);
        if (r === 'ok') { DL.done++; DL.strikes = 0; }
        else if (r === 'fail') { DL.failed.push(id); if (++DL.strikes >= 3) { DL.hold = 'net'; DL.paused = true; break; } }
        else if (r === 'quota') { DL.hold = 'quota'; DL.paused = true; break; }
        else if (r === 'pause') { DL.q.unshift(id); if (!DL.paused) DL.hold = holdReason() || 'net'; break; }
        else if (r === 'cancel') { DL.why = ''; break; }
        else if (r === 'skip') { DL.why = ''; DL.total = Math.max(0, DL.total - 1); }
        ui(true);
      }
    } finally {
      DL.running = false; DL.cur = null; DL.ctl = null;
      if (!DL.q.length && !DL.paused && !DL.hold) finishBatch();
      ui(true);
    }
  }
  function finishBatch() {
    var ok = DL.done, bad = DL.failed.length;
    if (ok || bad) {
      if (bad) toast(ok + ' descargadas, ' + bad + ' con error. Puedes reintentar.');
      else toast(ok === 1 ? 'Descarga lista: 1 canción.' : 'Descarga lista: ' + ok + ' canciones.');
    }
    DL.total = 0; DL.done = 0;
  }

  function verifyPlayable(blob) {
    return new Promise(function (res) {
      var a = new Audio(), u = URL.createObjectURL(blob), fin = false, t;
      var end = function (ok) { if (fin) return; fin = true; clearTimeout(t); try { a.removeAttribute('src'); a.load(); } catch (e) { } try { URL.revokeObjectURL(u); } catch (e) { } res(ok); };
      a.preload = 'metadata'; a.onloadedmetadata = function () { end(true); }; a.onerror = function () { end(false); };
      t = setTimeout(function () { end(true); }, 2500);   // algunos navegadores no cargan metadatos sin tocar play: no es error
      a.src = u;
    });
  }
  async function fetchThumb(url) {
    if (!url || /^blob:|^data:/.test(url)) return null;
    var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, 8000);
    try {
      var r = await fetch(url, { mode: 'cors', signal: ctl.signal });
      if (!r.ok) return null;
      var b = await r.blob();
      return (b.size && b.size < 3e6 && /^image\//.test(b.type)) ? b : null;
    } catch (e) { return null; } finally { clearTimeout(t); }
  }

  async function downloadOne(id) {
    var s = findSong(id);
    if (!s) return 'fail';
    var uid = OFF.uid || (me && me.id);
    DL.cur = { id: id, title: s.title, got: 0, total: 0 };
    ui(true);
    for (var attempt = 0; attempt < 3; attempt++) {
      if (DL.why === 'cancel') return 'cancel';
      if (DL.why === 'skip') return 'skip';
      if (DL.paused) return 'pause';
      if (DL.why === 'stall') DL.why = '';
      var ctl = new AbortController(), stall = null;
      DL.ctl = ctl;
      try {
        var url = await _signed(s);
        var res = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
        if (!res.ok) { if (res.status === 400 || res.status === 403) delete urlCache[s.id]; var he = new Error('http ' + res.status); if (res.status === 404) he.fatal = true; throw he; }
        var total = +res.headers.get('content-length') || 0, enc = res.headers.get('content-encoding');
        DL.cur.total = total;
        var last = Date.now();
        stall = setInterval(function () { if (Date.now() - last > 20000) { DL.why = 'stall'; ctl.abort(); } }, 4000);
        var blob;
        if (res.body && res.body.getReader) {
          var rd = res.body.getReader(), parts = [], got = 0;
          for (;;) {
            var x = await rd.read(); if (x.done) break;
            parts.push(x.value); got += x.value.length; last = Date.now(); DL.cur.got = got; ui();
          }
          blob = new Blob(parts, { type: mimeFor(s, res.headers.get('content-type')) });
        } else {
          var b0 = await res.blob(); blob = new Blob([b0], { type: mimeFor(s, res.headers.get('content-type')) });
        }
        clearInterval(stall); stall = null;
        if (!blob.size) throw new Error('vacío');
        if (total && !enc && blob.size !== total) throw new Error('incompleto');
        if (!(await verifyPlayable(blob))) throw new Error('no reproducible');
        var thumb = await fetchThumb(s.thumbnail_url);
        var saved = await putSong(uid, s, blob, thumb);
        OFF.have.set(sid(s.id), { size: saved.size, at: saved.at }); OFF.rows.set(sid(s.id), saved.row);
        delete urlCache[s.id];                 // que la próxima vez salga del teléfono y no de internet
        saveSnap();
        ui(true);
        return 'ok';
      } catch (e) {
        if (stall) clearInterval(stall);
        var nm = e && e.name;
        if (nm === 'QuotaExceededError' || (e && /quota/i.test(String(e.message || '')))) { toast('No hay espacio suficiente en el teléfono.'); return 'quota'; }
        if (nm === 'AbortError' && DL.why !== 'stall') {
          if (DL.why === 'skip') return 'skip';
          if (DL.why === 'cancel') return 'cancel';
          return 'pause';                       // pausa del usuario
        }
        if (e && e.fatal) return 'fail';          // el archivo no existe: reintentar no sirve
        if (navigator.onLine === false) return 'pause';
        if (attempt < 2) await new Promise(function (r) { setTimeout(r, 1200 * (attempt + 1)); });
      }
    }
    return 'fail';
  }

  function pauseAll() { DL.paused = true; DL.why = 'pause'; if (DL.ctl) DL.ctl.abort(); ui(true); }
  function resumeAll() { DL.paused = false; DL.why = ''; DL.hold = null; DL.strikes = 0; if (!DL.q.length && DL.failed.length) { var f = DL.failed.slice(); DL.failed = []; enqueue(f, true); } else kick(); ui(true); }
  function cancelAll() {
    DL.q = []; DL.paused = false; DL.hold = null; DL.total = 0; DL.done = 0; DL.failed = [];
    if (DL.cur) { DL.why = 'cancel'; if (DL.ctl) DL.ctl.abort(); }
    ui(true);
  }

  /* ---------- enganche con la app ---------- */
  var _signed;
  var CSS = '#offbar{position:sticky;top:0;z-index:2;display:none;align-items:center;gap:10px;flex-wrap:wrap;padding:calc(8px + var(--sat,0px)) 16px 8px;background:var(--p2);color:var(--t);font-size:13px;font-weight:600}' +
    '#offbar.on{display:flex}#offbar .lbl{flex:1;min-width:160px}#offbar button{padding:6px 14px;border-radius:999px;background:var(--g);color:#14102a;font-weight:800;font-size:12px}#offbar button.g{background:none;color:var(--t);border:1px solid var(--line,#555)}' +
    '#offbar .pb{flex-basis:100%;height:3px;background:var(--bar,#444);border-radius:3px;overflow:hidden}#offbar .pb i{display:block;height:100%;background:var(--g);width:0;transition:width .2s}' +
    '.off-dl .t b::after{content:"";display:inline-block;width:13px;height:13px;margin-left:7px;vertical-align:-2px;background:var(--gt,var(--g));-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\'%3E%3Cpath fill-rule=\'evenodd\' d=\'M12 2a10 10 0 100 20 10 10 0 000-20zm1 5v5.200l2.100-2.100 1.400 1.400L12 16l-4.500-4.500 1.400-1.400 2.100 2.100V7z\'/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\'%3E%3Cpath fill-rule=\'evenodd\' d=\'M12 2a10 10 0 100 20 10 10 0 000-20zm1 5v5.200l2.100-2.100 1.400 1.400L12 16l-4.500-4.500 1.400-1.400 2.100 2.100V7z\'/%3E%3C/svg%3E") center/contain no-repeat}' +
    'body.nonet .songs li:not(.off-dl){opacity:.38}' +
    '.od-card{background:var(--p);border-radius:14px;padding:16px 18px;display:grid;gap:10px}.od-card h4{font-size:15px}.od-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}' +
    '.od-row .btn,.od-row select{flex:0 1 auto;padding:10px 18px;font-size:14px}.od-row select{background:var(--fld);color:var(--t);border:0;border-radius:999px;font:inherit;max-width:100%}' +
    '.od-dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#3ecf8e;margin-right:8px}.od-dot.x{background:#ff7d8a}' +
    '.od-meter{height:6px;border-radius:6px;background:var(--bar,#444);overflow:hidden}.od-meter i{display:block;height:100%;background:var(--g);width:0}' +
    '#od-top,#od-prog{padding:0 24px 12px;max-width:640px}@media(max-width:800px){#od-top,#od-prog{padding:0 16px 12px}}';

  function paintBar() {
    var b = $q('#offbar'); if (!b) return;
    var on = false, h = '';
    var onl = navigator.onLine !== false;
    if ((DL.cur || DL.q.length) && !DL.paused && !DL.hold) {
      var n = DL.done + (DL.cur ? 1 : 0), p = DL.cur && DL.cur.total ? Math.min(100, DL.cur.got / DL.cur.total * 100) : 0;
      h = '<span class="lbl">Descargando ' + n + ' de ' + Math.max(DL.total, n) + (DL.cur ? ' · ' + esc2(DL.cur.title) : '') + '</span><button data-oa="pause">Pausar</button><span class="pb"><i style="width:' + p.toFixed(0) + '%"></i></span>';
      on = true;
    } else if (DL.hold || DL.paused) {
      var msg = DL.hold === 'offline' ? 'Descarga en pausa: sin conexión. Se reanuda sola.' : DL.hold === 'wifi' ? 'Descarga en pausa: esperando Wi‑Fi.' : DL.hold === 'quota' ? 'No hay espacio suficiente para seguir descargando.' : DL.hold === 'net' ? 'No se pudo descargar. Revisa tu conexión.' : 'Descarga en pausa.';
      h = '<span class="lbl">' + msg + '</span>' + (DL.hold === 'quota' ? '<button data-oa="cancel">Cancelar</button>' : '<button data-oa="resume">Reanudar</button><button class="g" data-oa="cancel">Cancelar</button>');
      on = true;
    } else if (DL.failed.length && onl) {
      h = '<span class="lbl">' + DL.failed.length + (DL.failed.length === 1 ? ' canción no se pudo descargar.' : ' canciones no se pudieron descargar.') + '</span><button data-oa="resume">Reintentar</button><button class="g" data-oa="cancel">Descartar</button>';
      on = true;
    } else if (OFF.mode) {
      h = '<span class="lbl">Modo sin conexión · escuchando tus descargas</span>' + (onl ? '<button data-oa="reload">Reintentar conexión</button>' : '');
      on = true;
    } else if (!onl) {
      h = '<span class="lbl">Sin conexión · solo suenan las canciones descargadas</span>' + (view === 'off' ? '' : '<button data-oa="open">Ver descargas</button>');
      on = true;
    }
    if (b.dataset.h !== h) { b.innerHTML = h; b.dataset.h = h; }
    b.classList.toggle('on', on);
  }
  function paintTop() {
    var t = $q('#od-top'); if (!t) return;
    var size = 0; OFF.have.forEach(function (v) { size += v.size; });
    var onl = navigator.onLine !== false, n = OFF.have.size;
    var stand = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone;
    var h = '<div class="od-card"><div><span class="od-dot' + (onl && !OFF.mode ? '' : ' x') + '"></span><b>' + (OFF.mode ? 'Modo sin conexión' : onl ? 'Conectado' : 'Sin conexión') + '</b></div>' +
      '<div>' + (n ? n + (n === 1 ? ' canción descargada' : ' canciones descargadas') + ' · ' + fmtSize(size) : 'Todavía no has descargado música.') + '</div>' +
      '<div class="od-meter" id="od-sp" hidden><i></i></div><div class="hint" id="od-spt"></div>' +
      (!stand && n ? '<div class="hint">Consejo: instala Sammelo en tu pantalla de inicio para que el teléfono no borre tus descargas.</div>' : '') + '</div>';
    if (!OFF.mode) {
      var nf = songs.filter(function (s) { return favs.has(s.id) && !OFF.have.has(sid(s.id)); }).length;
      var na = songs.filter(function (s) { return !OFF.have.has(sid(s.id)); }).length;
      var c = navigator.connection, canWifi = c && 'type' in c;
      h += '<div class="od-card" style="margin-top:12px"><h4>Descargar para escuchar sin internet</h4><div class="od-row">' +
        '<button class="btn" data-oa="fav"' + (nf ? '' : ' disabled') + '>Mis favoritas' + (nf ? ' (' + nf + ')' : '') + '</button>' +
        '<button class="btn ghost" data-oa="all"' + (na ? '' : ' disabled') + '>Toda la biblioteca' + (na ? ' (' + na + ')' : '') + '</button></div>' +
        (lists.length ? '<div class="od-row"><select id="od-sel" aria-label="Lista">' + lists.map(function (l) { return '<option value="' + esc2(l.id) + '">' + esc2(l.name) + '</option>'; }).join('') + '</select><button class="btn ghost" data-oa="list">Descargar lista</button></div>' : '') +
        (canWifi ? '<label class="sw" style="display:flex;gap:12px;align-items:center;justify-content:space-between;font-weight:600"><span>Descargar solo con Wi‑Fi<br><small class="hint">Evita gastar tus datos móviles.</small></span><input type="checkbox" id="od-wifi" ' + (prefWifi() ? 'checked' : '') + '></label>' : '') +
        '<div class="hint">Mantén la app abierta mientras descarga. La música queda guardada dentro de Sammelo, no en tu galería.</div></div>';
    } else {
      h += '<div class="od-card" style="margin-top:12px"><div class="hint">Para descargar más música necesitas internet.</div></div>';
    }
    t.innerHTML = h;
    paintSpace();
  }
  async function paintSpace() {
    try {
      if (!navigator.storage || !navigator.storage.estimate) return;
      var e = await navigator.storage.estimate(), m = $q('#od-sp'), t = $q('#od-spt');
      if (!m || !t || !e.quota) return;
      m.hidden = false; m.firstElementChild.style.width = Math.min(100, e.usage / e.quota * 100).toFixed(1) + '%';
      t.textContent = 'Espacio usado por Sammelo: ' + fmtSize(e.usage) + ' de ' + fmtSize(e.quota) + ' disponibles.';
    } catch (e) { }
  }
  function paintProg() {
    var p = $q('#od-prog'); if (!p) return;
    if (!(DL.cur || DL.q.length)) { if (p.innerHTML) p.innerHTML = ''; return; }
    var held = DL.paused || DL.hold;
    var n = DL.done + (DL.cur ? 1 : 0), pc = DL.cur && DL.cur.total ? Math.min(100, DL.cur.got / DL.cur.total * 100) : 0;
    p.innerHTML = '<div class="od-card"><div><b>Descargando ' + n + ' de ' + Math.max(DL.total, n) + '</b></div>' +
      (DL.cur ? '<div class="hint">' + esc2(DL.cur.title) + (DL.cur.total ? ' · ' + fmtSize(DL.cur.got) + ' de ' + fmtSize(DL.cur.total) : '') + '</div>' : '') +
      '<div class="od-meter"><i style="width:' + pc.toFixed(0) + '%"></i></div>' +
      '<div class="od-row">' + (held ? '<button class="btn" data-oa="resume">Reanudar</button>' : '<button class="btn ghost" data-oa="pause">Pausar</button>') + '<button class="btn ghost" data-oa="cancel">Cancelar</button></div></div>';
  }
  function dlList() {
    return Array.from(OFF.have.entries()).sort(function (a, b) { return b[1].at - a[1].at; })
      .map(function (kv) { return findSong(kv[0]) || (function () { var r = OFF.rows.get(kv[0]); return r ? Object.assign({}, r) : null; })(); }).filter(Boolean);
  }
  function paintList() {
    var l = $q('#od-list'); if (!l) return;
    var list = dlList();
    l.innerHTML = list.length
      ? playBar(list) + rows(list) + '<div class="pad" style="margin-top:6px"><button class="btn ghost" data-oa="wipe">Borrar todas las descargas</button></div>'
      : '<p class="mut mt">Aquí aparecerá tu música descargada. Toca «⋯» en una canción y elige «Descargar», o usa los botones de arriba.</p>';
    markRows(); upd();
  }
  function renderOff() {
    try { admStop(); } catch (e) { }
    $$q('nav button').forEach(function (b) { b.setAttribute('aria-current', b.dataset.v === 'off' ? 'page' : 'false'); });
    $q('#view').innerHTML = '<div class="hd"><h2>Descargas</h2><p class="mut" style="margin:-6px 0 4px">Tu música guardada en el teléfono para escucharla sin internet.</p></div><div id="od-top"></div><div id="od-prog"></div><div id="od-list"></div>';
    paintTop(); paintProg(); paintList(); upd(); syncUrl(); adsApply(); paintBar();
  }
  function renderNeedsNet(titulo) {
    try { admStop(); } catch (e) { }
    $$q('nav button').forEach(function (b) { b.setAttribute('aria-current', b.dataset.v === view ? 'page' : 'false'); });
    $q('#view').innerHTML = '<div class="hd"><h2>' + titulo + '</h2></div><p class="mut mt">Esto necesita internet. Mientras tanto puedes escuchar tus descargas.</p><div class="pad"><button class="btn" data-oa="open">Ver mis descargas</button></div>';
    upd(); syncUrl(); adsApply(); paintBar();
  }
  function markRows() {
    $$q('#main li[data-id]').forEach(function (li) { li.classList.toggle('off-dl', OFF.have.has(li.dataset.id)); });
  }
  function chip() {
    var c = $q('#tdl'); if (!c) return;
    var s = (typeof queue !== 'undefined' && qi >= 0) ? queue[qi] : null; if (!s) { c.hidden = true; return; }
    c.hidden = false;
    var id = sid(s.id), t = c.querySelector('span');
    var txt = OFF.have.has(id) ? 'Descargada' : (DL.cur && DL.cur.id === id) ? 'Descargando…' : DL.q.indexOf(id) >= 0 ? 'En cola' : 'Descargar';
    if (t.textContent !== txt) t.textContent = txt;
    c.setAttribute('aria-pressed', String(OFF.have.has(id)));
  }
  var rafM = 0;
  function ui(full) {
    var now = Date.now();
    if (!full && now - DL.lastUi < 250) return;
    DL.lastUi = now;
    document.body.classList.toggle('nonet', navigator.onLine === false || OFF.mode);
    paintBar(); chip();
    if (typeof view !== 'undefined' && view === 'off' && !coll && $q('#od-top')) {
      paintProg();
      if (full) { paintTop(); paintList(); }
    }
    if (!rafM) rafM = requestAnimationFrame(function () { rafM = 0; markRows(); });
  }

  window.__ask = window.__ask || function (x) { return typeof askSheet === 'function' ? askSheet(x) : Promise.resolve(confirm(x.title + (x.text ? '\n' + x.text : ''))); };
  async function toggleCurrent() {
    var s = queue[qi]; if (!s) return;
    var id = sid(s.id);
    if (OFF.have.has(id)) { if (await window.__ask({ title: '¿Quitar «' + s.title + '» de tus descargas?', ok: 'Quitar', danger: true })) removeSongs([id]); }
    else if (DL.q.indexOf(id) >= 0 || (DL.cur && DL.cur.id === id)) dequeue(id);
    else enqueue([id]);
  }
  async function onAct(e) {
    var b = e.target.closest && e.target.closest('[data-oa]'); if (!b) return;
    var a = b.dataset.oa;
    if (a === 'pause') return pauseAll();
    if (a === 'resume') return resumeAll();
    if (a === 'cancel') return cancelAll();
    if (a === 'reload') return location.reload();
    if (a === 'open') { view = 'off'; coll = null; curList = null; $q('#np') && ($q('#np').hidden = true); render(); go(); return; }
    if (a === 'np') return toggleCurrent();
    if (a === 'wipe') { if (await window.__ask({ title: '¿Borrar todas tus descargas?', text: 'Se quitarán las canciones guardadas en este dispositivo.', ok: 'Borrar', danger: true })) { cancelAll(); await removeSongs(Array.from(OFF.have.keys())); toast('Descargas borradas.'); } return; }
    if (a === 'fav' || a === 'all' || a === 'list') {
      var ids;
      if (a === 'fav') ids = songs.filter(function (s) { return favs.has(s.id); }).map(function (s) { return s.id; });
      else if (a === 'all') ids = songs.map(function (s) { return s.id; });
      else {
        var sel = $q('#od-sel'); if (!sel) return;
        var r = await fetchAll(function () { return sb.from('playlist_songs').select('song_id').eq('playlist_id', sel.value).order('song_id'); });
        if (r.error) return toast('No se pudo leer la lista.');
        ids = r.data.map(function (x) { return x.song_id; });
      }
      ids = ids.filter(function (id) { return !OFF.have.has(sid(id)) && findSong(id); });
      if (!ids.length) return toast('Esa música ya está descargada.');
      var need = ids.reduce(function (t, id) { return t + estBytes(findSong(id)); }, 0);
      try {
        if (navigator.storage && navigator.storage.estimate) {
          var es = await navigator.storage.estimate();
          if (es.quota && need * 1.1 > es.quota - es.usage) return alert('No hay espacio suficiente: necesitas unos ' + fmtSize(need) + ' y tienes ' + fmtSize(Math.max(0, es.quota - es.usage)) + ' libres para Sammelo.');
        }
      } catch (x) { }
      if (ids.length > 1 && !(await window.__ask({ title: '¿Descargar ' + ids.length + ' canciones?', text: 'Ocuparán unos ' + fmtSize(need) + ' en este dispositivo.', ok: 'Descargar' }))) return;
      enqueue(ids);
    }
  }

  /* ---------- install(): se llama una vez, justo antes de arrancar la app ---------- */
  OFF.install = function () {
    if (OFF.installed) return; OFF.installed = true;

    var st = document.createElement('style'); st.id = 'offcss'; st.textContent = CSS; document.head.appendChild(st);
    I.dl = P('M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z');
    if (!TABS.some(function (t) { return t[0] === 'off'; })) TABS.splice(TABS.length - 1, 0, ['off', 'Descargas', I.dl]);

    /* 1) Audio: si la canción está descargada, sale del teléfono */
    _signed = signed;
    signed = async function (s) { var u = await localUrl(s.id); return u || _signed(s); };

    /* 2) Arranque sin sesión utilizable (token vencido y sin internet) */
    var _init = init;
    init = function (s) {
      if (s || OFF.mode) { if (!s) return; return _init(s); }
      var ss = storedSession();
      if (!ss) return _init(s);                                   // cerró sesión de verdad → login normal
      return bootOffline().then(function (ok) { if (!ok) _init(s); });
    };

    /* 3) Carga de la biblioteca: si no hay internet, usa las descargas */
    var _load = load;
    load = async function () {
      var uid0 = me && me.id;
      await loadHave(uid0);
      var has = OFF.have.size > 0;
      /* Estado de la cuenta (solo si ya hay descargas): si el administrador bloqueó o retiró el acceso, se borran las descargas. */
      var chk = null;
      if (has && navigator.onLine !== false) {
        try { chk = Promise.resolve(sb.from('profiles').select('blocked,approved,role').eq('id', uid0).maybeSingle()).catch(function () { return null; }); } catch (e) { chk = null; }
      }
      if (has && navigator.onLine === false && (await bootOffline())) return;
      var done = false, wd = null;
      if (has) wd = setTimeout(function () { if (!done && !shellOn) bootOffline(); }, 4500);
      try { await _load(); } finally { done = true; clearTimeout(wd); }
      if (chk) {
        var cr = await Promise.race([chk, new Promise(function (r) { setTimeout(function () { r(null); }, 3000); })]), cd = cr && cr.data;
        if (cd && (cd.blocked === true || (cd.role !== 'admin' && cd.approved === false && !shellOn))) { await purgeUser(uid0); return; }
      }
      if (has && !songs.length && !OFF.mode) { if (await bootOffline()) return; }
      if (OFF.mode) {
        if (songs !== OFF.offSongs) {
          if (!songs.length) { songs = OFF.offSongs; render(); }      // el servidor no respondió: seguimos offline
          else { OFF.mode = false; ui(true); render(); }              // respondió tarde: ya estamos en línea
        }
        if (OFF.mode) return;
      }
      if (songs.length) { saveSnap(); background(); }
    };
    async function background() {                                   // mantiene al día lo descargado (best-effort)
      await new Promise(function (r) { setTimeout(r, 5000); });
      try {
        if (!OFF.have.size || navigator.onLine === false || OFF.mode) return;
        var r = await fetchAll(function () { return sb.from('songs').select('id').order('id'); });
        if (r.error || !r.data.length) return;
        var live = new Set(r.data.map(function (x) { return sid(x.id); }));
        var gone = Array.from(OFF.have.keys()).filter(function (id) { return !live.has(id); });
        if (gone.length) await removeSongs(gone);                    // canciones que el administrador ya quitó
        var chg = [];
        songs.forEach(function (s) { var id = sid(s.id); if (OFF.have.has(id) && JSON.stringify(OFF.rows.get(id)) !== JSON.stringify(s)) chg.push(s); });
        for (var i = 0; i < chg.length; i++) {
          var k = OFF.uid + ':' + sid(chg[i].id), rec = await reqP((await store('songs')).get(k));
          if (rec) { rec.row = JSON.parse(JSON.stringify(chg[i])); await reqP((await store('songs', 'readwrite')).put(rec)); OFF.rows.set(sid(chg[i].id), rec.row); }
        }
      } catch (e) { }
    }

    /* 4) No mostrar «no se pudieron cargar» cuando estamos usando las descargas */
    var _toast = toast;
    toast = function (m) { if (OFF.have.size && /No se pudieron cargar las canciones/.test(String(m))) return; return _toast(m); };

    /* 5) Pantalla Descargas + marcas */
    var _render = render;
    render = function () {
      if (view === 'off' && !coll) return renderOff();
      if (OFF.mode && view === 'pl' && !coll) return renderNeedsNet('Tus listas');
      _render(); markRows(); paintBar();
    };
    var _pathNow = pathNow;
    pathNow = function () { var np = $q('#np'); if (view === 'off' && !coll && !(np && !np.hidden)) return 'descargas'; return _pathNow(); };
    var _applyPath = applyPath;
    applyPath = async function (p) {
      if (String(p || '').split('/')[0] !== 'descargas') return _applyPath(p);
      navOn = false;
      try { var np = $q('#np'); np.hidden = true; npPushed = false; coll = null; curList = null; view = 'off'; render(); go(); lastPath = pathNow(); }
      finally { navOn = true; }
    };

    /* 6) Menú ⋯ de cada canción */
    var _openPick = openPick;
    openPick = function (id) {
      _openPick(id);
      var d = $q('#dlg'), sh = d && d.querySelector('[data-o="share"]'); if (!sh) return;
      var k = sid(id), btn = document.createElement('button'); btn.className = 'row';
      var have = OFF.have.get(k), queued = DL.q.indexOf(k) >= 0 || (DL.cur && DL.cur.id === k);
      if (have) btn.textContent = 'Quitar descarga (' + fmtSize(have.size) + ')';
      else if (queued) btn.textContent = 'En cola de descarga · cancelar';
      else if (OFF.mode) return;
      else btn.textContent = 'Descargar para escuchar sin internet';
      btn.onclick = function () {
        d.close();
        if (have) removeSongs([k]); else if (queued) dequeue(k); else enqueue([k]);
      };
      sh.insertAdjacentElement('afterend', btn);
    };

    /* 7) Botón en la pantalla de reproducción + barra de estado */
    var _shell = shell;
    shell = function () {
      var first = !shellOn;
      _shell();
      if (!first && $q('#offbar')) return;
      var m = $q('#main');
      if (m && !$q('#offbar')) { var bar = document.createElement('div'); bar.id = 'offbar'; bar.setAttribute('role', 'status'); m.insertBefore(bar, m.firstChild); }
      var tools = $q('#np .tools');
      if (tools && !$q('#tdl')) { var c = document.createElement('button'); c.className = 'chip'; c.id = 'tdl'; c.dataset.oa = 'np'; c.innerHTML = I.dl + '<span>Descargar</span>'; tools.appendChild(c); }
      ui(true);
    };
    var _upd = upd;
    upd = function () { _upd(); chip(); };

    /* 8) Eventos */
    document.addEventListener('click', onAct);
    document.addEventListener('change', function (e) {
      if (e.target && e.target.id === 'od-wifi') { try { localStorage.setItem('off:wifi', e.target.checked ? '1' : '0'); } catch (x) { } if (!e.target.checked && DL.hold === 'wifi') kick(); }
    });
    addEventListener('online', function () { if (DL.hold === 'offline') { DL.hold = null; kick(); } ui(true); });
    addEventListener('offline', function () { ui(true); });
    if (navigator.connection && navigator.connection.addEventListener) navigator.connection.addEventListener('change', function () { if (DL.hold === 'wifi' && !holdReason()) { DL.hold = null; kick(); } ui(true); });
    new MutationObserver(function () { if (!rafM) rafM = requestAnimationFrame(function () { rafM = 0; markRows(); }); })
      .observe(document.body, { childList: true, subtree: true });
  };
})();
