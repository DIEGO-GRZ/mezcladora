'use strict';
// Teclas configurables. Cada acción tiene su propia combinación { code, shift } usando e.code (posición física).
// Las etiquetas de los botones se llenan desde aquí, así siempre muestran la tecla que eligió el usuario.

const Teclas = (() => {
  // Acciones de cada deck. 'pend' = etapa en la que llega (si aún no existe, el botón se ve desactivado).
  const ACCIONES_DECK = [
    { id: 'play', nombre: 'Play / pausa' },
    { id: 'cue', nombre: 'Pre-escucha en audífonos' },
    { id: 'mark', nombre: 'Marcar inicio' },
    { id: 'clearMark', nombre: 'Borrar marca de inicio' },
    { id: 'tomark', nombre: 'Ir al inicio marcado' },
    { id: 'back', nombre: '−5 s', repetible: true },
    { id: 'fwd', nombre: '+5 s', repetible: true },
    { id: 'loop', nombre: 'Loop de 4 tiempos', pend: 4 },
    { id: 'sync', nombre: 'Sync', pend: 3 },
    { id: 'fx', nombre: 'Efecto', pend: 5 },
    { id: 'stemVoz', nombre: 'Stem voz', pend: 2 },
    { id: 'stemMel', nombre: 'Stem melodía', pend: 2 },
    { id: 'stemBajo', nombre: 'Stem bajo', pend: 2 },
    { id: 'stemBat', nombre: 'Stem batería', pend: 2 },
    { id: 'acapella', nombre: 'Acapella', pend: 2 },
    { id: 'instru', nombre: 'Instrumental', pend: 2 },
    { id: 'kick', nombre: 'Kick', pend: 2 },
    { id: 'hihat', nombre: 'HiHat', pend: 2 },
    ...[1, 2, 3, 4].flatMap(n => [
      { id: `cue${n}`, nombre: `Hot cue ${n}`, pend: 4 },
      { id: `saveCue${n}`, nombre: `Guardar hot cue ${n}`, pend: 4 },
    ]),
  ];

  const ACCIONES_GLOBALES = [
    { id: 'trans', nombre: 'Transición' },
    { id: 'cut', nombre: 'Corte instantáneo' },
    { id: 'xfLeft', nombre: 'Crossfader hacia A', repetible: true },
    { id: 'xfRight', nombre: 'Crossfader hacia B', repetible: true },
    { id: 'xfLeftBig', nombre: 'Crossfader hacia A (paso grande)', repetible: true },
    { id: 'xfRightBig', nombre: 'Crossfader hacia B (paso grande)', repetible: true },
    { id: 'fadeDur', nombre: 'Duración de transición' },
    ...['Mezcla larga', 'Corte', 'Filtro', 'Eco de salida', 'Loop y subida', 'Cambio de voz']
      .map((n, i) => ({ id: `estilo${i + 1}`, nombre: `Estilo: ${n}`, pend: 4 })),
    { id: 'black', nombre: 'Video en negro' },
    { id: 'talkover', nombre: 'Bajar la música (mantener)', pend: 6 },
    { id: 'libUp', nombre: 'Biblioteca: subir', repetible: true },
    { id: 'libDown', nombre: 'Biblioteca: bajar', repetible: true },
    { id: 'loadA', nombre: 'Cargar en deck A' },
    { id: 'loadB', nombre: 'Cargar en deck B' },
    { id: 'config', nombre: 'Abrir configuración' },
  ];

  // Lista completa: 'A.play', 'B.play', ..., 'trans', ...
  const ACCIONES = [
    ...['A', 'B'].flatMap(d => ACCIONES_DECK.map(a => ({ ...a, deck: d, clave: `${d}.${a.id}` }))),
    ...ACCIONES_GLOBALES.map(a => ({ ...a, clave: a.id })),
  ];
  const PORCLAVE = Object.fromEntries(ACCIONES.map(a => [a.clave, a]));

  // Esc es siempre Pánico: no se puede reasignar (protección en vivo)
  const FIJAS = { Escape: 'panic' };

  const k = (code, shift = false) => ({ code, shift });
  const L = c => (/^\d$/.test(c) ? `Digit${c}` : `Key${c}`);

  // Globales comunes a las dos distribuciones (transición y crossfader a la derecha)
  const GLOBALES = {
    trans: k('Space'), cut: k('Space', true),
    xfLeft: k('ArrowLeft'), xfRight: k('ArrowRight'), xfLeftBig: k('ArrowLeft', true), xfRightBig: k('ArrowRight', true),
    estilo1: k('F1'), estilo2: k('F2'), estilo3: k('F3'), estilo4: k('F4'), estilo5: k('F5'), estilo6: k('F6'),
    libUp: k('ArrowUp'), libDown: k('ArrowDown'), loadA: k('Enter'), loadB: k('Enter', true),
    config: k('F10'),
  };

  // Distribución del diseño (CLAUDE.md): deck A con la mano izquierda, deck B con la derecha
  const DISENO = {
    ...GLOBALES, fadeDur: k('KeyT'), black: k('KeyB'), talkover: k('IntlBackslash'),
    ...deck('A', { play: 'Q', cue: 'W', mark: 'E', tomark: 'R', back: 'A', fwd: 'S', loop: 'D', sync: 'F', fx: 'G',
      stems: ['Z', 'X', 'C', 'V'], cues: ['1', '2', '3', '4'] }),
    ...deck('B', { play: 'U', cue: 'I', mark: 'O', tomark: 'P', back: 'J', fwd: 'K', loop: 'L', sync: 'Semicolon', fx: 'H',
      stems: ['M', 'Comma', 'Period', 'Slash'], cues: ['7', '8', '9', '0'] }),
  };

  // Distribución zurda: lo que más se usa en vivo, de los dos decks, con la mano izquierda.
  // Fila Q = deck A, fila A = deck B; Z X / C V = adelantar/atrasar; stems, loops y cues B a la derecha.
  const ZURDA = {
    ...GLOBALES, fadeDur: k('KeyT'), black: k('KeyB'), talkover: k('IntlBackslash'),
    ...deck('A', { play: 'Q', cue: 'W', tomark: 'E', mark: 'R', back: 'Z', fwd: 'X', loop: 'M', sync: 'Comma', fx: 'G',
      stems: ['U', 'I', 'O', 'P'], cues: ['1', '2', '3', '4'] }),
    ...deck('B', { play: 'A', cue: 'S', tomark: 'D', mark: 'F', back: 'C', fwd: 'V', loop: 'Period', sync: 'Slash', fx: 'H',
      stems: ['J', 'K', 'L', 'Semicolon'], cues: ['7', '8', '9', '0'] }),
  };

  function deck(d, t) {
    const c = x => (x.length === 1 ? L(x) : x);
    const r = {
      [`${d}.play`]: k(c(t.play)), [`${d}.cue`]: k(c(t.cue)),
      [`${d}.mark`]: k(c(t.mark)), [`${d}.clearMark`]: k(c(t.mark), true),
      [`${d}.tomark`]: k(c(t.tomark)), [`${d}.back`]: k(c(t.back)), [`${d}.fwd`]: k(c(t.fwd)),
      [`${d}.loop`]: k(c(t.loop)), [`${d}.sync`]: k(c(t.sync)), [`${d}.fx`]: k(c(t.fx)),
    };
    ['stemVoz', 'stemMel', 'stemBajo', 'stemBat'].forEach((s, i) => { r[`${d}.${s}`] = k(c(t.stems[i])); });
    ['acapella', 'instru', 'kick', 'hihat'].forEach((s, i) => { r[`${d}.${s}`] = k(c(t.stems[i]), true); });
    t.cues.forEach((n, i) => { r[`${d}.cue${i + 1}`] = k(L(n)); r[`${d}.saveCue${i + 1}`] = k(L(n), true); });
    return r;
  }

  const PRESETS = { zurda: { nombre: 'Zurda', mapa: ZURDA }, diseno: { nombre: 'Diseño (diestra)', mapa: DISENO } };

  // ---------- Estado ----------
  let mapa = {};
  let indice = {}; // 'S+KeyQ' → clave de acción

  const idx = ({ code, shift }) => `${shift ? 'S+' : ''}${code}`;

  function cargar() {
    let guardado = null;
    try { guardado = JSON.parse(localStorage.getItem('cfg:teclas') || 'null'); } catch {}
    // Se parte del preset y encima lo que el usuario cambió (así una acción nueva siempre tiene tecla)
    const base = PRESETS[guardado?.preset] ? guardado.preset : 'zurda';
    aplicar(base, guardado?.cambios || {});
  }

  let presetActual = 'zurda', cambios = {};
  function aplicar(preset, camb) {
    presetActual = preset; cambios = { ...camb };
    mapa = { ...PRESETS[preset].mapa };
    for (const [clave, t] of Object.entries(cambios)) if (PORCLAVE[clave] && t?.code) mapa[clave] = k(t.code, !!t.shift);
    indice = {};
    for (const [clave, t] of Object.entries(mapa)) if (t && !indice[idx(t)]) indice[idx(t)] = clave;
  }
  function guardar() {
    try { localStorage.setItem('cfg:teclas', JSON.stringify({ preset: presetActual, cambios })); } catch {}
  }

  // ---------- Consulta ----------
  // Devuelve la acción para un evento de teclado, o null
  function accionDe(e) {
    if (FIJAS[e.code]) return { clave: FIJAS[e.code], fija: true };
    const clave = indice[idx({ code: e.code, shift: e.shiftKey })];
    return clave ? PORCLAVE[clave] : null;
  }

  // Texto de una tecla según la distribución real del teclado (latinoamericano), con respaldo fijo
  // Teclas sin carácter: siempre el mismo nombre
  const ESPECIALES = {
    Space: 'Espacio', Enter: 'Enter', NumpadEnter: 'Enter', Escape: 'Esc', Tab: 'Tab',
    ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
  };
  // Respaldo si Windows no informa la distribución: teclado latinoamericano
  const LATAM = {
    Semicolon: 'Ñ', Comma: ',', Period: '.', Slash: '-', IntlBackslash: '<', Backquote: '|', Minus: "'", Equal: '¿',
    BracketLeft: '´', BracketRight: '+', Quote: '{', Backslash: '}',
  };
  let layout = null;
  async function leerDistribucion() {
    try { layout = await navigator.keyboard?.getLayoutMap?.(); } catch { layout = null; }
  }
  function nombreCode(code) {
    if (ESPECIALES[code]) return ESPECIALES[code];
    const real = layout?.get?.(code);
    if (real) return real.toUpperCase();
    if (LATAM[code]) return LATAM[code];
    const m = /^(?:Key|Digit)(.)$/.exec(code);
    return m ? m[1] : code;
  }
  function etiqueta(clave) {
    const t = mapa[clave];
    if (!t) return '';
    return `${t.shift ? '⇧' : ''}${nombreCode(t.code)}`;
  }

  // Llena todos los <kbd data-tecla="..."> de la página
  function pintar(raiz = document) {
    raiz.querySelectorAll('kbd[data-tecla]').forEach(el => {
      const txt = el.dataset.tecla === 'panic' ? 'Esc' : etiqueta(el.dataset.tecla);
      el.textContent = txt;
      el.hidden = !txt;
    });
  }

  cargar();

  return {
    ACCIONES, PORCLAVE, PRESETS,
    accionDe, etiqueta, pintar, leerDistribucion,
    get preset() { return presetActual; },
    // Para la pantalla de configuración (siguiente paso)
    mapa: () => ({ ...mapa }),
    usarPreset(p) { if (PRESETS[p]) { aplicar(p, {}); guardar(); } },
    cambiar(clave, tecla) { aplicar(presetActual, { ...cambios, [clave]: tecla }); guardar(); },
  };
})();
