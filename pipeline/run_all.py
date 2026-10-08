"""Pipeline completo: descarga (con caché) + generación de public/world/.

  python run_all.py            usa la caché de data/cache/ si existe
  python run_all.py --refresh  vuelve a descargar OSM, Overture y DEM
"""
from __future__ import annotations

import sys

import build_world
import fetch_dem
import fetch_osm
import fetch_overture
from config import CACHE


def main() -> int:
    refresh = "--refresh" in sys.argv
    steps = [
        ("osm_raw.json", fetch_osm.main),
        ("overture_buildings.geojson", fetch_overture.main),
        ("dem.tif", fetch_dem.main),
    ]
    for cached, fn in steps:
        if refresh or not (CACHE / cached).exists():
            if fn() != 0:
                return 1
        else:
            print(f"[cache] {cached} ya existe (usa --refresh para descargar de nuevo)")
    return build_world.main()


if __name__ == "__main__":
    sys.exit(main())
