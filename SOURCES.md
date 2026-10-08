# Fuentes de datos — ZIPA MVP 0

Toda la geografía del juego sale de estas fuentes. El juego no consulta ninguna API en ejecución:
el pipeline (`pipeline/`) descarga una vez, guarda en `data/cache/` (no versionado) y genera `public/world/`.
Las imágenes satelitales y de Street View no se usaron como datos (ni siquiera como referencia en esta sesión).

## Área

| Concepto | Valor |
|---|---|
| Origen (0,0,0) | Centroide de la **Plaza de los Comuneros**: **lat 5.0234382, lon −74.0040019** |
| Origen en UTM 18N (EPSG:32618) | E 610412.295, N 555339.163 |
| Cota del origen | 2615.57 m s.n.m. (Copernicus GLO-30, interpolado) |
| Área jugable | Cuadrado de 800 × 800 m centrado en el origen (x, z ∈ [−400, 400]) |
| Terreno visible | 920 × 920 m (60 m de margen fuera de los muros invisibles) |
| Caja de descarga | lat 5.0180–5.0300, lon −74.0096 – −73.9976 (≈ 1.33 × 1.33 km) |

**Cómo se obtuvo la plaza.** OSM no tiene un polígono llamado "Plaza de los Comuneros" (tampoco Nominatim ni
Wikidata lo resuelven por nombre). Es la plaza principal, frente a la Catedral Diocesana (OSM way
[116943050](https://www.openstreetmap.org/way/116943050)). En OSM aparece como el espacio abierto (sin edificios)
delimitado por estos ways:
[116943045](https://www.openstreetmap.org/way/116943045) (Carrera 8),
[1036042257](https://www.openstreetmap.org/way/1036042257) y [1291180761](https://www.openstreetmap.org/way/1291180761) (Carrera 7),
[771704318](https://www.openstreetmap.org/way/771704318) (path, surface=sett) y
[1386064867](https://www.openstreetmap.org/way/1386064867) (footway junto a la catedral).
El pipeline toma la cara de la red vial (shapely `polygonize`) cuyo borde cubren esos ways (6 839 m²) y usa su
centroide como origen. La lista de ways está en `pipeline/config.py` (`PLAZA_BOUNDARY_WAYS`).

## 1. Calles, plazas, zonas verdes, árboles — OpenStreetMap

| | |
|---|---|
| Fuente | OpenStreetMap vía Overpass API (`https://overpass-api.de/api/interpreter`) |
| Consulta | `pipeline/fetch_osm.py` (highway, building, building:part, place=square, leisure, landuse, amenity, natural=tree, highway=street_lamp) |
| Fecha de descarga | 2026-10-07 14:10:27 UTC |
| Estado de la base OSM | 2026-10-07T14:09:07Z |
| Licencia | [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/) |
| Atribución | © OpenStreetMap contributors |

## 2. Huellas de edificios — OSM + Overture Maps

**Prioridad:** primero OSM (945 edificios en el área). Donde OSM no tiene edificio, se completa con Overture:
sólo registros cuya fuente **no** es OSM y que se solapan con edificios OSM en menos de 20 % de su área
(`overtureMaxOverlap` en `src/data/buildings.json`). Resultado: +235 Google Open Buildings, +37 Microsoft ML Buildings.

| | |
|---|---|
| Fuente | Overture Maps Foundation, tema `buildings`, tipo `building` |
| Release | **2026-09-23.1** |
| Herramienta | `overturemaps` 1.0.2 (CLI oficial, `pipeline/fetch_overture.py`) |
| Fecha de descarga | 2026-10-07 14:04:38 UTC |
| Licencia del tema | ODbL 1.0 |
| Subfuentes usadas | Google Open Buildings (versión 2024-04-16; el proveedor publica bajo CC BY 4.0 / ODbL 1.0, licencia dual) · Microsoft ML Buildings (versión 2026-08-11; ODbL 1.0) |
| Atribución | Overture Maps Foundation; © OpenStreetMap contributors; Google Open Buildings; Microsoft ML Buildings |

## 3. Alturas de edificios

| Origen | Edificios | Marca |
|---|---|---|
| OSM `height=*` | 0 | — |
| OSM `building:levels=*` × altura por piso del arquetipo | 2 | dato |
| Overture `height` / `num_floors` (no OSM) | 0 (Overture no trae alturas en esta zona) | — |
| **Regla documentada** (`src/data/buildings.json` → `heightEstimate`) | 1 214 | `est: true`, `hsrc: "estimado:regla"` |
| Hito (Catedral), altura estimada en `landmarks` | 1 | `est: true`, `hsrc: "estimado:hito"` |

## 4. Terreno — Copernicus DEM GLO-30

| | |
|---|---|
| Fuente | Copernicus DEM GLO-30 (resolución 1″ ≈ 30 m), AWS Open Data `s3://copernicus-dem-30m` (COG, lectura directa con rasterio) |
| Teselas | `Copernicus_DSM_COG_10_N05_00_W075_00_DEM`, `Copernicus_DSM_COG_10_N05_00_W074_00_DEM` (el área cruza el meridiano −74°) |
| Fecha de descarga | 2026-10-07 14:04:48 UTC |
| Licencia | Licencia Copernicus DEM: uso libre y gratuito, con atribución |
| Atribución | © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved |
| Nota | Es un **DSM** (incluye edificios/árboles). Se suaviza con un gaussiano de σ = 0.8 px antes de interpolar (`src/data/world.json`). Si se deja un DEM del IGAC en `data/raw/` (GeoTIFF EPSG:4326), el pipeline lo usa en su lugar. |

## 5. Catedral y plaza (fase 2)

| Fuente | Uso | Licencia / derechos |
|---|---|---|
| Carlos Arbeláez Camacho, *Una obra poco conocida del arquitecto Fray Domingo de Petrés: la catedral de Zipaquirá*, Revista **Apuntes**, Pontificia Universidad Javeriana ([PDF](https://revistas.javeriana.edu.co/index.php/revApuntesArq/article/download/9214/7505/34531)), consultado el 2026-10-07 | Composición de la fachada y de la planta (ver `docs/INFORME_CATEDRAL.md`). Sólo se citan hechos, no se reproduce el texto | Artículo académico; citado como referencia |
| Wikipedia, *Zipaquirá Cathedral* | Qué torre tiene el campanario y cuál el reloj | CC BY-SA 4.0 (sólo hechos) |
| Fotos aportadas por el usuario (`docs/referencias/foto_usuario_catedral.png`, `foto_usuario_plaza.png`), 2026-10-07 | **Referencia visual**: proporciones, vanos, colores, diseño de materas, bancas, adoquín, balcones. Nada se calcó como textura | Del usuario (uso interno del proyecto; no se redistribuyen con el juego) |

Las alturas que se derivaron de la foto quedan marcadas como **estimadas** en `src/data/catedral.json`.

## 6. Imágenes satelitales / Street View

No se usaron.

## Software (no son datos, pero se redistribuyen en el juego)

three.js (MIT) · Rapier (Apache-2.0) · Vite (MIT). Las pruebas usan GeographicLib (MIT) y Playwright (Apache-2.0).
El pipeline usa shapely, pyproj, rasterio, scipy, numpy, Pillow, mapbox_earcut y overturemaps (licencias BSD/MIT/Apache).

La atribución de los datos aparece en pantalla, en la esquina inferior derecha del juego.
