"""Análisis de una canción: BPM, rejilla de pulsos, tono (Camelot), forma de onda e inicio de la voz.

Uso de prueba:
    .venv\\Scripts\\python.exe analisis.py <archivo> [stems.opus]
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np

from audio import decodificar, decodificar_canales

SR = 22050                 # suficiente para pulso, tono y forma de onda
ONDA_POR_SEG = 100         # puntos de la forma de onda por segundo
BPM_MIN, BPM_MAX = 70, 180  # rango "de DJ": fuera de aquí se duplica o se divide a la mitad

NOTAS = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
# Rueda Camelot: número por tónica (índice en NOTAS); mayor = B, menor = A
CAMELOT_MAYOR = {0: 8, 7: 9, 2: 10, 9: 11, 4: 12, 11: 1, 6: 2, 1: 3, 8: 4, 3: 5, 10: 6, 5: 7}
CAMELOT_MENOR = {9: 8, 4: 9, 11: 10, 6: 11, 1: 12, 8: 1, 3: 2, 10: 3, 5: 4, 0: 5, 7: 6, 2: 7}
# Perfiles de Krumhansl-Kessler
PERFIL_MAYOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
PERFIL_MENOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


HOP_FINO = 128             # ~5.8 ms por cuadro para el ajuste fino del BPM


def pulso(y: np.ndarray) -> tuple[float, float]:
    """BPM (con centésimas) y momento del primer pulso (segundos).
    1) librosa da un BPM aproximado (su rejilla es gruesa: p. ej. 129.2 cuando es 128.0).
    2) Ajuste fino: se prueba cada BPM cercano en pasos de 0.01 "doblando" la curva de golpes sobre un
       periodo; el BPM correcto concentra los golpes en la misma fase (histograma más puntiagudo)."""
    import librosa
    tempo, _ = librosa.beat.beat_track(y=y, sr=SR, trim=False)
    aprox = float(np.atleast_1d(tempo)[0])
    if not aprox:
        raise RuntimeError("no se encontró un pulso claro")
    while aprox < BPM_MIN:
        aprox *= 2
    while aprox >= BPM_MAX:
        aprox /= 2

    golpes = librosa.onset.onset_strength(y=y, sr=SR, hop_length=HOP_FINO)
    golpes = np.maximum(golpes - np.median(golpes), 0)
    t = np.arange(len(golpes)) * HOP_FINO / SR
    if golpes.sum() <= 0:
        raise RuntimeError("no se encontró un pulso claro")

    def puntaje(bpm: float) -> float:
        # Peine: componentes 1..4 del histograma de fases. Solo con la 1.ª, los golpes a contratiempo
        # (hi-hats) cancelan a los del pulso y la curva queda plana.
        fase = 2 * np.pi * (t % (60.0 / bpm)) / (60.0 / bpm)
        return sum(abs(np.sum(golpes * np.exp(1j * k * fase))) for k in range(1, 5))

    candidatos = np.arange(aprox - 2.5, aprox + 2.5, 0.05)
    mejor = max(candidatos, key=puntaje)
    finos = np.arange(mejor - 0.06, mejor + 0.06, 0.005)
    bpm = float(max(finos, key=puntaje))
    periodo = 60.0 / bpm
    # Primer pulso: donde se concentran más golpes dentro del periodo (normalmente el bombo)
    bins = 64
    hist = np.bincount(((t % periodo) / periodo * bins).astype(int) % bins, weights=golpes, minlength=bins)
    hist = np.convolve(np.r_[hist[-2:], hist, hist[:2]], np.ones(5) / 5, "valid")
    primer = (np.argmax(hist) + 0.5) / bins * periodo
    return round(bpm, 2), round(float(primer), 3)


def tono(y: np.ndarray) -> tuple[str, str]:
    """Tonalidad ('Am', 'F#') y su código Camelot ('8A', '2B')."""
    import librosa
    armonico = librosa.effects.harmonic(y)
    croma = librosa.feature.chroma_cqt(y=armonico, sr=SR).mean(axis=1)
    mejor = (-2.0, 0, "mayor")
    for t in range(12):
        for modo, perfil in (("mayor", PERFIL_MAYOR), ("menor", PERFIL_MENOR)):
            c = float(np.corrcoef(croma, np.roll(perfil, t))[0, 1])
            if c > mejor[0]:
                mejor = (c, t, modo)
    _, t, modo = mejor
    if modo == "mayor":
        return NOTAS[t], f"{CAMELOT_MAYOR[t]}B"
    return f"{NOTAS[t]}m", f"{CAMELOT_MENOR[t]}A"


def forma_de_onda(y: np.ndarray) -> bytes:
    """Nivel por bandas (graves <200 Hz, medios, agudos >2 kHz), ONDA_POR_SEG puntos por segundo,
    como bytes intercalados [g, m, a, g, m, a, ...] de 0 a 255 (escala de dB de -48 a 0)."""
    from scipy.signal import butter, sosfilt
    graves = sosfilt(butter(4, 200, "lowpass", fs=SR, output="sos"), y)
    agudos = sosfilt(butter(4, 2000, "highpass", fs=SR, output="sos"), y)
    medios = y - graves - agudos
    paso = SR // ONDA_POR_SEG
    n = len(y) // paso
    salida = np.empty((n, 3), dtype=np.uint8)
    for i, banda in enumerate((graves, medios, agudos)):
        bloques = np.abs(banda[: n * paso]).reshape(n, paso).max(axis=1)
        db = 20 * np.log10(np.maximum(bloques, 1e-5))
        salida[:, i] = np.clip((db + 48) / 48 * 255, 0, 255).astype(np.uint8)
    return salida.tobytes()


def inicio_voz(stems: Path, bpm: float | None, primer: float | None) -> float | None:
    """Primer momento con voz sostenida (canales 0-1 de stems.opus), ajustado al pulso anterior."""
    voz = decodificar_canales(stems, SR, 8, [0, 1]).mean(axis=0)
    ventana = SR // 10                                    # bloques de 0.1 s
    n = len(voz) // ventana
    if n < 20:
        return None
    rms = np.sqrt((voz[: n * ventana].reshape(n, ventana) ** 2).mean(axis=1))
    umbral = max(np.percentile(rms, 90) * 0.2, 10 ** (-40 / 20))
    activo = rms > umbral
    # "sostenida": al menos 12 de los siguientes 20 bloques (1.2 s de 2 s) con voz
    suma = np.convolve(activo.astype(int), np.ones(20, dtype=int), "full")[19:]
    candidatos = np.nonzero(activo & (suma[: len(activo)] >= 12))[0]
    if not len(candidatos):
        return None
    t = candidatos[0] * 0.1
    if bpm and primer is not None:                        # al pulso anterior: la marca queda "en tiempo"
        periodo = 60.0 / bpm
        t = primer + np.floor((t - primer) / periodo) * periodo
    return round(max(0.0, float(t)), 3)


def analizar(ruta: Path, onda: Path | None = None, stems: Path | None = None) -> dict:
    inicio = time.time()
    y = decodificar(ruta, SR, 1)[0]
    duracion = len(y) / SR
    r: dict = {"duracion": round(duracion, 2)}
    try:
        r["bpm"], r["primer_beat"] = pulso(y)
    except Exception:
        r["bpm"], r["primer_beat"] = None, None          # sin pulso claro (p. ej. una balada sin batería)
    r["tono"], r["camelot"] = tono(y)
    if onda:
        onda.parent.mkdir(parents=True, exist_ok=True)
        temporal = onda.with_suffix(".tmp")
        temporal.write_bytes(forma_de_onda(y))
        temporal.replace(onda)
    r["inicio_voz"] = inicio_voz(stems, r["bpm"], r["primer_beat"]) if stems and stems.exists() else None
    r["segundos"] = round(time.time() - inicio, 1)
    return r


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    print(json.dumps(analizar(Path(sys.argv[1]), None, Path(sys.argv[2]) if len(sys.argv) > 2 else None), ensure_ascii=False))
