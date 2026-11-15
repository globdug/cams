'use strict';
// Consumo dell'app: il totale (cams.exe + ffmpeg + WebView2) sta nella barra in alto, il dettaglio per processo si apre con un clic.
const uBtn = $('usage');
const uPop = $('usagePop');
let uData = null; // ultima risposta di /api/usage

const fmtMem = (b) => (b >= 2 ** 30 ? (b / 2 ** 30).toFixed(2) + ' GB' : Math.round(b / 2 ** 20) + ' MB');
const fmtCpu = (v) => (v == null ? '—' : v.toFixed(1) + '%');

function procName(p) {
  if (p.kind === 'ffmpeg') return `ffmpeg · ${p.name} · ${p.label}`;
  if (p.kind === 'webview') return `WebView2 (interfaccia) ×${p.n}`;
  if (p.kind === 'console') return `conhost.exe (console degli ffmpeg) ×${p.n}`;
  return p.name;
}

// ordinamento dell'elenco (clic sull'intestazione), salvato nello stato: key null = ordine del backend (cams.exe, ffmpeg per telecamera, resto)
const SORTS = [['name', 'Processo', 1], ['cpu', 'CPU', -1], ['mem', 'RAM', -1]]; // chiave, titolo, direzione al primo clic
const sortVal = { name: procName, cpu: (p) => p.cpu ?? -1, mem: (p) => p.mem };

function sortedProcs() {
  const { key, dir } = state.usort || {};
  if (!key) return uData.procs;
  const val = sortVal[key];
  return [...uData.procs].sort((a, b) => {
    const x = val(a), y = val(b);
    return dir * (typeof x === 'string' ? x.localeCompare(y, 'it', { numeric: true }) : x - y);
  });
}

function sortBy(key, first) {
  const cur = state.usort || {};
  state.usort = { key, dir: cur.key === key ? -cur.dir : first };
  save();
  renderUsage();
}

function renderUsage() {
  if (!uData) return;
  uBtn.textContent = `CPU ${fmtCpu(uData.total.cpu)} · RAM ${fmtMem(uData.total.mem)}`;
  if (uPop.hidden) return;
  const row = (cls, name, pid, cpu, mem) => el('div', { className: 'row ' + cls },
    el('span', { className: 'nm' }, name, pid ? el('span', { className: 'dim', textContent: ' pid ' + pid }) : ''),
    el('span', { textContent: cpu }), el('span', { textContent: mem }));
  const cur = state.usort || {};
  const head = el('div', { className: 'row head' }, ...SORTS.map(([key, title, first]) => el('span', {
    className: 'sort' + (cur.key === key ? ' on' : ''),
    textContent: title + (cur.key === key ? (cur.dir > 0 ? ' ▲' : ' ▼') : ''),
    title: 'Ordina per ' + title.toLowerCase(),
    onclick: () => sortBy(key, first),
  })));
  uPop.replaceChildren(
    head,
    ...sortedProcs().map((p) => row('', procName(p), p.pid, fmtCpu(p.cpu), fmtMem(p.mem))),
    row('tot', 'Totale', 0, fmtCpu(uData.total.cpu), fmtMem(uData.total.mem)),
  );
}

let uBusy = false;
async function pollUsage() {
  if (uBusy || document.hidden) return;
  uBusy = true;
  try {
    uData = await getJSON('/api/usage');
    renderUsage();
  } catch { /* backend non raggiungibile: tengo l'ultimo valore */ }
  uBusy = false;
}

function openUsage() {
  closePicker();
  uPop.hidden = false;
  renderUsage();
  const b = uBtn.getBoundingClientRect();
  uPop.style.top = b.bottom + 4 + 'px';
  uPop.style.right = Math.max(4, innerWidth - b.right) + 'px';
}
const closeUsage = () => { uPop.hidden = true; };

uBtn.onclick = () => { if (uPop.hidden) openUsage(); else closeUsage(); };
// in fase di cattura: chiude il popup anche quando il clic e' su un pulsante che ferma la propagazione (es. "Scegli")
document.addEventListener('click', (e) => { if (!uPop.hidden && !uPop.contains(e.target) && e.target !== uBtn) closeUsage(); }, true);
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !uPop.hidden) closeUsage(); });

setInterval(pollUsage, 2000);
pollUsage();
