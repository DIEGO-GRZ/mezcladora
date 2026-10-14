"""Lectura de audio con ffmpeg (sin PyTorch: lo usan el análisis y la separación)."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import numpy as np
import imageio_ffmpeg

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
# Evita que se abra una ventana de consola por cada ffmpeg en Windows
SIN_VENTANA = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0


def decodificar(ruta: Path | str, sr: int, canales: int) -> np.ndarray:
    """Cualquier audio o video → float32 (canales, muestras) a la frecuencia pedida."""
    proc = subprocess.run(
        [FFMPEG, "-v", "error", "-nostdin", "-i", str(ruta), "-vn", "-f", "f32le", "-ac", str(canales), "-ar", str(sr), "-"],
        capture_output=True, creationflags=SIN_VENTANA,
    )
    if proc.returncode != 0 or not proc.stdout:
        raise RuntimeError(f"ffmpeg no pudo leer el archivo: {proc.stderr.decode(errors='replace')[-300:]}")
    return np.frombuffer(proc.stdout, dtype=np.float32).reshape(-1, canales).T.copy()


def decodificar_canales(ruta: Path | str, sr: int, total: int, elegir: list[int]) -> np.ndarray:
    """Lee un archivo de varios canales (p. ej. stems.opus de 8) y devuelve solo los pedidos, sin mezclar."""
    todo = decodificar_multicanal(ruta, sr, total)
    return todo[elegir]


def decodificar_multicanal(ruta: Path | str, sr: int, total: int) -> np.ndarray:
    # -ac no se usa: se pide la disposición original para que ffmpeg no mezcle los canales
    proc = subprocess.run(
        [FFMPEG, "-v", "error", "-nostdin", "-i", str(ruta), "-vn", "-f", "f32le", "-ar", str(sr), "-"],
        capture_output=True, creationflags=SIN_VENTANA,
    )
    if proc.returncode != 0 or not proc.stdout:
        raise RuntimeError(f"ffmpeg no pudo leer el archivo: {proc.stderr.decode(errors='replace')[-300:]}")
    return np.frombuffer(proc.stdout, dtype=np.float32).reshape(-1, total).T.copy()
