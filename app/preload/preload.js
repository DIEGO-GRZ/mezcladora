'use strict';
// Puente seguro entre la interfaz y el proceso principal.
// Por ahora solo expone datos de la app; el acceso a disco (biblioteca, archivos) llegará por IPC en los siguientes pasos.
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('mezcladora', {
  plataforma: process.platform,
  versiones: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  },
});
