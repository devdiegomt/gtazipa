"""Terreno: usa un DEM local en data/raw/ (p.ej. IGAC) si existe; si no, descarga Copernicus GLO-30.

Copernicus GLO-30 se lee como COG directamente de AWS Open Data (sin credenciales) y sólo se
guarda una ventana con margen alrededor del área. Si no se puede obtener, el script termina con error.
"""
from __future__ import annotations

import datetime as dt
import json
import sys

import numpy as np
import rasterio
from rasterio.merge import merge
from rasterio.windows import from_bounds

from config import CACHE, COP_BASE, COP_TILES, FETCH_BBOX_LL, RAW

MARGIN_DEG = 0.004  # ~450 m extra para interpolar sin bordes


def local_dem() -> list:
    return sorted(p for p in RAW.glob("*") if p.suffix.lower() in (".tif", ".tiff", ".img", ".asc"))


def main() -> int:
    CACHE.mkdir(parents=True, exist_ok=True)
    s, w, n, e = FETCH_BBOX_LL
    s, w, n, e = s - MARGIN_DEG, w - MARGIN_DEG, n + MARGIN_DEG, e + MARGIN_DEG
    out = CACHE / "dem.tif"
    meta = {"downloaded_utc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}

    raws = local_dem()
    if raws:
        src_path = raws[0]
        print(f"[dem] usando DEM local {src_path.name}")
        with rasterio.open(src_path) as src:
            # Se reproyecta en build_world; aquí sólo se copia tal cual.
            profile = src.profile
            data = src.read(1)
        with rasterio.open(out, "w", **profile) as dst:
            dst.write(data, 1)
        meta.update({"source": "local", "file": src_path.name, "crs": str(profile.get("crs"))})
    else:
        datasets = []
        for tile in COP_TILES:
            url = f"/vsicurl/{COP_BASE}/{tile}/{tile}.tif"
            try:
                ds = rasterio.open(url)
            except Exception as ex:  # noqa: BLE001
                print(f"[dem] no se pudo abrir {tile}: {ex}")
                continue
            b = ds.bounds
            if b.left < e and b.right > w and b.bottom < n and b.top > s:
                datasets.append(ds)
                print(f"[dem] tile {tile} cubre el área")
        if not datasets:
            print("[dem] ERROR: no se pudo obtener Copernicus GLO-30. Deteniendo.", file=sys.stderr)
            return 1
        mosaic, transform = merge(datasets, bounds=(w, s, e, n))
        profile = datasets[0].profile.copy()
        profile.update(driver="GTiff", height=mosaic.shape[1], width=mosaic.shape[2], transform=transform,
                       compress="deflate", tiled=False, blockxsize=None, blockysize=None)
        profile.pop("blockxsize"); profile.pop("blockysize")
        with rasterio.open(out, "w", **profile) as dst:
            dst.write(mosaic)
        meta.update({
            "source": "Copernicus GLO-30 DEM (AWS Open Data)",
            "tiles": [d.name.split("/")[-1] for d in datasets],
            "crs": str(profile["crs"]),
            "shape": list(mosaic.shape[1:]),
            "min_m": float(np.nanmin(mosaic)), "max_m": float(np.nanmax(mosaic)),
        })
        for d in datasets:
            d.close()
    (CACHE / "dem_meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"[dem] OK {meta}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
