'use strict';
const $ = (s, r = document) => r.querySelector(s);

// ---------- Teclas (por posición física, funciona con teclado en español) ----------
const KEYS = {
  A: { play: 'Q', cue: 'W', mark: 'E', tomark: 'R', back: 'A', fwd: 'S', load: '1' },
  B: { play: 'U', cue: 'I', mark: 'O', tomark: 'P', back: 'J', fwd: 'K', load: '2' }
};
const REPEATABLE = new Set(['back', 'fwd']);

// ---------- Almacenamiento seguro ----------
const store = {
  get(k, def) { try { const v = localStorage.getItem(k); return v === null ? def : JSON.parse(v); } catch { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} }
};

const state = { xf: 0, fade: store.get('cfg:fade', 8), stopOld: store.get('cfg:stopOld', true), trans: null, blackout: false };
const decks = {};
let ctx = null, masterGain, cueBus, cueAudio, masterAudio = null;
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
  cueBus = ctx.createGain();

  // Audífonos: bus independiente enviado a su propia salida
  const cueDest = ctx.createMediaStreamDestination();
  cueBus.connect(cueDest);
  cueAudio = new Audio(); cueAudio.srcObject = cueDest.stream; cueAudio.play().catch(() => {});

  // Principal: directo si el navegador permite elegir salida del contexto
  if (typeof ctx.setSinkId === 'function') {
    masterGain.connect(ctx.destination);
  } else {
    const md = ctx.createMediaStreamDestination();
    masterGain.connect(md);
    masterAudio = new Audio(); masterAudio.srcObject = md.stream; masterAudio.play().catch(() => {});
  }

  Object.values(decks).forEach(connectDeck);
  applyCrossfader();
  applyOutputs();
  const st = $('#status'); st.textContent = 'Audio activo'; st.classList.add('ok');
}

function connectDeck(d) {
  d.src = ctx.createMediaElementSource(d.audio);
  d.volGain = ctx.createGain(); d.volGain.gain.value = d.vol;
  d.xfGain = ctx.createGain(); d.xfGain.gain.value = deckLevel(d);
  d.cueGain = ctx.createGain(); d.cueGain.gain.value = d.cue ? 1 : 0;
  d.src.connect(d.volGain).connect(d.xfGain).connect(masterGain);
  d.src.connect(d.cueGain).connect(cueBus); // pre-escucha antes del volumen: se oye aunque el fader esté abajo
}

function holdParam(p) {
  const t = ctx.currentTime;
  if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t);
  else { const v = p.value; p.cancelScheduledValues(0); p.setValueAtTime(v, t); }
}

// ---------- Decks ----------
function deckHTML(id, k) {
  return `
  <h2>DECK ${id}<span class="badge"></span></h2>
  <div class="title">Sin canción</div>
  <div class="drop">Arrastra una canción o video, o haz clic <kbd>${k.load}</kbd></div>
  <input type="file" accept="audio/*,video/*,.mkv,.mov" hidden>
  <div class="bar"><div class="fill"></div><div class="mark"></div></div>
  <div class="times"><span class="cur">0:00</span><span class="rem">-0:00</span></div>
  <div class="btns">
    <button data-act="play"><span class="lbl">▶ Play</span><kbd>${k.play}</kbd></button>
    <button data-act="cue">Audífonos <kbd>${k.cue}</kbd></button>
    <button data-act="mark">Marcar inicio <kbd>${k.mark}</kbd></button>
    <button data-act="tomark">Ir al inicio <kbd>${k.tomark}</kbd></button>
    <button data-act="back">−5 s <kbd>${k.back}</kbd></button>
    <button data-act="fwd">+5 s <kbd>${k.fwd}</kbd></button>
  </div>
  <label class="row">Volumen <input type="range" class="vol" min="0" max="100" value="100"></label>
  <div class="markinfo"></div>`;
}

function createDeck(id) {
  const el = $(`.deck[data-deck="${id}"]`);
  el.innerHTML = deckHTML(id, KEYS[id]);
  // Un <video> reproduce tanto audio como video; vive oculto y su imagen se envía a la segunda pantalla
  const audio = document.createElement('video');
  audio.preload = 'auto';
  audio.playsInline = true;
  audio.preservesPitch = true;
  $('#mediaPool').appendChild(audio);
  const d = { id, el, audio, file: null, key: null, url: null, mark: null, cue: false, vol: 1, loadId: 0, isVideo: false,
    ui: { fill: $('.fill', el), cur: $('.cur', el), rem: $('.rem', el), play: $('[data-act=play] .lbl', el) } };
  decks[id] = d;

  const input = $('input[type=file]', el), drop = $('.drop', el);
  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { if (input.files[0]) loadFile(d, input.files[0]); input.value = ''; });
  el.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  el.addEventListener('dragleave', e => { if (!el.contains(e.relatedTarget)) drop.classList.remove('over'); });
  el.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) loadFile(d, f); });
  $('.btns', el).addEventListener('click', e => { const b = e.target.closest('button'); if (b) deckAction(d, b.dataset.act, e.shiftKey); });
  $('.bar', el).addEventListener('click', e => {
    if (!d.file || !isFinite(audio.duration)) return;
    const r = e.currentTarget.getBoundingClientRect();
    audio.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * audio.duration;
  });
  $('.vol', el).addEventListener('input', e => setVol(d, e.target.value / 100));
  ['play', 'pause', 'ended'].forEach(ev => audio.addEventListener(ev, () => updatePlayBtn(d)));
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
  return cargarEnDeck(d, { name: c.nombre, size: c.tamano, url: `/medio/${c.id}`, isVideo: c.tipo === 'video', libId: c.id });
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
  renderMark(d); updatePlayBtn(d); renderBadge(d);
  return true;
}
function renderBadge(d) {
  const b = $('.badge', d.el);
  b.textContent = d.file ? (d.isVideo ? 'VIDEO' : 'AUDIO') : '';
  b.classList.toggle('video', d.isVideo);
}

function deckAction(d, act, shift) {
  initAudio();
  switch (act) {
    case 'load': $('input[type=file]', d.el).click(); break;
    case 'play': togglePlay(d); break;
    case 'cue': toggleCue(d); break;
    case 'mark': shift ? clearMark(d) : setMark(d); break;
    case 'tomark': if (needTrack(d)) d.audio.currentTime = d.mark ?? 0; break;
    case 'back': if (needTrack(d)) d.audio.currentTime = Math.max(0, d.audio.currentTime - 5); break;
    case 'fwd': if (needTrack(d)) d.audio.currentTime = Math.min(d.audio.duration || 0, d.audio.currentTime + 5); break;
  }
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
    info.textContent = `Empieza en ${fmt(d.mark)} · Shift+${KEYS[d.id].mark} para borrar`;
  } else {
    m.style.display = 'none';
    info.textContent = d.file ? `Sin marca: presiona ${KEYS[d.id].mark} donde quieras que empiece` : '';
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
  $('#onair').textContent = `Al aire: ${a && b ? 'A + B' : a ? 'A' : 'B'}`;
  decks.A.el.classList.toggle('live', a);
  decks.B.el.classList.toggle('live', b);
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
  const b = $('#autoBtn'); b.classList.toggle('on', on);
  b.firstChild.textContent = on ? 'Mezclando… ' : 'Transición ';
}
function cycleFade() {
  const opts = [4, 8, 16, 32];
  state.fade = opts[(opts.indexOf(state.fade) + 1) % opts.length];
  $('#fade').value = state.fade; store.set('cfg:fade', state.fade);
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
  const b = $('#videoBtn');
  b.textContent = videoEstado.conectada ? `TV: ${videoEstado.nombre}` : 'TV: no conectada';
  b.title = videoEstado.conectada
    ? `Video en ${videoEstado.nombre} (${videoEstado.ancho}×${videoEstado.alto}). Clic para volver a colocarlo.`
    : 'Conecta el proyector o la TV en modo "Extender". Clic para buscarla otra vez.';
  b.classList.toggle('on', videoEstado.conectada);
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
  updateVideoOut();
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
  if (askPermission) toast(`Encontré ${$('#outMaster').options.length - 1} salidas de audio`);
  applyOutputs();
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
      <td class="libName" title="${esc(c.nombre)}">${esc(c.nombre.replace(/\.[^.]+$/, ''))}${c.falta ? ' <span class="badge">NO ENCONTRADO</span>' : ''}</td>
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
  fila?.classList.add('sel');
  fila?.scrollIntoView({ block: 'nearest' });
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

// ---------- Teclado ----------
const keyMap = {};
for (const [id, k] of Object.entries(KEYS))
  for (const [act, key] of Object.entries(k))
    keyMap[/\d/.test(key) ? `Digit${key}` : `Key${key}`] = [id, act];

document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey) return; // respeta atajos del sistema
  const tag = e.target.tagName;
  if (tag === 'SELECT' || (tag === 'INPUT' && !['range', 'checkbox'].includes(e.target.type))) return;
  initAudio();
  const m = keyMap[e.code];
  if (m) {
    e.preventDefault();
    if (e.repeat && !REPEATABLE.has(m[1])) return;
    return deckAction(decks[m[0]], m[1], e.shiftKey);
  }
  switch (e.code) {
    case 'Space': e.preventDefault(); if (!e.repeat) autoTransition(e.shiftKey); break;
    case 'ArrowLeft': e.preventDefault(); setXf(state.xf - (e.shiftKey ? 0.2 : 0.05), true); break;
    case 'ArrowRight': e.preventDefault(); setXf(state.xf + (e.shiftKey ? 0.2 : 0.05), true); break;
    case 'KeyT': e.preventDefault(); if (!e.repeat) cycleFade(); break;
    case 'KeyV': e.preventDefault(); if (!e.repeat) toggleBlackout(); break;
    case 'ArrowUp': e.preventDefault(); moverSeleccion(-1); break;
    case 'ArrowDown': e.preventDefault(); moverSeleccion(1); break;
    case 'Enter': case 'NumpadEnter': e.preventDefault(); if (!e.repeat) cargarSeleccion(e.shiftKey ? 'B' : 'A'); break;
  }
});

// ---------- Arranque ----------
createDeck('A'); createDeck('B');

$('#xf').addEventListener('input', e => { initAudio(); setXf(e.target.value / 1000, true); });
$('#autoBtn').addEventListener('click', () => autoTransition(false));
$('#cutBtn').addEventListener('click', () => autoTransition(true));
$('#fade').value = state.fade;
$('#fade').addEventListener('change', e => { state.fade = Number(e.target.value); store.set('cfg:fade', state.fade); });
$('#stopOld').checked = state.stopOld;
$('#stopOld').addEventListener('change', e => { state.stopOld = e.target.checked; store.set('cfg:stopOld', state.stopOld); });
$('#detect').addEventListener('click', () => { initAudio(); detectDevices(true); });
$('#videoBtn').addEventListener('click', recolocarVideo);
$('#blackBtn').addEventListener('click', toggleBlackout);
['outMaster', 'outCue'].forEach(id => $('#' + id).addEventListener('change', e => {
  store.set('cfg:' + id, e.target.value); initAudio(); applyOutputs();
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
    d.ui.fill.style.width = `${ok ? (a.currentTime / dur) * 100 : 0}%`;
    d.ui.cur.textContent = fmt(a.currentTime);
    d.ui.rem.textContent = '-' + fmt(ok ? dur - a.currentTime : 0);
    d.el.classList.toggle('ending', ok && isOnAir(d) && dur - a.currentTime < 30);
  }
  requestAnimationFrame(render);
}
updateOnAir();
detectDevices(false);
abrirVentanaVideo();
// La biblioteca se muestra de inmediato y luego se revisan las carpetas en segundo plano
cargarBiblioteca().then(() => escanearBiblioteca(false));
window.mezcladora.video.alCambiar(e => mostrarEstadoVideo(e, true));
window.mezcladora.video.estado().then(e => mostrarEstadoVideo(e, false)).catch(() => mostrarEstadoVideo(null, false));
render();
