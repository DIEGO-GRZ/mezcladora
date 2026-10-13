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
  d.src.connect(d.volGain).connect(d.xfGain).connect(masterGain);
  d.analyser = ctx.createAnalyser(); d.analyser.fftSize = 1024;
  d.volGain.connect(d.analyser); // medidor del deck: después del volumen, antes del crossfader
  d.src.connect(d.cueGain).connect(cueBus); // pre-escucha antes del volumen: se oye aunque el fader esté abajo
}

function holdParam(p) {
  const t = ctx.currentTime;
  if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t);
  else { const v = p.value; p.cancelScheduledValues(0); p.setValueAtTime(v, t); }
}

// ---------- Decks ----------
// Botón de deck. pend = etapa en la que llega la función (se ve desactivado hasta entonces).
const bot = (id, act, txt, pend) =>
  `<button class="btn" data-act="${act}"${pend ? ` disabled data-pend="${pend}"` : ''}><span>${txt}</span> <kbd data-tecla="${id}.${act}"></kbd></button>`;

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
  <div class="drop">Arrastra una canción o video aquí, o haz clic para elegir un archivo</div>
  <input type="file" accept="audio/*,video/*,.mkv,.mov" hidden>
  <div>
    <div class="bar"><div class="fill"></div><div class="mark"></div><div class="head"></div></div>
    <div class="times">
      <span><span class="mono cur">0:00</span> transcurrido</span>
      <span class="legend"><span class="y">▮</span> inicio · <span class="o">▮</span> salida</span>
      <span><span class="mono rem">-0:00</span> restante</span>
    </div>
    <div class="markinfo"></div>
  </div>
  <div class="grid4 btns">
    ${bot(id, 'play', '▶ Play')}${bot(id, 'cue', 'Audífonos')}${bot(id, 'mark', 'Marcar')}${bot(id, 'tomark', 'Al inicio')}
    ${bot(id, 'back', '−5 s')}${bot(id, 'fwd', '+5 s')}${bot(id, 'loop', 'Loop 4', 4)}${bot(id, 'sync', 'Sync', 3)}
  </div>
  <div>
    <div class="lbl mb6">Stems</div>
    <div class="grid4 stems">
      ${bot(id, 'stemVoz', 'Voz', 2)}${bot(id, 'stemMel', 'Melodía', 2)}${bot(id, 'stemBajo', 'Bajo', 2)}${bot(id, 'stemBat', 'Batería', 2)}
      ${bot(id, 'acapella', 'Acapella', 2)}${bot(id, 'instru', 'Instrumental', 2)}${bot(id, 'kick', 'Kick', 2)}${bot(id, 'hihat', 'HiHat', 2)}
    </div>
  </div>
  <div class="cuesFx">
    <div>
      <div class="lbl mb6">Hot cues <span class="norm">(⇧ = guardar)</span></div>
      <div class="grid4">${[1, 2, 3, 4].map(n => bot(id, `cue${n}`, '—', 4)).join('')}</div>
    </div>
    <div>
      <div class="lbl mb6">Efecto</div>
      ${bot(id, 'fx', 'Eco ▾', 5)}
    </div>
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
  const fcol = $(`.fcol[data-deck="${id}"]`);
  const d = { id, el, audio, file: null, key: null, url: null, mark: null, cue: false, vol: 1, loadId: 0, isVideo: false,
    ui: { fill: $('.fill', el), head: $('.bar .head', el), cur: $('.cur', el), rem: $('.rem', el), play: $('[data-act=play] span', el),
      state: $('.dState', el), wave: $(`.waveRow[data-deck="${id}"] .wfill`), vu: $('.vufill', fcol) } };
  decks[id] = d;

  const input = $('input[type=file]', el), drop = $('.drop', el);
  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { if (input.files[0]) loadFile(d, input.files[0]); input.value = ''; });
  el.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  el.addEventListener('dragleave', e => { if (!el.contains(e.relatedTarget)) drop.classList.remove('over'); });
  el.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) loadFile(d, f); });
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
  ['play', 'pause', 'ended'].forEach(ev => audio.addEventListener(ev, () => { updatePlayBtn(d); renderDeckState(d); }));
  audio.addEventListener('durationchange', () => renderMark(d));
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
    carpeta: c.carpeta.split(/[\\/]/).pop() });
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
  d.isVideo = m.isVideo;
  d.audio.src = d.url;
  d.audio.addEventListener('loadedmetadata', () => {
    if (myLoad !== d.loadId) return;
    if (d.mark != null && d.mark < d.audio.duration) d.audio.currentTime = d.mark; // salta el intro
    renderMark(d);
  }, { once: true });

  const t = $('.title', d.el);
  t.textContent = file.name.replace(/\.[^.]+$/, '');
  t.title = file.name;
  $('.sub', d.el).textContent = m.carpeta || '';
  d.el.classList.add('loaded');
  renderMark(d); updatePlayBtn(d); renderBadge(d); renderDeckState(d);
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
    info.textContent = `Empieza en ${fmt(d.mark)} · ${Teclas.etiqueta(`${d.id}.clearMark`)} para borrar`;
  } else {
    m.style.display = 'none';
    info.textContent = d.file ? `Sin marca: presiona ${Teclas.etiqueta(`${d.id}.mark`)} donde quieras que empiece` : '';
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
const lib = { canciones: [], sel: 0, carpetas: [] };

const fmtRes = c => (c.alto ? `${c.alto}p` : '');
const esc = t => String(t).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

async function cargarBiblioteca() {
  try {
    [lib.canciones, lib.carpetas] = await Promise.all([window.mezcladora.biblioteca.canciones(), window.mezcladora.biblioteca.carpetas()]);
  } catch { lib.canciones = []; toast('No se pudo leer la biblioteca'); }
  lib.sel = Math.min(lib.sel, Math.max(0, lib.canciones.length - 1));
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

function renderBiblioteca() {
  const n = lib.canciones.length;
  $('#libCount').textContent = n ? `${n} archivos` : '';
  const tbody = $('#libRows');
  if (!n) {
    tbody.innerHTML = `<tr><td colspan="6" class="libEmpty">${lib.carpetas.length
      ? 'No encontré canciones ni videos en tus carpetas. Presiona "Actualizar".'
      : 'Agrega tu carpeta de música con "Agregar carpeta".'}</td></tr>`;
    return;
  }
  tbody.innerHTML = lib.canciones.map((c, i) => `
    <tr data-i="${i}" class="${i === lib.sel ? 'sel' : ''}${c.falta ? ' falta' : ''}">
      <td class="libName" title="${esc(c.nombre)}">${esc(c.nombre.replace(/\.[^.]+$/, ''))}${c.falta ? ' <span class="tag">NO ENCONTRADO</span>' : ''}</td>
      <td>${c.tipo === 'video' ? 'Video' : 'Audio'}</td>
      <td class="num">${c.duracion ? fmt(c.duracion) : ''}</td>
      <td class="num${c.alto && c.alto < 720 ? ' lowres' : ''}">${fmtRes(c)}</td>
      <td class="libFolder" title="${esc(c.carpeta)}">${esc(c.carpeta.split(/[\\/]/).pop())}</td>
      <td class="libLoad"><button data-deck="A">A</button><button data-deck="B">B</button></td>
    </tr>`).join('');
}

function moverSeleccion(delta) {
  const n = lib.canciones.length;
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
  const c = lib.canciones[lib.sel];
  if (!c) return toast('La biblioteca está vacía');
  if (loadTrack(decks[id], c)) toast(`Deck ${id}: ${c.nombre.replace(/\.[^.]+$/, '')}`);
}

$('#libRows').addEventListener('click', e => {
  const fila = e.target.closest('tr[data-i]');
  if (!fila) return;
  moverSeleccion(Number(fila.dataset.i) - lib.sel);
  const b = e.target.closest('button[data-deck]');
  if (b) { initAudio(); cargarSeleccion(b.dataset.deck); }
});
$('#libScan').addEventListener('click', () => escanearBiblioteca(true));
$('#libAdd').addEventListener('click', agregarCarpetaBiblioteca);

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
document.addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });
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
window.mezcladora.video.alCambiar(e => mostrarEstadoVideo(e, true));
window.mezcladora.video.estado().then(e => mostrarEstadoVideo(e, false)).catch(() => mostrarEstadoVideo(null, false));
render();
