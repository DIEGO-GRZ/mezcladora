'use strict';
// Configuración del proceso principal en datos/config.json (carpeta de stems, etc.).
// Se escribe a un temporal y se renombra para no dejar el archivo a medias si la app se cierra.
const fs = require('node:fs');
const path = require('node:path');

let archivo = null;
let datos = {};

function cargar(carpetaDatos, porDefecto) {
  archivo = path.join(carpetaDatos, 'config.json');
  try { datos = { ...porDefecto, ...JSON.parse(fs.readFileSync(archivo, 'utf8')) }; }
  catch { datos = { ...porDefecto }; }
  return datos;
}

function obtener(clave) { return datos[clave]; }

function poner(clave, valor) {
  datos[clave] = valor;
  const tmp = `${archivo}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(datos, null, 2));
  fs.renameSync(tmp, archivo);
}

module.exports = { cargar, obtener, poner };
