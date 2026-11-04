'use strict';
// Pagina Impostazioni: modifica l'elenco telecamere, importa/esporta cameras.json.
// Lavora su una bozza (draft): nulla cambia finche' non premi Salva.
const S = $('settings');
const sMsg = $('sMsg');
const sList = $('sList');
const sJson = $('sJson');
let draft = [];
let mode = 'list';

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const msg = (t = '', ok = false) => { sMsg.textContent = t; sMsg.className = ok ? 'ok' : ''; };

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

// ---------- bozza <-> JSON ----------
function fromConfig(cfg) {
  const list = Array.isArray(cfg) ? cfg : cfg && cfg.cameras;
  if (!Array.isArray(list)) throw new Error('formato non riconosciuto: serve {"cameras": [ … ]}');
  return list.map((c) => {
    const raw = Array.isArray(c.streams) ? c.streams : Object.keys(c).filter((k) => /^stream\d+$/i.test(k)).sort().map((k) => c[k]);
    return {
      id: c.id,
      name: String(c.name ?? ''),
      streams: raw.map((s) => (typeof s === 'string' ? { label: '', url: s } : { label: s.label || '', url: s.url || '' })),
    };
  });
}

function toConfig() {
  return {
    cameras: draft.map((c) => {
      const name = c.name.trim();
      const o = {};
      if (c.id && c.id !== slugify(name)) o.id = c.id; // camera rinominata: tengo l'id per non perdere ordine e impostazioni
      o.name = name;
      o.streams = c.streams
        .filter((s) => s.url.trim())
        .map((s) => (s.label.trim() ? { label: s.label.trim(), url: s.url.trim() } : s.url.trim()));
      return o;
    }),
  };
}

// ---------- elenco ----------
function renderList() {
  sList.replaceChildren();
  draft.forEach((c, i) => {
    const name = el('input', { className: 'nm', value: c.name, placeholder: 'Nome telecamera' });
    name.oninput = () => (c.name = name.value);
    const del = el('button', { className: 'del', title: 'Elimina telecamera', textContent: '🗑 Elimina' });
    del.onclick = () => { draft.splice(i, 1); renderList(); };
    const card = el('div', { className: 'cam' }, el('div', { className: 'row' }, name, del));

    c.streams.forEach((s, k) => {
      const label = el('input', { className: 'lbl', value: s.label, placeholder: `Flusso ${k + 1}` });
      label.oninput = () => (s.label = label.value);
      const url = el('input', { value: s.url, placeholder: 'rtsp://utente:password@192.168.1.10:554/stream1', spellcheck: false });
      url.oninput = () => (s.url = url.value);
      const rm = el('button', { className: 'del', title: 'Rimuovi flusso', textContent: '✕' });
      rm.onclick = () => { c.streams.splice(k, 1); renderList(); };
      card.append(el('div', { className: 'row' }, el('span', { className: 'idx', textContent: k + 1 }), label, url, rm));
    });

    const add = el('button', { textContent: '＋ Flusso' });
    add.onclick = () => { c.streams.push({ label: '', url: '' }); renderList(); };
    card.append(el('div', { className: 'row' }, add, el('span', { className: 'dim', textContent: 'Il flusso 2 è quello predefinito nella dashboard.' })));
    sList.append(card);
  });

  const addCam = el('button', { textContent: '＋ Aggiungi telecamera' });
  addCam.style.alignSelf = 'flex-start';
  addCam.onclick = () => {
    draft.push({ name: '', streams: [{ label: '', url: '' }, { label: '', url: '' }] });
    renderList();
    sList.scrollTop = sList.scrollHeight;
  };
  sList.append(addCam);
}

function setMode(m, text) {
  mode = m;
  $('tabList').classList.toggle('on', m === 'list');
  $('tabJson').classList.toggle('on', m === 'json');
  sList.hidden = m !== 'list';
  sJson.hidden = m !== 'json';
  if (m === 'list') renderList();
  else sJson.value = text ?? JSON.stringify(toConfig(), null, 2);
}

// dalla scheda JSON alla bozza; false se il testo non e' valido
function syncFromJson() {
  try { draft = fromConfig(JSON.parse(sJson.value)); return true; }
  catch (e) { msg('JSON non valido: ' + e.message); return false; }
}

async function loadDraft() {
  msg();
  try {
    const r = await getJSON('/api/config');
    if (r.error) { draft = []; setMode('json', r.text); msg('cameras.json non è valido: ' + r.error); return; }
    draft = fromConfig(r.config);
    if (draft.length === cams.length) draft.forEach((c, i) => (c.id = cams[i].id)); // stessa posizione = stessa camera
    setMode('list');
  } catch { msg('Server non raggiungibile.'); }
}

// ---------- azioni ----------
async function saveConfig() {
  if (mode === 'json' && !syncFromJson()) return;
  try {
    const r = await fetch(API + '/api/config', { method: 'POST', body: JSON.stringify(toConfig()) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    await load(); // riavvia solo i flussi con URL cambiati
    await loadDraft();
    msg('Salvato.', true);
  } catch (e) {
    if (!(e instanceof TypeError)) return msg('Non salvato: ' + e.message);
    // errore di rete: controllo se almeno la lettura funziona, per capire cosa blocca la scrittura
    let get;
    try { get = 'lettura OK (' + (await fetch(API + '/api/cameras')).status + ')'; } catch (x) { get = 'anche la lettura fallisce'; }
    msg(`Non salvato: ${e.message}. Pagina ${location.origin} → ${API}; ${get}.`);
  }
}

function openSettings() {
  S.style.top = $('bar').offsetHeight + 'px';
  S.hidden = false;
  loadDraft();
}
const closeSettings = () => { S.hidden = true; };

$('cfg').onclick = () => (S.hidden ? openSettings() : closeSettings());
$('sCancel').onclick = closeSettings;
$('sSave').onclick = saveConfig;
$('tabList').onclick = () => { if (mode === 'list' || syncFromJson()) { msg(); setMode('list'); } };
$('tabJson').onclick = () => { if (mode !== 'json') { msg(); setMode('json'); } };

$('imp').onclick = () => $('file').click();
$('file').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const imported = fromConfig(JSON.parse(await f.text()));
    imported.forEach((c) => { c.id ||= cams.find((x) => x.name === c.name)?.id; }); // stessa camera = stesse impostazioni
    draft = imported;
    setMode(mode);
    msg(`Importate ${draft.length} telecamere da ${f.name}. Premi Salva per applicarle.`, true);
  } catch (err) { msg('Importazione fallita: ' + err.message); }
};

$('exp').onclick = () => {
  if (mode === 'json' && !syncFromJson()) return;
  const a = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(toConfig(), null, 2)], { type: 'application/json' })), download: 'cameras.json' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

addEventListener('keydown', (e) => { if (e.key === 'Escape' && !S.hidden) closeSettings(); });
