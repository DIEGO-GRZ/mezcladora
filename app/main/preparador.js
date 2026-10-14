'use strict';
// Administra el preparador de stems (preparador/servicio.py) como proceso hijo.
// Regla: la mezcladora nunca espera a la IA. Todo aquí es en segundo plano y se pausa mientras suena música.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const biblioteca = require('./biblioteca');

const APAGAR_TRAS_MS = 2 * 60 * 1000; // sin trabajo por 2 min → se cierra Python y libera ~1 GB de RAM

let cfg = null;            // { carpetaPreparador, carpetaStems, avisar(canal, datos) }
let proc = null;
let listo = false;         // Python terminó de cargar torch/demucs
let actual = null;         // { id, titulo, pct, etapa }
let musica = false;        // hay algún deck sonando
let pausado = false;
let temporizadorApagado = null;
let buffer = '';

function python() {
  return path.join(cfg.carpetaPreparador, '.venv', 'Scripts', 'python.exe');
}
function disponible() {
  return fs.existsSync(python()) && fs.existsSync(path.join(cfg.carpetaPreparador, 'servicio.py'));
}

function iniciar(opciones) {
  cfg = opciones;
  fs.mkdirSync(cfg.carpetaStems, { recursive: true });
  try { biblioteca.verificarStems(cfg.carpetaStems); } catch (err) { console.error('Stems:', err); }
  // Si quedó algo en la cola de la vez pasada, se retoma
  setTimeout(bombear, 3000);
}

function estado() {
  let enCola = 0;
  try { enCola = biblioteca.contarCola(); } catch {}
  return {
    disponible: cfg ? disponible() : false,
    activo: !!proc,
    cargando: !!proc && !listo,
    pausado: pausado || (musica && !actual),
    musica,
    actual: actual && { ...actual },
    enCola,
  };
}

function avisarEstado() { cfg?.avisar('preparador:estado', estado()); }
function avisarCancion(id, stems, info) { cfg?.avisar('preparador:cancion', { id, stems, stems_info: info ? JSON.stringify(info) : null }); }

function asegurarProceso() {
  if (proc || !disponible()) return;
  listo = false;
  buffer = '';
  proc = spawn(python(), ['-u', 'servicio.py'], { cwd: cfg.carpetaPreparador, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const este = proc;
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', d => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const linea = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!linea) continue;
      try { alEvento(JSON.parse(linea)); } catch { console.error('Preparador (línea no válida):', linea.slice(0, 200)); }
    }
  });
  proc.stderr.on('data', d => { if (process.env.MEZCLADORA_DEBUG) process.stderr.write(d); });
  proc.stdin.on('error', () => {}); // si Python ya cerró, escribirle no debe tirar la app
  proc.on('error', err => console.error('Preparador:', err));
  proc.on('exit', codigo => {
    if (proc !== este) return;
    proc = null; listo = false; pausado = false;
    // Si se cayó a media canción, esa canción queda con error (así no se repite el fallo en bucle)
    if (actual) {
      const info = { mensaje: `El preparador se cerró inesperadamente (código ${codigo})` };
      try { biblioteca.marcarStems(actual.id, 'error', info); } catch {}
      avisarCancion(actual.id, 'error', info);
      actual = null;
      setTimeout(bombear, 2000);
    }
    avisarEstado();
  });
  avisarEstado();
}

function enviar(orden) {
  if (proc && proc.stdin.writable) proc.stdin.write(JSON.stringify(orden) + '\n');
}

function alEvento(e) {
  switch (e.ev) {
    case 'listo':
      listo = true;
      if (musica) { enviar({ cmd: 'pausar' }); }
      bombear();
      break;
    case 'progreso':
      if (actual && actual.id === e.id) { actual.pct = e.pct; actual.etapa = e.etapa; }
      break;
    case 'pausado': pausado = true; break;
    case 'reanudado': pausado = false; break;
    case 'terminado': {
      const info = { segundos: e.segundos_total, mb: e.mb_en_disco, dispositivo: e.dispositivo, fecha: Date.now() };
      try { biblioteca.marcarStems(e.id, 'listo', info); } catch (err) { console.error(err); }
      avisarCancion(e.id, 'listo', info);
      actual = null;
      bombear();
      break;
    }
    case 'error': {
      const info = { mensaje: e.mensaje };
      try { biblioteca.marcarStems(e.id, 'error', info); } catch {}
      avisarCancion(e.id, 'error', info);
      actual = null;
      bombear();
      break;
    }
    case 'cancelado':
      if (actual && actual.id === e.id) actual = null;
      bombear();
      break;
    case 'fatal':
      console.error('Preparador:', e.mensaje);
      break;
  }
  avisarEstado();
}

// Manda la siguiente canción de la cola si no hay nada en curso y no suena música
function bombear() {
  clearTimeout(temporizadorApagado);
  if (!cfg || actual) return;
  let siguiente = null;
  try { siguiente = biblioteca.siguienteEnCola(); } catch (err) { console.error(err); }
  if (!siguiente) {
    // Nada que hacer: apagar Python al rato para liberar memoria
    if (proc) temporizadorApagado = setTimeout(detener, APAGAR_TRAS_MS);
    avisarEstado();
    return;
  }
  if (!disponible()) return avisarEstado();
  if (!proc) { asegurarProceso(); return; } // al terminar de cargar, 'listo' vuelve a llamar aquí
  if (!listo || musica) return avisarEstado(); // con música sonando no se empieza nada nuevo

  actual = { id: siguiente.id, titulo: siguiente.titulo || siguiente.nombre, pct: 0, etapa: 'leyendo' };
  biblioteca.marcarStems(siguiente.id, 'preparando');
  avisarCancion(siguiente.id, 'preparando');
  enviar({
    cmd: 'separar', id: siguiente.id, ruta: siguiente.ruta,
    salida: path.join(cfg.carpetaStems, biblioteca.claveStems(siguiente.nombre, siguiente.tamano)),
  });
  avisarEstado();
}

function encolar(ids) {
  const n = biblioteca.encolarStems((ids || []).map(Number).filter(Number.isFinite));
  for (const id of ids) {
    const c = biblioteca.cancionStems(id);
    if (c?.stems === 'cola') avisarCancion(c.id, 'cola');
  }
  bombear();
  return n;
}

// Quita de la cola, o cancela si es la que se está preparando
function cancelar(id) {
  id = Number(id);
  if (actual && actual.id === id) {
    enviar({ cmd: 'cancelar', id });
    biblioteca.marcarStems(id, null);
    avisarCancion(id, null);
    return true;
  }
  const c = biblioteca.cancionStems(id);
  if (c?.stems === 'cola') {
    biblioteca.marcarStems(id, null);
    avisarCancion(id, null);
    avisarEstado();
    return true;
  }
  return false;
}

// La interfaz avisa cuando empieza o deja de sonar música
function alCambiarMusica(sonando) {
  sonando = !!sonando;
  if (sonando === musica) return;
  musica = sonando;
  if (proc && listo) enviar({ cmd: musica ? 'pausar' : 'reanudar' });
  if (!musica) bombear();
  avisarEstado();
}

function detener() {
  clearTimeout(temporizadorApagado);
  const p = proc;
  if (!p) return;
  // Lo que estaba a medias vuelve a la cola (no es un error: se cerró a propósito)
  if (actual) {
    try { biblioteca.marcarStems(actual.id, 'cola'); } catch {}
    actual = null;
  }
  try { p.stdin.end(); } catch {}            // al cerrarle la entrada, Python termina solo
  setTimeout(() => { try { p.kill(); } catch {} }, 3000);
}

// ¿Está preparando algo ahora mismo? (no se puede mover la carpeta de stems a media canción)
function ocupado() { return !!actual; }
function usarCarpetaStems(nueva) {
  cfg.carpetaStems = nueva;
  fs.mkdirSync(nueva, { recursive: true });
}

module.exports = { iniciar, estado, encolar, cancelar, alCambiarMusica, detener, ocupado, usarCarpetaStems };
