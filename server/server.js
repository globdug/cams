'use strict';
// Backend leggero senza dipendenze: legge cameras.json, salva lo stato UI
// e converte i flussi RTSP in MJPEG (via ffmpeg) consumabile da un <img>.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.CAMS_PORT) || 17890;
const HOST = '127.0.0.1';
const ROOT = path.resolve(__dirname, '..');
const DATA = process.env.CAMS_DATA ? path.resolve(process.env.CAMS_DATA) : ROOT;
const CONFIG = path.join(DATA, 'cameras.json');
const STATE = path.join(DATA, 'state.json');
const WEB = path.join(ROOT, 'src');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const STALL_MS = 15000;
// Origini ammesse: pagine dell'app su loopback (finestra Tauri: tauri.localhost in produzione, 127.0.0.1:<porta> in "tauri dev").
// Qualsiasi sito esterno e' rifiutato.
function originOk(o) {
  if (o === 'tauri://localhost') return true;
  try {
    const u = new URL(o);
    return (u.protocol === 'http:' || u.protocol === 'https:') && ['127.0.0.1', 'localhost', '[::1]', 'tauri.localhost'].includes(u.hostname);
  } catch { return false; }
}
// Il browser apre max 6 connessioni per indirizzo:porta e ogni flusso ne tiene una aperta. Ascolto su piu' indirizzi
// di loopback (127.0.0.1-8) cosi' il client puo' distribuire i flussi e superare il limite.
const ADDRS = Array.from({ length: 8 }, (_, i) => `127.0.0.${i + 1}`);
const HOSTS = new Set([...ADDRS.map((a) => `${a}:${PORT}`), `localhost:${PORT}`]);
const boundHosts = [];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------- configurazione telecamere ----------
const SAMPLE = {
  cameras: [
    {
      name: 'Esempio',
      streams: [
        'rtsp://utente:password@192.168.1.10:554/stream1',
        'rtsp://utente:password@192.168.1.10:554/stream2',
      ],
    },
  ],
};

fs.mkdirSync(DATA, { recursive: true });
if (!fs.existsSync(CONFIG)) fs.writeFileSync(CONFIG, JSON.stringify(SAMPLE, null, 2));

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Codifica utente/password (es. '@' o '$' nella password): l'ULTIMA '@' separa le credenziali dall'host.
function encodeAuth(url) {
  const m = /^(rtsps?:\/\/)(.*)@([^@]*)$/i.exec(url);
  if (!m) return url;
  const enc = (v) => (/%[0-9a-f]{2}/i.test(v) ? v : encodeURIComponent(v)); // già codificato: lascio com'è
  const i = m[2].indexOf(':');
  const auth = i < 0 ? enc(m[2]) : enc(m[2].slice(0, i)) + ':' + enc(m[2].slice(i + 1));
  return m[1] + auth + '@' + m[3];
}

function normalize(raw) {
  const used = new Set();
  return (raw.cameras || []).map((c, i) => {
    let list = Array.isArray(c.streams) ? c.streams : [];
    if (!list.length) {
      // forma alternativa: stream1, stream2, ...
      list = Object.keys(c).filter((k) => /^stream\d+$/i.test(k)).sort().map((k) => c[k]);
    }
    const streams = list
      .map((s, n) => (typeof s === 'string' ? { label: `Flusso ${n + 1}`, url: s } : { label: s.label || `Flusso ${n + 1}`, url: s.url }))
      .filter((s) => s.url)
      .map((s) => ({ ...s, url: encodeAuth(s.url) }));
    let id = c.id ? String(c.id) : slug(c.name || '') || `cam${i + 1}`;
    while (used.has(id)) id += '-' + i;
    used.add(id);
    return { id, name: c.name || id, streams };
  });
}

// impronta degli URL (con sale casuale): il client sa quando riavviare un flusso senza vedere le credenziali
const SALT = require('crypto').randomBytes(8).toString('hex');
const rev = (c) => require('crypto').createHash('sha1').update(SALT + JSON.stringify(c.streams.map((s) => s.url))).digest('hex').slice(0, 10);

function validateConfig(b) {
  if (!b || !Array.isArray(b.cameras)) throw new Error('manca l\'elenco "cameras"');
  const out = b.cameras.map((c, i) => {
    const n = `telecamera ${i + 1}`;
    if (!c || typeof c.name !== 'string' || !c.name.trim()) throw new Error(`${n}: nome mancante`);
    if (!Array.isArray(c.streams) || !c.streams.length) throw new Error(`${c.name}: serve almeno un flusso`);
    const streams = c.streams.map((s, k) => {
      const url = typeof s === 'string' ? s : s && s.url;
      const label = typeof s === 'object' && s && typeof s.label === 'string' ? s.label.trim() : '';
      if (typeof url !== 'string' || !/^(rtsps?|https?):\/\/\S+$/i.test(url.trim())) throw new Error(`${c.name}, flusso ${k + 1}: URL non valido (deve iniziare con rtsp://)`);
      return label ? { label, url: url.trim() } : url.trim();
    });
    const o = { name: c.name.trim() };
    if (typeof c.id === 'string' && c.id.trim()) o.id = c.id.trim();
    o.streams = streams;
    return o;
  });
  return { cameras: out };
}

let cameras = [];
let configError = null;
function loadCameras() {
  try {
    cameras = normalize(JSON.parse(fs.readFileSync(CONFIG, 'utf8')));
    configError = null;
  } catch (e) {
    configError = `cameras.json non valido: ${e.message}`;
  }
}
loadCameras();

// ---------- ricarico automatico quando cameras.json cambia (il client lo scopre dal polling /api/streams) ----------
let cfgVersion = 0;
let debounce;
let ignoreWatchUntil = 0; // scritture fatte da /api/config: il client ricarica da solo
fs.watch(DATA, { persistent: false }, (_, file) => {
  if (file !== 'cameras.json' || Date.now() < ignoreWatchUntil) return;
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    loadCameras();
    cfgVersion++;
  }, 300);
});

// ---------- flussi ----------
const active = new Map(); // sid -> processo ffmpeg

function startStream(req, res, cam, idx, q) {
  const s = cam.streams[idx];
  if (!s) return send(res, 404, { error: 'flusso inesistente' });

  const w = clamp(Number(q.get('w')) || 640, 160, 1920);
  const fps = clamp(Number(q.get('fps')) || 10, 1, 30);
  const qv = clamp(Number(q.get('q')) || 5, 2, 20);
  const sid = q.get('sid') || Math.random().toString(36).slice(2);

  const args = ['-hide_banner', '-loglevel', 'error', '-fflags', 'nobuffer', '-flags', 'low_delay'];
  if (/^rtsps?:/i.test(s.url)) args.push('-rtsp_transport', 'tcp');
  args.push('-i', s.url, '-an', '-vf', `fps=${fps},scale='min(${w},iw)':-2`, '-q:v', String(qv), '-f', 'mpjpeg', '-boundary_tag', 'ffmpeg', 'pipe:1');

  const ff = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  active.set(sid, ff);

  let started = false;
  let stalled = false;
  let watchdog;
  const arm = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => { stalled = true; ff.kill(); }, STALL_MS);
  };
  arm();

  let lastErr = '';
  ff.stderr.on('data', (d) => (lastErr = d.toString().trim().split('\n').pop()));
  ff.on('error', (e) => {
    if (!started && !res.headersSent) send(res, 500, { error: e.code === 'ENOENT' ? 'ffmpeg non trovato nel PATH' : e.message });
  });
  ff.stdout.on('data', (chunk) => {
    arm();
    if (!started) {
      started = true;
      res.writeHead(200, {
        'Content-Type': 'multipart/x-mixed-replace; boundary=ffmpeg',
        'Cache-Control': 'no-store',
      });
    }
    res.write(chunk);
  });
  ff.on('close', () => {
    clearTimeout(watchdog);
    active.delete(sid);
    if (!started && !res.headersSent) {
      const why = stalled ? 'timeout: nessun dato ricevuto' : lastErr || 'flusso non raggiungibile';
      console.error(`[${cam.name} / ${s.label}] ${why}`);
      send(res, 502, { error: why });
    } else res.end();
  });
  res.on('close', () => ff.kill());
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const parts = [];
    req.on('data', (d) => {
      n += d.length;
      if (n > limit) { reject(new Error('troppo grande')); req.destroy(); }
      else parts.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

const handler = async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  const p = url.pathname;

  // Protezione: le credenziali delle camere passano da qui. Blocco altri siti (Origin) e DNS rebinding (Host).
  const origin = req.headers.origin;
  if (!HOSTS.has(req.headers.host) || (origin && !originOk(origin))) {
    console.error(`[403] ${req.method} ${req.url} origin=${origin} host=${req.headers.host}`);
    res.writeHead(403);
    return res.end();
  }
  if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  if (req.method !== 'GET') console.log(`[${req.method}] ${p} origin=${origin} host=${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET,PUT,POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Private-Network': 'true' });
    return res.end();
  }

  if (p === '/api/cameras') {
    loadCameras(); // rilegge sempre il file: il tasto Aggiorna non dipende da fs.watch
    // gli URL (con le credenziali) non escono mai dal backend
    return send(res, 200, {
      file: CONFIG,
      hosts: boundHosts,
      error: configError,
      cameras: cameras.map((c) => ({ id: c.id, name: c.name, streams: c.streams.map((s) => s.label), rev: rev(c) })),
    });
  }

  if (p === '/api/config') {
    if (req.method === 'PUT' || req.method === 'POST') { // POST: richiesta semplice, nessun preflight CORS
      try {
        const cfg = validateConfig(JSON.parse(await readBody(req)));
        if (fs.existsSync(CONFIG)) fs.copyFileSync(CONFIG, CONFIG + '.bak');
        ignoreWatchUntil = Date.now() + 1500;
        fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
        loadCameras();
        return send(res, 200, { ok: true });
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }
    const text = fs.readFileSync(CONFIG, 'utf8');
    try { return send(res, 200, { config: JSON.parse(text), file: CONFIG }); } catch (e) { return send(res, 200, { error: e.message, text, file: CONFIG }); }
  }

  if (p === '/api/state') {
    if (req.method === 'PUT' || req.method === 'POST') { // POST: richiesta semplice, nessun preflight CORS
      try {
        const body = JSON.parse(await readBody(req));
        fs.writeFileSync(STATE, JSON.stringify(body, null, 2));
        return send(res, 200, { ok: true });
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }
    try { return send(res, 200, JSON.parse(fs.readFileSync(STATE, 'utf8'))); } catch { return send(res, 200, {}); }
  }

  if (p === '/api/streams') return send(res, 200, { sids: [...active.keys()], cfg: cfgVersion });

  const m = /^\/stream\/([^/]+)\/(\d+)$/.exec(p);
  if (m) {
    const cam = cameras.find((c) => c.id === decodeURIComponent(m[1]));
    if (!cam) return send(res, 404, { error: 'telecamera inesistente' });
    return startStream(req, res, cam, Number(m[2]), url.searchParams);
  }

  // file statici (utile per provare l'interfaccia in un normale browser)
  const file = path.join(WEB, p === '/' ? 'index.html' : p);
  if (!file.startsWith(WEB + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, { error: 'not found' });
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
};

for (const addr of ADDRS) {
  const srv = http.createServer(handler);
  srv.on('error', (e) => {
    if (addr === HOST) { console.error('Impossibile avviare il backend:', e.message); process.exit(1); }
    console.warn(`indirizzo ${addr} non disponibile (${e.code}), ignorato`);
  });
  srv.listen(PORT, addr, () => {
    boundHosts.push(addr);
    if (addr === HOST) console.log(`Cams backend su http://${HOST}:${PORT}  (config: ${CONFIG})`);
  });
}

// un errore imprevisto in una richiesta non deve far cadere il server (e con lui tutti i flussi)
process.on('uncaughtException', (e) => console.error('[errore]', e));
process.on('unhandledRejection', (e) => console.error('[errore]', e));

const bye = () => { for (const ff of active.values()) ff.kill(); process.exit(0); };
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
