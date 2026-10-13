'use strict';
// Avisa a la mezcladora que la página ya está lista para recibir la imagen de los decks.
// (postMessage en vez de esperar "load" desde fuera: funciona aunque la ventana se recargue)
const avisar = () => { try { window.opener?.postMessage('video-listo', location.origin); } catch {} };
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', avisar); else avisar();

// Esta ventana no recibe teclado (no es enfocable), pero por si acaso no deja que el arrastre de archivos la navegue
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => e.preventDefault());
