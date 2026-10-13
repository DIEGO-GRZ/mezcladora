'use strict';
// Separa título y artista del nombre del archivo. Pensado para los nombres del descargador de YouTube:
//   "Artista - Canción (Video Oficial) - CanalVEVO (1080p, h264).mp4"
// Acierta en la mayoría; los que salgan mal se corrigen a mano desde la biblioteca.

// Etiquetas entre paréntesis o corchetes que no son parte del título
const RUIDO = /\s*[([](?:[^)\]]*\b(?:official|oficial|video|videoclip|lyrics?|letra|visualizer|audio|hd|4k|upgrade|explicit)\b[^)\]]*)[)\]]/gi;

function separar(archivo) {
  let base = String(archivo).replace(/\.[^.]+$/, '');
  let alto = null;
  // "(1080p, h264)" al final: resolución del video (sirve antes de cargarlo)
  const m = /\s*\((\d{3,4})p(?:,\s*[\w.]+)?\)\s*$/.exec(base);
  if (m) { alto = Number(m[1]); base = base.slice(0, m.index); }

  const partes = base.split(/\s+[-–]\s+|(?<=\S)-\s+/).map(p => p.trim()).filter(Boolean);
  const canal = partes.length >= 2 ? partes.pop() : ''; // lo último es el canal de YouTube
  const limpio = t => t.replace(RUIDO, '').replace(/\s{2,}/g, ' ').replace(/^[\s\-–]+|[\s\-–]+$/g, '').trim();

  let artista = '';
  let titulo;
  if (partes.length >= 2) {
    artista = limpio(partes.shift());
    titulo = limpio(partes.join(' - '));
  } else {
    titulo = limpio(partes[0] || base);
    artista = canal.replace(/VEVO$/i, '').trim(); // sin artista en el título: el canal suele serlo
  }
  return { titulo: titulo || base, artista, alto };
}

module.exports = { separar };
