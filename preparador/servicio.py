"""Preparador de stems: proceso hijo de la Mezcladora Personal.

Electron lo arranca y le habla por la entrada estándar, una orden JSON por línea:
    {"cmd": "separar", "id": 12, "ruta": "C:/.../cancion.mp4", "salida": "C:/.../datos/stems/abc123"}
    {"cmd": "pausar"}      {"cmd": "reanudar"}      {"cmd": "cancelar", "id": 12}      {"cmd": "salir"}

Responde por la salida estándar, un evento JSON por línea:
    {"ev": "listo"}                                   el servicio arrancó y espera órdenes
    {"ev": "progreso", "id": 12, "etapa": "separando", "pct": 40}
    {"ev": "terminado", "id": 12, ...estadísticas}
    {"ev": "error", "id": 12, "mensaje": "..."}       {"ev": "cancelado", "id": 12}
    {"ev": "pausado"}  {"ev": "reanudado"}

Procesa una canción a la vez. Si se cierra la entrada (la mezcladora se cerró o se cayó), termina solo.
"""
from __future__ import annotations

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

_lock = threading.Lock()


def evento(**datos) -> None:
    with _lock:
        _salida.write(json.dumps(datos, ensure_ascii=False) + "\n")
        _salida.flush()


trabajos: "queue.Queue[dict]" = queue.Queue()
pausa = threading.Event()            # puesta = pausado
cancelados: set[int] = set()
actual: dict | None = None


def leer_ordenes() -> None:
    """Hilo que lee órdenes mientras el hilo principal separa."""
    for linea in sys.stdin:
        try:
            orden = json.loads(linea)
        except json.JSONDecodeError:
            continue
        cmd = orden.get("cmd")
        if cmd == "separar":
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


def main() -> None:
    import separar  # importa torch y demucs (tarda unos segundos)

    threading.Thread(target=leer_ordenes, daemon=True).start()
    evento(ev="listo")

    global actual
    while True:
        orden = trabajos.get()
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
            evento(ev="error", id=id_, mensaje=str(err)[:500])
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
