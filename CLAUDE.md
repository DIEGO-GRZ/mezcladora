# Mezcladora Personal

App de escritorio para Windows que reemplaza a VirtualDJ: mezclar música y video desde el teclado de la laptop, sin marca de agua, con stems por IA (instrumental / acapella), video en segunda pantalla y funciones para dar temas y llevar el sonido de obras de teatro.

Documento de diseño completo (funciones premium, técnicas de DJ, fuentes): https://claude.ai/code/artifact/22c8788d-e55e-4f8e-8a7a-04a03c212f09

## Cómo trabajar conmigo (Diego)

- Responde en **español**.
- Entrega el código **por pasos pequeños**, no todo de golpe. Al terminar cada paso, dime cómo probarlo y espera mi confirmación antes de seguir.
- **Pregunta** cuando algo no esté claro en vez de suponer.
- Agrega por tu cuenta validaciones, manejo de errores y protecciones contra errores en vivo (ver "Reglas").
- Haz un commit de Git al cerrar cada paso que funcione.

## Equipo donde corre

| Componente | Detalle |
| --- | --- |
| Sistema | Windows, 64 bits |
| Procesador | AMD Ryzen 7 7435HS |
| RAM | 8 GB (justa: no correr la IA mientras se mezcla) |
| GPU | NVIDIA GeForce RTX 2050, 4 GB VRAM |
| Disco | ~82 GB libres |
| Audio | Bocinas Bluetooth (salida principal) + audífonos de cable (pre-escucha) |
| Video | Segunda pantalla (proyector o TV) |

## Reglas de diseño (no negociables)

1. **Teclado primero:** toda función tiene tecla directa, sin Alt ni Ctrl. Usar `e.code` (posición física), no `e.key`.
2. **Nada automático que quite control:** nada sube o baja volumen por su cuenta. El talkover (bajar música al hablar) es **opcional y apagado por defecto**; en teatro a veces se sube la música a propósito.
3. **Video solo en la segunda pantalla.** En la laptop no se muestra imagen salvo una vista previa opcional, apagada por defecto.
4. **La mezcladora nunca espera a la IA:** los stems se preparan antes; en vivo solo se lee del disco.
5. **Protecciones en vivo:** confirmar antes de reemplazar un deck que está al aire, avisar si se desconecta un dispositivo de audio, aviso al cerrar con música sonando, el foco nunca se queda en botones (Espacio no debe "presionarlos").
6. **Ahorro de disco:** stems comprimidos (Opus), solo de las canciones que yo elija preparar, carpeta de stems configurable y botón "Liberar espacio".

## Estado actual: prototipo

`prototipo/mezcladora.html` (un solo archivo, corre en Chrome desde localhost) ya tiene:

- Dos decks que aceptan audio y video, carga por arrastre o tecla.
- Crossfader de potencia constante; transición automática con curva programada (`setValueCurveAtTime`), que sigue funcionando aunque la ventana no esté visible.
- Marca de inicio por canción para saltar intros, guardada por `nombre|tamaño`.
- Salida principal y de audífonos separadas: principal con `AudioContext.setSinkId`, audífonos con un bus aparte → `MediaStreamDestination` → `<audio>` con `setSinkId`. La pre-escucha va antes del fader de volumen.
- Ventana de video: recibe la imagen de cada deck con `captureStream()`, funde según el crossfader, pantalla en negro con V.
- Barra que parpadea en los últimos 30 s del deck al aire.

Reutilizar su lógica de audio y teclado al migrar; no reescribir desde cero.

## Estado actual: app de Electron (etapa 1 terminada)

Se arranca con `npm start`. Lo que ya existe en `app/`:

- **Páginas servidas con `app://mezcladora/...`** (`protocol.handle` en `app/main/main.js`), solo archivos dentro de `app/`. Las canciones de la biblioteca se sirven en `app://mezcladora/medio/<id>` con peticiones por rangos; solo se sirven rutas que están en la biblioteca. Mismo origen para todo, así Web Audio y `captureStream()` funcionan sin CORS.
- **Mezcladora** (`app/renderer/`): el prototipo separado en `index.html`, `estilos.css` y `mezcladora.js`, con su misma lógica. CSP estricto, sin scripts en línea.
- **Ventana de video** (`app/video/`): la abre la mezcladora con `window.open` (comparten proceso y recibe la imagen con `captureStream()`). El proceso principal la pone a pantalla completa en la pantalla donde no está la mezcladora, la oculta si no hay segunda pantalla y la mueve al conectar/desconectar. No es enfocable, no se puede cerrar y no sale en la barra de tareas.
- **Biblioteca** (`app/main/biblioteca.js`): SQLite con `node:sqlite` (integrado, sin módulos nativos) en `datos/biblioteca.sqlite`. Esquema versionado con `PRAGMA user_version`. Escaneo asíncrono al abrir y con el botón Actualizar; lo que falta se marca como "no encontrado" sin borrarse.
- **Protecciones:** una sola instancia, sin menú (evita Ctrl+R), aviso al cerrar con música sonando, recarga si la página se cae, sin throttling en segundo plano.

## Diseño de la interfaz (referencia obligatoria)

- Archivo: `diseno/Main.dc.html` (y `diseno/pantalla-dj.png` si existe). El `.dc.html` es **solo referencia** de layout, colores y textos: no se ejecuta tal cual. Ignorar `support.js`, `<x-dc>`, `<sc-for>` y la clase `DCLogic`; construir la interfaz real en `app/renderer/`.
- Diseño en línea: https://claude.ai/artifact/HfcAoHLmwop1P5armGxkZz
- Estructura de arriba a abajo: barra superior (modo DJ/Temas/Teatro, estado de bocinas/audífonos/TV, medidor maestro con limitador, botón Pánico) → formas de onda de A y B con cabezal al centro → Deck A | Mixer | Deck B → Biblioteca (carpetas, tabla, panel de video y cola de preparación).
- Colores: fondo `#0D0F12`, paneles `#15181D`, controles `#1C2027`, bordes `#2A2F38`, texto `#E9ECF1`, texto secundario `#9AA3B2`, deck A `#2EC4E6`, deck B `#F0609E`, listo/al aire `#4ADE80`, aviso `#F5B942`, marca de salida `#FB923C`, pánico `#E5484D`.
- Tipografías (Google Fonts, empaquetarlas localmente en Electron): Barlow (texto), Barlow Condensed (etiquetas y títulos), JetBrains Mono (BPM, tiempos, teclas).
- Cada botón muestra su tecla en una etiqueta tipo tecla. Tono en notación Camelot, en verde si es compatible con el deck al aire. Resolución de video en amarillo si es menor a 720p.

### Teclas

**Son configurables** (Diego es zurdo: con la derecha usa el mouse, la transición y el crossfader). Todas salen de `app/renderer/teclas.js`; los botones muestran la tecla elegida (`<kbd data-tecla="...">`). Hay dos distribuciones y encima se pueden cambiar teclas sueltas. **Esc siempre es Pánico** y no se puede reasignar.

**Distribución zurda (la predeterminada):** lo más usado de los dos decks con la mano izquierda.

| Acción | Deck A | Deck B |
| --- | --- | --- |
| Play / pausa | Q | A |
| Pre-escucha en audífonos | W | S |
| Ir al inicio marcado | E | D |
| Marcar inicio (Shift = borrar) | R | F |
| −5 s / +5 s | Z / X | C / V |
| Loop de 4 tiempos / Sync | M / , | . / - |
| Efecto | G | H |
| Stems Voz / Melodía / Bajo / Batería (Shift = Acapella / Instrumental / Kick / HiHat) | U I O P | J K L Ñ |
| Hot cues 1-4 (Shift = guardar) | 1 2 3 4 | 7 8 9 0 |

Globales iguales en las dos distribuciones (ver abajo), más F10 = configuración.

**Distribución del diseño (diestra).** Teclado latinoamericano. Usar `e.code`.

| Acción | Deck A | Deck B |
| --- | --- | --- |
| Play / pausa | Q | U |
| Pre-escucha en audífonos | W | I |
| Marcar inicio (Shift = borrar) | E | O |
| Ir al inicio marcado | R | P |
| −5 s / +5 s | A / S | J / K |
| Loop de 4 tiempos | D | L |
| Sync | F | Ñ |
| Efecto | G | H |
| Stems Voz / Melodía / Bajo / Batería | Z / X / C / V | M / , / . / - |
| Acapella / Instrumental / Kick / HiHat | Shift + Z / X / C / V | Shift + M / , / . / - |
| Hot cues 1-4 (Shift = guardar) | 1 2 3 4 | 7 8 9 0 |

Globales: Espacio = transición, Shift+Espacio = corte, ← → = crossfader (Shift = paso grande), T = duración de transición (4/8/16/32 s), F1-F6 = estilo de transición (mezcla larga, corte, filtro, eco de salida, loop y subida, cambio de voz), B = video en negro, mantener `<` = bajar la música (talkover manual), Esc = pánico, ↑ ↓ = moverse en la biblioteca, Enter = cargar en A, Shift+Enter = cargar en B.

## Arquitectura objetivo

```
mezcladora-personal/
  CLAUDE.md
  prototipo/mezcladora.html     # referencia, no se borra
  diseno/Main.dc.html           # diseño de la interfaz (solo referencia)
  app/                          # Electron
    main/                       # proceso principal: ventanas, pantallas, archivos, SQLite, arranca el preparador
    preload/                    # puente seguro (contextBridge)
    renderer/                   # interfaz de la mezcladora + motor de audio
    video/                      # ventana de salida de video
  preparador/                   # servicio local en Python (FastAPI)
    separar.py                  # Demucs / audio-separator
    analisis.py                 # BPM, tono, detección de voz
  datos/                        # en .gitignore: biblioteca.sqlite, stems/
```

- **Electron:** `contextIsolation: true`, `nodeIntegration: false`, todo acceso a disco por IPC desde el preload. Servir archivos locales con un protocolo propio (`protocol.handle`) que soporte peticiones por rangos para poder adelantar en videos largos.
- **Segunda pantalla:** usar el módulo `screen` de Electron para abrir la ventana de video en pantalla completa en la pantalla externa y moverla sola si se conecta o desconecta.
- **Biblioteca:** SQLite (canciones, marcas, cues, BPM, tono, resolución del video, estado de stems). Migrar las marcas guardadas en `localStorage` del prototipo si es posible.
- **Preparador:** FastAPI local que Electron arranca y detiene solo; cola de trabajos, una canción a la vez, pausable mientras se reproduce.
  - Demucs `htdemucs` (4 stems: voz, batería, bajo, otros) con `--segment 7` para caber en 4 GB de VRAM. El repo original está archivado desde enero 2025: fijar versión.
  - Opción de alta calidad para voz/instrumental: BS-RoFormer vía `audio-separator` (MIT, dar crédito a UVR).
  - Respaldo en CPU si falla CUDA (≈1.5× la duración de la canción).
- **Stems en vivo:** reproducir con buffers sincronizados para que nunca se desfasen. Botones como VirtualDJ: Vocal, Instru, Bass, Kick, HiHat (Kick y HiHat = batería separada por filtro), Acapella, Instrumental.

## Plan por etapas

- [x] **Prototipo** (ver "Estado actual").
- [x] **1. Base de escritorio:** Electron con el prototipo migrado, ventana de video automática en la pantalla externa, biblioteca SQLite con carpeta de música.
- [ ] **1.5. Diseño nuevo:** pasar la interfaz a `diseno/Main.dc.html` (layout, colores, tipografías locales) y las teclas nuevas, antes de agregar stems.
- [ ] **2. Stems con IA:** preparador Python, cola de preparación, botones de stems, filtro en vivo de respaldo para canciones no preparadas.
- [ ] **3. Análisis:** BPM, tono (Camelot), forma de onda, detección de dónde empieza la voz para sugerir la marca de inicio.
- [ ] **4. Control fino:** 8 hot cues, loops, marca de salida, estilos de transición (mezcla larga, corte, filtro, eco de salida, loop y subida, cambio de voz), limitador en la salida principal.
- [ ] **5. Efectos y sonidos:** eco, reverb y filtro (un efecto por transición, en frases de 8/16/32 tiempos), efectos por stem, pads de efectos de sonido.
- [ ] **6. Temas y teatro:** lista de escena (modo show, una tecla lanza el siguiente), modo fondo musical, talkover manual, subidas/bajadas controladas, botón de pánico (Esc = fundido a silencio en 2 s).
- [ ] **7. Extras:** grabar la mezcla, sugerencias por tono compatible, texto en pantalla, visualizaciones, medidor de espacio y resolución de cada video en la biblioteca.

## Pendientes (anotados para no olvidarlos)

- **Búsqueda en la biblioteca** → con el diseño nuevo (etapa 1.5). Debe respetar "teclado primero": mientras se escribe, las teclas de los decks no deben quedar bloqueadas sin salida clara (p. ej. Enter/Esc devuelven el control).
- **Teclas para "Agregar carpeta" y "Actualizar biblioteca"** → con las teclas nuevas (etapa 1.5).
- **Marcas de inicio en SQLite** (hoy están en `localStorage` del renderer, clave `mark:nombre|tamaño`) → en la etapa 4, junto con hot cues y marca de salida. Migrar las existentes de `localStorage` a la base.
- **Importar marcas del prototipo** (están en el `localStorage` de Chrome, origen localhost) → al final, solo si hacen falta: exportarlas desde Chrome a un archivo e importarlo.
