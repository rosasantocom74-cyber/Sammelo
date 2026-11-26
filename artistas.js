/* Sammelo · ARREGLAR ARTISTAS
   ------------------------------------------------------------------
   Problema: la app agrupa los artistas por el TEXTO del campo «artista» de cada canción, y ese texto
   llega de la importación con errores (nombre del canal de YouTube, el título puesto como artista,
   «E.L.A.D.I.O» en vez de «Eladio Carrión»…). Resultado: muchos «artistas» con 1 sola canción.

   Qué hace este archivo (no cambia tus canciones en la base de datos):
   1. Automático: nombres que solo se diferencian en puntos, espacios, tildes o mayúsculas se juntan solos
      («E.L.A.D.I.O» = «Eladio»).
   2. Administrador: en la página de un artista, botón «Arreglar artista» → lo une con el artista correcto.
      En el menú ⋯ de una canción, «Cambiar artista de esta canción».
   3. Las correcciones se guardan UNA vez en la tabla app_settings (clave «artist_fix») y valen para
      todos los usuarios. Se pueden deshacer. Si este archivo falla o se borra, la app queda como antes. */
(function () {
  'use strict';
  var A = window.SammeloArtistas = {};
  var R = { v: 1, merge: {}, songs: {} };      // reglas guardadas: merge[claveCompacta] = {to,from,id} · songs[idCanción] = {to,id}
  var CANON = new Map();                       // texto de artista tal como viene → nombre final del artista
  var _main, seenSongs = null, seenLen = -1, rulesAt = 0;

  var $q = function (s) { return document.querySelector(s); };
  var esc2 = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var compact = function (x) { return _nk(x).replace(/ /g, ''); };
  var def = function (o, k, v) { Object.defineProperty(o, k, { value: v, writable: true, configurable: true, enumerable: false }); };
  var canFix = function () { return typeof isAdm === 'function' && isAdm() && !(window.SammeloOffline && SammeloOffline.mode) && navigator.onLine !== false; };

  /* ---------- reglas: leer / guardar ---------- */
  function clean(v) {
    var o = { v: 1, merge: {}, songs: {} };
    if (v && typeof v === 'object') {
      Object.keys(v.merge || {}).forEach(function (k) { var m = v.merge[k]; if (m && typeof m.to === 'string' && m.to.trim()) o.merge[k] = { to: m.to.trim(), from: String(m.from || ''), id: m.id == null ? null : m.id }; });
      Object.keys(v.songs || {}).forEach(function (k) { var m = v.songs[k]; if (m && typeof m.to === 'string' && m.to.trim()) o.songs[k] = { to: m.to.trim(), id: m.id == null ? null : m.id }; });
    }
    return o;
  }
  function cacheRules() { try { localStorage.setItem('af:rules', JSON.stringify(R)); } catch (e) { } }
  async function fetchRules() {
    try {
      var r = await sb.from('app_settings').select('value').eq('key', 'artist_fix').maybeSingle();
      if (r && !r.error) { R = clean(r.data && r.data.value); cacheRules(); return true; }
    } catch (e) { }
    return false;
  }
  async function saveRules() {
    var r = await sb.from('app_settings').upsert({ key: 'artist_fix', value: R, updated_at: new Date().toISOString() });
    if (r && r.error) throw r.error;
    cacheRules();
  }

  /* ---------- aplicar reglas a las canciones en memoria ---------- */
  function sameId(a, b) { return String(a) === String(b); }
  function applyRules() {
    var changed = false, CAN = new Map();
    songs.forEach(function (s) {
      var cur = s.artist, hasA = Object.prototype.hasOwnProperty.call(s, '_an');
      var raw = (hasA && s._an === cur) ? s._a0 : cur;                       // texto original que llegó de la base
      var hasI = Object.prototype.hasOwnProperty.call(s, '_ai');
      var rawId = (hasI && sameId(s._ai, s.artist_id)) ? s._i0 : s.artist_id;
      var out = raw, outId = rawId, rule = null, ps = R.songs[s.id];
      if (ps) { rule = ps; out = ps.to; }
      else {
        var mt = _main(raw), m = R.merge[compact(mt)];
        if (m) { rule = m; var i = String(raw).indexOf(mt); out = i >= 0 ? String(raw).slice(0, i) + m.to + String(raw).slice(i + mt.length) : m.to; }
      }
      if (rule) { outId = rule.id == null ? null : rule.id; CAN.set(out, rule.to); }
      if (out !== cur) changed = true;
      def(s, '_a0', raw); def(s, '_an', out); s.artist = out;
      if ('artist_id' in s || hasI) { def(s, '_i0', rawId); def(s, '_ai', outId); if (String(s.artist_id) !== String(outId)) { s.artist_id = outId; changed = true; } }
    });
    /* Automático: mismas letras, distinta escritura («E.L.A.D.I.O» / «Eladio» / «ELADIO») → un solo artista */
    var groups = new Map();
    songs.forEach(function (s) {
      if (CAN.has(s.artist)) return;
      var t = _main(s.artist), k = compact(t); if (!k) return;
      if (!groups.has(k)) groups.set(k, new Map());
      var g = groups.get(k), f = _nk(t), e = g.get(f) || { text: t, n: 0, raws: new Set() };
      e.n++; e.raws.add(s.artist); g.set(f, e);
    });
    groups.forEach(function (g) {
      if (g.size < 2) return;
      var best = null;
      g.forEach(function (e) {
        var sym = (e.text.match(/[^\p{L}\p{N}\s]/gu) || []).length;          // menos puntos y símbolos = mejor
        e.score = [e.n, -sym, e.text.length];
        if (!best || e.score[0] > best.score[0] || (e.score[0] === best.score[0] && (e.score[1] > best.score[1] || (e.score[1] === best.score[1] && e.score[2] > best.score[2])))) best = e;
      });
      g.forEach(function (e) { if (e !== best) e.raws.forEach(function (raw) { CAN.set(raw, best.text); }); });
    });
    CANON = CAN; seenSongs = songs; seenLen = songs.length;
    return changed;
  }

  /* ---------- ventana «Arreglar artista» ---------- */
  var ctx = null;
  function domId(items) {
    var c = {}, best = null;
    items.forEach(function (s) { var i = s.artist_id; if (i == null) return; c[i] = (c[i] || 0) + 1; if (best == null || c[i] > c[best]) best = i; });
    return best;
  }
  function score(c, src, tt) {
    var cn = _nk(c.name), cc = compact(c.name), sc = src ? compact(src) : '', s = 0;
    if (sc && cc.length >= 4 && sc.length >= 4 && (cc.indexOf(sc) === 0 || sc.indexOf(cc) === 0)) s = 3;
    if (!s && src) { var a = _nk(src).split(' '), b = cn.split(' '); if (a.some(function (w) { return w.length >= 4 && b.indexOf(w) >= 0; })) s = 2; }
    if (tt && cn.length >= 3 && (' ' + tt + ' ').indexOf(' ' + cn + ' ') >= 0) s = Math.max(s, 3);
    return s;
  }
  function candidates() {
    var all = artistsAll(), src = ctx.mode === 'artist' ? ctx.coll.name : null, srcKey = ctx.mode === 'artist' ? ctx.coll.key : _nk(mainArtist(ctx.song.artist));
    var tt = ctx.mode === 'song' ? _nk(ctx.song.title) : ctx.coll.items.map(function (x) { return _nk(x.title); }).join(' ');
    return all.filter(function (c) { return c.key !== srcKey; }).map(function (c) { c.sim = score(c, src || ctx.song.artist, tt); return c; });
  }
  function paintList() {
    var q = _nk(($q('#af-q') || {}).value || ''), raw = (($q('#af-q') || {}).value || '').trim();
    var cs = candidates().filter(function (c) { return !q || _nk(c.name).indexOf(q) >= 0; });
    cs.sort(function (a, b) { return b.sim - a.sim || b.items.length - a.items.length || a.name.localeCompare(b.name, 'es'); });
    var h = cs.slice(0, 60).map(function (c, i) {
      return '<button class="row" data-af="pick" data-i="' + i + '"><b>' + esc2(c.name) + '</b><br><small class="mut">' + plur(c.items.length) + (c.sim >= 2 ? ' · parecido' : '') + '</small></button>';
    }).join('');
    ctx.shown = cs.slice(0, 60);
    if (raw && !cs.some(function (c) { return _nk(c.name) === q; }) && raw.length <= 80) h += '<button class="row" data-af="new"><b>Usar «' + esc2(raw) + '» como nombre nuevo</b></button>';
    if (!h) h = '<p class="mut">No hay otros artistas que coincidan.</p>';
    $q('#af-l').innerHTML = h;
  }
  function openFix(mode, obj) {
    ctx = { mode: mode, coll: mode === 'artist' ? obj : null, song: mode === 'song' ? obj : null, shown: [] };
    var d = $q('#afdlg'), extra = '', undo = '';
    var title = mode === 'artist' ? 'Arreglar «' + esc2(obj.name) + '»' : 'Artista de «' + esc2(obj.title) + '»';
    var intro = mode === 'artist'
      ? 'Elige el artista correcto: las ' + obj.items.length + (obj.items.length === 1 ? ' canción' : ' canciones') + ' de «' + esc2(obj.name) + '» pasarán a él.'
      : 'Ahora aparece como «' + esc2(obj.artist) + '». Elige el artista correcto para esta canción.';
    if (mode === 'artist') {
      var mine = Object.keys(R.merge).filter(function (k) { return _nk(R.merge[k].to) === _nk(obj.name); });
      if (mine.length) extra = '<p class="mut" style="margin:14px 0 4px;font-weight:700">Uniones guardadas en este artista</p>' + mine.map(function (k) { return '<button class="row" data-af="split" data-k="' + esc2(k) + '">Separar «' + esc2(R.merge[k].from || k) + '»</button>'; }).join('');
    } else if (R.songs[obj.id]) {
      extra = '<button class="row" data-af="unsong">Volver al artista original</button>';
    }
    try { if (localStorage.getItem('af:undo')) undo = '<button class="row" data-af="undo">Deshacer el último cambio</button>'; } catch (e) { }
    d.innerHTML = '<h3>' + title + '</h3><p class="mut" style="margin:-6px 0 10px">' + intro + '</p>' +
      '<input id="af-q" type="search" autocomplete="off" placeholder="Buscar artista o escribir un nombre nuevo" style="width:100%;padding:12px 14px;border-radius:999px;border:0;background:var(--fld);color:var(--t);font:inherit;margin-bottom:10px">' +
      '<div id="af-l"></div>' + extra + undo + '<button class="btn ghost" style="margin-top:12px;width:100%" data-af="close">Cerrar</button>';
    paintList();
    if (!d.open) d.showModal();
  }

  async function commit(label, mutate, then) {
    var prev = JSON.stringify(R);
    mutate();
    try { await saveRules(); }
    catch (e) { R = clean(JSON.parse(prev)); applyRules(); toast('No se pudo guardar. Revisa el permiso de admin.'); return false; }
    try { localStorage.setItem('af:undo', prev); } catch (e) { }
    applyRules(); $q('#afdlg').close();
    if (coll && coll.kind === 'artist') { var g = artistsAll().filter(function (a) { return a.key === coll.key; })[0]; coll = g || null; if (g) rg(g); }
    if (then) then(); else render();
    toast(label);
    return true;
  }
  function targetFrom(c, typed) {
    var name = c ? c.name : typed, ex = c || artistsAll().filter(function (x) { return x.key === _nk(mainArtist(typed)); })[0];
    var rk = R.merge[compact(name)];
    if (rk) name = rk.to;                                                      // si el destino ya fue unido a otro, se usa ese (sin cadenas)
    return { name: name, id: ex ? domId(ex.items) : (rk ? rk.id : null) };
  }
  async function doMergeArtist(t) {
    var src = ctx.coll;
    if (_nk(t.name) === _nk(src.name)) return toast('Ya es el mismo artista.');
    if (!confirm('¿Mover ' + plur(src.items.length) + ' de «' + src.name + '» a «' + t.name + '»?')) return;
    var n = src.items.length;
    await commit('Listo: ' + plur(n) + ' ahora en «' + t.name + '».', function () {
      var keys = new Map();
      src.items.forEach(function (s) { var mt = _main(s._a0 !== undefined ? s._a0 : s.artist); keys.set(compact(mt), mt); });
      var tk = compact(t.name);
      Object.keys(R.merge).forEach(function (k) { if (compact(R.merge[k].to) === compact(src.name) || keys.has(compact(R.merge[k].to))) { R.merge[k].to = t.name; R.merge[k].id = t.id; } });   // nada de cadenas A→B→C
      keys.forEach(function (mt, k) { if (k !== tk) R.merge[k] = { to: t.name, from: mt, id: t.id }; });
    }, function () {
      var g = artistsAll().filter(function (a) { return a.key === _nk(mainArtist(t.name)); })[0];
      if (g) { coll = null; var k = rg(g); openColl(k); } else { coll = null; render(); }
    });
  }
  async function doSong(t) {
    var s = ctx.song;
    if (_nk(t.name) === _nk(mainArtist(s.artist))) return toast('Esa canción ya está en ese artista.');
    if (!confirm('¿Poner «' + s.title + '» en el artista «' + t.name + '»?')) return;
    await commit('Listo: «' + s.title + '» ahora está en «' + t.name + '».', function () { R.songs[s.id] = { to: t.name, id: t.id }; });
  }
  async function onAf(e) {
    var b = e.target.closest && e.target.closest('[data-af]'); if (!b) return;
    var a = b.dataset.af;
    if (a === 'artist') { if (coll && coll.kind === 'artist') openFix('artist', coll); return; }
    if (!ctx) return;
    if (a === 'close') return $q('#afdlg').close();
    if (a === 'pick') { var c = ctx.shown[+b.dataset.i]; if (!c) return; var t = targetFrom(c); return ctx.mode === 'artist' ? doMergeArtist(t) : doSong(t); }
    if (a === 'new') { var nm = (($q('#af-q') || {}).value || '').trim(); if (!nm) return; var t2 = targetFrom(null, nm); return ctx.mode === 'artist' ? doMergeArtist(t2) : doSong(t2); }
    if (a === 'split') { var k = b.dataset.k, nm2 = R.merge[k] && R.merge[k].from; if (!confirm('¿Separar «' + nm2 + '» de este artista?')) return; return commit('Listo: «' + nm2 + '» vuelve a ser un artista aparte.', function () { delete R.merge[k]; }); }
    if (a === 'unsong') return commit('Listo: la canción volvió a su artista original.', function () { delete R.songs[ctx.song.id]; });
    if (a === 'undo') {
      var u = null; try { u = JSON.parse(localStorage.getItem('af:undo')); } catch (x) { }
      if (!u) return;
      return commit('Listo: cambio deshecho.', function () { R = clean(u); try { localStorage.removeItem('af:undo'); } catch (x) { } });
    }
  }

  /* ---------- install(): se llama una vez, justo antes de arrancar la app ---------- */
  A.install = function () {
    if (A.installed) return; A.installed = true;
    try { R = clean(JSON.parse(localStorage.getItem('af:rules') || 'null')); } catch (e) { }
    _main = mainArtist;
    mainArtist = function (raw) { var c = CANON.get(raw); return c !== undefined ? c : _main(raw); };

    var d = document.createElement('dialog'); d.id = 'afdlg'; d.style.width = 'min(92vw,420px)'; d.addEventListener('click', function (e) { if (e.target === d) d.close(); });
    d.addEventListener('input', function (e) { if (e.target && e.target.id === 'af-q' && ctx) paintList(); });
    document.body.appendChild(d);
    document.addEventListener('click', onAf);

    /* Al cargar la biblioteca: leer reglas y arreglar los nombres antes de que se vean */
    var _load = load;
    load = async function () {
      var rp = fetchRules();
      var r = await _load();
      await Promise.race([rp, new Promise(function (res) { setTimeout(res, 2500); })]);
      if (applyRules()) render();
      return r;
    };
    /* Canciones nuevas o cambiadas en tiempo real */
    var _osc = onSongChange;
    onSongChange = function (p) { var r = _osc(p); try { applyRules(); } catch (e) { } return r; };
    /* Si la lista de canciones cambió por otro camino (modo sin conexión, etc.) */
    var _render = render;
    render = function () { if (songs !== seenSongs || songs.length !== seenLen) { try { applyRules(); } catch (e) { } } return _render(); };

    /* Botón en la página del artista (solo administrador) */
    var _cp = collPage;
    collPage = function (m) {
      _cp(m);
      if (coll && coll.kind === 'artist' && canFix()) {
        var bar = m.querySelector('.bar');
        if (bar) { var b = document.createElement('button'); b.className = 'btn ghost'; b.dataset.af = 'artist'; b.textContent = 'Arreglar artista'; bar.appendChild(b); }
      }
    };
    /* Opción en el menú ⋯ de cada canción (solo administrador) */
    var _op = openPick;
    openPick = function (id) {
      _op(id);
      if (!canFix()) return;
      var dl = $q('#dlg'), sh = dl && dl.querySelector('[data-o="share"]'), sg = songs.find(function (x) { return x.id === id; });
      if (!sh || !sg) return;
      var b = document.createElement('button'); b.className = 'row'; b.textContent = 'Cambiar artista de esta canción…';
      b.onclick = function () { dl.close(); openFix('song', sg); };
      sh.insertAdjacentElement('afterend', b);
    };
  };
})();
