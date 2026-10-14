"""Separación de stems con Demucs (htdemucs) para la Mezcladora Personal.

Uso de prueba:
    .venv\\Scripts\\python.exe separar.py <archivo de audio o video> <carpeta de salida>

Escribe en la carpeta de salida: voz.opus, bateria.opus, bajo.opus, melodia.opus
e imprime el avance como líneas JSON.
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
import types
from pathlib import Path

import numpy as np
import torch
import imageio_ffmpeg
import demucs.apply
from demucs.apply import apply_model
from demucs.pretrained import get_model

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
SR = 44100                      # frecuencia con la que trabaja htdemucs
MODELO = "htdemucs"             # 4 stems: drums, bass, other, vocals
SEGMENTO = 7                    # segundos por bloque: cabe en 4 GB de VRAM (máximo del modelo: 7.8)
BITRATE = "96k"                 # Opus estéreo: buena calidad y ~3 MB por stem en 4 min
# Nombres de Demucs → nombres de la mezcladora
NOMBRES = {"vocals": "voz", "drums": "bateria", "bass": "bajo", "other": "melodia"}

# Evita que se abra una ventana de consola por cada ffmpeg en Windows
SIN_VENTANA = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

_modelo = None

# --- Punto de control entre bloques ---
# Demucs recorre la canción en bloques de SEGMENTO segundos usando tqdm. Lo reemplazamos por un recorrido
# que antes de cada bloque llama a _control(hechos, total): ahí se reporta el avance, se espera si hay
# que pausar o se lanza Cancelado. Sin control, se comporta igual que antes.
_control = None


class Cancelado(Exception):
    pass


def _recorrer(iterable, **_):
    elementos = list(iterable)
    for i, x in enumerate(elementos):
        if _control:
            _control(i, len(elementos))
        yield x


demucs.apply.tqdm = types.SimpleNamespace(tqdm=_recorrer)


def avisar(**datos) -> None:
    print(json.dumps(datos, ensure_ascii=False), flush=True)


def modelo():
    """Carga el modelo una sola vez (la primera vez lo descarga, ~80 MB)."""
    global _modelo
    if _modelo is None:
        _modelo = get_model(MODELO)
        _modelo.eval()
    return _modelo


def cargar_audio(ruta: Path) -> torch.Tensor:
    """Decodifica cualquier audio o video a estéreo float32 a 44.1 kHz → tensor (2, muestras)."""
    proc = subprocess.run(
        [FFMPEG, "-v", "error", "-nostdin", "-i", str(ruta), "-vn", "-f", "f32le", "-ac", "2", "-ar", str(SR), "-"],
        capture_output=True, creationflags=SIN_VENTANA,
    )
    if proc.returncode != 0 or not proc.stdout:
        raise RuntimeError(f"ffmpeg no pudo leer el archivo: {proc.stderr.decode(errors='replace')[-300:]}")
    datos = np.frombuffer(proc.stdout, dtype=np.float32).reshape(-1, 2).T.copy()
    return torch.from_numpy(datos)


def guardar_opus(audio: torch.Tensor, destino: Path) -> None:
    """Comprime un stem (2, muestras) a Opus. Se escribe a un temporal y se renombra al final."""
    temporal = destino.with_suffix(".tmp.opus")
    datos = audio.clamp(-1, 1).T.contiguous().numpy().astype(np.float32).tobytes()
    proc = subprocess.run(
        [FFMPEG, "-v", "error", "-nostdin", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", "-",
         "-c:a", "libopus", "-b:a", BITRATE, "-ar", "48000", str(temporal)],
        input=datos, capture_output=True, creationflags=SIN_VENTANA,
    )
    if proc.returncode != 0:
        temporal.unlink(missing_ok=True)
        raise RuntimeError(f"ffmpeg no pudo guardar {destino.name}: {proc.stderr.decode(errors='replace')[-300:]}")
    temporal.replace(destino)


def separar_en(wav: torch.Tensor, dispositivo: str) -> torch.Tensor:
    """Corre Demucs. Normaliza como lo hace la línea de comandos de Demucs."""
    ref = wav.mean(0)
    media, desv = ref.mean(), ref.std() + 1e-8
    entrada = ((wav - media) / desv)[None]
    with torch.no_grad():
        salida = apply_model(modelo(), entrada, device=dispositivo, segment=SEGMENTO, split=True,
                             overlap=0.25, shifts=1, progress=True)[0]
    return salida * desv + media


def separar(ruta: Path, carpeta: Path, control=None) -> dict:
    """control(hechos, total) se llama antes de cada bloque (avance, pausa, cancelación)."""
    global _control
    _control = control
    inicio = time.time()
    carpeta.mkdir(parents=True, exist_ok=True)
    avisar(etapa="leyendo", archivo=ruta.name)
    wav = cargar_audio(ruta)
    duracion = wav.shape[1] / SR

    dispositivo = "cuda" if torch.cuda.is_available() else "cpu"
    avisar(etapa="separando", dispositivo=dispositivo, duracion=round(duracion, 1))
    try:
        stems = separar_en(wav, dispositivo)
    except Cancelado:
        raise
    except (RuntimeError, torch.cuda.OutOfMemoryError) as err:
        if dispositivo != "cuda":
            raise
        # Respaldo: si la GPU falla (memoria, driver), se repite en el procesador
        avisar(etapa="respaldo_cpu", motivo=str(err)[:200])
        torch.cuda.empty_cache()
        dispositivo = "cpu"
        stems = separar_en(wav, dispositivo)

    t_sep = time.time() - inicio
    avisar(etapa="guardando")
    for i, fuente in enumerate(modelo().sources):
        guardar_opus(stems[i], carpeta / f"{NOMBRES[fuente]}.opus")

    vram = torch.cuda.max_memory_allocated() / 2**20 if dispositivo == "cuda" else 0
    resultado = dict(etapa="listo", dispositivo=dispositivo, duracion=round(duracion, 1),
                     segundos_separar=round(t_sep, 1), segundos_total=round(time.time() - inicio, 1),
                     vram_mb=round(vram), mb_en_disco=round(sum(f.stat().st_size for f in carpeta.glob("*.opus")) / 2**20, 1))
    avisar(**resultado)
    return resultado


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    try:
        separar(Path(sys.argv[1]), Path(sys.argv[2]))
    except Exception as err:  # el error va como JSON para que Electron lo pueda mostrar
        avisar(etapa="error", mensaje=str(err)[:500])
        sys.exit(1)
