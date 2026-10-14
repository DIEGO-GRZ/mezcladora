'use strict';
const $ = (s, r = document) => r.querySelector(s);

// Las teclas están en teclas.js (configurables; por defecto distribución zurda)

// ---------- Almacenamiento seguro ----------
const store = {
  get(k, def) { try { const v = localStorage.getItem(k); return v === null ? def : JSON.parse(v); } catch { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} }
};

const state = { xf: 0, fade: store.get('cfg:fade', 8), stopOld: store.get('cfg:stopOld', true), trans: null, blackout: false };
const decks = {};
let ctx = null, masterGain, masterOut, masterAnalyser, cueBus, cueAudio, masterAudio = null;
let vwin = null; // ventana de salida de video (segunda pantalla)
const AUDIO_EXT = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus)$/i;
const VIDEO_EXT = /\.(mp4|m4v|webm|mov|mkv|ogv)$/i;

// ---------- Utilidades ----------
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}
const fmt = s => { if (!isFinite(s) || s < 0) s = 0; return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };
const deckLevel = d => d.id === 'A' ? Math.cos(state.xf * Math.PI / 2) : Math.sin(state.xf * Math.PI / 2);
const isOnAir = d => !d.audio.paused && deckLevel(d) > 0.05 && d.vol > 0;
function needTrack(d) { if (!d.file) { toast(`El deck ${d.id} está vacío`); return false; } return true; }

// ---------- Motor de audio ----------
function initAudio() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  ctx = new AudioContext({ latencyHint: 'interactive' });
  masterGain = ctx.createGain();
  masterOut = ctx.createGain(); // solo la usa el pánico
  masterAnalyser = ctx.createAnalyser(); masterAnalyser.fftSize = 1024;
  masterGain.connect(masterOut);
  masterOut.connect(masterAnalyser);
  cueBus = ctx.createGain();

  // Audífonos: bus independiente enviado a su propia salida
  const cueDest = ctx.createMediaStreamDestination();
  cueBus.connect(cueDest);
  cueAudio = new Audio(); cueAudio.srcObject = cueDest.stream; cueAudio.play().catch(() => {});

  // Principal: directo si el navegador permite elegir salida del contexto
  if (typeof ctx.setSinkId === 'function') {
    masterOut.connect(ctx.destination);
  } else {
    const md = ctx.createMediaStreamDestination();
    masterOut.connect(md);
    masterAudio = new Audio(); masterAudio.srcObject = md.stream; masterAudio.play().catch(() => {});
  }

  Object.values(decks).forEach(connectDeck);
  applyCrossfader();
  applyOutputs();
}

function connectDeck(d) {
  d.src = ctx.createMediaElementSource(d.audio);
  d.volGain = ctx.createGain(); d.volGain.gain.value = d.vol;
  d.xfGain = ctx.createGain(); d.xfGain.gain.value = deckLevel(d);
  d.cueGain = ctx.createGain(); d.cueGain.gain.value = d.cue ? 1 : 0;
  // pre = lo que suena del deck: el original o la suma de stems (ver "Stems en vivo")
  d.pre = ctx.createGain();
  d.origGain = ctx.createGain();
  crearGrafoRespaldo(d);
  d.src.connect(d.fb.entrada);
  d.fb.salida.connect(d.origGain).connect(d.pre);
  d.pre.connect(d.volGain).connect(d.xfGain).connect(masterGain);
  d.analyser = ctx.createAnalyser(); d.analyser.fftSize = 1024;
  d.volGain.connect(d.analyser); // medidor del deck: después del volumen, antes del crossfader
  d.pre.connect(d.cueGain).connect(cueBus); // pre-escucha antes del volumen: se oye aunque el fader esté abajo
  crearGrafoStems(d);
}

function holdParam(p) {
  const t = ctx.currentTime;
  if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t);
  else { const v = p.value; p.cancelScheduledValues(0); p.setValueAtTime(v, t); }
}

// ---------- Stems en vivo ----------
// Cada deck tiene un segundo reproductor (d.stemsEl) con stems.opus: 8 canales en un solo archivo, así los
// stems nunca se desfasan entre sí. Canales: 0-1 voz · 2 bajo (mono) · 3 vacío · 4-5 batería · 6-7 melodía.
// El original (d.audio) manda: los stems lo siguen. Mientras no se toque ningún stem suena el original.
const STEMS_BASE = { voz: true, mel: true, bajo: true, bat: true, kick: true, hat: true };
const ACCION_STEM = { stemVoz: 'voz', stemMel: 'mel', stemBajo: 'bajo', stemBat: 'bat', kick: 'kick', hihat: 'hat' };
const NOMBRE_STEM = { voz: 'Voz', mel: 'Melodía', bajo: 'Bajo', bat: 'Batería', kick: 'Kick', hat: 'HiHat' };
const FUNDIDO_STEMS = 0.02; // s: cambio sin clics

function crearGrafoStems(d) {
  d.stemSrc = ctx.createMediaElementSource(d.stemsEl);
  const sp = ctx.createChannelSplitter(8);
  d.stemSrc.connect(sp);
  const estereo = (izq, der) => { const m = ctx.createChannelMerger(2); sp.connect(m, izq, 0); sp.connect(m, der, 1); return m; };
  const g = () => ctx.createGain();
  // Filtros Linkwitz-Riley de 4.º orden (dos Butterworth en cascada): las bandas suman plano
  const lr4 = (tipo, f) => {
    const a = ctx.createBiquadFilter(), b = ctx.createBiquadFilter();
    a.type = b.type = tipo; a.frequency.value = b.frequency.value = f; a.Q.value = b.Q.value = Math.SQRT1_2;
    a.connect(b); return { entrada: a, salida: b };
  };
  d.sg = { voz: g(), mel: g(), bajo: g(), bat: g(), kick: g(), hat: g(), medios: g() };
  d.stemsSum = g();
  d.stemsSum.gain.value = 0;
  // Tomas para medir el desfase real (ver medirDesfase): el original y la suma de stems sin tocar
  d.stTap = g();
  d.anO = ctx.createAnalyser(); d.anO.fftSize = MUESTRAS_DESFASE; d.src.connect(d.anO);
  d.anS = ctx.createAnalyser(); d.anS.fftSize = MUESTRAS_DESFASE; d.stTap.connect(d.anS);

  const vozM = estereo(0, 1), bajoM = estereo(2, 2), batM = estereo(4, 5), melM = estereo(6, 7); // bajo mono a los dos lados
  [vozM, bajoM, batM, melM].forEach(m => m.connect(d.stTap));
  vozM.connect(d.sg.voz).connect(d.stemsSum);
  bajoM.connect(d.sg.bajo).connect(d.stemsSum);
  melM.connect(d.sg.mel).connect(d.stemsSum);
  // Batería: volumen general y luego tres bandas → Kick (<120 Hz), medios, HiHat (>6 kHz)
  const bat = batM.connect(d.sg.bat);
  const bajos = lr4('lowpass', 120), altos = lr4('highpass', 6000);
  const m1 = lr4('highpass', 120), m2 = lr4('lowpass', 6000);
  bat.connect(bajos.entrada); bajos.salida.connect(d.sg.kick).connect(d.stemsSum);
  bat.connect(altos.entrada); altos.salida.connect(d.sg.hat).connect(d.stemsSum);
  bat.connect(m1.entrada); m1.salida.connect(m2.entrada); m2.salida.connect(d.sg.medios).connect(d.stemsSum);

  d.stemsSum.connect(d.pre);
  aplicarStems(d);
}

// ¿La canción del deck tiene stems y ya cargaron?
const tieneStems = d => !!d.stemsUrl;

function reiniciarStems(d) {
  d.st = { ...STEMS_BASE };
  d.stModo = null;        // 'acapella' | 'instru' | null
  d.stPrevio = null;      // estado para volver al quitar acapella/instrumental
}

// Conecta (o quita) el archivo de stems del deck según la canción cargada
function prepararStemsDeck(d, c) {
  const url = c && c.stems === 'listo' && c.clave ? `/stems/${c.clave}/stems.opus` : null;
  if (url === d.stemsUrl) return;
  d.stemsUrl = url;
  // Desfase ya medido para esta canción (si no, se mide al sonar)
  d.stClave = url ? c.clave : null;
  const guardado = url ? store.get(`stoff:${c.clave}`, null) : null;
  // Sin medición previa: un video suele ir ~1 cuadro atrás (≈ -35 ms); un audio, alineado
  d.stOff = typeof guardado === 'number' ? guardado : c?.tipo === 'video' ? -0.035 : 0;
  d.stConfirmado = typeof guardado === 'number' ? 2 : 0;
  d.stIntentos = 0;
  d.stemsEl.pause();
  if (url) {
    d.stemsEl.src = url;
    d.stemsEl.currentTime = d.audio.currentTime || 0;
    if (!d.audio.paused) d.stemsEl.play().catch(() => {});
  } else {
    d.stemsEl.removeAttribute('src');
    d.stemsEl.load();
    reiniciarStems(d);
  }
  aplicarStems(d);
  renderStems(d);
}

function accionStem(d, act) {
  if (!needTrack(d)) return;
  if (!tieneStems(d) && !RESPALDO_POSIBLE.has(act)) {
    const c = lib.canciones.find(x => x.id === d.libId);
    const estado = c?.stems === 'cola' || c?.stems === 'preparando' ? 'se están preparando' : `no están preparados (${Teclas.etiqueta('prep')} los prepara)`;
    return toast(`Deck ${d.id}: ${act === 'stemMel' ? 'Melodía' : 'Batería'} necesita stems; los de esta canción ${estado}`);
  }
  if (act === 'acapella' || act === 'instru') {
    if (d.stModo === act) {                     // apagar el modo: volver a como estaba
      d.st = d.stPrevio || { ...STEMS_BASE };
      d.stModo = null; d.stPrevio = null;
    } else {
      if (!d.stModo) d.stPrevio = { ...d.st };
      d.stModo = act;
      d.st = act === 'acapella'
        ? { voz: true, mel: false, bajo: false, bat: false, kick: true, hat: true }
        : { ...(d.stPrevio || STEMS_BASE), voz: false };
    }
  } else {
    const k = ACCION_STEM[act];
    d.stModo = null; d.stPrevio = null;         // tocar un stem suelto sale de acapella/instrumental
    d.st[k] = !d.st[k];
  }
  aplicarStems(d);
  renderStems(d);
}

// Lleva los volúmenes de cada stem a su estado; si todo está normal suena el original
function aplicarStems(d) {
  if (!ctx || !d.sg) return;
  aplicarRespaldo(d);
  const t = ctx.currentTime;
  const poner = (param, v) => { holdParam(param); param.setTargetAtTime(v, t, FUNDIDO_STEMS / 3); };
  const s = d.st;
  poner(d.sg.voz.gain, s.voz ? 1 : 0);
  poner(d.sg.mel.gain, s.mel ? 1 : 0);
  poner(d.sg.bajo.gain, s.bajo ? 1 : 0);
  poner(d.sg.bat.gain, s.bat ? 1 : 0);
  poner(d.sg.kick.gain, s.kick ? 1 : 0);
  poner(d.sg.hat.gain, s.hat ? 1 : 0);
  const usarStems = tieneStems(d) && Object.keys(STEMS_BASE).some(k => !s[k]);
  poner(d.stemsSum.gain, usarStems ? 1 : 0);
  poner(d.origGain.gain, usarStems ? 0 : 1);
}

// --- Filtro de respaldo: canciones sin stems ---
// Aproximaciones con filtros sobre el original. Melodía y Batería no se pueden separar sin la IA.
//   Voz / Instrumental → "karaoke": se cancela el centro (L−R), conservando los graves del centro (<200 Hz)
//   Acapella           → centro (L+R) en la banda de la voz (250 Hz – 5 kHz)
//   Bajo → paso alto 150 Hz · Kick → estante grave −30 dB (100 Hz) · HiHat → estante agudo −30 dB (7 kHz)
const RESPALDO_POSIBLE = new Set(['stemVoz', 'stemBajo', 'kick', 'hihat', 'acapella', 'instru']);

function crearGrafoRespaldo(d) {
  const f = (tipo, frec, q = Math.SQRT1_2) => { const b = ctx.createBiquadFilter(); b.type = tipo; b.frequency.value = frec; b.Q.value = q; return b; };
  const g = (v = 1) => { const n = ctx.createGain(); n.gain.value = v; return n; };
  const entrada = g(), sp = ctx.createChannelSplitter(2);
  entrada.connect(sp);
  const aEstereo = mono => { const m = ctx.createChannelMerger(2); mono.connect(m, 0, 0); mono.connect(m, 0, 1); return m; };

  // Centro (L+R)/2 y lados (L−R)
  const centro = g(), lados = g();
  const L = g(0.5), R = g(0.5), Lm = g(1), Rm = g(-1);
  sp.connect(L, 0); sp.connect(R, 1); L.connect(centro); R.connect(centro);
  sp.connect(Lm, 0); sp.connect(Rm, 1); Lm.connect(lados); Rm.connect(lados);

  // Caminos: normal (tal cual), karaoke y acapella; solo uno suena a la vez
  const normal = g(1), karaoke = g(0), acapella = g(0);
  entrada.connect(normal);
  const ladosAgudos = f('highpass', 200), centroGraves = f('lowpass', 200), kSuma = g();
  lados.connect(ladosAgudos).connect(kSuma);
  centro.connect(centroGraves).connect(kSuma);
  aEstereo(kSuma).connect(karaoke);
  const aHp = f('highpass', 250), aLp = f('lowpass', 5000);
  centro.connect(aHp).connect(aLp);
  aEstereo(aLp).connect(acapella);

  // En serie: bajo, kick, hihat (transparentes cuando están apagados)
  const bajo = f('highpass', 10), kick = f('lowshelf', 100), hat = f('highshelf', 7000);
  kick.gain.value = 0; hat.gain.value = 0;
  const suma = g();
  [normal, karaoke, acapella].forEach(n => n.connect(suma));
  suma.connect(bajo).connect(kick).connect(hat);

  d.fb = { entrada, salida: hat, normal, karaoke, acapella, bajo, kick, hat };
}

function aplicarRespaldo(d) {
  if (!d.fb) return;
  const t = ctx.currentTime, k = FUNDIDO_STEMS / 3;
  const poner = (p, v) => { holdParam(p); p.setTargetAtTime(v, t, k); };
  const activo = !tieneStems(d) && !!d.file, s = d.st;
  const acap = activo && d.stModo === 'acapella';
  const kara = activo && !acap && !s.voz;
  poner(d.fb.normal.gain, acap || kara ? 0 : 1);
  poner(d.fb.karaoke.gain, kara ? 1 : 0);
  poner(d.fb.acapella.gain, acap ? 1 : 0);
  poner(d.fb.bajo.frequency, activo && !acap && !s.bajo ? 150 : 10);
  poner(d.fb.kick.gain, activo && !acap && !s.kick ? -30 : 0);
  poner(d.fb.hat.gain, activo && !acap && !s.hat ? -30 : 0);
}

// --- Desfase real entre el original y los stems ---
// Un <video> con imagen entrega su audio unos milisegundos (≈ un cuadro) más tarde de lo que dice su
// currentTime; un <audio> no. Por eso, mientras suena, se compara la onda del original con la suma de stems
// (correlación cruzada en un Web Worker) y se corrige d.stOff. Con 2 confirmaciones se guarda por canción.
const MUESTRAS_DESFASE = 16384;
const correlador = new Worker('correlacion.js');
correlador.onmessage = ({ data: { id, retraso, confianza } }) => {
  const [deck, carga] = id.split(':');
  const d = decks[deck];
  if (!d || Number(carga) !== d.loadId || !d.stemsUrl) return;
  if (confianza < 0.6) return;                      // tramo poco claro (silencio, efectos): no cuenta
  if (Math.abs(retraso) < 0.003) {
    if (++d.stConfirmado >= 2) store.set(`stoff:${d.stClave}`, +d.stOff.toFixed(4));
    return;
  }
  d.stOff += retraso;                               // negativo = los stems iban adelantados
  d.stConfirmado = 0;
  alinearStems(d);
};
function medirDesfase(d) {
  if (d.stConfirmado >= 2 || !d.anO || d.stIntentos > 20) return;
  const ahora = performance.now();
  if (ahora < (d.proxMedida || 0) || Math.abs(d.stemsEl.playbackRate - 1) > 0.002) return;
  d.proxMedida = ahora + 1200;
  d.stIntentos++;
  const o = new Float32Array(MUESTRAS_DESFASE), s = new Float32Array(MUESTRAS_DESFASE);
  d.anO.getFloatTimeDomainData(o);
  d.anS.getFloatTimeDomainData(s);
  correlador.postMessage({ id: `${d.id}:${d.loadId}`, o, s, rate: ctx.sampleRate, maxMs: 80 }, [o.buffer, s.buffer]);
}

function renderStems(d) {
  const hay = tieneStems(d);
  const usable = act => !!d.file && (hay || RESPALDO_POSIBLE.has(act));
  const aprox = act => !hay && RESPALDO_POSIBLE.has(act) ? ' (aproximado: sin stems)' : '';
  for (const [act, k] of Object.entries(ACCION_STEM)) {
    const b = $(`[data-act="${act}"]`, d.el), ok = usable(act);
    b.disabled = !ok;
    b.classList.toggle('mute', ok && !d.st[k]);
    b.classList.toggle('aprox', ok && !hay);
    b.title = ok ? `${NOMBRE_STEM[k]}: ${d.st[k] ? 'suena' : 'apagado'}${aprox(act)}` : `${NOMBRE_STEM[k]}: prepara los stems de esta canción para usarlo`;
  }
  for (const act of ['acapella', 'instru']) {
    const b = $(`[data-act="${act}"]`, d.el), ok = usable(act);
    b.disabled = !ok;
    b.classList.toggle('on', ok && d.stModo === act);
    b.classList.toggle('aprox', ok && !hay);
    b.title = `${act === 'acapella' ? 'Acapella' : 'Instrumental'}${aprox(act)}`;
  }
}

// --- Sincronía: los stems siguen al original ---
// El original (sobre todo un video) tarda en arrancar tras un play o un salto. Los stems esperan quietos
// hasta que el original de verdad suena ('playing') y entonces se alinean y arrancan.
function seguirOriginal(d, ev) {
  if (!d.stemsUrl) return;
  const a = d.audio, s = d.stemsEl;
  if (ev === 'playing') { alinearStems(d); s.play().catch(() => {}); return; }
  s.pause();                                   // play (aún no suena), seeking, pause, ended
  if (ev === 'seeking' || ev === 'play') s.currentTime = Math.max(0, a.currentTime + (d.stOff || 0));
}
function alinearStems(d) {
  d.stemsEl.currentTime = Math.max(0, d.audio.currentTime + (d.stOff || 0));
  d.stemsEl.playbackRate = 1;
  d.desvio = 0;
  d.calmaHasta = performance.now() + 400;      // tras alinear, dejar que se asiente antes de medir
}
// En cada cuadro: desvío pequeño → se corrige acelerando o frenando un poco; grande → salto
function sincronizarStems(d) {
  const a = d.audio, s = d.stemsEl;
  if (!d.stemsUrl || a.paused || a.seeking || a.readyState < 3 || s.readyState < 2) return;
  if (s.paused) { alinearStems(d); s.play().catch(() => {}); return; }
  if (performance.now() < (d.calmaHasta || 0)) return;
  medirDesfase(d);
  const desvio = s.currentTime - (a.currentTime + (d.stOff || 0));
  d.desvio = (d.desvio ?? desvio) * 0.8 + desvio * 0.2; // suavizado: currentTime trae algo de ruido
  if (Math.abs(d.desvio) > 0.04) { alinearStems(d); return; }
  const r = Math.abs(d.desvio) < 0.005 ? 1 : 1 - Math.max(-0.03, Math.min(0.03, d.desvio));
  if (Math.abs(s.playbackRate - r) > 0.0005) s.playbackRate = r;
}

// ---------- Decks ----------
// Botón compacto de deck: la tecla va en una etiqueta chica en la esquina y el nombre completo en el tooltip.
// pend = etapa en la que llega la función (se ve desactivado hasta entonces).
const bot = (id, act, txt, pend) => {
  const nombre = Teclas.PORCLAVE[`${id}.${act}`]?.nombre || txt;
  return `<button class="btn mini" data-act="${act}" title="${nombre}${pend ? ` · llega en la etapa ${pend}` : ''}"${pend ? ` disabled data-pend="${pend}"` : ''}><span>${txt}</span><kbd data-tecla="${id}.${act}"></kbd></button>`;
};

function deckHTML(id) {
  return `
  <div class="dHead">
    <div class="dInfo">
      <div class="dTags"><span class="dId">${id}</span><span class="dState"></span><span class="tag tipo"></span><span class="tag ok stemsTag"></span></div>
      <div class="title">Sin canción</div>
      <div class="sub"></div>
    </div>
    <div class="dBpm" title="BPM y tono llegan con el análisis (etapa 3)">
      <div class="bpm na">—</div>
      <div class="bpmRow"><span class="lbl">BPM</span><span class="keyTag">—</span></div>
    </div>
  </div>
  <div class="drop">Arrastra aquí una canción de la biblioteca o de una carpeta, o haz clic para elegir un archivo</div>
  <input type="file" accept="audio/*,video/*,.mkv,.mov" hidden>
  <div>
    <div class="bar"><div class="fill"></div><div class="mark"></div><div class="head"></div></div>
    <div class="times">
      <span class="mono cur">0:00</span>
      <span class="markinfo"></span>
      <span class="mono rem">-0:00</span>
    </div>
  </div>
  <div class="row8">
    ${bot(id, 'play', '▶ Play')}${bot(id, 'cue', 'Audíf.')}${bot(id, 'mark', 'Marcar')}${bot(id, 'tomark', 'Inicio')}
    ${bot(id, 'back', '−5 s')}${bot(id, 'fwd', '+5 s')}${bot(id, 'loop', 'Loop 4', 4)}${bot(id, 'sync', 'Sync', 3)}
  </div>
  <div class="row8 stems">
    ${bot(id, 'stemVoz', 'Voz')}${bot(id, 'stemMel', 'Melodía')}${bot(id, 'stemBajo', 'Bajo')}${bot(id, 'stemBat', 'Batería')}
    ${bot(id, 'acapella', 'Acapella')}${bot(id, 'instru', 'Instru.')}${bot(id, 'kick', 'Kick')}${bot(id, 'hihat', 'HiHat')}
  </div>
  <div class="row5">
    ${[1, 2, 3, 4].map(n => bot(id, `cue${n}`, `Cue ${n}`, 4)).join('')}${bot(id, 'fx', 'Eco ▾', 5)}
  </div>`;
}

const KNOBS = ['Ganancia', 'Voz', 'Graves', 'Filtro'];
function knobsHTML() {
  return KNOBS.map(k => `<div class="knob" title="Llega en la etapa 4"><svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="16" fill="#1C2027" stroke="#2A2F38" stroke-width="2"/><line x1="20" y1="20" x2="20" y2="7" stroke="var(--c)" stroke-width="3" stroke-linecap="round"/></svg><span class="lbl">${k}</span></div>`).join('');
}

function createDeck(id) {
  const el = $(`.deck[data-deck="${id}"]`);
  el.innerHTML = deckHTML(id);
  $(`.knobs[data-deck="${id}"]`).innerHTML = knobsHTML();
  // Un <video> reproduce tanto audio como video; vive oculto y su imagen se envía a la segunda pantalla
  const audio = document.createElement('video');
  audio.preload = 'auto';
  audio.playsInline = true;
  audio.preservesPitch = true;
  $('#mediaPool').appendChild(audio);
  const stemsEl = document.createElement('audio');
  stemsEl.preload = 'auto';
  stemsEl.preservesPitch = false; // las correcciones de sincronía (±2 %) no se notan y no dejan artefactos
  $('#mediaPool').appendChild(stemsEl);
  const fcol = $(`.fcol[data-deck="${id}"]`);
  const d = { id, el, audio, stemsEl, stemsUrl: null, file: null, key: null, url: null, mark: null, cue: false, vol: 1, loadId: 0, isVideo: false,
    ui: { fill: $('.fill', el), head: $('.bar .head', el), cur: $('.cur', el), rem: $('.rem', el), play: $('[data-act=play] span', el),
      state: $('.dState', el), wave: $(`.waveRow[data-deck="${id}"] .wfill`), vu: $('.vufill', fcol) } };
  decks[id] = d;

  const input = $('input[type=file]', el), drop = $('.drop', el);
  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { if (input.files[0]) loadFile(d, input.files[0]); input.value = ''; });
  // Soltar aquí una fila de la biblioteca o un archivo de una carpeta de Windows
  el.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; el.classList.add('soltar'); });
  el.addEventListener('dragleave', e => { if (!el.contains(e.relatedTarget)) el.classList.remove('soltar'); });
  el.addEventListener('drop', e => {
    e.preventDefault();
    el.classList.remove('soltar');
    const libId = Number(e.dataTransfer.getData(ARRASTRE_BIBLIOTECA));
    if (libId) return soltarDeBiblioteca(d, libId);
    const f = e.dataTransfer.files[0];
    if (f) loadFile(d, f);
  });
  // Clic en botones del deck y en el botón de audífonos del mixer (Shift+clic en Marcar = borrar)
  const alClic = e => {
    const b = e.target.closest('button[data-act]');
    if (!b || b.disabled) return;
    const act = b.dataset.act === 'mark' && e.shiftKey ? 'clearMark' : b.dataset.act;
    deckAction(d, act);
  };
  el.addEventListener('click', alClic);
  $('.headBtn', fcol).addEventListener('click', alClic);
  $('.bar', el).addEventListener('click', e => {
    if (!d.file || !isFinite(audio.duration)) return;
    const r = e.currentTarget.getBoundingClientRect();
    audio.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * audio.duration;
  });
  $('.vol', fcol).addEventListener('input', e => setVol(d, e.target.value / 100));
  ['play', 'pause', 'ended'].forEach(ev => audio.addEventListener(ev, () => { updatePlayBtn(d); renderDeckState(d); avisarMusica(); }));
  audio.addEventListener('durationchange', () => renderMark(d));
  ['play', 'playing', 'pause', 'seeking', 'ended'].forEach(ev => audio.addEventListener(ev, () => seguirOriginal(d, ev)));
  stemsEl.addEventListener('error', () => { if (d.stemsUrl) { toast(`Deck ${id}: no se pudieron leer los stems`); d.stemsUrl = null; aplicarStems(d); renderStems(d); } });
  reiniciarStems(d);
  renderStems(d);
  audio.addEventListener('loadeddata', () => {
    d.isVideo = audio.videoWidth > 0; // confirma si el archivo realmente trae imagen
    renderBadge(d); feedVideo(d); updateVideoOut();
    if (d.libId != null) guardarInfoCancion(d.libId, { duracion: audio.duration, ancho: audio.videoWidth, alto: audio.videoHeight });
  });
  audio.addEventListener('error', () => { if (d.file) toast(`Deck ${id}: no se pudo leer "${d.file.name}"`); });
}

function loadFile(d, file) {
  const isMedia = /^(audio|video)\//.test(file.type) || AUDIO_EXT.test(file.name) || VIDEO_EXT.test(file.name);
  if (!isMedia) return toast('Ese archivo no parece ser audio ni video');
  cargarEnDeck(d, {
    name: file.name, size: file.size, url: URL.createObjectURL(file), blob: true,
    isVideo: file.type.startsWith('video/') || VIDEO_EXT.test(file.name),
  });
}

// Carga una canción de la biblioteca (se sirve desde app://mezcladora/medio/<id>)
function loadTrack(d, c) {
  if (!c || c.falta) { toast('Ese archivo ya no está en su carpeta'); return false; }
  return cargarEnDeck(d, { name: c.nombre, size: c.tamano, url: `/medio/${c.id}`, isVideo: c.tipo === 'video', libId: c.id,
    titulo: c.titulo, artista: c.artista });
}

// m = { name, size, url, isVideo, blob?, libId? }. La marca de inicio se guarda por nombre|tamaño, venga de donde venga.
function cargarEnDeck(d, m) {
  if (isOnAir(d) && !confirm(`El deck ${d.id} está sonando al aire. ¿Reemplazar la canción?`)) {
    if (m.blob) URL.revokeObjectURL(m.url);
    return false;
  }
  d.audio.pause();
  if (d.url && d.urlBlob) URL.revokeObjectURL(d.url);
  const myLoad = ++d.loadId;
  const file = d.file = { name: m.name, size: m.size };
  d.key = `mark:${file.name}|${file.size}`;
  d.url = m.url; d.urlBlob = !!m.blob; d.libId = m.libId ?? null;
  d.mark = store.get(d.key, null);
  reiniciarStems(d);
  d.stemsUrl = '__cambio__'; // fuerza a prepararStemsDeck a actualizar
  prepararStemsDeck(d, m.libId != null ? lib.canciones.find(x => x.id === m.libId) : null);
  d.isVideo = m.isVideo;
  d.audio.src = d.url;
  d.audio.addEventListener('loadedmetadata', () => {
    if (myLoad !== d.loadId) return;
    if (d.mark != null && d.mark < d.audio.duration) d.audio.currentTime = d.mark; // salta el intro
    renderMark(d);
  }, { once: true });

  const t = $('.title', d.el);
  t.textContent = m.titulo || file.name.replace(/\.[^.]+$/, '');
  t.title = file.name;
  $('.sub', d.el).textContent = m.artista || '';
  d.el.classList.add('loaded');
  renderMark(d); updatePlayBtn(d); renderBadge(d); renderDeckState(d); renderStemsTag(d);
  return true;
}
function renderBadge(d) {
  const b = $('.tipo', d.el), h = d.audio.videoHeight;
  b.textContent = !d.file ? '' : d.isVideo ? (h ? `VIDEO ${h}p` : 'VIDEO') : 'AUDIO';
  b.classList.toggle('warn', d.isVideo && h > 0 && h < 720); // se verá borroso en el proyector
}
// AL AIRE / EN AUDÍFONOS junto a la letra del deck
function renderDeckState(d) {
  const s = d.ui.state;
  if (isOnAir(d)) { s.textContent = 'AL AIRE'; s.className = 'dState air'; }
  else if (d.cue) { s.textContent = 'EN AUDÍFONOS'; s.className = 'dState head'; }
  else { s.textContent = ''; s.className = 'dState'; }
}

function deckAction(d, act) {
  initAudio();
  switch (act) {
    case 'play': togglePlay(d); break;
    case 'cue': toggleCue(d); break;
    case 'mark': setMark(d); break;
    case 'clearMark': clearMark(d); break;
    case 'tomark': if (needTrack(d)) d.audio.currentTime = d.mark ?? 0; break;
    case 'back': if (needTrack(d)) d.audio.currentTime = Math.max(0, d.audio.currentTime - 5); break;
    case 'fwd': if (needTrack(d)) d.audio.currentTime = Math.min(d.audio.duration || 0, d.audio.currentTime + 5); break;
    case 'stemVoz': case 'stemMel': case 'stemBajo': case 'stemBat':
    case 'acapella': case 'instru': case 'kick': case 'hihat': accionStem(d, act); break;
    default: avisoPendiente(`${d.id}.${act}`);
  }
}

// Tecla de una función que todavía no existe: avisa en qué etapa llega, sin hacer nada más
function avisoPendiente(clave) {
  const a = Teclas.PORCLAVE[clave];
  if (a?.pend) toast(`${a.deck ? `Deck ${a.deck} · ` : ''}${a.nombre}: llega en la etapa ${a.pend}`);
}

function togglePlay(d) {
  if (!needTrack(d)) return;
  if (d.audio.paused) {
    if (d.audio.ended) d.audio.currentTime = d.mark ?? 0;
    d.audio.play().catch(() => toast(`Deck ${d.id}: no se pudo reproducir`));
  } else d.audio.pause();
}

function toggleCue(d) {
  d.cue = !d.cue;
  if (d.cueGain) d.cueGain.gain.setTargetAtTime(d.cue ? 1 : 0, ctx.currentTime, 0.01);
  $('[data-act=cue]', d.el).classList.toggle('on', d.cue);
  $(`.headBtn[data-deck="${d.id}"]`).classList.toggle('on', d.cue);
  renderDeckState(d);
  if (d.cue && $('#outCue').value === $('#outMaster').value)
    toast('Ojo: audífonos y bocinas usan la misma salida; la pre-escucha se oirá en las bocinas');
}

function setVol(d, v) {
  d.vol = v * v; // curva más natural que la lineal
  if (d.volGain) d.volGain.gain.setTargetAtTime(d.vol, ctx.currentTime, 0.01);
}

function setMark(d) {
  if (!needTrack(d)) return;
  d.mark = Math.round(d.audio.currentTime * 100) / 100;
  store.set(d.key, d.mark);
  renderMark(d);
  toast(`Deck ${d.id}: inicio marcado en ${fmt(d.mark)} (se recordará para esta canción)`);
}
function clearMark(d) {
  if (!needTrack(d)) return;
  d.mark = null; store.del(d.key); renderMark(d);
  toast(`Deck ${d.id}: marca borrada`);
}
function renderMark(d) {
  const m = $('.mark', d.el), info = $('.markinfo', d.el), dur = d.audio.duration;
  if (d.mark != null && isFinite(dur) && dur > 0) {
    m.style.display = 'block'; m.style.left = `${(d.mark / dur) * 100}%`;
    info.textContent = `Inicio ${fmt(d.mark)} · ${Teclas.etiqueta(`${d.id}.clearMark`)} borra`;
  } else {
    m.style.display = 'none';
    info.textContent = d.file ? `Sin marca · ${Teclas.etiqueta(`${d.id}.mark`)} marca el inicio` : '';
  }
}
function updatePlayBtn(d) {
  const playing = !d.audio.paused;
  d.ui.play.textContent = playing ? '⏸ Pausa' : '▶ Play';
  $('[data-act=play]', d.el).classList.toggle('on', playing);
}

// ---------- Crossfader y transiciones ----------
function setXf(x, fromUser) {
  state.xf = Math.min(1, Math.max(0, x));
  $('#xf').value = Math.round(state.xf * 1000);
  if (fromUser) { cancelTransition(); applyCrossfader(); }
  updateOnAir();
}
function applyCrossfader() {
  if (!ctx) return;
  for (const d of Object.values(decks)) { const g = d.xfGain.gain; holdParam(g); g.setTargetAtTime(deckLevel(d), ctx.currentTime, 0.01); }
}
function updateOnAir() {
  const a = deckLevel(decks.A) > 0.3, b = deckLevel(decks.B) > 0.3;
  const txt = a && b ? 'A + B' : a ? 'A' : 'B';
  $('#onair').textContent = `Al aire: ${txt}`;
  decks.A.el.classList.toggle('live', a);
  decks.B.el.classList.toggle('live', b);
  Object.values(decks).forEach(renderDeckState);
  if (!state.trans) $('#autoTxt').textContent = state.xf < 0.5 ? 'TRANSICIÓN A → B' : 'TRANSICIÓN B → A';
  const vs = $('#vidShows'), va = decks.A.isVideo && a, vb = decks.B.isVideo && b;
  vs.textContent = state.blackout ? 'En negro' : va || vb ? `Muestra deck ${va && vb ? 'A + B' : va ? 'A' : 'B'}` : 'Sin video';
  vs.classList.toggle('ok', !state.blackout && (va || vb));
  updateVideoOut();
}

function autoTransition(instant) {
  initAudio();
  if (state.trans) return toast('Ya hay una transición en curso (mueve el crossfader para cancelarla)');
  const from = state.xf < 0.5 ? decks.A : decks.B;
  const to = from === decks.A ? decks.B : decks.A;
  if (!to.file) return toast(`Primero carga una canción en el deck ${to.id}`);
  if (to.audio.ended) to.audio.currentTime = to.mark ?? 0;
  if (to.audio.paused) to.audio.play().catch(() => toast(`Deck ${to.id}: no se pudo reproducir`));
  if (to.vol === 0) toast(`Ojo: el volumen del deck ${to.id} está en cero`);
  const endX = to.id === 'A' ? 0 : 1;

  if (instant) { setXf(endX, true); finishOld(from); return; }

  // Curva de potencia constante programada en el motor de audio
  // (sigue sonando bien aunque cambies de pestaña)
  const startX = state.xf, secs = state.fade, n = 128;
  const ca = new Float32Array(n), cb = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = startX + (endX - startX) * i / (n - 1);
    ca[i] = Math.cos(x * Math.PI / 2); cb[i] = Math.sin(x * Math.PI / 2);
  }
  const t = ctx.currentTime + 0.03;
  [[decks.A, ca], [decks.B, cb]].forEach(([d, c]) => { const g = d.xfGain.gain; holdParam(g); g.setValueCurveAtTime(c, t, secs); });

  const t0 = performance.now();
  const tr = state.trans = { raf: 0, timer: 0 };
  const tick = () => {
    if (state.trans !== tr) return;
    const p = Math.min(1, (performance.now() - t0) / (secs * 1000));
    setXf(startX + (endX - startX) * p, false);
    if (p < 1) tr.raf = requestAnimationFrame(tick);
  };
  tr.raf = requestAnimationFrame(tick);
  tr.timer = setTimeout(() => {
    if (state.trans !== tr) return;
    cancelAnimationFrame(tr.raf); state.trans = null;
    setXf(endX, false); applyCrossfader(); finishOld(from); setTransUI(false);
  }, secs * 1000 + 60);
  setTransUI(true);
}
function cancelTransition() {
  const tr = state.trans; if (!tr) return;
  cancelAnimationFrame(tr.raf); clearTimeout(tr.timer);
  state.trans = null; setTransUI(false);
}
function finishOld(from) { if (state.stopOld && !from.audio.paused) from.audio.pause(); }
function setTransUI(on) {
  $('#autoBtn').classList.toggle('mixing', on);
  if (on) $('#autoTxt').textContent = 'MEZCLANDO…'; else updateOnAir();
}
function cycleFade() {
  const opts = [4, 8, 16, 32];
  state.fade = opts[(opts.indexOf(state.fade) + 1) % opts.length];
  $('#fadeTxt').textContent = `${state.fade} s`; store.set('cfg:fade', state.fade);
  toast(`Duración de transición: ${state.fade} s`);
}

// ---------- Salida de video (segunda pantalla) ----------
// La ventana de video vive en app/video/. El proceso principal la pone a pantalla completa en la pantalla
// externa (o la oculta si no hay). Se abre desde aquí para compartir proceso y pasarle la imagen con captureStream().
const VIDEO_URL = new URL('../video/index.html', location.href).href;
let videoEstado = { conectada: false, nombre: '' };

function abrirVentanaVideo() {
  if (vwin && !vwin.closed) return;
  vwin = window.open(VIDEO_URL, '_blank');
  if (!vwin) toast('No se pudo abrir la ventana de video');
}

// La página de video avisa cuando está lista; entonces le pasamos la imagen de los decks
window.addEventListener('message', e => {
  if (e.origin !== location.origin || e.source !== vwin || e.data !== 'video-listo') return;
  Object.values(decks).forEach(feedVideo);
  updateVideoOut();
});

function mostrarEstadoVideo(estado, avisar) {
  const antes = videoEstado;
  videoEstado = estado || { conectada: false, nombre: '' };
  const b = $('#chipTV');
  $('span', b).textContent = videoEstado.conectada ? `TV · ${videoEstado.nombre}` : 'TV';
  b.title = videoEstado.conectada
    ? `Video en ${videoEstado.nombre} (${videoEstado.ancho}×${videoEstado.alto}). Clic para volver a colocarlo.`
    : 'TV no conectada. Conecta el proyector o la TV en modo "Extender" (Windows + P). Clic para buscarla otra vez.';
  b.classList.toggle('ok', videoEstado.conectada);
  if (!avisar) return;
  if (videoEstado.conectada && !antes.conectada) toast(`Pantalla de video conectada: ${videoEstado.nombre}`);
  else if (!videoEstado.conectada && antes.conectada) toast('Se desconectó la pantalla de video');
}

async function recolocarVideo() {
  abrirVentanaVideo();
  try {
    const estado = await window.mezcladora.video.recolocar();
    mostrarEstadoVideo(estado, false);
    toast(estado.conectada ? `Video en ${estado.nombre}` : 'No detecto segunda pantalla. Conéctala en modo "Extender" (Windows + P)');
  } catch { toast('No se pudo colocar la ventana de video'); }
}

function feedVideo(d) {
  if (!vwin || vwin.closed) return;
  try {
    const v = vwin.document.getElementById(d.id);
    if (!v) return;
    if (!d.isVideo) { v.srcObject = null; return; }
    if (!d.audio.captureStream) return toast('Este navegador no puede enviar video a otra ventana (usa Chrome o Edge)');
    v.srcObject = d.audio.captureStream(); // espejo en vivo del deck, sin audio (la ventana está muda)
    v.play().catch(() => {});
  } catch { toast(`Deck ${d.id}: no se pudo enviar el video a la segunda pantalla`); }
}

function updateVideoOut() {
  if (!vwin || vwin.closed) return;
  try {
    const doc = vwin.document, A = doc.getElementById('A'), B = doc.getElementById('B'), black = doc.getElementById('black');
    if (!A) return;
    const va = decks.A.isVideo, vb = decks.B.isVideo, x = state.xf;
    // B se dibuja encima de A: con los dos en video, B aparece sobre A; si solo uno es video, sale/entra desde negro
    A.style.opacity = va ? (vb ? 1 : 1 - x) : 0;
    B.style.opacity = vb ? x : 0;
    black.style.opacity = state.blackout ? 1 : 0;
  } catch {}
}

function toggleBlackout() {
  state.blackout = !state.blackout;
  $('#blackBtn').classList.toggle('on', state.blackout);
  updateOnAir();
  toast(state.blackout ? 'Pantalla de video en negro' : 'Pantalla de video visible');
}

// ---------- Salidas de audio ----------
function fillSelect(sel, outs, saved) {
  sel.innerHTML = '';
  sel.add(new Option('Predeterminada del sistema', 'default'));
  outs.filter(o => o.deviceId && o.deviceId !== 'default' && o.deviceId !== 'communications')
      .forEach((o, i) => sel.add(new Option(o.label || `Salida ${i + 1}`, o.deviceId)));
  sel.value = [...sel.options].some(o => o.value === saved) ? saved : 'default';
  return saved !== 'default' && sel.value === 'default'; // true = el dispositivo guardado ya no está
}
async function detectDevices(askPermission, fromChange) {
  if (!navigator.mediaDevices?.enumerateDevices) return toast('Este navegador no permite elegir salidas (usa Chrome o Edge)');
  if (askPermission) {
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach(t => t.stop()); }
    catch { toast('Sin permiso: las salidas aparecerán sin nombre'); }
  }
  const outs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput');
  const lostM = fillSelect($('#outMaster'), outs, store.get('cfg:outMaster', 'default'));
  const lostC = fillSelect($('#outCue'), outs, store.get('cfg:outCue', 'default'));
  if (fromChange && (lostM || lostC)) toast('Se desconectó un dispositivo de audio; usando la salida predeterminada');
  renderChipsSalida(fromChange && lostM, fromChange && lostC);
  if (askPermission) toast(`Encontré ${$('#outMaster').options.length - 1} salidas de audio`);
  applyOutputs();
}
// Bocinas / Audífonos en la barra superior: verde = elegida, amarillo = predeterminada o compartida, rojo = se desconectó
const salidasPerdidas = { m: false, c: false };
function renderChipsSalida(perdioM, perdioC) {
  if (perdioM) salidasPerdidas.m = true;
  if (perdioC) salidasPerdidas.c = true;
  const m = $('#outMaster'), c = $('#outCue');
  const nombre = sel => sel.options[sel.selectedIndex]?.text || 'Predeterminada';
  const pinta = (chip, sel, perdida, base) => {
    const def = sel.value === 'default';
    $('span', chip).textContent = perdida ? `${base}: desconectada` : def ? base : nombre(sel);
    chip.title = `${base}: ${def ? 'salida predeterminada de Windows' : nombre(sel)}. Clic para cambiar.`;
    chip.classList.toggle('ok', !perdida && !def);
    chip.classList.toggle('warn', !perdida && def);
    chip.classList.toggle('bad', perdida);
  };
  pinta($('#chipMaster'), m, salidasPerdidas.m, 'Bocinas');
  pinta($('#chipCue'), c, salidasPerdidas.c, 'Audífonos');
  if (!salidasPerdidas.c && c.value === m.value) {
    const chip = $('#chipCue'); chip.classList.remove('ok'); chip.classList.add('warn');
    chip.title = 'Audífonos y bocinas usan la misma salida: la pre-escucha se oirá en las bocinas.';
  }
}

async function applyOutputs() {
  if (!ctx) return;
  const id = v => (!v || v === 'default') ? '' : v;
  const m = $('#outMaster').value, c = $('#outCue').value;
  try {
    if (typeof ctx.setSinkId === 'function') await ctx.setSinkId(id(m));
    else if (masterAudio?.setSinkId) await masterAudio.setSinkId(id(m));
  } catch { toast('No se pudo usar esa salida principal'); }
  try {
    if (cueAudio.setSinkId) await cueAudio.setSinkId(id(c));
  } catch { toast('No se pudo usar esa salida de audífonos'); }
}

// ---------- Biblioteca ----------
// lib.vista = lo que se ve con la categoría y la búsqueda actuales; lib.sel es un índice dentro de la vista
const lib = { canciones: [], carpetas: [], vista: [], sel: 0, cat: store.get('cfg:libCat', 'todo'), q: '' };

// Categorías del diseño; las que aún no existen se ven desactivadas
const CATEGORIAS = [
  { id: 'todo', nombre: 'Todo', filtro: () => true },
  { id: 'video', nombre: 'Videos', filtro: c => c.tipo === 'video' },
  { id: 'audio', nombre: 'Música', filtro: c => c.tipo === 'audio' },
  { id: 'stems', nombre: 'Con stems', filtro: c => c.stems === 'listo' },
  { id: 'listas', nombre: 'Mis listas', pend: 7 },
  { id: 'escena', nombre: 'Lista de escena', pend: 6 },
  { id: 'efectos', nombre: 'Efectos de sonido', pend: 5 },
];

const esc = t => String(t ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
// Para buscar sin importar acentos ni mayúsculas
const plano = t => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const tituloDe = c => c.titulo || c.nombre.replace(/\.[^.]+$/, '');
const carpetaCorta = ruta => String(ruta).split(/[\\/]/).pop();

async function cargarBiblioteca() {
  try {
    [lib.canciones, lib.carpetas] = await Promise.all([window.mezcladora.biblioteca.canciones(), window.mezcladora.biblioteca.carpetas()]);
  } catch { lib.canciones = []; toast('No se pudo leer la biblioteca'); }
  for (const c of lib.canciones) c._busca = plano(`${c.titulo} ${c.artista} ${c.nombre}`);
  filtrarBiblioteca();
}

function filtroActual() {
  if (lib.cat.startsWith('carpeta:')) { const id = Number(lib.cat.slice(8)); return c => c.carpeta_id === id; }
  return (CATEGORIAS.find(k => k.id === lib.cat && k.filtro) || CATEGORIAS[0]).filtro;
}

// Recalcula la vista conservando la canción seleccionada si sigue visible
function filtrarBiblioteca() {
  const antes = lib.vista[lib.sel]?.id;
  const palabras = plano(lib.q).split(/\s+/).filter(Boolean);
  const f = filtroActual();
  lib.vista = lib.canciones.filter(c => f(c) && palabras.every(p => c._busca.includes(p)));
  const i = lib.vista.findIndex(c => c.id === antes);
  lib.sel = i >= 0 ? i : 0;
  renderBiblioteca();
}

async function escanearBiblioteca(avisarSiNada) {
  const b = $('#libScan'); b.disabled = true; b.firstChild.textContent = 'Revisando… ';
  try {
    const r = await window.mezcladora.biblioteca.escanear();
    if (!r) return toast('No se pudo revisar la biblioteca');
    if (r.nuevas || r.faltan) await cargarBiblioteca();
    const partes = [];
    if (r.nuevas) partes.push(`${r.nuevas} nuevas`);
    if (r.faltan) partes.push(`${r.faltan} ya no están`);
    if (r.carpetasNoEncontradas.length) partes.push(`no encontré ${r.carpetasNoEncontradas.join(', ')}`);
    if (partes.length) toast(`Biblioteca: ${partes.join(' · ')}`);
    else if (avisarSiNada) toast('Biblioteca al día');
  } catch { toast('No se pudo revisar la biblioteca'); }
  finally { b.disabled = false; b.firstChild.textContent = 'Actualizar '; }
}

async function agregarCarpetaBiblioteca() {
  try {
    const ruta = await window.mezcladora.biblioteca.agregarCarpeta();
    if (!ruta) return;
    await cargarBiblioteca();
    await escanearBiblioteca(true);
    await cargarBiblioteca();
  } catch { toast('No se pudo agregar la carpeta'); }
}

function guardarInfoCancion(id, info) {
  window.mezcladora.biblioteca.guardarInfo(id, info).then(() => {
    const c = lib.canciones.find(x => x.id === id);
    if (!c) return;
    if (isFinite(info.duracion)) c.duracion = info.duracion;
    if (info.alto > 0) { c.ancho = info.ancho; c.alto = info.alto; }
    renderBiblioteca();
  }).catch(() => {});
}

function renderNav() {
  const cuenta = f => lib.canciones.filter(f).length;
  $('#libCats').innerHTML = CATEGORIAS.map(k => k.pend
    ? `<button class="navItem" disabled title="Llega en la etapa ${k.pend}"><span class="nm">${k.nombre}</span></button>`
    : `<button class="navItem${lib.cat === k.id ? ' on' : ''}" data-cat="${k.id}"><span class="nm">${k.nombre}</span><span class="n">${cuenta(k.filtro)}</span></button>`).join('');
  $('#libFolders').innerHTML = lib.carpetas.map(k => `<button class="navItem${lib.cat === `carpeta:${k.id}` ? ' on' : ''}" data-cat="carpeta:${k.id}" title="${esc(k.ruta)}">
      <span class="nm">${esc(carpetaCorta(k.ruta))}</span><span class="n">${cuenta(c => c.carpeta_id === k.id)}</span></button>`).join('')
    || '<div class="muted small">Sin carpetas</div>';
}

function renderBiblioteca() {
  renderNav();
  const total = lib.canciones.length, n = lib.vista.length;
  $('#libCount').textContent = !total ? '' : n === total ? `${total} archivos` : `${n} de ${total}`;
  const tbody = $('#libRows');
  if (!n) {
    tbody.innerHTML = `<tr><td colspan="9" class="libEmpty">${
      !lib.carpetas.length ? 'Agrega tu carpeta de música con "+ Carpeta".'
      : !total ? 'No encontré canciones ni videos en tus carpetas. Presiona "Actualizar".'
      : lib.q ? `Nada coincide con "${esc(lib.q)}".` : 'No hay nada en esta categoría.'}</td></tr>`;
    return;
  }
  const enDeck = id => ['A', 'B'].filter(k => decks[k]?.libId === id).join('');
  tbody.innerHTML = lib.vista.map((c, i) => {
    const dk = enDeck(c.id);
    const video = c.tipo !== 'video' ? '<td class="tSm na">audio</td>'
      : `<td class="tSm${c.alto && c.alto < 720 ? ' lowres' : ''}">${c.alto ? `${c.alto}p` : 'video'}</td>`;
    return `<tr data-i="${i}" data-id="${c.id}" draggable="${!c.falta}" class="${i === lib.sel ? 'sel' : ''}${c.falta ? ' falta' : ''}${dk ? ' enDeck' : ''}">
      <td class="cDeck ${dk.slice(0, 1)}">${dk}</td>
      <td class="tTit" title="${esc(c.nombre)}">${esc(tituloDe(c))}${c.nombre_manual ? '<span class="manual" title="Corregido a mano">✎</span>' : ''}${c.falta ? ' <span class="tag">NO ENCONTRADO</span>' : ''}</td>
      <td class="tArt">${esc(c.artista)}</td>
      <td class="num">${c.duracion ? fmt(c.duracion) : ''}</td>
      <td class="num na">—</td>
      <td class="tSm na">—</td>
      ${video}
      <td class="tStems">${celdaStems(c)}</td>
      <td class="libLoad"><button class="edit" data-edit title="Corregir título y artista">✎</button><button data-deck="A">A</button><button data-deck="B">B</button></td>
    </tr>`;
  }).join('');
}

// ---------- Stems: estado por canción ----------
function celdaStems(c) {
  if (c.falta) return '';
  const info = (() => { try { return JSON.parse(c.stems_info || 'null'); } catch { return null; } })();
  switch (c.stems) {
    case 'listo': return `<span class="stemSt ok" title="Stems listos${info?.mb ? ` · ${info.mb} MB` : ''}">Listo</span>`;
    case 'cola': return '<button class="stemBtn cola" data-cancel title="Clic para quitar de la cola">En cola</button>';
    case 'preparando': return `<button class="stemBtn cola" data-cancel title="Clic para cancelar">Preparando ${prep.actual?.id === c.id ? `${prep.actual.pct}%` : '…'}</button>`;
    case 'error': return `<button class="stemBtn err" data-prep title="${esc(info?.mensaje || 'Error')} · clic para reintentar">Error</button>`;
    default: return '<button class="stemBtn" data-prep title="Separar voz, melodía, bajo y batería">Preparar</button>';
  }
}

async function prepararCancion(c) {
  if (!c || c.falta) return;
  if (c.stems === 'listo') return toast('Esa canción ya tiene stems');
  if (c.stems === 'cola' || c.stems === 'preparando') return toast('Esa canción ya está en la cola');
  if (!prep.disponible) return toast('El preparador de stems no está instalado (falta preparador/.venv)');
  try {
    const n = await window.mezcladora.preparador.encolar([c.id]);
    if (n) toast(`En cola para stems: ${tituloDe(c)}`);
  } catch { toast('No se pudo poner en la cola'); }
}
async function cancelarPreparacion(c) {
  try { await window.mezcladora.preparador.cancelar(c.id); } catch { toast('No se pudo quitar de la cola'); }
}
function prepararSeleccion() {
  const c = lib.vista[lib.sel];
  if (!c) return toast('No hay ninguna canción elegida');
  prepararCancion(c);
}

// Estado general del preparador → panel de la derecha
let prep = { disponible: true, actual: null, enCola: 0 };
function mostrarPreparador(e) {
  prep = e || prep;
  const panel = $('.prepPanel'), a = prep.actual;
  $('#prepCola').textContent = prep.enCola ? `${prep.enCola} en cola` : '';
  $('#prepTitulo').textContent = !prep.disponible ? 'Preparador no instalado'
    : a ? a.titulo : prep.cargando ? 'Cargando la IA…' : 'Nada en preparación';
  $('#prepFill').style.width = a ? `${a.pct || 0}%` : '0%';
  $('#prepInfo').textContent = a ? `${a.pct || 0}% · ${a.etapa === 'leyendo' ? 'leyendo' : 'GPU'}` : '';
  const enPausa = prep.musica && (a || prep.enCola);
  panel.classList.toggle('pausa', !!enPausa);
  $('#prepNota').textContent = enPausa ? 'En pausa: hay música sonando. Sigue sola al detenerla.' : 'Se pausa sola mientras haya música sonando.';
  // Porcentaje en la fila de la canción que se prepara (sin redibujar toda la tabla)
  if (a) {
    const celda = $(`#libRows tr[data-id="${a.id}"] .tStems button`);
    if (celda) celda.textContent = `Preparando ${a.pct || 0}%`;
  }
}

// Cambio de estado de una canción (en cola, preparando, listo, error)
function alCambiarCancionStems({ id, stems, stems_info }) {
  const c = lib.canciones.find(x => x.id === id);
  if (!c) return;
  c.stems = stems; c.stems_info = stems_info;
  if (stems === 'listo') { toast(`Stems listos: ${tituloDe(c)}`); actualizarEspacio(); }
  if (stems === 'error') toast(`No se pudieron preparar los stems de ${tituloDe(c)}`);
  Object.values(decks).forEach(d => { renderStemsTag(d); if (d.libId === id) prepararStemsDeck(d, c); });
  filtrarBiblioteca();
}

function renderStemsTag(d) {
  const c = d.libId != null && lib.canciones.find(x => x.id === d.libId);
  $('.stemsTag', d.el).textContent = c && c.stems === 'listo' ? 'STEMS LISTOS' : '';
}

// La mezcladora avisa al preparador si hay algo sonando (para pausarse)
let musicaAvisada = null;
function avisarMusica() {
  const sonando = Object.values(decks).some(d => !d.audio.paused);
  if (sonando === musicaAvisada) return;
  musicaAvisada = sonando;
  window.mezcladora.preparador.musica(sonando);
}

function moverSeleccion(delta) {
  const n = lib.vista.length;
  if (!n) return;
  $(`#libRows tr[data-i="${lib.sel}"]`)?.classList.remove('sel');
  lib.sel = Math.max(0, Math.min(n - 1, lib.sel + delta));
  const fila = $(`#libRows tr[data-i="${lib.sel}"]`);
  if (!fila) return;
  fila.classList.add('sel');
  // Desplaza solo la lista (scrollIntoView movería la página entera y los decks saldrían de la vista)
  const wrap = $('.libWrap'), cab = $('.lib thead').offsetHeight;
  if (fila.offsetTop - cab < wrap.scrollTop) wrap.scrollTop = fila.offsetTop - cab;
  else if (fila.offsetTop + fila.offsetHeight > wrap.scrollTop + wrap.clientHeight) wrap.scrollTop = fila.offsetTop + fila.offsetHeight - wrap.clientHeight;
}

function cargarSeleccion(id) {
  const c = lib.vista[lib.sel];
  if (!c) return toast(lib.canciones.length ? 'No hay ninguna canción seleccionada' : 'La biblioteca está vacía');
  if (loadTrack(decks[id], c)) { toast(`Deck ${id}: ${tituloDe(c)}`); renderBiblioteca(); }
}

// --- Búsqueda (solo con el mouse: clic en la caja para escribir, clic fuera para volver) ---
const buscador = $('#libSearch');
function modoBusqueda(on) {
  $('#searchHint').hidden = !on;
  $('#libKeys').hidden = on;
}
buscador.addEventListener('focus', () => modoBusqueda(true));
buscador.addEventListener('blur', () => modoBusqueda(false));
buscador.addEventListener('input', () => { lib.q = buscador.value; filtrarBiblioteca(); $('.libWrap').scrollTop = 0; });
buscador.addEventListener('keydown', e => {
  if (e.code === 'ArrowUp' || e.code === 'ArrowDown') { e.preventDefault(); moverSeleccion(e.code === 'ArrowUp' ? -1 : 1); }
  else if (e.code === 'Enter' || e.code === 'NumpadEnter') {
    e.preventDefault();
    initAudio();
    cargarSeleccion(e.shiftKey ? 'B' : 'A');
    buscador.blur(); // cargar devuelve el teclado a la mezcladora
  }
});

// --- Corregir título y artista ---
let editando = null;
function abrirEditarNombre(c) {
  editando = c;
  $('#nameFile').textContent = `Archivo: ${c.nombre}`;
  $('#nameTitulo').value = tituloDe(c);
  $('#nameArtista').value = c.artista || '';
  $('#nameAuto').disabled = !c.nombre_manual;
  $('#nameDlg').hidden = false;
  $('#nameTitulo').focus();
  $('#nameTitulo').select();
}
function cerrarEditarNombre() {
  editando = null;
  $('#nameDlg').hidden = true;
  document.activeElement?.blur?.();
}
async function guardarNombre(auto) {
  const c = editando;
  if (!c) return;
  const titulo = $('#nameTitulo').value.trim(), artista = $('#nameArtista').value.trim();
  if (!auto && !titulo) { toast('El título no puede quedar vacío'); $('#nameTitulo').focus(); return; }
  try {
    const r = await window.mezcladora.biblioteca.editarNombre(c.id, auto ? {} : { titulo, artista });
    if (!r) throw new Error();
    Object.assign(c, r);
    c._busca = plano(`${c.titulo} ${c.artista} ${c.nombre}`);
    // Si está cargada en un deck, actualizar su encabezado
    for (const d of Object.values(decks)) if (d.libId === c.id) { $('.title', d.el).textContent = c.titulo; $('.sub', d.el).textContent = c.artista; }
    cerrarEditarNombre();
    filtrarBiblioteca();
    toast(auto ? 'Nombre automático restaurado' : 'Nombre corregido');
  } catch { toast('No se pudo guardar el nombre'); }
}
$('#nameOk').addEventListener('click', () => guardarNombre(false));
$('#nameAuto').addEventListener('click', () => guardarNombre(true));
$('#nameCancel').addEventListener('click', cerrarEditarNombre);
$('#nameDlg').addEventListener('mousedown', e => { if (e.target.id === 'nameDlg') cerrarEditarNombre(); });
['#nameTitulo', '#nameArtista'].forEach(s => $(s).addEventListener('keydown', e => {
  if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); guardarNombre(false); }
}));

$('#libRows').addEventListener('click', e => {
  const fila = e.target.closest('tr[data-i]');
  if (!fila) return;
  moverSeleccion(Number(fila.dataset.i) - lib.sel);
  const c = lib.vista[lib.sel];
  if (e.target.closest('[data-edit]')) return abrirEditarNombre(c);
  if (e.target.closest('[data-prep]')) return prepararCancion(c);
  if (e.target.closest('[data-cancel]')) return cancelarPreparacion(c);
  const b = e.target.closest('button[data-deck]');
  if (b) { initAudio(); cargarSeleccion(b.dataset.deck); }
});
$('.libNav').addEventListener('click', e => {
  const b = e.target.closest('[data-cat]');
  if (!b) return;
  lib.cat = b.dataset.cat;
  store.set('cfg:libCat', lib.cat);
  filtrarBiblioteca();
  $('.libWrap').scrollTop = 0;
});
// --- Arrastrar una fila directo a un deck (sin tener que seleccionarla antes) ---
const ARRASTRE_BIBLIOTECA = 'application/x-mezcladora-cancion';
$('#libRows').addEventListener('dragstart', e => {
  const fila = e.target.closest?.('tr[data-i]');
  const c = fila && lib.vista[Number(fila.dataset.i)];
  if (!c || c.falta) return e.preventDefault();
  e.dataTransfer.setData(ARRASTRE_BIBLIOTECA, String(c.id));
  e.dataTransfer.setData('text/plain', tituloDe(c));
  e.dataTransfer.effectAllowed = 'copy';
  fila.classList.add('arrastrando');
});
$('#libRows').addEventListener('dragend', e => e.target.closest?.('tr')?.classList.remove('arrastrando'));
function soltarDeBiblioteca(d, id) {
  initAudio();
  const c = lib.canciones.find(x => x.id === id);
  if (loadTrack(d, c)) { toast(`Deck ${d.id}: ${tituloDe(c)}`); renderBiblioteca(); }
}

$('#libScan').addEventListener('click', () => escanearBiblioteca(true));
$('#libAdd').addEventListener('click', agregarCarpetaBiblioteca);

// ---------- Espacio de los stems ----------
let esp = { items: [], sel: new Set() };
const algoSonando = () => Object.values(decks).some(d => !d.audio.paused);

async function actualizarEspacio() {
  try {
    const r = await window.mezcladora.espacio.resumen();
    if (!r) return;
    const info = $('#espInfo');
    info.textContent = `Stems: ${r.totalMb} MB${r.libreGb != null ? ` · ${r.libreGb} GB libres` : ''}`;
    info.classList.toggle('warn', r.libreGb != null && r.libreGb < 5); // poco espacio: aviso en amarillo
    info.title = `Carpeta: ${r.carpeta}`;
    $('#cfgStems').textContent = r.carpeta;
    return r;
  } catch {}
}

async function abrirEspacio() {
  const r = await actualizarEspacio();
  if (!r) return toast('No se pudo revisar el espacio');
  esp = { items: r.items, sel: new Set() };
  $('#espResumen').textContent = r.items.length
    ? `${r.items.length} canciones con stems · ${r.totalMb} MB en total${r.libreGb != null ? ` · ${r.libreGb} GB libres en el disco` : ''}`
    : 'No hay stems preparados.';
  renderEspacio();
  $('#espDlg').hidden = false;
}

// Estado de cada carpeta: si su canción está cargada en un deck que suena, no se puede borrar
function usoDeck(clave) {
  const d = Object.values(decks).find(x => x.stClave === clave && x.stemsUrl);
  return d ? { deck: d.id, sonando: !d.audio.paused } : null;
}

function renderEspacio() {
  const etiqueta = it => {
    const u = usoDeck(it.clave);
    if (u) return `<span class="est uso">${u.sonando ? `sonando en ${u.deck}` : `cargada en ${u.deck}`}</span>`;
    return { falta: '<span class="est falta">el archivo ya no está</span>', suelta: '<span class="est suelta">sin canción</span>',
      preparando: '<span class="est">preparando</span>' }[it.estado] || '';
  };
  $('#espRows').innerHTML = esp.items.map(it => {
    const bloqueada = it.estado === 'preparando' || usoDeck(it.clave)?.sonando;
    return `<tr><td><input type="checkbox" data-clave="${it.clave}"${esp.sel.has(it.clave) ? ' checked' : ''}${bloqueada ? ' disabled' : ''}></td>
      <td class="tTit">${esc(it.titulo || `(carpeta ${it.clave})`)}</td><td class="tArt">${esc(it.artista)}</td>
      <td>${etiqueta(it)}</td><td class="num">${it.mb} MB</td></tr>`;
  }).join('') || '<tr><td class="libEmpty">Nada que borrar.</td></tr>';
  const mb = esp.items.filter(i => esp.sel.has(i.clave)).reduce((a, i) => a + i.mb, 0);
  const b = $('#espBorrar');
  b.disabled = !esp.sel.size;
  b.textContent = esp.sel.size ? `Borrar ${esp.sel.size} (${Math.round(mb * 10) / 10} MB)` : 'Borrar';
}

function elegirEspacio(filtro) {
  esp.sel = new Set(esp.items.filter(i => filtro(i) && i.estado !== 'preparando' && !usoDeck(i.clave)?.sonando).map(i => i.clave));
  renderEspacio();
}

async function borrarEspacio() {
  const claves = [...esp.sel];
  if (!claves.length) return;
  const mb = esp.items.filter(i => esp.sel.has(i.clave)).reduce((a, i) => a + i.mb, 0);
  if (!confirm(`¿Borrar los stems de ${claves.length} canción(es)? Se liberan ${Math.round(mb * 10) / 10} MB.`)) return;
  // Lo que suena no se toca; lo que solo está cargado se suelta primero (para liberar el archivo)
  const enUso = claves.filter(k => usoDeck(k)?.sonando);
  for (const d of Object.values(decks)) if (d.stClave && claves.includes(d.stClave) && d.audio.paused) prepararStemsDeck(d, null);
  await new Promise(r => setTimeout(r, 300));
  try {
    const r = await window.mezcladora.espacio.borrar(claves, enUso);
    if (!r) throw new Error();
    toast(`Espacio liberado: ${r.liberadoMb} MB${r.fallidas.length ? ` · ${r.fallidas.length} no se pudieron borrar` : ''}`);
  } catch { toast('No se pudieron borrar los stems'); }
  await cargarBiblioteca();
  Object.values(decks).forEach(renderStemsTag);
  await abrirEspacio();
}

async function cambiarCarpetaStems() {
  if (algoSonando()) return toast('Detén la música para cambiar la carpeta de stems');
  // Soltar los stems cargados para que se puedan mover
  const recargar = Object.values(decks).filter(d => d.stemsUrl);
  recargar.forEach(d => prepararStemsDeck(d, null));
  const r = await window.mezcladora.espacio.cambiarCarpeta();
  if (r?.error) toast(r.error);
  else if (r) toast(`Stems en ${r.carpeta}${r.movidas ? ` (${r.movidas} movidos)` : ''}`);
  for (const d of recargar) prepararStemsDeck(d, lib.canciones.find(c => c.id === d.libId));
  actualizarEspacio();
}

$('#libreBtn').addEventListener('click', abrirEspacio);
$('#espCerrar').addEventListener('click', () => { $('#espDlg').hidden = true; });
$('#espDlg').addEventListener('mousedown', e => { if (e.target.id === 'espDlg') $('#espDlg').hidden = true; });
$('#espRows').addEventListener('change', e => {
  const k = e.target.dataset?.clave;
  if (!k) return;
  if (e.target.checked) esp.sel.add(k); else esp.sel.delete(k);
  e.target.blur();
  renderEspacio();
});
$('#espSobrantes').addEventListener('click', () => elegirEspacio(i => i.estado === 'falta' || i.estado === 'suelta'));
$('#espTodas').addEventListener('click', () => elegirEspacio(() => true));
$('#espNinguna').addEventListener('click', () => elegirEspacio(() => false));
$('#espBorrar').addEventListener('click', borrarEspacio);
$('#cfgStemsBtn').addEventListener('click', cambiarCarpetaStems);

// ---------- Pánico ----------
// Esc: fundido a silencio en 2 s en la salida principal, luego pausa todo y deja el volumen listo otra vez
let panico = null;
function panic() {
  initAudio();
  if (panico) return;
  cancelTransition();
  const g = masterOut.gain, t = ctx.currentTime;
  holdParam(g); g.linearRampToValueAtTime(0, t + 2);
  $('#panicBtn').classList.add('on');
  toast('Pánico: bajando todo a silencio');
  panico = setTimeout(() => {
    Object.values(decks).forEach(d => d.audio.pause());
    holdParam(g); g.setValueAtTime(1, ctx.currentTime + 0.05);
    $('#panicBtn').classList.remove('on');
    panico = null;
    toast('Todo en pausa. Presiona Play para volver a empezar.');
  }, 2050);
}

// ---------- Configuración ----------
function abrirConfig(abrir = $('#cfg').hidden) {
  $('#cfg').hidden = !abrir;
  document.dispatchEvent(new Event(abrir ? 'config:abierta' : 'config:cerrada'));
  if (abrir) actualizarEspacio();
}

// ---------- Teclado ----------
document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey) return; // respeta atajos del sistema
  const tag = e.target.tagName;
  if (tag === 'SELECT' || (tag === 'INPUT' && !['range', 'checkbox'].includes(e.target.type))) {
    if (e.code !== 'Escape') return; // escribiendo: solo Pánico sigue activo
  }
  const a = Teclas.accionDe(e);
  if (!a) return;
  e.preventDefault();
  initAudio();
  if (a.clave === 'panic') { if (!e.repeat) panic(); return; }
  if (e.repeat && !a.repetible) return;
  if (a.pend) return avisoPendiente(a.clave);
  if (a.deck) return deckAction(decks[a.deck], a.id);
  switch (a.id) {
    case 'trans': autoTransition(false); break;
    case 'cut': autoTransition(true); break;
    case 'xfLeft': setXf(state.xf - 0.05, true); break;
    case 'xfRight': setXf(state.xf + 0.05, true); break;
    case 'xfLeftBig': setXf(state.xf - 0.2, true); break;
    case 'xfRightBig': setXf(state.xf + 0.2, true); break;
    case 'fadeDur': cycleFade(); break;
    case 'black': toggleBlackout(); break;
    case 'libUp': moverSeleccion(-1); break;
    case 'libDown': moverSeleccion(1); break;
    case 'loadA': cargarSeleccion('A'); break;
    case 'loadB': cargarSeleccion('B'); break;
    case 'config': abrirConfig(); break;
    case 'prep': prepararSeleccion(); break;
  }
});

// ---------- Arranque ----------
createDeck('A'); createDeck('B');

$('#xf').addEventListener('input', e => { initAudio(); setXf(e.target.value / 1000, true); });
$('#autoBtn').addEventListener('click', () => autoTransition(false));
$('#cutBtn').addEventListener('click', () => autoTransition(true));
$('#fadeTxt').textContent = `${state.fade} s`;
$('#fadeBtn').addEventListener('click', cycleFade);
$('#panicBtn').addEventListener('click', panic);
$('#cfgBtn').addEventListener('click', () => abrirConfig(true));
$('#cfgClose').addEventListener('click', () => abrirConfig(false));
$('#cfg').addEventListener('mousedown', e => { if (e.target.id === 'cfg') abrirConfig(false); });
['chipMaster', 'chipCue'].forEach(id => $('#' + id).addEventListener('click', () => abrirConfig(true)));
// Los botones desactivados dicen en qué etapa llegan
document.querySelectorAll('[data-pend]').forEach(b => { b.title = `Llega en la etapa ${b.dataset.pend}`; });
$('#stopOld').checked = state.stopOld;
$('#stopOld').addEventListener('change', e => { state.stopOld = e.target.checked; store.set('cfg:stopOld', state.stopOld); });
$('#detect').addEventListener('click', () => { initAudio(); detectDevices(true); });
$('#chipTV').addEventListener('click', recolocarVideo);
$('#blackBtn').addEventListener('click', toggleBlackout);
['outMaster', 'outCue'].forEach(id => $('#' + id).addEventListener('change', e => {
  store.set('cfg:' + id, e.target.value); initAudio(); applyOutputs();
  salidasPerdidas[id === 'outMaster' ? 'm' : 'c'] = false;
  renderChipsSalida();
}));
navigator.mediaDevices?.addEventListener?.('devicechange', () => detectDevices(false, true));

// Que el foco nunca se quede en botones/controles (si no, Espacio los "presionaría")
document.addEventListener('mousedown', e => {
  // Clic fuera de una caja de texto la suelta (si no, seguiría recibiendo las teclas de la mezcladora)
  const ae = document.activeElement;
  if (ae?.matches?.('input[type=search], input[type=text]') && !ae.contains(e.target) && !e.target.closest('.modalBox')) ae.blur();
  if (e.target.closest('button')) e.preventDefault();
});
document.addEventListener('change', e => { if (e.target.matches('input[type=range],input[type=checkbox],select')) e.target.blur(); });
document.addEventListener('pointerdown', () => initAudio());

// Evita que soltar un archivo fuera de un deck abra la canción en la pestaña
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => e.preventDefault());
// Aviso si cierras la pestaña con música sonando
window.addEventListener('beforeunload', e => {
  if (Object.values(decks).some(d => !d.audio.paused)) { e.preventDefault(); e.returnValue = ''; }
});

function render() {
  if (vwin && vwin.closed) { vwin = null; abrirVentanaVideo(); } // no debería cerrarse: si pasa, se reabre
  for (const d of Object.values(decks)) {
    const a = d.audio, dur = a.duration, ok = isFinite(dur) && dur > 0;
    const pct = `${ok ? (a.currentTime / dur) * 100 : 0}%`;
    d.ui.fill.style.width = pct; d.ui.head.style.left = pct; d.ui.wave.style.width = pct;
    d.ui.vu.style.height = `${nivel(d.analyser) * 100}%`;
    sincronizarStems(d);
    d.ui.cur.textContent = fmt(a.currentTime);
    d.ui.rem.textContent = '-' + fmt(ok ? dur - a.currentTime : 0);
    d.el.classList.toggle('ending', ok && isOnAir(d) && dur - a.currentTime < 30);
  }
  pintarMaestro(nivel(masterAnalyser));
  requestAnimationFrame(render);
}

// Nivel 0..1 (pico del último bloque, en escala de dB de -48 a 0)
const muestras = new Float32Array(1024);
function nivel(an) {
  if (!an) return 0;
  an.getFloatTimeDomainData(muestras);
  let pico = 0;
  for (let i = 0; i < muestras.length; i++) { const v = Math.abs(muestras[i]); if (v > pico) pico = v; }
  if (pico < 1e-4) return 0;
  return Math.max(0, Math.min(1, 1 + (20 * Math.log10(pico)) / 48));
}
const SEGS = 8;
$('#masterMeter').innerHTML = '<i></i>'.repeat(SEGS);
const segs = [...document.querySelectorAll('#masterMeter i')];
function pintarMaestro(v) {
  const n = Math.round(v * SEGS);
  segs.forEach((s, i) => { s.className = i < n ? (i >= SEGS - 1 ? 'r' : i >= SEGS - 3 ? 'y' : 'g') : ''; });
}
updateOnAir();
Teclas.pintar();
Teclas.leerDistribucion().then(() => { Teclas.pintar(); Object.values(decks).forEach(renderMark); });
detectDevices(false);
abrirVentanaVideo();
// La biblioteca se muestra de inmediato y luego se revisan las carpetas en segundo plano
cargarBiblioteca().then(() => escanearBiblioteca(false));
window.mezcladora.preparador.alCambiarEstado(mostrarPreparador);
window.mezcladora.preparador.alCambiarCancion(alCambiarCancionStems);
window.mezcladora.preparador.estado().then(mostrarPreparador).catch(() => {});
actualizarEspacio();
window.mezcladora.video.alCambiar(e => mostrarEstadoVideo(e, true));
window.mezcladora.video.estado().then(e => mostrarEstadoVideo(e, false)).catch(() => mostrarEstadoVideo(null, false));
render();
