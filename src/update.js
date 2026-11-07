'use strict';
// Aggiornamento dell'app: controllo all'avvio e ogni 6 ore; il pulsante nella barra in basso installa e riavvia.
const updMsg = $('updMsg');
const updBtn = $('updBtn');
let updBusy = false;

function updShow(text, cls = '') {
  updMsg.textContent = text;
  updMsg.className = cls;
}

// manual = true: l'utente ha cliccato sulla versione, quindi mostro anche "aggiornato" e gli errori
async function checkUpdate(manual) {
  if (updBusy) return;
  if (manual) updShow('Controllo…');
  try {
    const r = await fetch(API + '/api/update' + (manual ? '?force=1' : ''));
    const u = await r.json();
    if (!r.ok) throw new Error(u.error || r.status);
    updBtn.hidden = !(u.available && u.canInstall);
    updBtn.textContent = u.available ? `⬆ Installa ${u.latest} e riavvia` : '';
    updBtn.title = u.notes || '';
    if (u.available) updShow(u.canInstall ? `Aggiornamento disponibile: ${u.latest}` : `Disponibile ${u.latest} (installa a mano)`, 'new');
    else updShow(manual ? 'Sei aggiornato' : '');
  } catch (e) {
    updBtn.hidden = true;
    updShow(manual ? 'Controllo non riuscito: ' + (e.message || e) : '', 'err');
  }
}

async function installUpdate() {
  updBusy = true;
  updBtn.disabled = true;
  updShow('Scarico l\'aggiornamento…');
  try {
    const r = await fetch(API + '/api/update', { method: 'POST' });
    const u = await r.json();
    if (!r.ok) throw new Error(u.error || r.status);
    updShow('Riavvio…'); // il backend chiude l'app e rilancia il nuovo exe
  } catch (e) {
    updBusy = false;
    updBtn.disabled = false;
    updShow('Aggiornamento non riuscito: ' + (e.message || e), 'err');
  }
}

updBtn.onclick = installUpdate;
$('ver').onclick = () => checkUpdate(true);
setTimeout(() => checkUpdate(false), 5000);
setInterval(() => checkUpdate(false), 6 * 3600 * 1000);
