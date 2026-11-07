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
