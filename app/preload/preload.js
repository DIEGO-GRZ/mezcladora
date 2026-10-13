'use strict';
// Puente seguro entre la interfaz y el proceso principal.
// El acceso a disco (biblioteca, archivos) llegará por IPC en los siguientes pasos.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mezcladora', {
  plataforma: process.platform,
  versiones: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  },
  biblioteca: {
    canciones: () => ipcRenderer.invoke('biblioteca:canciones'),
    carpetas: () => ipcRenderer.invoke('biblioteca:carpetas'),
    // Revisa las carpetas y agrega lo nuevo → { nuevas, faltan, carpetasNoEncontradas } o null si falló
    escanear: () => ipcRenderer.invoke('biblioteca:escanear'),
    // Abre el selector de carpetas → ruta agregada o null si se canceló
    agregarCarpeta: () => ipcRenderer.invoke('biblioteca:agregarCarpeta'),
    // Guarda duración y resolución que se conocen al cargar la canción en un deck
    guardarInfo: (id, info) => ipcRenderer.invoke('biblioteca:guardarInfo', id, info),
    // Corrige título/artista a mano; datos vacíos = volver a lo automático → { titulo, artista, nombre_manual }
    editarNombre: (id, datos) => ipcRenderer.invoke('biblioteca:editarNombre', id, datos),
  },
  video: {
    // { conectada, nombre, ancho, alto } de la pantalla externa
    estado: () => ipcRenderer.invoke('video:estado'),
    // Vuelve a buscar la pantalla externa y coloca ahí la ventana de video
    recolocar: () => ipcRenderer.invoke('video:recolocar'),
    alCambiar: cb => {
      const f = (_e, estado) => cb(estado);
      ipcRenderer.on('video:estado', f);
      return () => ipcRenderer.removeListener('video:estado', f);
    },
  },
});
