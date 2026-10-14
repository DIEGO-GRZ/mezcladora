'use strict';
// Espacio en disco de los stems: medidor, borrar ("Liberar espacio") y mover a otra carpeta.
const fs = require('node:fs');
const path = require('node:path');
const biblioteca = require('./biblioteca');

const CLAVE = /^[0-9a-f]{16}$/; // solo se tocan carpetas con nombre de clave de stems

async function tamanoCarpeta(dir) {
  let total = 0;
  try {
    for (const f of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (f.isFile()) total += (await fs.promises.stat(path.join(dir, f.name))).size;
    }
  } catch {}
  return total;
}

async function libreEn(dir) {
  try { const s = await fs.promises.statfs(dir); return s.bavail * s.bsize; } catch { return null; }
}

// Lista de carpetas de stems con su canción (si existe) y el espacio libre del disco
async function resumen(carpetaStems) {
  const porClave = new Map();
  for (const c of biblioteca.canciones()) {
    if (!porClave.has(c.clave)) porClave.set(c.clave, []);
    porClave.get(c.clave).push(c);
  }
  const items = [];
  let total = 0;
  let entradas = [];
  try { entradas = await fs.promises.readdir(carpetaStems, { withFileTypes: true }); } catch {}
  for (const e of entradas) {
    if (!e.isDirectory() || !CLAVE.test(e.name)) continue;
    const bytes = await tamanoCarpeta(path.join(carpetaStems, e.name));
    total += bytes;
    const canciones = porClave.get(e.name) || [];
    const c = canciones.find(x => !x.falta) || canciones[0];
    items.push({
      clave: e.name,
      mb: Math.round(bytes / 2 ** 20 * 10) / 10,
      id: c?.id ?? null,
      titulo: c ? (c.titulo || c.nombre) : null,
      artista: c?.artista || '',
      estado: !c ? 'suelta' : c.falta ? 'falta' : c.stems === 'preparando' ? 'preparando' : 'ok',
    });
  }
  items.sort((a, b) => (a.titulo || '~').localeCompare(b.titulo || '~', 'es'));
  return { carpeta: carpetaStems, totalMb: Math.round(total / 2 ** 20 * 10) / 10, libreGb: await gb(carpetaStems), items };
}

async function gb(dir) {
  const b = await libreEn(dir);
  return b == null ? null : Math.round(b / 2 ** 30 * 10) / 10;
}

// Borra las carpetas de stems indicadas y deja esas canciones como "sin preparar"
async function borrar(carpetaStems, claves, enUso = new Set()) {
  let liberado = 0;
  const fallidas = [];
  for (const clave of claves) {
    if (!CLAVE.test(clave) || enUso.has(clave)) { fallidas.push(clave); continue; }
    const dir = path.join(carpetaStems, clave);
    const bytes = await tamanoCarpeta(dir);
    try {
      // En Windows un archivo recién soltado por el reproductor puede tardar en liberarse: reintentos
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      liberado += bytes;
      biblioteca.quitarStemsPorClave(clave);
    } catch {
      fallidas.push(clave);
    }
  }
  return { liberadoMb: Math.round(liberado / 2 ** 20 * 10) / 10, fallidas };
}

// Copia todas las carpetas de stems a la nueva ubicación y, si todo salió bien, borra las viejas
async function mover(origen, destino) {
  if (path.resolve(origen) === path.resolve(destino)) return { movidas: 0 };
  await fs.promises.mkdir(destino, { recursive: true });
  // Prueba de escritura antes de mover nada
  const prueba = path.join(destino, `.prueba-${Date.now()}`);
  await fs.promises.writeFile(prueba, 'ok');
  await fs.promises.rm(prueba, { force: true });

  let entradas = [];
  try { entradas = await fs.promises.readdir(origen, { withFileTypes: true }); } catch {}
  const claves = entradas.filter(e => e.isDirectory() && CLAVE.test(e.name)).map(e => e.name);
  for (const clave of claves) {
    await fs.promises.cp(path.join(origen, clave), path.join(destino, clave), { recursive: true, force: true });
  }
  for (const clave of claves) {
    await fs.promises.rm(path.join(origen, clave), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
  return { movidas: claves.length };
}

module.exports = { resumen, borrar, mover, gb };
