'use strict';
const API = 'http://127.0.0.1:17890'; // backend Node (la pagina puo' essere servita da altre porte, es. 1430 in tauri dev)
const PRESETS = ['auto', '1x1', '2x1', '2x2', '3x2', '3x3', '4x3', '3x4', '4x4', '5x4', '6x4']; // colonne x righe
const ASPECTS = [['auto', 'Cella'], ['16:9', '16:9'], ['4:3', '4:3'], ['21:9', '21:9'], ['1:1', '1:1'], ['3:4', '3:4'], ['9:16', '9:16'], ['custom', 'Altro…']];
const FITS = [['contain', 'Adatta'], ['cover', 'Ritaglia'], ['fill', 'Stira']];
const FPS = [5, 10, 15]; // le telecamere trasmettono a 15 fps: valori piu' alti duplicano frame e sprecano CPU
const BUCKETS = [320, 480, 640, 960, 1280, 1920];

const $ = (id) => document.getElementById(id);
const grid = $('grid');
const tiles = new Map(); // id -> {cam, el, frame, img, st, sel..., sid, started, w, timer}
let cams = [];
let state = { preset: 'auto', fps: 10, order: [], cams: {}, groups: [], view: 'all' };
let statsAll = false; // statistiche tecniche visibili su tutti i riquadri
let focus = null;
let page = 0;
let dragId = null;
let cfgSeen = null; // versione di cameras.json vista dal server
let hosts = ['127.0.0.1']; // indirizzi del backend su cui distribuire i flussi (limite: 6 connessioni per indirizzo)

const opt = (v, l, sel) => `<option value="${v}"${sel ? ' selected' : ''}>${l}</option>`;
const getJSON = (p) => fetch(API + p).then((r) => r.json());

// ---------- stato ----------
let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fetch(API + '/api/state', { method: 'POST', body: JSON.stringify(state) }).catch(() => {}), 400);
}
const cs = (id) => (state.cams[id] ||= { aspect: 'auto', fit: 'contain' });
// flusso scelto dall'utente; di default il 2 (qualità minore) se la camera ne ha più di uno
const streamOf = (cam) => Math.min(cs(cam.id).stream ?? 1, Math.max(0, cam.streams.length - 1));

// restart=true riavvia tutti i flussi; altrimenti solo quelli delle telecamere con URL modificati
async function load(restart = false) {
  let c, s;
  try { [c, s] = await Promise.all([getJSON('/api/cameras'), getJSON('/api/state')]); }
  catch { $('msg').textContent = 'Connessione al server…'; return setTimeout(load, 1000); }
  cams = c.cameras;
  if (c.hosts && c.hosts.length) hosts = [...c.hosts].sort();
  state = Object.assign({ preset: 'auto', fps: 10, order: [], cams: {}, groups: [], view: 'all' }, s);
  state.fps = Math.min(state.fps, FPS[FPS.length - 1]); // stato salvato con i vecchi 25 fps
  if (state.v !== 2) { for (const k in state.cams) delete state.cams[k].stream; state.v = 2; save(); } // il flusso 1 salvato in automatico non era una scelta
  for (const t of tiles.values()) { // render() riavvia i flussi fermati
    const n = cams.find((c) => c.id === t.cam.id);
    if (restart || !n || n.rev !== t.cam.rev) stop(t);
  }
  const ids = cams.map((x) => x.id);
  for (const k in state.cams) if (!ids.includes(k)) delete state.cams[k];
  state.order = state.order.filter((i) => ids.includes(i)).concat(ids.filter((i) => !state.order.includes(i)));
  $('msg').textContent = c.error || '';
  buildViewMenu();
  if (c.version) $('ver').textContent = 'v' + c.version;
  grid.dataset.empty = `Nessuna telecamera. Modifica ${c.file}`;
  render();
}

// ---------- layout ----------
function dims(n) {
  if (state.preset === 'auto') { const c = Math.max(1, Math.ceil(Math.sqrt(n))); return [c, Math.max(1, Math.ceil(n / c))]; }
  return state.preset.split('x').map(Number);
}

// ---------- viste: tutte / gruppo / singola telecamera ----------
// elenco (ordinato) delle telecamere della vista corrente; gruppo o telecamera inesistenti -> tutte
function viewIds() {
  const v = state.view || 'all';
  if (v.startsWith('g:')) {
    const g = state.groups.find((x) => 'g:' + x.id === v);
    if (g) return state.order.filter((i) => g.cams.includes(i));
  } else if (v.startsWith('c:') && state.order.includes(v.slice(2))) return [v.slice(2)];
  return state.order;
}

function buildViewMenu() {
  const sel = $('view');
  const add = (parent, value, text) => { const o = document.createElement('option'); o.value = value; o.textContent = text; parent.append(o); };
  sel.replaceChildren();
  add(sel, 'all', `Tutte (${cams.length})`);
  if (state.groups.length) {
    const og = document.createElement('optgroup');
    og.label = 'Gruppi';
    for (const g of state.groups) add(og, 'g:' + g.id, `${g.name || 'Senza nome'} (${g.cams.filter((i) => cams.some((c) => c.id === i)).length})`);
    sel.append(og);
  }
  const oc = document.createElement('optgroup');
  oc.label = 'Telecamere';
  for (const c of cams) add(oc, 'c:' + c.id, c.name);
  sel.append(oc);
  if (![...sel.options].some((o) => o.value === state.view)) state.view = 'all';
  sel.value = state.view;
}

// Il "focus" (doppio clic) e' solo visivo: gli altri riquadri vengono nascosti ma i loro flussi restano attivi.
function render() {
  const list = viewIds();
  const n = list.length;
  const [cols, rows] = dims(n);
  if (focus && !list.includes(focus)) focus = null;
  const per = state.preset === 'auto' ? Math.max(1, n) : cols * rows;
  const pages = Math.max(1, Math.ceil(n / per));
  page = Math.min(page, pages - 1);
  const vis = list.slice(page * per, (page + 1) * per); // riquadri della pagina corrente
  $('pager').hidden = pages < 2 || !!focus;
  $('pageLbl').textContent = `${page + 1} / ${pages}`;
  const [gc, gr] = focus ? [1, 1] : [cols, rows];
  grid.style.gridTemplateColumns = `repeat(${gc}, minmax(0, 1fr))`;
  grid.style.gridTemplateRows = `repeat(${gr}, minmax(0, 1fr))`;

  for (const [id, t] of tiles) if (!cams.some((c) => c.id === id)) { stop(t); t.el.remove(); tiles.delete(id); }
  for (const cam of cams) {
    const t = tiles.get(cam.id) || makeTile(cam);
    t.cam = cam;
    const pos = vis.indexOf(cam.id);
    if (pos < 0) { t.el.hidden = true; stop(t); continue; } // altra pagina: flusso fermo
    t.el.hidden = document.hidden || (!!focus && cam.id !== focus);
    t.el.style.order = pos;
    applyTile(t);
  }
  for (const t of tiles.values()) if (!t.el.hidden) ensureStream(t);
  $('preset').value = state.preset;
  $('fps').value = state.fps;
  $('view').value = state.view;
  const none = $('none');
  none.hidden = n > 0 || !cams.length;
  none.textContent = 'Questo gruppo è vuoto. Aggiungi telecamere da «👥 Gruppi».';
  $('stats').classList.toggle('on', statsAll);
}

// ---------- riquadro ----------
function ratio(v) {
  const m = /^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/.exec(v || '');
  return m && +m[2] ? m[1] / m[2] : null;
}

function makeTile(cam) {
  const el = document.createElement('div');
  el.className = 'tile';
  el.draggable = true;
  el.innerHTML = `<div class="frame"><img draggable="false" alt=""><div class="st"></div><div class="name"></div>
    <div class="tb"><select class="s" title="Flusso"></select><select class="a" title="Proporzioni"></select>
    <input class="c" placeholder="16:10" title="w:h" hidden><select class="f" title="Adattamento"></select>
    <span class="sp"></span><button class="i" title="Statistiche tecniche">ⓘ</button><button class="r" title="Riavvia il flusso di questa telecamera">⟳</button></div>
    <div class="stats" hidden></div></div>`;
  const q = (s) => el.querySelector(s);
  const t = { cam, el, frame: q('.frame'), img: q('img'), st: q('.st'), s: q('.s'), a: q('.a'), c: q('.c'), f: q('.f'), sid: null, w: 0, timer: 0, stats: q('.stats'), showStats: statsAll, prev: null };
  q('.name').textContent = cam.name;
  t.a.innerHTML = ASPECTS.map(([v, l]) => opt(v, l)).join('');
  t.f.innerHTML = FITS.map(([v, l]) => opt(v, l)).join('');

  t.s.onchange = () => { cs(cam.id).stream = +t.s.value; save(); restart(t); };
  t.a.onchange = () => {
    if (t.a.value === 'custom') { t.c.hidden = false; t.c.focus(); return; }
    cs(cam.id).aspect = t.a.value; save(); render();
  };
  t.c.onchange = () => { if (ratio(t.c.value)) { cs(cam.id).aspect = t.c.value.trim(); save(); render(); } };
  t.f.onchange = () => { cs(cam.id).fit = t.f.value; save(); applyTile(t); };
  q('.r').onclick = (e) => { e.stopPropagation(); t.prev = null; restart(t); };
  q('.i').onclick = (e) => { e.stopPropagation(); t.showStats = !t.showStats; t.prev = null; applyStats(t); pollStats(); };
  el.ondblclick = (e) => { if (e.target.closest('.tb')) return; focus = focus ? null : cam.id; render(); };

  t.img.onload = () => { if (t.sid) t.st.textContent = ''; };
  t.img.onerror = () => { if (!t.sid) return; t.st.textContent = 'Nessun segnale'; retry(t); };

  el.ondragstart = (e) => { dragId = cam.id; e.dataTransfer.setData('text/plain', cam.id); e.dataTransfer.effectAllowed = 'move'; el.classList.add('drag'); };
  el.ondragend = () => { dragId = null; el.classList.remove('drag'); document.querySelectorAll('.over').forEach((x) => x.classList.remove('over')); };
  el.ondragover = (e) => { if (dragId && dragId !== cam.id) { e.preventDefault(); el.classList.add('over'); } };
  el.ondragleave = () => el.classList.remove('over');
  el.ondrop = (e) => {
    e.preventDefault();
    const o = state.order, from = o.indexOf(dragId), to = o.indexOf(cam.id);
    if (from < 0 || to < 0) return;
    o.splice(from, 1); o.splice(to, 0, dragId);
    save(); render();
  };

  grid.appendChild(el);
  tiles.set(cam.id, t);
  return t;
}

function applyTile(t) {
  const s = cs(t.cam.id);
  t.el.querySelector('.name').textContent = t.cam.name;
  t.s.innerHTML = t.cam.streams.map((l, i) => opt(i, l, i === streamOf(t.cam))).join('');
  t.s.hidden = t.cam.streams.length < 2;
  const known = ASPECTS.some(([v]) => v === s.aspect);
  t.a.value = known ? s.aspect : 'custom';
  t.c.hidden = known;
  if (!known) t.c.value = s.aspect;
  t.f.value = s.fit;
  const r = ratio(s.aspect);
  t.frame.classList.toggle('ar', !!r);
  if (r) t.frame.style.setProperty('--ar', r);
  t.img.style.objectFit = s.fit;
  applyStats(t);
}

// ---------- flussi ----------
const bucket = (t) => {
  const px = t.frame.clientWidth * devicePixelRatio;
  return BUCKETS.find((b) => b >= px) || BUCKETS[BUCKETS.length - 1];
};

function ensureStream(t) {
  if (t.sid) { if (!focus && bucket(t) !== t.w) restart(t); return; } // in focus nessun riavvio per cambio dimensione
  start(t);
}

function start(t) {
  clearTimeout(t.timer);
  t.sid = Math.random().toString(36).slice(2);
  t.started = Date.now();
  t.w = bucket(t);
  t.st.textContent = 'Connessione…';
  t.img.src = `http://${hosts[Math.max(0, cams.indexOf(t.cam)) % hosts.length]}:17890/stream/${encodeURIComponent(t.cam.id)}/${streamOf(t.cam)}?w=${t.w}&fps=${state.fps}&sid=${t.sid}`;
}

function stop(t) {
  clearTimeout(t.timer);
  t.sid = null;
  if (t.img.hasAttribute('src')) t.img.removeAttribute('src'); // chiude la connessione, il server ferma ffmpeg
}

function restart(t) { stop(t); if (!t.el.hidden) start(t); }
function retry(t) { clearTimeout(t.timer); t.timer = setTimeout(() => restart(t), 5000); }

// il server dimentica i flussi morti (ffmpeg terminato o bloccato): rilancio quelli mancanti
setInterval(async () => {
  if (document.hidden) return;
  let alive;
  try {
    const r = await getJSON('/api/streams');
    alive = r.sids;
    if (cfgSeen !== null && r.cfg !== cfgSeen) load(); // cameras.json modificato a mano
    cfgSeen = r.cfg;
  } catch { return; }
  for (const t of tiles.values()) {
    if (t.sid && Date.now() - t.started > 6000 && !alive.includes(t.sid)) { t.st.textContent = 'Riconnessione…'; restart(t); }
  }
}, 4000);

// ---------- statistiche tecniche ----------
const fmtRate = (kbps) => (kbps >= 1000 ? (kbps / 1000).toFixed(2) + ' Mbps' : Math.round(kbps) + ' kbps');
const fmtTime = (s) => [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n, i) => (i ? String(n).padStart(2, '0') : n)).join(':');
const esc = (v) => String(v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

function applyStats(t) {
  t.stats.hidden = !t.showStats || t.el.hidden;
  const b = t.el.querySelector('.i');
  if (b) b.classList.toggle('on', t.showStats);
  if (!t.stats.hidden && !t.stats.innerHTML) t.stats.textContent = 'Statistiche in arrivo…';
}

function renderStats(t, d) {
  const now = Date.now();
  let fpsOut = null, kbpsOut = null;
  if (t.prev && t.prev.sid === d.sid && now > t.prev.ts) { // velocità misurate tra due campioni
    const dt = (now - t.prev.ts) / 1000;
    fpsOut = (d.frames - t.prev.frames) / dt;
    kbpsOut = ((d.bytes - t.prev.bytes) * 8) / dt / 1000;
  }
  t.prev = { sid: d.sid, ts: now, frames: d.frames, bytes: d.bytes };

  const inp = d.input || '';
  const codec = (/^([A-Za-z0-9_]+)/.exec(inp) || [])[1];
  const prof = (/^[A-Za-z0-9_]+ \(([^)]*)\)/.exec(inp) || [])[1];
  const res = (/(\d{2,5}x\d{2,5})/.exec(inp) || [])[1];
  const fps = (/([\d.]+) fps/.exec(inp) || [])[1];
  const tbr = (/([\d.]+k?) tbr/.exec(inp) || [])[1];
  const pix = (/, ([a-z]+\d+[a-z0-9]*)/.exec(inp) || [])[1];
  const pr = d.progress || {};
  const srcKbps = /([\d.]+)\s*kbits/.exec(pr.bitrate || '');
  const outRes = (/(\d{2,5}x\d{2,5})/.exec(d.output || '') || [])[1];
  const dup = +pr.dup_frames || 0, drop = +pr.drop_frames || 0;
  const hw = d.hwdec ? d.hwdec + ' (hardware)' : d.req.hwaccel === 'none' ? 'software' : 'software (hw non attiva)';
  const lines = [
    `<b>${esc(d.name)}</b> · ${esc(d.label)}`,
    `Sorgente   ${codec ? esc(codec.toUpperCase()) : '—'}${prof ? ' ' + esc(prof) : ''} · ${res || '—'}${fps ? ' · ' + fps + ' fps' : ''}${tbr ? ' (tbr ' + tbr + ')' : ''}${pix ? ' · ' + esc(pix) : ''}`,
    `Bitrate    ${srcKbps ? fmtRate(+srcKbps[1]) : '—'} (flusso originale)`,
    `Uscita     MJPEG ${outRes || '—'} · ${fpsOut == null ? '—' : fpsOut.toFixed(1)} fps · ${kbpsOut == null ? '—' : fmtRate(kbpsOut)}  (q${d.req.q}, richiesti ${d.req.fps} fps)`,
    `Frame      ${d.frames} inviati · dup ${dup} · drop ${drop} · velocità ${esc(pr.speed || '—')}`,
    `Decodifica ${esc(hw)}`,
    `ffmpeg     CPU ${d.cpu == null ? '—' : d.cpu.toFixed(1) + '%'} · pid ${d.pid} · attivo da ${fmtTime(d.uptime)}`,
  ];
  t.stats.innerHTML = lines.join('\n');
}

let statsBusy = false;
async function pollStats() {
  if (statsBusy || document.hidden) return;
  const active = [...tiles.values()].filter((t) => t.showStats && !t.el.hidden);
  if (!active.length) return;
  statsBusy = true;
  try {
    const r = await getJSON('/api/stats');
    for (const t of active) {
      applyStats(t);
      const d = r.streams.find((x) => x.sid === t.sid);
      if (d) renderStats(t, d);
      else t.stats.textContent = t.sid ? 'In attesa del flusso…' : 'Flusso non attivo';
    }
  } catch { /* backend non raggiungibile: riprovo al prossimo giro */ }
  statsBusy = false;
}
setInterval(pollStats, 2000);

// ---------- controlli globali ----------
$('preset').innerHTML = PRESETS.map((p) => opt(p, p === 'auto' ? 'Auto' : p)).join('');
$('fps').innerHTML = FPS.map((f) => opt(f, f)).join('');
$('preset').onchange = (e) => { state.preset = e.target.value; page = 0; focus = null; save(); render(); };
$('fps').onchange = (e) => { state.fps = +e.target.value; save(); for (const t of tiles.values()) restart(t); };
$('view').onchange = (e) => { state.view = e.target.value; page = 0; focus = null; save(); render(); };
$('stats').onclick = () => { statsAll = !statsAll; for (const t of tiles.values()) { t.showStats = statsAll; t.prev = null; } render(); pollStats(); };
$('prev').onclick = () => { page = Math.max(0, page - 1); render(); };
$('next').onclick = () => { page++; render(); };
$('refresh').onclick = () => load(true);
$('full').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
addEventListener('keydown', (e) => { if (e.key === 'Escape' && focus) { focus = null; render(); } });

// risparmio: nessun flusso a finestra nascosta/minimizzata
document.addEventListener('visibilitychange', () => {
  if (document.hidden) for (const t of tiles.values()) stop(t);
  else render();
});
// niente riavvio al ridimensionamento/schermo intero della finestra: la risoluzione si rivaluta solo a cambio layout o con Aggiorna

load();
