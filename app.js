'use strict';

/* ===================== ESTADO Y PERSISTENCIA LOCAL ===================== */

const LS = { data: 'agenda.days', dirty: 'agenda.dirty', since: 'agenda.since', cfg: 'agenda.cfg', last: 'agenda.lastSync' };
const AVISOS = [
  ['', 'Sin aviso', '—'],
  ['0', 'A la hora', '0′'],
  ['5', '5 min antes', '5′'],
  ['10', '10 min antes', '10′'],
  ['15', '15 min antes', '15′'],
  ['30', '30 min antes', '30′'],
  ['60', '1 hora antes', '1 h'],
  ['120', '2 horas antes', '2 h'],
  ['1440', '1 día antes', '1 d']
];
const PERIODOS = [['m', '☀️', 'Mañana', 'hasta 12:00'], ['t', '🌤️', 'Tarde', '12:00 a 19:00'], ['n', '🌙', 'Noche', 'desde 19:00']];
const POLL_MS = 60000;
const DEBOUNCE_MS = 1200;

const S = {
  days: leer(LS.data, {}),
  dirty: leer(LS.dirty, {}),
  since: leer(LS.since, 0),
  cfg: leer(LS.cfg, { url: '', key: '' }),
  lastSync: leer(LS.last, 0),
  actual: hoyStr(),
  calMes: null,
  syncing: false,
  pendienteOtra: false,
  error: '',
  editId: null
};

function leer(k, def) {
  try { const v = localStorage.getItem(k); return v === null ? def : JSON.parse(v); } catch (e) { return def; }
}
function escribir(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { setEstado('err', 'Almacenamiento local lleno'); }
}
function persistir() {
  escribir(LS.data, S.days);
  escribir(LS.dirty, S.dirty);
  escribir(LS.since, S.since);
  escribir(LS.last, S.lastSync);
}

/* ===================== FECHAS ===================== */

function pad(n) { return String(n).padStart(2, '0'); }
function fechaStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function hoyStr() { return fechaStr(new Date()); }
function aDate(s) { const p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
function sumarDias(s, n) { const d = aDate(s); d.setDate(d.getDate() + n); return fechaStr(d); }
const may = t => t.charAt(0).toUpperCase() + t.slice(1);
function fechaLarga(s) {
  return may(aDate(s).toLocaleDateString('es-PY', { weekday: 'long', day: 'numeric', month: 'long' }));
}
function relativo(s) {
  const diff = Math.round((aDate(s) - aDate(hoyStr())) / 86400000);
  const anio = aDate(s).getFullYear();
  if (diff === 0) return 'Hoy · ' + anio;
  if (diff === 1) return 'Mañana · ' + anio;
  if (diff === -1) return 'Ayer · ' + anio;
  return (diff > 0 ? 'En ' + diff + ' días' : 'Hace ' + (-diff) + ' días') + ' · ' + anio;
}

/* ===================== MODELO ===================== */

function periodoDeHora(t) { const h = Number(t.slice(0, 2)); return h < 12 ? 'm' : h < 19 ? 't' : 'n'; }
function periodoDe(it) { return it.time ? periodoDeHora(it.time) : (it.period || ''); }
function periodoActual() { return periodoDeHora(pad(new Date().getHours()) + ':00'); }

function diaVacio() { return { note: '', noteUpdatedAt: 0, items: {}, rev: 0 }; }
function getDia(f) { return S.days[f] || diaVacio(); }

function fusionarDia(a, b) {
  a = a || diaVacio(); b = b || diaVacio();
  const out = diaVacio();
  if ((b.noteUpdatedAt || 0) > (a.noteUpdatedAt || 0)) { out.note = b.note; out.noteUpdatedAt = b.noteUpdatedAt; }
  else { out.note = a.note || ''; out.noteUpdatedAt = a.noteUpdatedAt || 0; }
  const ai = a.items || {}, bi = b.items || {};
  for (const id in ai) out.items[id] = ai[id];
  for (const id in bi) {
    if (!out.items[id] || (bi[id].updatedAt || 0) > (out.items[id].updatedAt || 0)) out.items[id] = bi[id];
  }
  out.rev = Math.max(a.rev || 0, b.rev || 0);
  return out;
}

function itemsVisibles(f) {
  const items = Object.values(getDia(f).items).filter(i => !i.deleted);
  items.sort((x, y) => {
    if (x.time && y.time) return x.time.localeCompare(y.time) || (x.createdAt - y.createdAt);
    if (x.time) return -1;
    if (y.time) return 1;
    return (x.createdAt || 0) - (y.createdAt || 0);
  });
  return items;
}

function modificar(fecha, fn) {
  const d = S.days[fecha] ? S.days[fecha] : (S.days[fecha] = diaVacio());
  fn(d);
  S.dirty[fecha] = (S.dirty[fecha] || 0) + 1;
  persistir();
  programarSync();
}

function nuevoId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/* ===================== SINCRONIZACIÓN ===================== */

let tSync = null;
function programarSync() {
  renderEstado();
  clearTimeout(tSync);
  tSync = setTimeout(sincronizar, DEBOUNCE_MS);
}

async function api(body) {
  if (!S.cfg.url || !S.cfg.key) throw new Error('Falta configurar URL y clave');
  const r = await fetch(S.cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ key: S.cfg.key }, body)),
    redirect: 'follow'
  });
  const txt = await r.text();
  let j;
  try { j = JSON.parse(txt); } catch (e) { throw new Error('Respuesta no válida del servidor (¿URL o permisos de la implementación?)'); }
  if (!j.ok) throw new Error(j.error || 'Error del servidor');
  return j;
}

async function sincronizar() {
  clearTimeout(tSync);
  if (!S.cfg.url || !S.cfg.key) { renderEstado(); return; }
  if (S.syncing) { S.pendienteOtra = true; return; }
  if (!navigator.onLine) { S.error = 'Sin conexión'; renderEstado(); return; }

  S.syncing = true; renderEstado();
  const enviados = Object.assign({}, S.dirty);
  const changes = {};
  for (const f in enviados) changes[f] = S.days[f] || diaVacio();

  try {
    const res = await api({ action: 'sync', since: S.since, changes });
    let afectaVista = false;
    for (const f in res.days) {
      S.days[f] = fusionarDia(S.days[f], res.days[f]);
      if (f === S.actual) afectaVista = true;
    }
    for (const f in enviados) if (S.dirty[f] === enviados[f]) delete S.dirty[f];
    S.since = res.now;
    S.lastSync = Date.now();
    S.error = '';
    persistir();
    if (afectaVista) render(false);
    else if (!document.getElementById('calendario').hidden) renderCalendario();
  } catch (e) {
    S.error = e.message || String(e);
  } finally {
    S.syncing = false;
    renderEstado();
    if (S.pendienteOtra) { S.pendienteOtra = false; programarSync(); }
  }
}

/* ===================== RENDER ===================== */

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function llenarAvisos(sel, corto) {
  sel.innerHTML = AVISOS.map(a => `<option value="${a[0]}">${corto ? a[2] : a[1]}</option>`).join('');
}
function etiquetaAviso(min) {
  const a = AVISOS.find(x => x[0] === String(min));
  return a ? a[2] : min + '′';
}

function setEstado(cls, txt) {
  const el = $('estado');
  el.className = 'estado ' + cls;
  el.textContent = txt;
}

function renderEstado() {
  const pend = Object.keys(S.dirty).length;
  if (!S.cfg.url || !S.cfg.key) return setEstado('err', 'Sin configurar · solo local');
  if (S.syncing) return setEstado('', 'Sincronizando…');
  if (S.error) return setEstado('err', '⚠ ' + S.error + (pend ? ' · ' + pend + ' pend.' : ''));
  if (pend) return setEstado('pend', '● ' + pend + ' día(s) sin subir');
  if (S.lastSync) {
    const d = new Date(S.lastSync);
    return setEstado('ok', '✓ Drive ' + pad(d.getHours()) + ':' + pad(d.getMinutes()));
  }
  setEstado('', '');
}

function render(forzarNota = true) {
  const f = S.actual;
  $('tituloDia').textContent = fechaLarga(f);
  $('subtituloDia').textContent = relativo(f);
  $('btnTitulo').classList.toggle('es-hoy', f === hoyStr());

  const nota = $('nota');
  if (forzarNota || document.activeElement !== nota) {
    const v = getDia(f).note || '';
    if (nota.value !== v) nota.value = v;
    autoAltura(nota);
  }

  const items = itemsVisibles(f);
  const hechos = items.filter(i => i.done).length;
  $('contador').textContent = items.length ? `(${hechos}/${items.length})` : '';
  const li = i => `
    <li data-id="${esc(i.id)}" class="${i.done ? 'hecho' : ''}">
      <input type="checkbox" ${i.done ? 'checked' : ''} aria-label="Hecho">
      <span class="hora ${i.time ? '' : 'sin'}">${i.time ? esc(i.time) : '—'}</span>
      <span class="txt">${esc(i.text)}</span>
      ${i.time && i.remind !== null && i.remind !== undefined ? `<span class="aviso">🔔 ${esc(etiquetaAviso(i.remind))}</span>` : ''}
    </li>`;
  const ahora = f === hoyStr() ? periodoActual() : '';
  const cuenta = g => g.length ? g.filter(i => i.done).length + '/' + g.length : '';
  let html = PERIODOS.map(([k, ic, nom, rango]) => {
    const g = items.filter(i => periodoDe(i) === k);
    return `<div class="periodo ${k === ahora ? 'actual' : ''}">
      <div class="per-head"><span>${ic}</span><b>${nom}</b><span class="rango">${rango}</span><span class="cnt">${cuenta(g)}</span>
        <button type="button" data-p="${k}" aria-label="Agregar a ${nom}">＋</button></div>
      ${g.length ? `<ul class="lista">${g.map(li).join('')}</ul>` : '<div class="per-vacio">—</div>'}
    </div>`;
  }).join('');
  const sin = items.filter(i => !periodoDe(i));
  if (sin.length) {
    html += `<div class="periodo"><div class="per-head"><span>📌</span><b>Sin horario</b><span class="rango">tocá para asignar período</span><span class="cnt">${cuenta(sin)}</span></div>
      <ul class="lista">${sin.map(li).join('')}</ul></div>`;
  }
  $('periodos').innerHTML = html;
  renderDevo();

  if (!$('calendario').hidden) renderCalendario();
  renderEstado();
}

function renderCalendario() {
  const base = S.calMes || S.actual.slice(0, 7);
  const [y, m] = base.split('-').map(Number);
  const primero = new Date(y, m - 1, 1);
  $('calTitulo').textContent = may(primero.toLocaleDateString('es-PY', { month: 'long', year: 'numeric' }));
  const offset = (primero.getDay() + 6) % 7; // lunes primero
  const inicio = new Date(y, m - 1, 1 - offset);
  const hoy = hoyStr();
  let html = ['L', 'M', 'M', 'J', 'V', 'S', 'D'].map(d => `<span class="dow">${d}</span>`).join('');
  for (let i = 0; i < 42; i++) {
    const d = new Date(inicio); d.setDate(inicio.getDate() + i);
    const f = fechaStr(d);
    const dia = S.days[f];
    const con = dia && ((dia.note && dia.note.trim()) || Object.values(dia.items).some(x => !x.deleted));
    const cls = [d.getMonth() !== m - 1 ? 'otro' : '', f === hoy ? 'hoy' : '', f === S.actual ? 'sel' : '', con ? 'con' : ''].join(' ');
    html += `<button type="button" data-f="${f}" class="${cls}">${d.getDate()}</button>`;
  }
  $('calGrid').innerHTML = html;
}

function autoAltura(t) {
  t.style.height = 'auto';
  t.style.height = Math.max(64, t.scrollHeight + 2) + 'px';
}

function irA(f) {
  S.actual = f;
  S.calMes = f.slice(0, 7);
  periodoPorDefecto();
  render(true);
}

function periodoPorDefecto() {
  if ($('nuevoHora').value) return;
  $('nuevoPeriodo').value = S.actual === hoyStr() ? periodoActual() : 'm';
}

/* ===================== DEVOCIONAL ===================== */

const LS_DEVO = 'agenda.devo', LS_DEVO_CERR = 'agenda.devoCerrado';
let devo = leer(LS_DEVO, null);

async function cargarDevo(forzar) {
  if (!S.cfg.url || !S.cfg.key || !navigator.onLine) return;
  if (!forzar && devo && devo.dia === hoyStr() && Date.now() - devo.at < 3 * 3600e3) return;
  try {
    const r = await api({ action: 'devocional' });
    devo = { at: Date.now(), dia: hoyStr(), fuente: r.fuente || 'Devocional', items: r.items || [] };
    escribir(LS_DEVO, devo);
    renderDevo();
  } catch (e) { /* sin devocional: no bloquea la agenda */ }
}

function renderDevo() {
  const el = $('devo');
  const it = devo && (devo.items || []).find(x => x.d === S.actual);
  if (!it) { el.hidden = true; el.innerHTML = ''; el.dataset.key = ''; return; }
  const key = S.actual + '|' + it.link;
  if (el.dataset.key !== key) {
    el.dataset.key = key;
    el.innerHTML = `<summary><span class="fuente">📖 ${esc(devo.fuente)}</span><span class="dtitulo">${esc(it.title)}</span></summary>
      <p>${esc(it.excerpt)}</p>
      <a class="leer" href="${esc(it.link)}" target="_blank" rel="noopener">Leer completo ↗</a>`;
    el.open = !leer(LS_DEVO_CERR, {})[S.actual];
  }
  el.hidden = false;
}

/* ===================== EVENTOS ===================== */

function iniciar() {
  llenarAvisos($('nuevoAviso'), true);
  llenarAvisos($('itAviso'), false);

  $('btnPrev').onclick = () => irA(sumarDias(S.actual, -1));
  $('btnNext').onclick = () => irA(sumarDias(S.actual, 1));
  $('btnHoy').onclick = () => irA(hoyStr());
  $('btnSync').onclick = () => sincronizar();
  $('btnTitulo').onclick = () => {
    const c = $('calendario');
    c.hidden = !c.hidden;
    S.calMes = S.actual.slice(0, 7);
    if (!c.hidden) renderCalendario();
  };
  const moverMes = n => {
    const [y, m] = (S.calMes || S.actual.slice(0, 7)).split('-').map(Number);
    const d = new Date(y, m - 1 + n, 1);
    S.calMes = d.getFullYear() + '-' + pad(d.getMonth() + 1);
    renderCalendario();
  };
  $('calPrev').onclick = () => moverMes(-1);
  $('calNext').onclick = () => moverMes(1);
  $('calGrid').onclick = e => {
    const b = e.target.closest('button[data-f]');
    if (!b) return;
    irA(b.dataset.f);
    $('calendario').hidden = true;
  };

  // Deslizar para cambiar de día
  let x0 = null, y0 = null;
  document.querySelector('main').addEventListener('touchstart', e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  document.querySelector('main').addEventListener('touchend', e => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 80 && Math.abs(dx) > Math.abs(dy) * 2 && document.activeElement !== $('nota')) {
      irA(sumarDias(S.actual, dx < 0 ? 1 : -1));
    }
  }, { passive: true });

  // Nota del día
  let tNota = null;
  const nota = $('nota');
  nota.addEventListener('input', () => {
    autoAltura(nota);
    const f = S.actual, v = nota.value;
    clearTimeout(tNota);
    tNota = setTimeout(() => modificar(f, d => { d.note = v; d.noteUpdatedAt = Date.now(); }), 500);
  });
  nota.addEventListener('blur', () => {
    if (tNota) { clearTimeout(tNota); tNota = null; }
    const f = S.actual, v = nota.value;
    if ((getDia(f).note || '') !== v) modificar(f, d => { d.note = v; d.noteUpdatedAt = Date.now(); });
  });

  // Devocional: recordar si se cerró ese día
  $('devo').addEventListener('toggle', () => {
    const el = $('devo');
    if (!el.dataset.key) return;
    const m = leer(LS_DEVO_CERR, {});
    if (el.open) delete m[S.actual]; else m[S.actual] = 1;
    const claves = Object.keys(m).sort();
    claves.slice(0, Math.max(0, claves.length - 30)).forEach(k => delete m[k]);
    escribir(LS_DEVO_CERR, m);
  });

  // Nueva actividad
  const hora = $('nuevoHora'), aviso = $('nuevoAviso'), per = $('nuevoPeriodo');
  per.innerHTML = PERIODOS.map(p => `<option value="${p[0]}">${p[1]} ${p[2]}</option>`).join('');
  periodoPorDefecto();
  hora.addEventListener('input', () => {
    aviso.disabled = !hora.value;
    if (!hora.value) aviso.value = '';
    per.disabled = !!hora.value;
    if (hora.value) per.value = periodoDeHora(hora.value); else periodoPorDefecto();
  });
  $('formNuevo').addEventListener('submit', e => {
    e.preventDefault();
    const texto = $('nuevoTexto').value.trim();
    if (!texto) return;
    const now = Date.now();
    const id = nuevoId();
    const it = {
      id, time: hora.value || '', text: texto, done: false,
      period: hora.value ? periodoDeHora(hora.value) : per.value,
      remind: hora.value && aviso.value !== '' ? Number(aviso.value) : null,
      createdAt: now, updatedAt: now, deleted: false
    };
    modificar(S.actual, d => { d.items[id] = it; });
    $('nuevoTexto').value = '';
    hora.value = ''; aviso.value = ''; aviso.disabled = true; per.disabled = false;
    render(false);
  });

  // Períodos: agregar en un período / marcar hecho / editar
  $('periodos').addEventListener('click', e => {
    const bp = e.target.closest('button[data-p]');
    if (bp) {
      hora.value = ''; aviso.value = ''; aviso.disabled = true; per.disabled = false;
      per.value = bp.dataset.p;
      $('nuevoTexto').focus();
      return;
    }
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    const id = li.dataset.id;
    if (e.target.matches('input[type=checkbox]')) {
      const checked = e.target.checked;
      modificar(S.actual, d => { const it = d.items[id]; it.done = checked; it.updatedAt = Date.now(); });
      render(false);
    } else {
      abrirEdicion(id);
    }
  });

  // Diálogo de edición
  $('itPeriodo').innerHTML = PERIODOS.map(p => `<option value="${p[0]}">${p[1]} ${p[2]}</option>`).join('');
  $('itHora').addEventListener('input', () => {
    const h = $('itHora').value;
    $('itAviso').disabled = !h;
    if (!h) $('itAviso').value = '';
    $('itPeriodo').disabled = !!h;
    if (h) $('itPeriodo').value = periodoDeHora(h);
  });
  $('itBorrar').onclick = () => {
    const id = S.editId;
    modificar(S.actual, d => { const it = d.items[id]; it.deleted = true; it.updatedAt = Date.now(); });
    $('dlgItem').close('cancel');
    render(false);
  };
  $('dlgItem').addEventListener('close', () => {
    if ($('dlgItem').returnValue !== 'ok' || !S.editId) { S.editId = null; return; }
    guardarEdicion();
  });

  // Configuración
  $('btnConfig').onclick = () => {
    $('cfgUrl').value = S.cfg.url; $('cfgKey').value = S.cfg.key;
    msgCfg('', '');
    $('dlgConfig').returnValue = '';
    $('dlgConfig').showModal();
  };
  const leerCfg = () => ({ url: $('cfgUrl').value.trim(), key: $('cfgKey').value.trim() });
  const conCfg = async (fn, okTxt) => {
    const prev = S.cfg; S.cfg = leerCfg();
    msgCfg('', 'Procesando…');
    try { await fn(); msgCfg('ok', okTxt); }
    catch (e) { msgCfg('err', e.message); }
    finally { S.cfg = prev; }
  };
  $('cfgProbar').onclick = () => conCfg(() => api({ action: 'ping' }), 'Conexión OK.');
  $('cfgTelegram').onclick = () => conCfg(() => api({ action: 'testTelegram' }), 'Mensaje enviado. Revisá Telegram.');
  $('cfgCompleta').onclick = async () => {
    S.cfg = leerCfg(); escribir(LS.cfg, S.cfg);
    S.since = 0; persistir();
    msgCfg('', 'Descargando…');
    await sincronizar();
    msgCfg(S.error ? 'err' : 'ok', S.error || 'Descarga completa.');
    render(true);
  };
  $('cfgExportar').onclick = () => {
    const blob = new Blob([JSON.stringify({ version: 1, exportado: new Date().toISOString(), days: S.days }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'agenda-' + hoyStr() + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  $('dlgConfig').addEventListener('close', () => {
    if ($('dlgConfig').returnValue !== 'ok') return;
    const nuevo = leerCfg();
    const cambioServidor = nuevo.url !== S.cfg.url;
    S.cfg = nuevo; escribir(LS.cfg, S.cfg);
    if (cambioServidor) {
      // Servidor nuevo: subir todo lo local y bajar todo lo remoto.
      S.since = 0;
      for (const f in S.days) S.dirty[f] = (S.dirty[f] || 0) + 1;
      persistir();
    }
    S.error = '';
    sincronizar();
    cargarDevo(true);
  });

  // Sincronización automática
  setInterval(() => { if (document.visibilityState === 'visible') sincronizar(); }, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (S.actual !== hoyStr() && S._ultimoHoy && S._ultimoHoy !== hoyStr()) irA(hoyStr());
      S._ultimoHoy = hoyStr();
      sincronizar();
      cargarDevo();
    } else if (Object.keys(S.dirty).length) {
      sincronizar();
    }
  });
  S._ultimoHoy = hoyStr();
  window.addEventListener('online', () => { S.error = ''; sincronizar(); });
  window.addEventListener('offline', () => { S.error = 'Sin conexión'; renderEstado(); });

  render(true);
  sincronizar();
  cargarDevo();

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

function msgCfg(cls, txt) { const m = $('cfgMsg'); m.className = 'msg ' + cls; m.textContent = txt; }

function abrirEdicion(id) {
  const it = getDia(S.actual).items[id];
  if (!it) return;
  S.editId = id;
  $('itTexto').value = it.text;
  $('itHora').value = it.time || '';
  $('itAviso').value = it.time && it.remind !== null && it.remind !== undefined ? String(it.remind) : '';
  $('itAviso').disabled = !it.time;
  $('itFecha').value = S.actual;
  $('itHecho').checked = !!it.done;
  $('itPeriodo').value = periodoDe(it) || (S.actual === hoyStr() ? periodoActual() : 'm');
  $('itPeriodo').disabled = !!it.time;
  $('dlgItem').returnValue = '';
  $('dlgItem').showModal();
}

function guardarEdicion() {
  const id = S.editId; S.editId = null;
  const origen = S.actual;
  const actual = getDia(origen).items[id];
  if (!actual) return;
  const texto = $('itTexto').value.trim();
  if (!texto) return;
  const time = $('itHora').value || '';
  const remind = time && $('itAviso').value !== '' ? Number($('itAviso').value) : null;
  const destino = $('itFecha').value || origen;
  const period = time ? periodoDeHora(time) : $('itPeriodo').value;
  const now = Date.now();

  if (destino === origen) {
    modificar(origen, d => Object.assign(d.items[id], { text: texto, time, remind, period, done: $('itHecho').checked, updatedAt: now }));
  } else {
    const nid = nuevoId();
    modificar(origen, d => { d.items[id].deleted = true; d.items[id].updatedAt = now; });
    modificar(destino, d => {
      d.items[nid] = { id: nid, text: texto, time, remind, period, done: $('itHecho').checked, createdAt: actual.createdAt || now, updatedAt: now, deleted: false };
    });
  }
  render(false);
}

document.addEventListener('DOMContentLoaded', iniciar);
