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
  // corta = para las etiquetas chicas en la esquina de los botones compactos
  const CORTOS = { Espacio: 'Esp', Enter: 'Ent' };
  function etiqueta(clave, corta = false) {
    const t = mapa[clave];
    if (!t) return '';
    const n = nombreCode(t.code);
    return `${t.shift ? '⇧' : ''}${corta ? (CORTOS[n] || n) : n}`;
  }

  // Llena todos los <kbd data-tecla="..."> de la página
  function pintar(raiz = document) {
    raiz.querySelectorAll('kbd[data-tecla]').forEach(el => {
      const txt = el.dataset.tecla === 'panic' ? 'Esc' : etiqueta(el.dataset.tecla, !!el.closest('.mini'));
      el.textContent = txt;
      el.hidden = !txt;
    });
  }

  // ---------- Parejas con Shift ----------
  // La acción con Shift va siempre en la misma tecla que su base: al mover la base, se mueve también
  const PARES = {
    mark: 'clearMark', stemVoz: 'acapella', stemMel: 'instru', stemBajo: 'kick', stemBat: 'hihat',
    cue1: 'saveCue1', cue2: 'saveCue2', cue3: 'saveCue3', cue4: 'saveCue4',
    trans: 'cut', xfLeft: 'xfLeftBig', xfRight: 'xfRightBig', loadA: 'loadB',
  };
  const ES_PAREJA = new Set(Object.values(PARES));
  const parDe = clave => {
    const a = PORCLAVE[clave];
    const p = a && PARES[a.id];
    return p ? (a.deck ? `${a.deck}.${p}` : p) : null;
  };
  // Acciones que se muestran en la pantalla de teclas (las parejas van en la misma fila que su base)
  const EDITABLES = ACCIONES.filter(a => !ES_PAREJA.has(a.id));

  // ---------- Validación ----------
  // Prohibidas: Esc (Pánico), modificadores, teclas de estado y F12 (herramientas de desarrollo)
  const PROHIBIDAS = /^(Escape|Tab|CapsLock|NumLock|ScrollLock|Shift|Control|Alt|Meta|OS|ContextMenu|PrintScreen|Pause|F12|Fn)/;
  // Devuelve null si se puede usar, o el motivo si no
  function motivoNoValida(e) {
    if (e.code === 'Escape') return 'Esc siempre es Pánico';
    if (e.ctrlKey || e.altKey || e.metaKey) return 'Sin Ctrl ni Alt: usa una tecla sola (o con Shift)';
    if (!e.code || PROHIBIDAS.test(e.code)) return 'Esa tecla no se puede usar';
    if (e.key === 'Dead') return 'Esa es una tecla de acento: elige otra';
    return null;
  }
  const esModificador = e => /^(Shift|Control|Alt|Meta|OS)/.test(e.code);

  // ---------- Asignar ----------
  const igual = (x, y) => x && y && x.code === y.code && !!x.shift === !!y.shift;
  // Asigna { code, shift } a una acción. Si la tecla está ocupada devuelve { conflictos } sin cambiar nada,
  // salvo que intercambiar = true: entonces la otra acción se queda con la tecla vieja.
  function asignar(clave, tecla, intercambiar = false) {
    const par = parDe(clave);
    // Las acciones con pareja usan la tecla sola; Shift + esa tecla queda para la pareja
    const nueva = { code: tecla.code, shift: par ? false : !!tecla.shift };
    const objetivos = [[clave, nueva]];
    if (par) objetivos.push([par, { code: nueva.code, shift: true }]);
    const propias = new Set(objetivos.map(o => o[0]));

    const conflictos = [];
    for (const [obj, nb] of objetivos) {
      for (const [otra, t] of Object.entries(mapa)) {
        if (!propias.has(otra) && igual(t, nb)) conflictos.push({ clave: otra, de: obj });
      }
    }
    if (conflictos.length && !intercambiar) {
      return { conflictos: conflictos.map(c => ({ ...c, nombre: nombreCompleto(c.clave) })) };
    }
    // Una pareja con Shift se mueve junto con su base. Si su base no se está moviendo, no se puede quitar sola.
    const seMueveConBase = c => conflictos.some(o => parDe(o.clave) === c.clave);
    const pareja = conflictos.find(c => ES_PAREJA.has(PORCLAVE[c.clave].id) && !seMueveConBase(c));
    if (pareja) return { error: `${etiqueta(pareja.clave)} es "${nombreCompleto(pareja.clave)}". Cambia primero su tecla base.` };

    const nuevos = { ...cambios };
    for (const c of conflictos) {
      if (ES_PAREJA.has(PORCLAVE[c.clave].id)) continue; // ya la mueve su base
      // La otra acción toma la tecla que tenía la nuestra (y su pareja, si la tiene)
      const vieja = mapa[c.de];
      const parOtra = parDe(c.clave);
      nuevos[c.clave] = { code: vieja.code, shift: parOtra ? false : !!vieja.shift };
      if (parOtra) nuevos[parOtra] = { code: vieja.code, shift: true };
    }
    for (const [obj, nb] of objetivos) nuevos[obj] = nb;

    // Protección: nunca dejar dos acciones en la misma tecla
    const prueba = { ...PRESETS[presetActual].mapa };
    for (const [c, t] of Object.entries(nuevos)) prueba[c] = t;
    const vistas = new Map();
    for (const [c, t] of Object.entries(prueba)) {
      const i = idx(t);
      if (vistas.has(i)) return { error: `No se puede intercambiar sin repetir ${t.shift ? '⇧' : ''}${nombreCode(t.code)}. Cambia primero "${nombreCompleto(vistas.get(i))}".` };
      vistas.set(i, c);
    }
    aplicar(presetActual, nuevos);
    guardar();
    return { ok: true };
  }

  function nombreCompleto(clave) {
    const a = PORCLAVE[clave];
    return a ? `${a.nombre}${a.deck ? ` (deck ${a.deck})` : ''}` : clave;
  }

  cargar();

  return {
    ACCIONES, PORCLAVE, PRESETS, EDITABLES,
    accionDe, etiqueta, pintar, leerDistribucion,
    parDe, motivoNoValida, esModificador, asignar, nombreCompleto,
    get preset() { return presetActual; },
    get personalizada() { return Object.keys(cambios).length > 0; },
    // true si la tecla de esa acción es distinta a la de la distribución elegida
    esCambiada: clave => !igual(mapa[clave], PRESETS[presetActual].mapa[clave]),
    mapa: () => ({ ...mapa }),
    // Cambiar de distribución o restaurar la actual borra los cambios sueltos
    usarPreset(p) { if (PRESETS[p]) { aplicar(p, {}); guardar(); } },
  };
})();
