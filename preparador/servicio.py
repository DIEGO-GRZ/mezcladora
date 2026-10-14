"""Preparador de stems: proceso hijo de la Mezcladora Personal.

Electron lo arranca y le habla por la entrada estándar, una orden JSON por línea:
    {"cmd": "separar", "id": 12, "ruta": "C:/.../cancion.mp4", "salida": "C:/.../datos/stems/abc123"}
    {"cmd": "analizar", "id": 12, "ruta": "...", "onda": "C:/.../datos/analisis/abc123.onda", "stems": "...stems.opus" | null}
    {"cmd": "pausar"}      {"cmd": "reanudar"}      {"cmd": "cancelar", "id": 12}      {"cmd": "salir"}

Responde por la salida estándar, un evento JSON por línea:
    {"ev": "listo"}                                   el servicio arrancó y espera órdenes
    {"ev": "progreso", "id": 12, "etapa": "separando", "pct": 40}
    {"ev": "terminado", "id": 12, ...estadísticas}
    {"ev": "analizado", "id": 12, "bpm": 128.0, "primer_beat": 0.21, "tono": "Am", "camelot": "8A", "inicio_voz": 15.1, ...}
    {"ev": "error", "id": 12, "tipo": "separar" | "analizar", "mensaje": "..."}       {"ev": "cancelado", "id": 12}
    {"ev": "pausado"}  {"ev": "reanudado"}

Procesa una canción a la vez. Si se cierra la entrada (la mezcladora se cerró o se cayó), termina solo.
"""
from __future__ import annotations

import io
import json
import os
import queue
import sys
import threading
import time
import traceback
from pathlib import Path

# La salida estándar es solo para eventos: cualquier otro texto (avisos de librerías) va a stderr
_salida = sys.stdout
sys.stdout = sys.stderr
# Las órdenes se leen directo del descriptor 0 (ver leer_ordenes). sys.stdin queda vacío: si alguna
# librería lo consulta al importarse, no se queda esperando el bloqueo del hilo lector (eso congelaba
# el primer análisis, porque librosa se importa después de arrancar el hilo).
_fd_entrada = sys.stdin.fileno()
sys.stdin = io.StringIO("")

_lock = threading.Lock()


def evento(**datos) -> None:
    with _lock:
        _salida.write(json.dumps(datos, ensure_ascii=False) + "\n")
        _salida.flush()


trabajos: "queue.Queue[dict]" = queue.Queue()
pausa = threading.Event()            # puesta = pausado
cancelados: set[int] = set()
actual: dict | None = None


def _leer_bloque() -> bytes:
    """Un bloque de la entrada; b"" = se cerró.
    En Windows NO se puede dejar un hilo bloqueado leyendo la tubería: mientras tanto, cargar cualquier DLL
    nueva (numpy, librosa, torch) se congela. Por eso se pregunta primero si hay datos (PeekNamedPipe)
    y solo se lee cuando los hay."""
    if sys.platform != "win32":
        return os.read(_fd_entrada, 65536)
    import ctypes
    import msvcrt
    from ctypes import wintypes
    manejador = msvcrt.get_osfhandle(_fd_entrada)
    disponibles = wintypes.DWORD(0)
    peek = ctypes.windll.kernel32.PeekNamedPipe
    while True:
        if not peek(wintypes.HANDLE(manejador), None, 0, None, ctypes.byref(disponibles), None):
            return b""                         # tubería rota: Electron se cerró
        if disponibles.value:
            return os.read(_fd_entrada, disponibles.value)
        time.sleep(0.05)


def lineas_entrada():
    """Lee líneas del descriptor de entrada sin usar sys.stdin (ver arriba)."""
    pendiente = b""
    while True:
        bloque = _leer_bloque()
        if not bloque:
            return
        pendiente += bloque
        while b"\n" in pendiente:
            linea, pendiente = pendiente.split(b"\n", 1)
            yield linea.decode("utf-8", errors="replace")


def leer_ordenes() -> None:
    """Hilo que lee órdenes mientras el hilo principal trabaja."""
    for linea in lineas_entrada():
        try:
            orden = json.loads(linea)
        except json.JSONDecodeError:
            continue
        cmd = orden.get("cmd")
        if cmd in ("separar", "analizar"):
            trabajos.put(orden)
        elif cmd == "pausar":
            if not pausa.is_set():
                pausa.set()
                evento(ev="pausado")
        elif cmd == "reanudar":
            if pausa.is_set():
                pausa.clear()
                evento(ev="reanudado")
        elif cmd == "cancelar":
            cancelados.add(int(orden.get("id", -1)))
        elif cmd == "salir":
            break
    # Entrada cerrada o "salir": terminar ya, aunque haya un trabajo a medias
    os._exit(0)


def limpiar(carpeta: Path) -> None:
    """Tras cancelar o fallar: borra solo los temporales propios y la carpeta si quedó vacía."""
    try:
        for f in carpeta.glob("*.tmp.opus"):
            f.unlink(missing_ok=True)
        if carpeta.is_dir() and not any(carpeta.iterdir()):
            carpeta.rmdir()
    except OSError:
        pass


def analizar(orden: dict) -> None:
    import analisis  # librosa (sin PyTorch: el análisis no usa la GPU)
    id_ = int(orden["id"])
    try:
        stems = Path(orden["stems"]) if orden.get("stems") else None
        r = analisis.analizar(Path(orden["ruta"]), Path(orden["onda"]) if orden.get("onda") else None, stems)
        evento(ev="analizado", id=id_, **r)
    except Exception as err:
        traceback.print_exc()
        evento(ev="error", id=id_, tipo="analizar", mensaje=str(err)[:500])


def main() -> None:
    threading.Thread(target=leer_ordenes, daemon=True).start()
    evento(ev="listo")

    global actual
    while True:
        orden = trabajos.get()
        if orden.get("cmd") == "analizar":
            analizar(orden)
            continue
        import separar  # PyTorch y Demucs se cargan solo la primera vez que hay que separar
        id_ = int(orden["id"])
        if id_ in cancelados:
            cancelados.discard(id_)
            evento(ev="cancelado", id=id_)
            continue
        actual = orden
        ultimo = {"pct": -1}

        def control(hechos: int, total: int) -> None:
            # Antes de cada bloque: cancelar, esperar si hay pausa, reportar avance
            while True:
                if id_ in cancelados:
                    raise separar.Cancelado()
                if not pausa.is_set():
                    break
                time.sleep(0.25)
            pct = int(100 * hechos / max(total, 1))
            if pct != ultimo["pct"]:
                ultimo["pct"] = pct
                evento(ev="progreso", id=id_, etapa="separando", pct=pct)

        try:
            evento(ev="progreso", id=id_, etapa="leyendo", pct=0)
            r = separar.separar(Path(orden["ruta"]), Path(orden["salida"]), control=control)
            evento(ev="terminado", id=id_, **{k: v for k, v in r.items() if k != "etapa"})
        except separar.Cancelado:
            cancelados.discard(id_)
            limpiar(Path(orden["salida"]))
            evento(ev="cancelado", id=id_)
        except Exception as err:
            traceback.print_exc()
            limpiar(Path(orden["salida"]))
            evento(ev="error", id=id_, tipo="separar", mensaje=str(err)[:500])
        finally:
            actual = None
            try:
                import torch
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass


if __name__ == "__main__":
    # Que separar.py e imports locales funcionen sin importar desde dónde se lance
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    try:
        main()
    except Exception as err:
        evento(ev="fatal", mensaje=str(err)[:500])
        raise
