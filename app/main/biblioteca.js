'use strict';
// Biblioteca de canciones en SQLite (node:sqlite, integrado en Electron: no hay que compilar nada).
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const AUDIO = new Set(['.mp3', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.flac', '.opus']);
const VIDEO = new Set(['.mp4', '.m4v', '.webm', '.mov', '.mkv', '.ogv']);

let db = null;

function abrir(carpetaDatos) {
  fs.mkdirSync(carpetaDatos, { recursive: true });
  db = new DatabaseSync(path.join(carpetaDatos, 'biblioteca.sqlite'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrar();
}

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
    SELECT c.id, c.nombre, c.tipo, c.tamano, c.duracion, c.ancho, c.alto, c.falta, k.ruta AS carpeta
    FROM canciones c JOIN carpetas k ON k.id = c.carpeta_id
    ORDER BY c.falta, c.nombre COLLATE NOCASE
  `).all();
}

// Solo se sirven archivos que están en la biblioteca (nunca una ruta arbitraria)
function rutaDe(id) {
  const fila = db.prepare('SELECT ruta FROM canciones WHERE id = ? AND falta = 0').get(Number(id));
  return fila ? fila.ruta : null;
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
    const insertar = db.prepare(`
      INSERT INTO canciones (carpeta_id, ruta, nombre, tipo, tamano, modificado, agregada)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ruta) DO UPDATE SET
        tamano = excluded.tamano, modificado = excluded.modificado, tipo = excluded.tipo, falta = 0
    `);
    const marcarFalta = db.prepare('UPDATE canciones SET falta = 1 WHERE carpeta_id = ? AND ruta = ? AND falta = 0');

    db.exec('BEGIN');
    try {
      const vistos = new Set();
      for (const e of encontrados) {
        if (!existentes.has(e.ruta)) resumen.nuevas++;
        insertar.run(carpeta.id, e.ruta, e.nombre, e.tipo, e.tamano, e.modificado, Date.now());
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

function cerrar() {
  try { db?.close(); } catch {}
  db = null;
}

module.exports = { abrir, carpetas, agregarCarpeta, canciones, rutaDe, guardarInfo, escanear, cerrar };
