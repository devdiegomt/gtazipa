"""Huellas de edificios de Overture Maps (tema buildings) para la caja de descarga.

Usa el CLI oficial `overturemaps` (última release; la versión queda en el .state junto al GeoJSON).
build_world.py sólo usa los edificios cuya fuente NO es OpenStreetMap y que no se solapan con OSM.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from config import CACHE, FETCH_BBOX_LL


def main() -> int:
    s, w, n, e = FETCH_BBOX_LL
    CACHE.mkdir(parents=True, exist_ok=True)
    exe = Path(sys.executable).with_name("overturemaps.exe" if sys.platform == "win32" else "overturemaps")
    cmd = [str(exe), "download", f"--bbox={w},{s},{e},{n}", "-f", "geojson", "-t", "building",
           "-o", str(CACHE / "overture_buildings.geojson")]
    print("[overture]", " ".join(cmd))
    r = subprocess.run(cmd)
    if r.returncode != 0:
        print("[overture] ERROR: no se pudo descargar Overture buildings. Deteniendo.", file=sys.stderr)
    return r.returncode


if __name__ == "__main__":
    sys.exit(main())
