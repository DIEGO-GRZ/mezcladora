'use strict';
// Pantalla de configuración: cambio de teclas. Usa Teclas (teclas.js) y funciones de mezcladora.js ($, toast, panic, decks, renderMark).

const tec = {
  captura: null,     // { clave, boton } mientras se espera la tecla nueva
  pendiente: null,   // { clave, tecla } si la tecla elegida está ocupada y falta confirmar el intercambio
};

function renderTeclas() {
  // Distribuciones
  $('#tecPresets').innerHTML = Object.entries(Teclas.PRESETS)
    .map(([id, p]) => `<button data-preset="${id}" class="${id === Teclas.preset ? 'on' : ''}">${p.nombre}</button>`).join('');
  $('#tecEstado').textContent = Teclas.personalizada ? 'con cambios tuyos' : '';
  $('#tecRestaurar').disabled = !Teclas.personalizada;

  const fila = a => {
    const par = Teclas.parDe(a.clave);
    const parNombre = par ? Teclas.PORCLAVE[par].nombre : '';
    const capt = tec.captura?.clave === a.clave;
    return `<div class="tecRow${a.pend ? ' pend' : ''}">
      <span class="tecName">${a.nombre}${par ? `<small>⇧ ${parNombre}</small>` : ''}</span>
      ${a.pend ? `<span class="pendTag" title="La función llega en la etapa ${a.pend}">etapa ${a.pend}</span>` : ''}
      <button class="tecKey${capt ? ' capt' : ''}${Teclas.esCambiada(a.clave) ? ' cambiada' : ''}" data-clave="${a.clave}"
        title="${Teclas.esCambiada(a.clave) ? 'Cambiada por ti. ' : ''}Clic para cambiar">${capt ? 'Presiona…' : Teclas.etiqueta(a.clave)}</button>
    </div>`;
  };
  const de = filtro => Teclas.EDITABLES.filter(filtro).map(fila).join('');
  $('#tecA').innerHTML = de(a => a.deck === 'A');
  $('#tecB').innerHTML = de(a => a.deck === 'B');
  $('#tecG').innerHTML = de(a => !a.deck);
}

function mensajeTeclas(html, tipo = '') {
  const m = $('#tecMsg');
  m.hidden = !html;
  m.className = `tecMsg ${tipo}`;
  m.innerHTML = html || '';
}

function empezarCaptura(clave) {
  tec.pendiente = null;
  tec.captura = { clave };
  mensajeTeclas(`Presiona la tecla nueva para <b>${Teclas.nombreCompleto(clave)}</b>. Clic otra vez en el botón para cancelar.`, 'info');
  renderTeclas();
}

function cancelarCapturaTeclas() {
  if (!tec.captura && !tec.pendiente) return;
  tec.captura = null; tec.pendiente = null;
  mensajeTeclas('');
  renderTeclas();
}

// Tras cualquier cambio: etiquetas de toda la app, mensajes de marca y la tabla
function teclasCambiadas() {
  Teclas.pintar();
  Object.values(decks).forEach(renderMark);
  renderTeclas();
}

function intentarAsignar(clave, tecla, intercambiar) {
  const r = Teclas.asignar(clave, tecla, intercambiar);
  if (r.ok) {
    tec.captura = null; tec.pendiente = null;
    mensajeTeclas('');
    teclasCambiadas();
    toast(`${Teclas.nombreCompleto(clave)}: ${Teclas.etiqueta(clave)}`);
    return;
  }
  if (r.error) {
    tec.pendiente = null;
    mensajeTeclas(`${r.error} Presiona otra tecla o clic en el botón para cancelar.`, 'err');
    return;
  }
  // Ocupada: preguntar si se intercambia
  tec.captura = null;
  tec.pendiente = { clave, tecla };
  const quien = [...new Set(r.conflictos.map(c => `<b>${c.nombre}</b>`))].join(' y ');
  mensajeTeclas(`Esa tecla ya es de ${quien}.
    <button class="btn sm" id="tecSwap">Intercambiar</button><button class="btn sm" id="tecNo">Cancelar</button>`);
  renderTeclas();
}

// Captura de la tecla nueva: va antes que el teclado de la mezcladora y lo bloquea mientras dura
window.addEventListener('keydown', e => {
  if (!tec.captura) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (e.code === 'Escape') { cancelarCapturaTeclas(); panic(); return; } // Esc siempre es Pánico
  if (e.repeat || Teclas.esModificador(e)) return; // espera la tecla real (Shift solo no cuenta)
  const motivo = Teclas.motivoNoValida(e);
  if (motivo) { mensajeTeclas(`${motivo}. Presiona otra tecla o clic en el botón para cancelar.`, 'err'); return; }
  intentarAsignar(tec.captura.clave, { code: e.code, shift: e.shiftKey }, false);
}, true);

$('#cfg').addEventListener('click', e => {
  const k = e.target.closest('.tecKey');
  if (k) {
    if (tec.captura?.clave === k.dataset.clave) cancelarCapturaTeclas();
    else empezarCaptura(k.dataset.clave);
    return;
  }
  const p = e.target.closest('[data-preset]');
  if (p && p.dataset.preset !== Teclas.preset) {
    if (Teclas.personalizada && !confirm('Se perderán las teclas que cambiaste. ¿Cambiar de distribución?')) return;
    cancelarCapturaTeclas();
    Teclas.usarPreset(p.dataset.preset);
    teclasCambiadas();
    toast(`Distribución: ${Teclas.PRESETS[Teclas.preset].nombre}`);
    return;
  }
  if (e.target.id === 'tecSwap' && tec.pendiente) {
    const { clave, tecla } = tec.pendiente;
    intentarAsignar(clave, tecla, true);
    return;
  }
  if (e.target.id === 'tecNo') cancelarCapturaTeclas();
});

$('#tecRestaurar').addEventListener('click', () => {
  if (!confirm(`¿Volver a la distribución ${Teclas.PRESETS[Teclas.preset].nombre} original? Se pierden tus cambios.`)) return;
  cancelarCapturaTeclas();
  Teclas.usarPreset(Teclas.preset);
  teclasCambiadas();
});

document.addEventListener('config:abierta', renderTeclas);
document.addEventListener('config:cerrada', cancelarCapturaTeclas);
