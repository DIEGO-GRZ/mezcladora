'use strict';
// Biblioteca de canciones en SQLite (node:sqlite, integrado en Electron: no hay que compilar nada).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { separar } = require('./nombres');

const AUDIO = new Set(['.mp3', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.flac', '.opus']);
const VIDEO = new Set(['.mp4', '.m4v', '.webm', '.mov', '.mkv', '.ogv']);

let db = null;

function abrir(carpetaDatos) {
  fs.mkdirSync(carpetaDatos, { recursive: true });
  const archivo = path.join(carpetaDatos, 'biblioteca.sqlite');
  db = new DatabaseSync(archivo);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  // Antes de cambiar el esquema de una base que ya tiene datos, se guarda una copia
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 0 && version < VERSION) {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    fs.copyFileSync(archivo, path.join(carpetaDatos, `biblioteca.antes-v${VERSION}.sqlite`));
  }
  migrar();
  // Si la app se cerró a media preparación, esa canción vuelve a la cola
  db.prepare("UPDATE canciones SET stems = 'cola' WHERE stems = 'preparando'").run();
}

const VERSION = 3; // versión actual del esquema

// Cada versión del esquema es un paso; así las bases viejas se actualizan sin perder datos
function migrar() {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version < 1) {
    db.exec(`
      CREATE TABLE carpetas (
        id    INTEGER PRIMARY KEY,
        ruta  TEXT NOT NULL UNIQUE
      );
      CREATE TABLE canciones (
        id          INTEGER PRIMARY KEY,
        carpeta_id  INTEGER NOT NULL REFERENCES carpetas(id) ON DELETE CASCADE,
        ruta        TEXT NOT NULL UNIQUE,
        nombre      TEXT NOT NULL,          -- nombre del archivo con extensión
        tipo        TEXT NOT NULL,          -- 'audio' | 'video' (por extensión)
        tamano      INTEGER NOT NULL,
        modificado  INTEGER NOT NULL,       -- ms
        duracion    REAL,                   -- se llena al cargarla en un deck
        ancho       INTEGER,
        alto        INTEGER,
        falta       INTEGER NOT NULL DEFAULT 0,  -- 1 = el archivo ya no está (se conserva por sus datos)
        agregada    INTEGER NOT NULL
      );
      CREATE INDEX canciones_carpeta ON canciones(carpeta_id);
      PRAGMA user_version = 1;
    `);
  }
  if (version < 2) {
    // Título y artista separados del nombre del archivo; nombre_manual = 1 si el usuario los corrigió
    db.exec('BEGIN');
    try {
      db.exec(`
        ALTER TABLE canciones ADD COLUMN titulo TEXT;
        ALTER TABLE canciones ADD COLUMN artista TEXT;
        ALTER TABLE canciones ADD COLUMN nombre_manual INTEGER NOT NULL DEFAULT 0;
      `);
      const poner = db.prepare('UPDATE canciones SET titulo = ?, artista = ?, alto = COALESCE(alto, ?) WHERE id = ?');
      for (const f of db.prepare('SELECT id, nombre FROM canciones').all()) {
        const n = separar(f.nombre);
        poner.run(n.titulo, n.artista, n.alto, f.id);
      }
      db.exec('PRAGMA user_version = 2; COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  if (version < 3) {
    // Estado de los stems: NULL (sin preparar) | 'cola' | 'preparando' | 'listo' | 'error'
    db.exec(`
      BEGIN;
      ALTER TABLE canciones ADD COLUMN stems TEXT;
      ALTER TABLE canciones ADD COLUMN stems_info TEXT;     -- JSON: estadísticas o mensaje de error
      ALTER TABLE canciones ADD COLUMN stems_orden INTEGER; -- cuándo entró a la cola
      PRAGMA user_version = 3;
      COMMIT;
    `);
  }
}

function carpetas() {
  return db.prepare('SELECT id, ruta FROM carpetas ORDER BY ruta').all();
}

function agregarCarpeta(ruta) {
  const r = path.resolve(ruta);
  db.prepare('INSERT OR IGNORE INTO carpetas (ruta) VALUES (?)').run(r);
  return r;
}

function canciones() {
  return db.prepare(`
    SELECT c.id, c.nombre, c.titulo, c.artista, c.nombre_manual, c.tipo, c.tamano, c.duracion, c.ancho, c.alto, c.falta,
           c.stems, c.stems_info,
           c.carpeta_id, k.ruta AS carpeta
    FROM canciones c JOIN carpetas k ON k.id = c.carpeta_id
    ORDER BY c.falta, COALESCE(NULLIF(c.artista, ''), c.titulo) COLLATE NOCASE, c.titulo COLLATE NOCASE
  `).all().map(c => ({ ...c, clave: claveStems(c.nombre, c.tamano) })); // carpeta de sus stems
}

// Solo se sirven archivos que están en la biblioteca (nunca una ruta arbitraria)
function rutaDe(id) {
  const fila = db.prepare('SELECT ruta FROM canciones WHERE id = ? AND falta = 0').get(Number(id));
  return fila ? fila.ruta : null;
}

// Corrección a mano de título y artista (no toca el archivo). Sin datos = volver a lo automático.
function editarNombre(id, datos) {
  const fila = db.prepare('SELECT nombre FROM canciones WHERE id = ?').get(Number(id));
  if (!fila) return null;
  const t = String(datos?.titulo ?? '').trim().slice(0, 300);
  const a = String(datos?.artista ?? '').trim().slice(0, 300);
  if (!t) {
    const n = separar(fila.nombre);
    db.prepare('UPDATE canciones SET titulo = ?, artista = ?, nombre_manual = 0 WHERE id = ?').run(n.titulo, n.artista, Number(id));
    return { titulo: n.titulo, artista: n.artista, nombre_manual: 0 };
  }
  db.prepare('UPDATE canciones SET titulo = ?, artista = ?, nombre_manual = 1 WHERE id = ?').run(t, a, Number(id));
  return { titulo: t, artista: a, nombre_manual: 1 };
}

function guardarInfo(id, { duracion, ancho, alto }) {
  const num = v => (Number.isFinite(v) && v > 0 ? v : null);
  db.prepare(`UPDATE canciones SET duracion = COALESCE(?, duracion), ancho = COALESCE(?, ancho), alto = COALESCE(?, alto) WHERE id = ?`)
    .run(num(duracion), num(ancho) && Math.round(ancho), num(alto) && Math.round(alto), Number(id));
}

// Recorre las carpetas (con subcarpetas) y agrega lo nuevo. Lo que ya no está se marca como faltante.
// Lee el disco de forma asíncrona para no trabar la mezcladora mientras suena música.
async function escanear() {
  const resumen = { nuevas: 0, faltan: 0, carpetasNoEncontradas: [] };
  for (const carpeta of carpetas()) {
    let archivos;
    try {
      archivos = await fs.promises.readdir(carpeta.ruta, { recursive: true, withFileTypes: true });
    } catch {
      resumen.carpetasNoEncontradas.push(carpeta.ruta);
      continue; // si la carpeta no está (p. ej. disco externo desconectado) no se tocan sus canciones
    }

    const encontrados = [];
    for (const a of archivos) {
      if (!a.isFile()) continue;
      const ext = path.extname(a.name).toLowerCase();
      const tipo = VIDEO.has(ext) ? 'video' : AUDIO.has(ext) ? 'audio' : null;
      if (!tipo) continue;
      const ruta = path.join(a.parentPath ?? a.path, a.name);
      try {
        const st = await fs.promises.stat(ruta);
        encontrados.push({ ruta, nombre: a.name, tipo, tamano: st.size, modificado: Math.round(st.mtimeMs) });
      } catch {} // el archivo desapareció entre leer la carpeta y revisarlo
    }

    const existentes = new Set(db.prepare('SELECT ruta FROM canciones WHERE carpeta_id = ?').all(carpeta.id).map(f => f.ruta));
    // Al actualizar una canción que ya estaba no se tocan título/artista (pueden estar corregidos a mano)
    const insertar = db.prepare(`
      INSERT INTO canciones (carpeta_id, ruta, nombre, tipo, tamano, modificado, agregada, titulo, artista, alto)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ruta) DO UPDATE SET
        tamano = excluded.tamano, modificado = excluded.modificado, tipo = excluded.tipo, falta = 0
    `);
    const marcarFalta = db.prepare('UPDATE canciones SET falta = 1 WHERE carpeta_id = ? AND ruta = ? AND falta = 0');

    db.exec('BEGIN');
    try {
      const vistos = new Set();
      for (const e of encontrados) {
        if (!existentes.has(e.ruta)) resumen.nuevas++;
        const n = separar(e.nombre);
        insertar.run(carpeta.id, e.ruta, e.nombre, e.tipo, e.tamano, e.modificado, Date.now(), n.titulo, n.artista, n.alto);
        vistos.add(e.ruta);
      }
      for (const r of existentes) if (!vistos.has(r)) resumen.faltan += Number(marcarFalta.run(carpeta.id, r).changes);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return resumen;
}

// ---------- Stems ----------
// Carpeta de stems de una canción: se nombra por nombre|tamaño (igual que las marcas), así sobrevive
// a mover la carpeta de música o reconstruir la biblioteca
function claveStems(nombre, tamano) {
  return crypto.createHash('sha1').update(`${nombre}|${tamano}`).digest('hex').slice(0, 16);
}
const ARCHIVO_STEMS = 'stems.opus'; // 8 canales: ver preparador/separar.py

function encolarStems(ids) {
  const poner = db.prepare(`UPDATE canciones SET stems = 'cola', stems_info = NULL, stems_orden = ?
                            WHERE id = ? AND falta = 0 AND (stems IS NULL OR stems = 'error')`);
  let n = 0;
  db.exec('BEGIN');
  try {
    ids.forEach((id, i) => { n += Number(poner.run(Date.now() + i, Number(id)).changes); });
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return n;
}

function siguienteEnCola() {
  return db.prepare(`SELECT id, ruta, nombre, tamano, titulo FROM canciones
                     WHERE stems = 'cola' AND falta = 0 ORDER BY stems_orden LIMIT 1`).get() || null;
}

function contarCola() {
  return db.prepare("SELECT COUNT(*) AS n FROM canciones WHERE stems = 'cola'").get().n;
}

function marcarStems(id, estado, info = null) {
  db.prepare('UPDATE canciones SET stems = ?, stems_info = ? WHERE id = ?')
    .run(estado, info == null ? null : JSON.stringify(info), Number(id));
}

// Si borraron la carpeta de stems a mano, la canción vuelve a "sin preparar"
function verificarStems(carpetaStems) {
  const listos = db.prepare("SELECT id, nombre, tamano FROM canciones WHERE stems = 'listo'").all();
  const quitar = db.prepare('UPDATE canciones SET stems = NULL, stems_info = NULL WHERE id = ?');
  let n = 0;
  for (const c of listos) {
    const dir = path.join(carpetaStems, claveStems(c.nombre, c.tamano));
    if (!fs.existsSync(path.join(dir, ARCHIVO_STEMS))) { quitar.run(c.id); n++; }
  }
  return n;
}

function cancionStems(id) {
  return db.prepare('SELECT id, nombre, tamano, stems FROM canciones WHERE id = ?').get(Number(id)) || null;
}

function cerrar() {
  try { db?.close(); } catch {}
  db = null;
}

module.exports = {
  abrir, carpetas, agregarCarpeta, canciones, rutaDe, guardarInfo, editarNombre, escanear, cerrar,
  claveStems, ARCHIVO_STEMS, encolarStems, siguienteEnCola, contarCola, marcarStems, verificarStems, cancionStems,
};
