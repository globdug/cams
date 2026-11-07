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
let state = { preset: 'auto', fps: 10, order: [], cams: {} };
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
  state = Object.assign({ preset: 'auto', fps: 10, order: [], cams: {} }, s);
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
  if (c.version) $('ver').textContent = 'v' + c.version;
  grid.dataset.empty = `Nessuna telecamera. Modifica ${c.file}`;
  render();
}

// ---------- layout ----------
function dims(n) {
  if (state.preset === 'auto') { const c = Math.max(1, Math.ceil(Math.sqrt(n))); return [c, Math.max(1, Math.ceil(n / c))]; }
  return state.preset.split('x').map(Number);
}

// Il "focus" (doppio clic) e' solo visivo: gli altri riquadri vengono nascosti ma i loro flussi restano attivi.
function render() {
  const n = state.order.length;
  const [cols, rows] = dims(n);
  if (focus && !state.order.includes(focus)) focus = null;
  const per = state.preset === 'auto' ? Math.max(1, n) : cols * rows;
  const pages = Math.max(1, Math.ceil(n / per));
  page = Math.min(page, pages - 1);
  const vis = state.order.slice(page * per, (page + 1) * per); // riquadri della pagina corrente
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
    <input class="c" placeholder="16:10" title="w:h" hidden><select class="f" title="Adattamento"></select></div></div>`;
  const q = (s) => el.querySelector(s);
  const t = { cam, el, frame: q('.frame'), img: q('img'), st: q('.st'), s: q('.s'), a: q('.a'), c: q('.c'), f: q('.f'), sid: null, w: 0, timer: 0 };
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

// ---------- controlli globali ----------
$('preset').innerHTML = PRESETS.map((p) => opt(p, p === 'auto' ? 'Auto' : p)).join('');
$('fps').innerHTML = FPS.map((f) => opt(f, f)).join('');
$('preset').onchange = (e) => { state.preset = e.target.value; page = 0; focus = null; save(); render(); };
$('fps').onchange = (e) => { state.fps = +e.target.value; save(); for (const t of tiles.values()) restart(t); };
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
