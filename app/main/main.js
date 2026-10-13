'use strict';
// Proceso principal de la Mezcladora Personal: crea la ventana y aplica las protecciones en vivo.
const { app, BrowserWindow, Menu, dialog, session, shell } = require('electron');
const path = require('node:path');

const DEV = !app.isPackaged;
let win = null;

// Solo una mezcladora abierta a la vez (dos instancias pelearían por las salidas de audio)
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(arrancar);
}

function arrancar() {
  // Sin menú: evita atajos como Ctrl+R (recargar cortaría la música) y que Alt robe el foco
  Menu.setApplicationMenu(null);

  // Permisos: solo micrófono/medios (para ver los nombres de las salidas de audio) y pantalla completa
  const PERMITIDOS = new Set(['media', 'speaker-selection', 'fullscreen', 'window-management']);
  session.defaultSession.setPermissionRequestHandler((_wc, permiso, cb) => cb(PERMITIDOS.has(permiso)));
  session.defaultSession.setPermissionCheckHandler((_wc, permiso) => PERMITIDOS.has(permiso));

  crearVentana();
}

function crearVentana() {
  win = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#0D0F12',
    title: 'Mezcladora Personal',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Las transiciones y el parpadeo siguen corriendo aunque la ventana esté minimizada o tapada
      backgroundThrottling: false,
      // El audio arranca sin esperar un clic
      autoplayPolicy: 'no-user-gesture-required',
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => { win.maximize(); win.show(); });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Ventana de video del prototipo (popup en blanco que la mezcladora rellena). Cualquier otro enlace se abre en el navegador.
  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (frameName === 'salidaVideo' && (url === '' || url === 'about:blank')) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          title: 'Salida de video',
          backgroundColor: '#000000',
          autoHideMenuBar: true,
          webPreferences: { backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
        },
      };
    }
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Nunca navegar fuera de la mezcladora (p. ej. al soltar un archivo fuera de un deck)
  win.webContents.on('will-navigate', e => e.preventDefault());

  // Aviso al cerrar con música sonando: la página bloquea el cierre (beforeunload) y aquí preguntamos
  win.webContents.on('will-prevent-unload', e => {
    const r = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Seguir mezclando', 'Cerrar de todos modos'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Mezcladora Personal',
      message: 'Hay música sonando.',
      detail: '¿Seguro que quieres cerrar la mezcladora?',
    });
    if (r === 1) e.preventDefault(); // ignora el bloqueo y cierra
  });

  // Si la página se cae, ofrecer recargarla en vez de dejar la ventana en blanco
  win.webContents.on('render-process-gone', (_e, info) => {
    if (info.reason === 'clean-exit') return;
    const r = dialog.showMessageBoxSync(win, {
      type: 'error',
      buttons: ['Recargar', 'Cerrar'],
      defaultId: 0,
      title: 'Mezcladora Personal',
      message: 'La mezcladora dejó de responder.',
      detail: `Motivo: ${info.reason}`,
    });
    if (r === 0) win.reload(); else win.destroy();
  });

  // Herramientas de desarrollo solo en desarrollo, con F12 (no choca con ninguna tecla de la mezcladora)
  if (DEV) {
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.code === 'F12') win.webContents.toggleDevTools();
    });
  }

  win.on('closed', () => { win = null; });
}

app.on('window-all-closed', () => app.quit());
