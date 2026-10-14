'use strict';
// Proceso principal de la Mezcladora Personal: crea las ventanas y aplica las protecciones en vivo.
const { app, BrowserWindow, Menu, dialog, session, shell, protocol, net, screen, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { Readable } = require('node:stream');
const { pathToFileURL } = require('node:url');
const biblioteca = require('./biblioteca');
const preparador = require('./preparador');

const DEV = !app.isPackaged;
const APP_DIR = path.resolve(__dirname, '..');
// Las páginas se sirven como app://mezcladora/... para que la mezcladora y la ventana de video
// compartan origen (la mezcladora le pasa la imagen de los decks directamente)
const ORIGEN = 'app://mezcladora';
const URL_VIDEO = `${ORIGEN}/video/index.html`;
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; media-src 'self' blob: mediastream:; img-src 'self' data: blob:";
// Datos locales (biblioteca, stems): en desarrollo la carpeta datos/ del proyecto; instalada, la del usuario
const CARPETA_DATOS = DEV ? path.resolve(APP_DIR, '..', 'datos') : path.join(app.getPath('userData'), 'datos');
const TIPOS_MEDIO = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.flac': 'audio/flac', '.opus': 'audio/ogg', '.mp4': 'video/mp4', '.m4v': 'video/mp4',
  '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.ogv': 'video/ogg',
};

let win = null;       // mezcladora
let videoWin = null;  // salida de video (segunda pantalla)
let estadoVideo = { conectada: false, nombre: '', ancho: 0, alto: 0 };
let videoEn = null;   // id de la pantalla donde está la ventana de video

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

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
  const PERMITIDOS = new Set(['media', 'speaker-selection', 'fullscreen']);
  session.defaultSession.setPermissionRequestHandler((_wc, permiso, cb) => cb(PERMITIDOS.has(permiso)));
  session.defaultSession.setPermissionCheckHandler((_wc, permiso) => PERMITIDOS.has(permiso));

  try {
    biblioteca.abrir(CARPETA_DATOS);
  } catch (err) {
    dialog.showErrorBox('Mezcladora Personal', `No se pudo abrir la biblioteca:
${err.message}

La mezcladora funciona igual cargando canciones por arrastre.`);
  }

  // app://mezcladora/<ruta> → archivos dentro de app/, nunca fuera
  // app://mezcladora/medio/<id> → canción de la biblioteca (mismo origen: el audio pasa por Web Audio sin bloqueos)
  protocol.handle('app', async req => {
    try {
      const u = new URL(req.url);
      if (u.host !== 'mezcladora') return new Response('No encontrado', { status: 404 });
      const medio = /^\/medio\/(\d+)$/.exec(u.pathname);
      if (medio) return await servirMedio(medio[1], req);
      const archivo = path.resolve(APP_DIR, '.' + decodeURIComponent(u.pathname));
      if (!archivo.startsWith(APP_DIR + path.sep)) return new Response('Prohibido', { status: 403 });
      const r = await net.fetch(pathToFileURL(archivo).toString());
      if (!archivo.endsWith('.html')) return r;
      // La política de contenido también va como encabezado (la etiqueta <meta> sola deja avisos de Electron)
      const headers = new Headers(r.headers);
      headers.set('Content-Security-Policy', CSP);
      return new Response(r.body, { status: r.status, headers });
    } catch {
      return new Response('No encontrado', { status: 404 });
    }
  });

  ipcMain.handle('biblioteca:canciones', () => conBiblioteca(() => biblioteca.canciones(), []));
  ipcMain.handle('biblioteca:carpetas', () => conBiblioteca(() => biblioteca.carpetas(), []));
  ipcMain.handle('biblioteca:escanear', () => conBiblioteca(() => biblioteca.escanear(), null));
  ipcMain.handle('biblioteca:agregarCarpeta', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Agregar carpeta de música', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return conBiblioteca(() => biblioteca.agregarCarpeta(r.filePaths[0]), null);
  });
  ipcMain.handle('biblioteca:guardarInfo', (_e, id, info) => conBiblioteca(() => biblioteca.guardarInfo(id, info || {}), null));
  ipcMain.handle('biblioteca:editarNombre', (_e, id, datos) => conBiblioteca(() => biblioteca.editarNombre(id, datos), null));

  // Preparador de stems (Python en segundo plano)
  preparador.iniciar({
    carpetaPreparador: path.resolve(APP_DIR, '..', 'preparador'),
    carpetaStems: path.join(CARPETA_DATOS, 'stems'),
    avisar: (canal, datos) => { if (win && !win.isDestroyed()) win.webContents.send(canal, datos); },
  });
  ipcMain.handle('preparador:estado', () => preparador.estado());
  ipcMain.handle('preparador:encolar', (_e, ids) => conBiblioteca(() => preparador.encolar(Array.isArray(ids) ? ids : [ids]), 0));
  ipcMain.handle('preparador:cancelar', (_e, id) => conBiblioteca(() => preparador.cancelar(id), false));
  ipcMain.on('preparador:musica', (_e, sonando) => preparador.alCambiarMusica(sonando));

  ipcMain.handle('video:estado', () => estadoVideo);
  ipcMain.handle('video:recolocar', () => { colocarVideo(true); return estadoVideo; });

  // Windows suele mandar varios avisos seguidos al conectar una pantalla: esperamos a que se calme
  let espera;
  const alCambiarPantallas = () => { clearTimeout(espera); espera = setTimeout(() => colocarVideo(true), 400); };
  screen.on('display-added', alCambiarPantallas);
  screen.on('display-removed', alCambiarPantallas);
  screen.on('display-metrics-changed', alCambiarPantallas);

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
  win.loadURL(`${ORIGEN}/renderer/index.html`);

  // La única ventana que la mezcladora puede abrir es la salida de video. Cualquier enlace web va al navegador.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url === URL_VIDEO) {
      // Si la mezcladora se recargó, la ventana vieja ya no recibe imagen: la reemplazamos
      if (videoWin && !videoWin.isDestroyed()) videoWin.destroy();
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          title: 'Salida de video',
          show: false,
          frame: false,
          // Nunca toma el teclado: aunque le des clic, las teclas siguen yendo a la mezcladora
          focusable: false,
          skipTaskbar: true,
          backgroundColor: '#000000',
          webPreferences: { backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
        },
      };
    }
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('did-create-window', (ventana, { url }) => {
    if (url !== URL_VIDEO) return;
    videoWin = ventana;
    // Mientras la mezcladora siga abierta, la ventana de video no se cierra (solo se oculta)
    ventana.on('close', e => { if (win && !win.isDestroyed()) { e.preventDefault(); ventana.hide(); } });
    ventana.on('closed', () => { if (videoWin === ventana) videoWin = null; });
    // Solo puede cargar su propia página (window.open navega desde about:blank, eso sí se permite)
    ventana.webContents.on('will-navigate', (e, destino) => { if (destino !== URL_VIDEO) e.preventDefault(); });
    ventana.webContents.once('did-finish-load', () => colocarVideo(true));
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

  // Si la mezcladora se mueve a otra pantalla, la de video puede tener que cambiar
  win.on('moved', () => colocarVideo());

  win.on('closed', () => {
    win = null;
    if (videoWin && !videoWin.isDestroyed()) videoWin.destroy();
  });
}

// ---------- Salida de video en la segunda pantalla ----------

// La pantalla externa es cualquiera donde NO esté la mezcladora (así funciona aunque el proyector sea la "principal")
function pantallaExterna() {
  const todas = screen.getAllDisplays();
  if (todas.length < 2) return null;
  const actual = win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay();
  return todas.find(d => d.id !== actual.id) || null;
}

// forzar = volver a colocarla aunque ya esté en esa pantalla (al conectar/desconectar o al pedirlo)
function colocarVideo(forzar = false) {
  if (!videoWin || videoWin.isDestroyed()) return;
  const ext = pantallaExterna();
  if (!forzar && (ext?.id ?? null) === videoEn) return; // nada cambió: no hacer parpadear el proyector
  videoEn = ext?.id ?? null;
  const antes = estadoVideo;

  if (ext) {
    // Regla: el video solo se ve en la segunda pantalla, a pantalla completa
    if (videoWin.isFullScreen()) videoWin.setFullScreen(false);
    // Dos veces: Windows ajusta mal el tamaño al pasar entre pantallas con distinta escala
    videoWin.setBounds(ext.bounds);
    videoWin.setBounds(ext.bounds);
    videoWin.setFullScreen(true);
    videoWin.showInactive(); // sin quitarle el foco a la mezcladora
    estadoVideo = {
      conectada: true,
      nombre: ext.label || 'Pantalla externa',
      ancho: Math.round(ext.size.width * ext.scaleFactor),
      alto: Math.round(ext.size.height * ext.scaleFactor),
    };
  } else {
    // Sin segunda pantalla, la imagen no se muestra en la laptop
    videoWin.hide();
    estadoVideo = { conectada: false, nombre: '', ancho: 0, alto: 0 };
  }

  if (antes.conectada !== estadoVideo.conectada || antes.nombre !== estadoVideo.nombre) {
    if (win && !win.isDestroyed()) win.webContents.send('video:estado', estadoVideo);
  }
}

// ---------- Biblioteca ----------

// Si la base falla, la mezcladora sigue funcionando (por arrastre); nunca tirar la app por la biblioteca
async function conBiblioteca(fn, siFalla) {
  try { return await fn(); }
  catch (err) { console.error('Biblioteca:', err); return siFalla; }
}

// Sirve un archivo de la biblioteca con soporte de rangos (para poder adelantar en videos largos)
async function servirMedio(id, req) {
  const ruta = biblioteca.rutaDe(id);
  if (!ruta) return new Response('No encontrado', { status: 404 });
  let st;
  try { st = await fs.promises.stat(ruta); } catch { return new Response('No encontrado', { status: 404 }); }
  const tipo = TIPOS_MEDIO[path.extname(ruta).toLowerCase()] || 'application/octet-stream';
  const total = st.size;
  const rango = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') || '');

  if (!rango) {
    return new Response(Readable.toWeb(fs.createReadStream(ruta)), {
      status: 200,
      headers: { 'Content-Type': tipo, 'Content-Length': String(total), 'Accept-Ranges': 'bytes' },
    });
  }
  let inicio, fin;
  if (rango[1] === '') { inicio = Math.max(0, total - Number(rango[2])); fin = total - 1; } // bytes=-N (últimos N)
  else { inicio = Number(rango[1]); fin = rango[2] === '' ? total - 1 : Math.min(Number(rango[2]), total - 1); }
  if (!(inicio <= fin) || inicio >= total) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
  }
  return new Response(Readable.toWeb(fs.createReadStream(ruta, { start: inicio, end: fin })), {
    status: 206,
    headers: {
      'Content-Type': tipo,
      'Content-Length': String(fin - inicio + 1),
      'Content-Range': `bytes ${inicio}-${fin}/${total}`,
      'Accept-Ranges': 'bytes',
    },
  });
}

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { preparador.detener(); biblioteca.cerrar(); });
