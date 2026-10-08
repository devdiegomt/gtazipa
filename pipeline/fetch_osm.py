"""Descarga los datos OSM crudos del área (con margen) vía Overpass.

Guarda data/cache/osm_raw.json y data/cache/osm_meta.json (endpoint, timestamp de la base OSM, fecha de descarga).
Si todos los endpoints fallan, el script termina con error: NO se inventan datos.
"""
from __future__ import annotations

import datetime as dt
import json
import sys
import time

import requests

from config import CACHE, FETCH_BBOX_LL, OVERPASS_ENDPOINTS, USER_AGENT


def build_query(s: float, w: float, n: float, e: float) -> str:
    bb = f"{s},{w},{n},{e}"
    return f"""
[out:json][timeout:180];
(
  way["highway"]({bb});
  way["building"]({bb});
  relation["building"]({bb});
  way["building:part"]({bb});
  way["place"="square"]({bb});
  relation["place"="square"]({bb});
  way["area:highway"]({bb});
  way["leisure"]({bb});
  way["landuse"]({bb});
  way["amenity"]({bb});
  way["footway"]({bb});
  node["place"="square"]({bb});
  node["natural"="tree"]({bb});
  node["highway"="street_lamp"]({bb});
  way["natural"="tree_row"]({bb});
  way["natural"="water"]({bb});
  way["area"="yes"]["name"]({bb});
  nwr["historic"]({bb});
  nwr["tourism"="artwork"]({bb});
  nwr["amenity"~"^(bench|fountain|waste_basket|drinking_water)$"]({bb});
  node["man_made"="flagpole"]({bb});
);
(._;>;);
out body;
"""


def main() -> int:
    s, w, n, e = FETCH_BBOX_LL
    q = build_query(s, w, n, e)
    last_err = None
    for ep in OVERPASS_ENDPOINTS:
        for attempt in range(3):
            try:
                print(f"[osm] {ep} intento {attempt + 1}")
                r = requests.post(ep, data={"data": q}, headers={"User-Agent": USER_AGENT}, timeout=240)
                r.raise_for_status()
                data = r.json()
                if not data.get("elements"):
                    raise RuntimeError("respuesta sin elementos")
                CACHE.mkdir(parents=True, exist_ok=True)
                (CACHE / "osm_raw.json").write_text(json.dumps(data), encoding="utf-8")
                meta = {
                    "endpoint": ep,
                    "bbox_lat_lon": [s, w, n, e],
                    "osm_base_timestamp": data.get("osm3s", {}).get("timestamp_osm_base"),
                    "downloaded_utc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                    "elements": len(data["elements"]),
                }
                (CACHE / "osm_meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                print(f"[osm] OK {meta['elements']} elementos, base {meta['osm_base_timestamp']}")
                return 0
            except Exception as ex:  # noqa: BLE001
                last_err = ex
                print(f"[osm]   fallo: {ex}")
                time.sleep(5 * (attempt + 1))
    print(f"[osm] ERROR: no se pudo descargar OSM ({last_err}). Deteniendo.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
