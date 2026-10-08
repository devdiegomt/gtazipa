"""Configuración del pipeline. Los valores de juego ajustables viven en src/data/*.json."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "cache"
RAW = ROOT / "data" / "raw"
OUT = ROOT / "public" / "world"
GAME_DATA = ROOT / "src" / "data"

USER_AGENT = "ZIPA-pipeline/0.1 (proyecto de juego; contacto via repositorio)"

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

# Caja de descarga (lat_s, lon_w, lat_n, lon_e): ~1.3 km alrededor de la Catedral Diocesana
# (OSM way 116943050, centro 5.0240041, -74.0036028). El recorte final de 800 m se hace
# alrededor del centro de la plaza, que se calcula desde OSM en build_world.py.
FETCH_BBOX_LL = (5.0180, -74.0096, 5.0300, -73.9976)

# Plaza de los Comuneros (plaza principal, frente a la Catedral Diocesana). OSM no la tiene como
# polígono con nombre: es la cara de la red vial (polygonize) delimitada por estos ways OSM, sin
# edificios dentro. Su centroide es el origen (0,0,0). Ver SOURCES.md.
PLAZA_BOUNDARY_WAYS = [116943045, 1036042257, 1291180761, 771704318, 1386064867]
CATHEDRAL_WAY = 116943050

AREA_SIZE_M = 800.0  # lado del cuadrado jugable
EPSG_UTM = 32618

# Copernicus GLO-30 (AWS Open Data, sin credenciales)
COP_TILES = [
    "Copernicus_DSM_COG_10_N05_00_W075_00_DEM",
    "Copernicus_DSM_COG_10_N05_00_W074_00_DEM",
]
COP_BASE = "https://copernicus-dem-30m.s3.amazonaws.com"
