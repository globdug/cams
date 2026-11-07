'use strict';
// Gruppi di telecamere (es. "Casa", "Ufficio"): nome + telecamere scelte. Salvati in state.json; si usano dal menu "Vista".
const G = $('groups');
const gList = $('gList');

// rebuild=false mentre si scrive il nome: aggiorno solo il menu, senza ridisegnare i riquadri
function groupsChanged(rebuild = true) {
  save();
  buildViewMenu();
  if (rebuild) render();
}

function renderGroups() {
  gList.replaceChildren();
  state.groups.forEach((g, gi) => {
    const name = el('input', { className: 'nm', value: g.name, placeholder: 'Nome gruppo (es. Casa, Ufficio)' });
    name.oninput = () => { g.name = name.value; groupsChanged(false); };

    const all = el('button', { textContent: 'Tutte', title: 'Seleziona tutte le telecamere' });
    all.onclick = () => { g.cams = cams.map((c) => c.id); groupsChanged(); renderGroups(); };
    const none = el('button', { textContent: 'Nessuna', title: 'Deseleziona tutte' });
    none.onclick = () => { g.cams = []; groupsChanged(); renderGroups(); };
    const del = el('button', { className: 'del', textContent: '🗑 Elimina', title: 'Elimina il gruppo (le telecamere restano)' });
    del.onclick = () => {
      state.groups.splice(gi, 1);
      if (state.view === 'g:' + g.id) { state.view = 'all'; page = 0; }
      groupsChanged();
      renderGroups();
    };

    const boxes = cams.map((c) => {
      const cb = el('input', { type: 'checkbox', checked: g.cams.includes(c.id) });
      cb.onchange = () => { g.cams = cb.checked ? [...g.cams, c.id] : g.cams.filter((i) => i !== c.id); groupsChanged(); };
      return el('label', {}, cb, c.name);
    });
    gList.append(el('div', { className: 'cam grp' }, el('div', { className: 'row' }, name, all, none, del), el('div', { className: 'cams' }, ...boxes)));
  });
  if (!state.groups.length) gList.append(el('div', { className: 'dim', textContent: 'Nessun gruppo. Premi «Nuovo gruppo», dagli un nome e spunta le telecamere.' }));
}

function openGroups() {
  $('settings').hidden = true;
  G.style.top = $('bar').offsetHeight + 'px';
  G.hidden = false;
  renderGroups();
}
const closeGroups = () => { G.hidden = true; };

$('grp').onclick = () => (G.hidden ? openGroups() : closeGroups());
$('gClose').onclick = closeGroups;
$('gAdd').onclick = () => {
  state.groups.push({ id: 'g' + Math.random().toString(36).slice(2, 8), name: '', cams: [] });
  groupsChanged(false);
  renderGroups();
  const inputs = gList.querySelectorAll('.nm');
  inputs[inputs.length - 1].focus();
  gList.scrollTop = gList.scrollHeight;
};
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !G.hidden) closeGroups(); });

// ---------- selezione al volo (senza creare un gruppo) ----------
const P = $('picker');

// applica le caselle spuntate: la vista diventa "Selezione"
function pickApply() {
  state.sel = [...P.querySelectorAll('input[type=checkbox]')].filter((cb) => cb.checked).map((cb) => cb.dataset.id);
  state.view = 'sel';
  page = 0;
  focus = null;
  save();
  buildViewMenu();
  render();
}

function renderPicker() {
  P.replaceChildren();
  const cur = new Set(viewIds()); // parto dalle telecamere della vista corrente
  const boxes = cams.map((c) => {
    const cb = el('input', { type: 'checkbox', checked: cur.has(c.id) });
    cb.dataset.id = c.id;
    cb.onchange = pickApply;
    return el('label', {}, cb, c.name);
  });
  const setAll = (v) => () => { P.querySelectorAll('input[type=checkbox]').forEach((cb) => (cb.checked = v)); pickApply(); };
  const all = el('button', { textContent: 'Tutte' });
  all.onclick = setAll(true);
  const none = el('button', { textContent: 'Nessuna' });
  none.onclick = setAll(false);

  const name = el('input', { type: 'text', placeholder: 'Nome (es. Casa)' });
  const saveGrp = el('button', { textContent: 'Salva come gruppo', title: 'Crea un gruppo con le telecamere spuntate' });
  saveGrp.onclick = () => {
    const nm = name.value.trim();
    const ids = [...P.querySelectorAll('input[type=checkbox]')].filter((cb) => cb.checked).map((cb) => cb.dataset.id);
    if (!nm || !ids.length) { name.focus(); return; }
    const grp = { id: 'g' + Math.random().toString(36).slice(2, 8), name: nm, cams: ids };
    state.groups.push(grp);
    state.view = 'g:' + grp.id;
    page = 0;
    save();
    buildViewMenu();
    render();
    closePicker();
  };
  P.append(el('div', { className: 'row' }, all, none), ...boxes, el('hr'), el('div', { className: 'dim', textContent: 'Per riusarla: salva la selezione come gruppo.' }), el('div', { className: 'row' }, name, saveGrp));
}

function openPicker() {
  G.hidden = true;
  $('settings').hidden = true;
  renderPicker();
  const b = $('pick').getBoundingClientRect();
  P.style.left = Math.max(4, Math.min(b.left, innerWidth - 250)) + 'px';
  P.style.top = b.bottom + 4 + 'px';
  P.hidden = false;
}
const closePicker = () => { P.hidden = true; };

$('pick').onclick = (e) => { e.stopPropagation(); if (P.hidden) openPicker(); else closePicker(); };
document.addEventListener('click', (e) => { if (!P.hidden && !P.contains(e.target)) closePicker(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !P.hidden) closePicker(); });
