"""Genera public/world/ a partir de los datos crudos en data/cache/.

Sistema de coordenadas del juego (1 unidad = 1 metro):
  - Proyección UTM 18N (EPSG:32618). Origen local = centroide de la Plaza de los Comuneros (OSM).
  - x = (E - E0) / k,  z = -(N - N0) / k,  y = h - h0
    k = factor de escala UTM en el origen (las distancias del juego son distancias reales sobre el
    elipsoide, no distancias de cuadrícula). -Z = norte de cuadrícula UTM, +X = este, Y = altura.

Salidas (public/world/):
  world.json      metadatos: origen, terreno, estadísticas, atribución
  terrain.bin     alturas Float32 (n*n, fila = z, columna = x)
  ground.png      textura del suelo: calzadas, aceras, plazas, zonas verdes
  buildings.glb   edificios fusionados por manzana (un mesh por manzana, una primitiva por material)
  buildings.json  metadatos por edificio (fuente, arquetipo, regla, altura, altura_estimada)
  roads.json      red vial (polilíneas en coordenadas del juego) para minimapa y lógica
  corners.json    esquinas (nodos OSM compartidos por calles con distinto nombre) con lat/lon originales
  props.json      árboles y postes de OSM (instanciados en el juego)
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
import struct
import sys
from collections import defaultdict

import mapbox_earcut as earcut
import numpy as np
import rasterio
from PIL import Image, ImageDraw
from pyproj import Proj, Transformer
from scipy.ndimage import gaussian_filter, map_coordinates
from shapely import make_valid
from shapely.geometry import LineString, MultiPolygon, Point, Polygon, box, shape
from shapely.geometry.polygon import orient
from shapely.ops import polygonize, split, unary_union
from shapely.strtree import STRtree

import shapely
import catedral as cat_model
import vias as vias_model
from config import (CACHE, CATHEDRAL_WAY, EPSG_UTM, GAME_DATA, OUT, PLAZA_BOUNDARY_WAYS)

ROADS_CFG = json.loads((GAME_DATA / "roads.json").read_text(encoding="utf-8"))
BLD_CFG = json.loads((GAME_DATA / "buildings.json").read_text(encoding="utf-8"))
WORLD_CFG = json.loads((GAME_DATA / "world.json").read_text(encoding="utf-8"))
PLAZA_CFG = json.loads((GAME_DATA / "plaza.json").read_text(encoding="utf-8"))
CAT_CFG = json.loads((GAME_DATA / "catedral.json").read_text(encoding="utf-8"))
TRAFFIC_CFG = json.loads((GAME_DATA / "trafico.json").read_text(encoding="utf-8"))
PARKS_CFG = {k: v for k, v in json.loads((GAME_DATA / "parques.json").read_text(encoding="utf-8")).items() if not k.startswith("_")}

HALF = WORLD_CFG["area"]["size"] / 2.0
T_HALF = HALF + WORLD_CFG["area"]["terrainMargin"]
T_STEP = WORLD_CFG["area"]["terrainSpacing"]

VEHICULAR = {"primary", "secondary", "tertiary", "unclassified", "residential", "living_street"}
BLOCK_EDGES = VEHICULAR | {"pedestrian"}


def log(*a):
    print("[world]", *a, flush=True)


# ---------------------------------------------------------------- OSM

class OSM:
    def __init__(self, raw: dict):
        self.nodes = {}
        self.ways = {}
        self.rels = {}
        for e in raw["elements"]:
            if e["type"] == "node":
                self.nodes[e["id"]] = e
            elif e["type"] == "way":
                self.ways[e["id"]] = e
            else:
                self.rels[e["id"]] = e


class Frame:
    """Transforma lon/lat <-> coordenadas del juego."""

    def __init__(self, lon0: float, lat0: float):
        self.fwd = Transformer.from_crs(4326, EPSG_UTM, always_xy=True)
        self.inv = Transformer.from_crs(EPSG_UTM, 4326, always_xy=True)
        self.E0, self.N0 = self.fwd.transform(lon0, lat0)
        f = Proj(EPSG_UTM).get_factors(lon0, lat0)
        self.k = float(f.meridional_scale)
        self.convergence = float(f.meridian_convergence)
        self.lon0, self.lat0 = lon0, lat0

    def xn(self, lon, lat):
        """Coordenadas planas locales (x=este, n=norte) en metros reales."""
        E, N = self.fwd.transform(lon, lat)
        return (np.asarray(E) - self.E0) / self.k, (np.asarray(N) - self.N0) / self.k

    def lonlat(self, x, n):
        return self.inv.transform(self.E0 + np.asarray(x) * self.k, self.N0 + np.asarray(n) * self.k)


def way_coords_ll(osm: OSM, w) -> list:
    return [(osm.nodes[i]["lon"], osm.nodes[i]["lat"]) for i in w["nodes"] if i in osm.nodes]


def find_plaza(osm: OSM) -> Polygon:
    """Cara de la red vial delimitada por PLAZA_BOUNDARY_WAYS (en lon/lat → UTM provisional)."""
    fwd = Transformer.from_crs(4326, EPSG_UTM, always_xy=True)
    lines = []
    for w in osm.ways.values():
        if "highway" in w.get("tags", {}):
            ll = way_coords_ll(osm, w)
            if len(ll) >= 2:
                lines.append(LineString([fwd.transform(*p) for p in ll]))
    border = unary_union([LineString([fwd.transform(*p) for p in way_coords_ll(osm, osm.ways[i])])
                          for i in PLAZA_BOUNDARY_WAYS]).buffer(0.5)
    best = None
    for poly in polygonize(unary_union(lines)):
        covered = poly.exterior.intersection(border).length / poly.exterior.length
        if covered > 0.95 and (best is None or poly.area > best.area):
            best = poly
    if best is None:
        raise SystemExit("No se encontró la plaza delimitada por PLAZA_BOUNDARY_WAYS")
    return best


# ---------------------------------------------------------------- terreno

class Terrain:
    def __init__(self, frame: Frame):
        with rasterio.open(CACHE / "dem.tif") as src:
            if src.crs.to_epsg() != 4326:
                raise SystemExit("El DEM local debe estar en EPSG:4326 (o adaptar fetch_dem.py)")
            dem = src.read(1).astype(np.float64)
            inv_t = ~src.transform
        dem = gaussian_filter(dem, WORLD_CFG["dem"]["smoothSigmaPx"])
        self.n = int(round(2 * T_HALF / T_STEP)) + 1
        xs = -T_HALF + np.arange(self.n) * T_STEP
        X, Z = np.meshgrid(xs, xs)  # filas = z, columnas = x
        lon, lat = frame.lonlat(X.ravel(), -Z.ravel())
        col, row = inv_t * (np.asarray(lon), np.asarray(lat))
        h = map_coordinates(dem, [np.asarray(row) - 0.5, np.asarray(col) - 0.5], order=3, mode="nearest")
        h = h.reshape(self.n, self.n)
        self.h0 = float(self.sample_abs(h, 0.0, 0.0))
        self.heights = (h - self.h0).astype(np.float32)
        log(f"terreno {self.n}x{self.n} paso {T_STEP} m, h0 = {self.h0:.2f} m s.n.m., "
            f"relieve {self.heights.min():.1f}..{self.heights.max():.1f} m")

    def sample_abs(self, h, x, z):
        fx = (x + T_HALF) / T_STEP
        fz = (z + T_HALF) / T_STEP
        return map_coordinates(h, [[fz], [fx]], order=1, mode="nearest")[0]

    def y(self, x, z):
        """Altura bilineal (coordenadas del juego). x, z escalares o arrays."""
        x = np.atleast_1d(np.asarray(x, dtype=np.float64))
        z = np.atleast_1d(np.asarray(z, dtype=np.float64))
        return map_coordinates(self.heights, [(z + T_HALF) / T_STEP, (x + T_HALF) / T_STEP], order=1, mode="nearest")


def fit_plane(terrain: "Terrain", poly: Polygon):
    """Plano por mínimos cuadrados ajustado al DEM a lo largo del borde de un polígono (coords del juego)."""
    ring = poly.exterior
    samples = [ring.interpolate(d) for d in np.arange(0, ring.length, 2.0)]
    sx = np.array([q.x for q in samples]); sz = np.array([q.y for q in samples])
    sy = terrain.y(sx, sz)
    A = np.c_[np.ones_like(sx), sx, sz]
    coef, *_ = np.linalg.lstsq(A, sy, rcond=None)
    return coef, float(np.std(sy - A @ coef))


def apply_plane(terrain: "Terrain", coef, region, blend: float):
    n = terrain.n
    xs = -T_HALF + np.arange(n) * T_STEP
    X, Z = np.meshgrid(xs, xs)
    d = shapely.distance(region, shapely.points(X.ravel(), Z.ravel())).reshape(n, n)
    t = np.clip(1 - d / blend, 0, 1)
    w = t * t * (3 - 2 * t)
    planeH = coef[0] + coef[1] * X + coef[2] * Z
    terrain.heights = (terrain.heights * (1 - w) + planeH * w).astype(np.float32)


def flatten_terrain(terrain: "Terrain", plaza_game: Polygon, cat_game: Polygon):
    """Sustituye el DSM dentro de la plaza y la catedral por un plano ajustado al DEM en el borde de la plaza."""
    cfg = PLAZA_CFG["terrain"]
    coef, resid = fit_plane(terrain, plaza_game)
    region = unary_union([plaza_game.buffer(cfg["buffer"]), cat_game.buffer(cfg["buffer"])])
    apply_plane(terrain, coef, region, cfg["blend"])
    # Re-cero: el centro de la plaza (origen) vuelve a quedar en y = 0.
    terrain.heights -= np.float32(coef[0])
    terrain.h0 += float(coef[0])
    coef[0] = 0.0
    slope = math.degrees(math.atan(math.hypot(coef[1], coef[2])))
    log(f"plaza aplanada: plano y = {coef[0]:.2f} + {coef[1]:.4f}·x + {coef[2]:.4f}·z (pendiente {slope:.1f}°, "
        f"residuo DEM en el borde ±{resid:.2f} m)")
    return {"a": float(coef[0]), "bx": float(coef[1]), "bz": float(coef[2]), "slopeDeg": slope, "residualStd": resid}


def flatten_park(terrain: "Terrain", park_game: Polygon, cfg: dict, name: str):
    coef, resid = fit_plane(terrain, park_game)
    apply_plane(terrain, coef, park_game.buffer(cfg["buffer"]), cfg["blend"])
    slope = math.degrees(math.atan(math.hypot(coef[1], coef[2])))
    log(f"{name}: rasante plana (pendiente {slope:.1f}°, residuo DEM en el borde ±{resid:.2f} m)")
    return {"a": float(coef[0]), "bx": float(coef[1]), "bz": float(coef[2]), "slopeDeg": slope, "residualStd": resid}


def park_export(osm: "OSM", frame: "Frame", key: str, cfg: dict, plane: dict):
    """Geometría del parque y de sus elementos (OSM) en coordenadas del juego."""
    def ring_of(wid):
        ll = way_coords_ll(osm, osm.ways[wid])
        x, n = frame.xn([q[0] for q in ll], [q[1] for q in ll])
        return orient(Polygon(list(zip(x, -n))), 1.0)
    park = ring_of(cfg["osmPark"])
    out = {"id": key, "name": cfg["name"], "osm": f"way/{cfg['osmPark']}", "area": round(park.area, 1),
           "ring": [[round(a, 2), round(b, 2)] for a, b in park.exterior.coords], "plane": plane,
           "fountains": [], "monuments": [], "memorials": []}
    for wid in cfg.get("fountains", []):
        if wid in osm.ways:
            f = ring_of(wid)
            out["fountains"].append({"osm": f"way/{wid}", "name": osm.ways[wid]["tags"].get("name"),
                                     "x": round(f.centroid.x, 2), "z": round(f.centroid.y, 2),
                                     "radius": round(math.sqrt(f.area / math.pi), 2),
                                     "ring": [[round(a, 2), round(b, 2)] for a, b in f.exterior.coords]})
    for wid in cfg.get("monuments", []):
        if wid in osm.ways:
            m = ring_of(wid)
            q = np.asarray(m.minimum_rotated_rectangle.exterior.coords)[:4]
            e0, e1 = q[1] - q[0], q[2] - q[1]
            ax = e0 if np.linalg.norm(e0) >= np.linalg.norm(e1) else e1
            L, W = max(np.linalg.norm(e0), np.linalg.norm(e1)), min(np.linalg.norm(e0), np.linalg.norm(e1))
            ax = ax / np.linalg.norm(ax)
            pc = park.centroid
            # lado "frontal" de la plataforma: el que mira al centro del parque
            nrm = np.array([-ax[1], ax[0]])
            if np.dot(nrm, np.array([pc.x - m.centroid.x, pc.y - m.centroid.y])) < 0:
                nrm = -nrm
            out["monuments"].append({"osm": f"way/{wid}", "name": osm.ways[wid]["tags"].get("name"),
                                     "x": round(m.centroid.x, 2), "z": round(m.centroid.y, 2),
                                     "axis": [round(float(ax[0]), 5), round(float(ax[1]), 5)],
                                     "front": [round(float(nrm[0]), 5), round(float(nrm[1]), 5)],
                                     "length": round(float(L), 2), "width": round(float(W), 2),
                                     "ring": [[round(a, 2), round(b, 2)] for a, b in m.exterior.coords]})
    for nid in cfg.get("memorials", []):
        nd = osm.nodes.get(nid)
        if nd:
            x, n = frame.xn(nd["lon"], nd["lat"])
            out["memorials"].append({"osm": f"node/{nid}", "name": nd.get("tags", {}).get("name"),
                                     "x": round(float(x), 2), "z": round(float(-n), 2)})
    return out


def build_cathedral(cat_map: Polygon, terrain: "Terrain"):
    """Ajusta el marco local a la fachada (arista OSM más cercana a la plaza) y genera catedral.glb."""
    ring = np.asarray(orient(cat_map, 1.0).exterior.coords)
    game = np.c_[ring[:, 0], -ring[:, 1]]  # (x, z)
    best = None
    for i in range(len(game) - 1):
        m = (game[i] + game[i + 1]) / 2
        dd = float(np.hypot(*m))
        if best is None or dd < best[0]:
            best = (dd, game[i], game[i + 1])
    _, a, b = best
    width = float(np.linalg.norm(b - a))
    mid = (a + b) / 2
    e = (b - a) / width
    nrm = np.array([-e[1], e[0]])
    if np.dot(nrm, -mid) > 0:
        nrm = -nrm                        # n: hacia el interior del templo
    ax = np.array([-nrm[1], nrm[0]])      # derecha del observador que mira la fachada
    uv = [(float(np.dot(p - mid, ax)), float(np.dot(p - mid, nrm))) for p in game]
    foot_uv = make_valid(Polygon(uv))
    steps = CAT_CFG["steps"]
    y0 = float(terrain.y(mid[0], mid[1])[0]) + steps["rise"] * steps["count"]
    gy = terrain.y(game[:, 0], game[:, 1])
    y_bottom = float(gy.min()) - 0.8 - y0
    B = cat_model.build(CAT_CFG, foot_uv, width, y_bottom)
    prims, tris = [], 0
    names = sorted(B.d)
    for mat in names:
        m = B.d[mat]
        P = np.asarray(m["p"], np.float64)
        N = np.asarray(m["n"], np.float64)
        gx = mid[0] + P[:, 0] * ax[0] - P[:, 2] * nrm[0]
        gz = mid[1] + P[:, 0] * ax[1] - P[:, 2] * nrm[1]
        pos = np.c_[gx, y0 + P[:, 1], gz]
        nx = N[:, 0] * ax[0] - N[:, 2] * nrm[0]
        nz = N[:, 0] * ax[1] - N[:, 2] * nrm[1]
        nr = np.c_[nx, N[:, 1], nz]
        nr /= np.linalg.norm(nr, axis=1, keepdims=True) + 1e-12
        idx = np.asarray(m["i"], np.uint32)
        tris += len(idx) // 3
        prims.append((mat, pos, nr, np.asarray(m["uv"]), np.ones((len(pos), 3)), idx))
    write_glb(OUT / "catedral.glb", [("catedral", prims)], names)
    log(f"catedral.glb: {len(names)} materiales, {tris} triángulos; fachada {width:.2f} m, piso atrio y={y0:.2f}")
    return {"file": "catedral.glb", "origin": [round(float(mid[0]), 3), round(float(mid[1]), 3)],
            "axisU": [round(float(ax[0]), 6), round(float(ax[1]), 6)], "axisV": [round(float(nrm[0]), 6), round(float(nrm[1]), 6)],
            "floorY": round(y0, 3), "facadeWidth": round(width, 3), "triangles": tris}


# ---------------------------------------------------------------- glb writer

def write_glb(path, meshes, material_names):
    """meshes: list of (name, [(material, pos[N,3], nrm[N,3], uv[N,2], col[N,3], idx[M])])"""
    bin_chunks = []
    offset = 0
    buffer_views, accessors = [], []

    def add(arr: np.ndarray, target, comp, type_, minmax=False, normalized=False):
        nonlocal offset
        data = arr.tobytes()
        pad = (-len(data)) % 4
        buffer_views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(data), **({"target": target} if target else {})})
        bin_chunks.append(data + b"\x00" * pad)
        offset += len(data) + pad
        acc = {"bufferView": len(buffer_views) - 1, "componentType": comp, "count": int(arr.shape[0]), "type": type_}
        if normalized:
            acc["normalized"] = True
        if minmax:
            acc["min"] = arr.min(axis=0).tolist()
            acc["max"] = arr.max(axis=0).tolist()
        accessors.append(acc)
        return len(accessors) - 1

    mat_index = {m: i for i, m in enumerate(material_names)}
    gl_meshes, nodes = [], []
    for name, prims in meshes:
        gprims = []
        for mat, pos, nrm, uv, col, idx in prims:
            attrs = {
                "POSITION": add(pos.astype(np.float32), 34962, 5126, "VEC3", minmax=True),
                "NORMAL": add(nrm.astype(np.float32), 34962, 5126, "VEC3"),
                "TEXCOORD_0": add(uv.astype(np.float32), 34962, 5126, "VEC2"),
                "COLOR_0": add(np.clip((col if col.shape[1] == 4 else np.hstack([col, np.ones((len(col), 1))])) * 255 + 0.5, 0, 255).astype(np.uint8),
                               34962, 5121, "VEC4", normalized=True),
            }
            ind = add(idx.astype(np.uint32), 34963, 5125, "SCALAR")
            gprims.append({"attributes": attrs, "indices": ind, "material": mat_index[mat]})
        gl_meshes.append({"name": name, "primitives": gprims})
        nodes.append({"name": name, "mesh": len(gl_meshes) - 1})
    gltf = {
        "asset": {"version": "2.0", "generator": "ZIPA pipeline"},
        "scene": 0,
        "scenes": [{"nodes": list(range(len(nodes)))}],
        "nodes": nodes,
        "meshes": gl_meshes,
        "materials": [{"name": m, "pbrMetallicRoughness": {"metallicFactor": 0.0, "roughnessFactor": 0.9}} for m in material_names],
        "buffers": [{"byteLength": offset}],
        "bufferViews": buffer_views,
        "accessors": accessors,
    }
    js = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    js += b" " * ((-len(js)) % 4)
    binary = b"".join(bin_chunks)
    total = 12 + 8 + len(js) + 8 + len(binary)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(js), 0x4E4F534A))
        f.write(js)
        f.write(struct.pack("<II", len(binary), 0x004E4942))
        f.write(binary)


class MeshBuilder:
    def __init__(self):
        self.pos, self.nrm, self.uv, self.col, self.idx = [], [], [], [], []
        self.count = 0

    @staticmethod
    def _rgba(color):
        return tuple(color) if len(color) == 4 else (*color, 1.0)

    def quad(self, a, b, c, d, n, uvs, color):
        base = self.count
        self.pos += [a, b, c, d]
        self.nrm += [n] * 4
        self.uv += uvs
        self.col += [self._rgba(color)] * 4
        self.idx += [base, base + 1, base + 2, base, base + 2, base + 3]
        self.count += 4

    def tris(self, verts, tris, n, uvs, color):
        base = self.count
        self.pos += verts
        self.nrm += [n] * len(verts)
        self.uv += uvs
        self.col += [self._rgba(color)] * len(verts)
        self.idx += [base + i for i in tris]
        self.count += len(verts)

    def face(self, pts, n, uvs, color):
        """Polígono convexo; el sentido de los triángulos se ajusta a la normal n."""
        P = [np.asarray(q, float) for q in pts]
        flip = np.dot(np.cross(P[1] - P[0], P[2] - P[0]), n) < 0
        tri = []
        for k in range(1, len(P) - 1):
            tri += [0, k + 1, k] if flip else [0, k, k + 1]
        self.tris([tuple(q) for q in P], tri, tuple(n), uvs, color)

    def arrays(self):
        return (np.array(self.pos, np.float32), np.array(self.nrm, np.float32), np.array(self.uv, np.float32),
                np.array(self.col, np.float32).reshape(-1, 4), np.array(self.idx, np.uint32))


def polygon_parts(g):
    if g.is_empty:
        return []
    if isinstance(g, Polygon):
        return [g]
    if isinstance(g, MultiPolygon):
        return list(g.geoms)
    if hasattr(g, "geoms"):
        out = []
        for p in g.geoms:
            out += polygon_parts(p)
        return out
    return []


def triangulate(poly: Polygon):
    """Triangula un polígono (x, n) con huecos; devuelve vértices y triángulos CCW vistos desde arriba."""
    rings = [np.asarray(poly.exterior.coords)[:-1]] + [np.asarray(r.coords)[:-1] for r in poly.interiors]
    verts = np.vstack(rings)
    ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
    tri = earcut.triangulate_float64(verts, ends).reshape(-1, 3)
    out = []
    for a, b, c in tri:
        (x1, y1), (x2, y2), (x3, y3) = verts[a], verts[b], verts[c]
        area = (x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1)
        out.append((a, b, c) if area > 0 else (a, c, b))
    return verts, out


def add_prism(mb: MeshBuilder, poly: Polygon, y_bottom: float, y_top: float, ground_ref: float, color,
              top=True, bottom=False, uv_scale_top=1.0):
    """Paredes (UV en metros: u = perímetro, v = altura sobre ground_ref) + tapa superior."""
    poly = orient(poly, 1.0)
    for ring in [poly.exterior, *poly.interiors]:
        pts = np.asarray(ring.coords)
        u = 0.0
        for (x0, n0), (x1, n1) in zip(pts[:-1], pts[1:]):
            L = math.hypot(x1 - x0, n1 - n0)
            if L < 1e-3:
                continue
            dx, dn = (x1 - x0) / L, (n1 - n0) / L
            nrm = (dn, 0.0, dx)  # normal exterior en coords juego: (nE, 0, -nN) con nE=dn, nN=-dx
            a = (x0, y_bottom, -n0)
            b = (x1, y_bottom, -n1)
            c = (x1, y_top, -n1)
            d = (x0, y_top, -n0)
            vb, vt = y_bottom - ground_ref, y_top - ground_ref
            mb.quad(a, b, c, d, nrm, [(u, vb), (u + L, vb), (u + L, vt), (u, vt)], color)
            u += L
    if top or bottom:
        verts, tris = triangulate(poly)
        if top:
            v3 = [(float(x), y_top, float(-n)) for x, n in verts]
            mb.tris(v3, [i for t in tris for i in t], (0.0, 1.0, 0.0),
                    [(float(x) * uv_scale_top, float(n) * uv_scale_top) for x, n in verts], color)
        if bottom:
            v3 = [(float(x), y_bottom, float(-n)) for x, n in verts]
            mb.tris(v3, [i for t in tris for i in (t[0], t[2], t[1])], (0.0, -1.0, 0.0),
                    [(float(x), float(n)) for x, n in verts], color)


def _insert_line_crossings(coords, nrm, ks, c):
    """Inserta vértices donde el anillo cruza las rectas (p - c)·nrm = k."""
    out = []
    pts = [tuple(q) for q in coords]
    for a, b in zip(pts[:-1], pts[1:]):
        out.append(a)
        da = [(a[0] - c[0]) * nrm[0] + (a[1] - c[1]) * nrm[1] - k for k in ks]
        db = [(b[0] - c[0]) * nrm[0] + (b[1] - c[1]) * nrm[1] - k for k in ks]
        cuts = [x0 / (x0 - x1) for x0, x1 in zip(da, db) if x0 * x1 < 0]
        for t in sorted(cuts):
            out.append((a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])))
    out.append(pts[-1])
    return out


def add_pitched(mb_wall, mb_roof, poly, y_bottom, eave, ground_ref, color, pitch_deg, max_run, overhang):
    """Cubierta a dos aguas con cumbrera según el eje largo del rectángulo mínimo de la huella; si la crujía es muy
    ancha, la pendiente se limita a max_run (franja superior plana). Muros hasta la cubierta (hastiales)."""
    poly = orient(poly, 1.0)
    mrr = poly.minimum_rotated_rectangle
    q = np.asarray(mrr.exterior.coords)[:4]
    e0, e1 = q[1] - q[0], q[2] - q[1]
    d = e0 if np.linalg.norm(e0) >= np.linalg.norm(e1) else e1
    d = d / np.linalg.norm(d)
    nrm = np.array([-d[1], d[0]])
    c = np.asarray(mrr.centroid.coords[0])
    half = min(np.linalg.norm(e0), np.linalg.norm(e1)) / 2
    t = math.tan(math.radians(pitch_deg))
    run = min(half, max_run)
    ks = [0.0] if half <= max_run + 1e-6 else [-(half - run), half - run]

    def h(x, n):
        s_ = abs((x - c[0]) * nrm[0] + (n - c[1]) * nrm[1])
        return eave + t * min(run, half - s_)

    for ring in [poly.exterior, *poly.interiors]:
        pts = _insert_line_crossings(np.asarray(ring.coords), nrm, ks, c)
        u = 0.0
        for (x0, n0), (x1, n1) in zip(pts[:-1], pts[1:]):
            L = math.hypot(x1 - x0, n1 - n0)
            if L < 1e-3:
                continue
            dx, dn = (x1 - x0) / L, (n1 - n0) / L
            t0, t1 = h(x0, n0), h(x1, n1)
            vb = y_bottom - ground_ref
            mb_wall.face([(x0, y_bottom, -n0), (x1, y_bottom, -n1), (x1, t1, -n1), (x0, t0, -n0)], (dn, 0.0, dx),
                         [(u, vb), (u + L, vb), (u + L, t1 - ground_ref), (u, t0 - ground_ref)], color)
            u += L
    roof = poly.buffer(overhang, join_style=2, mitre_limit=2.0)
    far = 1000.0
    pieces = [roof]
    for k in ks:
        p0 = c + nrm * k - d * far
        p1 = c + nrm * k + d * far
        nxt = []
        for pc in pieces:
            nxt += polygon_parts(split(pc, LineString([tuple(p0), tuple(p1)])))
        pieces = nxt
    for pc in pieces:
        if pc.area < 0.05:
            continue
        verts, tris = triangulate(pc)
        if not tris:
            continue
        v3 = [(float(x), h(x, n), float(-n)) for x, n in verts]
        a, b, cc = (np.asarray(v3[i]) for i in tris[0])
        nn = np.cross(b - a, cc - a)
        nn = nn / (np.linalg.norm(nn) + 1e-12)
        if nn[1] < 0:
            nn = -nn
        uvs = [(float((x - c[0]) * d[0] + (n - c[1]) * d[1]), float(abs((x - c[0]) * nrm[0] + (n - c[1]) * nrm[1])))
               for x, n in verts]
        mb_roof.tris(v3, [i for tr in tris for i in tr], tuple(nn), uvs, color)
    return h


def add_balconies(mb, poly, plaza_map, floor_y, color, cfg):
    """Balcón corrido de madera en las fachadas (aristas) que dan a la plaza. Alfa 0 = baranda (balaustres)."""
    poly = orient(poly, 1.0)
    pts = np.asarray(poly.exterior.coords)
    n_added = 0
    for (x0, n0), (x1, n1) in zip(pts[:-1], pts[1:]):
        L = math.hypot(x1 - x0, n1 - n0)
        if L < cfg["minEdge"]:
            continue
        dx, dn = (x1 - x0) / L, (n1 - n0) / L
        out = np.array([dn, -dx])
        mid = np.array([(x0 + x1) / 2, (n0 + n1) / 2])
        if plaza_map.distance(Point(*mid)) > cfg["maxDistToPlaza"]:
            continue
        near = np.asarray(plaza_map.exterior.interpolate(plaza_map.exterior.project(Point(*mid))).coords[0])
        if np.dot(near - mid, out) <= 0:
            continue
        a = np.array([x0, n0]) + np.array([dx, dn]) * cfg["inset"]
        b = np.array([x1, n1]) - np.array([dx, dn]) * cfg["inset"]
        D = cfg["depth"]
        a2, b2 = a + out * D, b + out * D
        y0, y1 = floor_y, floor_y + 0.16
        P = lambda q_, y: (float(q_[0]), y, float(-q_[1]))
        o3 = (float(out[0]), 0.0, float(-out[1]))
        Lb = float(np.linalg.norm(b - a))
        slab = (*color[:3], 1.0)
        mb.face([P(a, y1), P(b, y1), P(b2, y1), P(a2, y1)], (0.0, 1.0, 0.0), [(0, 0), (Lb, 0), (Lb, D), (0, D)], slab)
        mb.face([P(a, y0), P(b, y0), P(b2, y0), P(a2, y0)], (0.0, -1.0, 0.0), [(0, 0), (Lb, 0), (Lb, D), (0, D)], slab)
        mb.face([P(a2, y0), P(b2, y0), P(b2, y1), P(a2, y1)], o3, [(0, 0), (Lb, 0), (Lb, 0.16), (0, 0.16)], slab)
        yr = y1 + cfg["railHeight"]
        rail = (*color[:3], 0.0)
        mb.face([P(a2, y1), P(b2, y1), P(b2, yr), P(a2, yr)], o3, [(0, 0), (Lb, 0), (Lb, 1), (0, 1)], rail)
        mb.face([P(a2, y1), P(b2, y1), P(b2, yr), P(a2, yr)], tuple(-v for v in o3), [(0, 0), (Lb, 0), (Lb, 1), (0, 1)], rail)
        side = (float(-dx), 0.0, float(dn))
        for e, sgn in ((a, 1), (b, -1)):
            e2 = e + out * D
            ns = tuple(sgn * v for v in side)
            mb.face([P(e, y1), P(e2, y1), P(e2, yr), P(e, yr)], ns, [(0, 0), (D, 0), (D, 1), (0, 1)], rail)
            mb.face([P(e, y1), P(e2, y1), P(e2, yr), P(e, yr)], tuple(-v for v in ns), [(0, 0), (D, 0), (D, 1), (0, 1)], rail)
        n_added += 1
    return n_added


# ---------------------------------------------------------------- edificios

def parse_float(v):
    if v is None:
        return None
    try:
        return float(str(v).replace(",", ".").split(";")[0].replace("m", "").strip())
    except ValueError:
        return None


def tint(seed: str, amount: float):
    """Variación de color determinista (procedural) por edificio: ±amount en brillo."""
    hsh = int(hashlib.md5(seed.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
    hsh2 = int(hashlib.md5((seed + "b").encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
    b = 1.0 - amount + 2 * amount * hsh
    return (b, b * (1 - 0.04 * (hsh2 - 0.5)), b * (1 - 0.08 * (hsh2 - 0.5)))


def collect_buildings(osm: OSM, frame: Frame):
    out = []

    def to_poly(rings_ll):
        polys = []
        for ring in rings_ll:
            x, n = frame.xn([p[0] for p in ring], [p[1] for p in ring])
            polys.append(list(zip(x.tolist(), n.tolist())))
        return polys

    member_ways = set()
    for r in osm.rels.values():
        t = r.get("tags", {})
        if "building" not in t or t.get("type") != "multipolygon":
            continue
        outers, inners = [], []
        for m in r["members"]:
            if m["type"] != "way" or m["ref"] not in osm.ways:
                continue
            member_ways.add(m["ref"])
            ll = way_coords_ll(osm, osm.ways[m["ref"]])
            x, n = frame.xn([p[0] for p in ll], [p[1] for p in ll])
            (outers if m.get("role") != "inner" else inners).append(LineString(list(zip(x, n))))
        op = unary_union(list(polygonize(outers)))
        ip = unary_union(list(polygonize(inners))) if inners else None
        g = op.difference(ip) if ip is not None else op
        out.append({"src": "osm", "osm": f"relation/{r['id']}", "tags": t, "geom": g})

    for w in osm.ways.values():
        t = w.get("tags", {})
        if "building" not in t or t.get("building") == "no":
            continue
        if w["nodes"][0] != w["nodes"][-1] or len(w["nodes"]) < 4:
            continue
        if w["id"] in member_ways and "building" not in t:
            continue
        ring = to_poly([way_coords_ll(osm, w)])[0]
        out.append({"src": "osm", "osm": f"way/{w['id']}", "tags": t, "geom": Polygon(ring), "way_id": w["id"]})
    return out


def collect_overture(frame: Frame, tree_osm, open_spaces=None):
    p = CACHE / "overture_buildings.geojson"
    if not p.exists():
        log("AVISO: sin data/cache/overture_buildings.geojson; sólo OSM")
        return [], {}
    d = json.loads(p.read_text(encoding="utf-8"))
    out, counts = [], defaultdict(int)
    max_ov = BLD_CFG["geometry"]["overtureMaxOverlap"]
    for f in d["features"]:
        props = f["properties"]
        srcs = props.get("sources") or [{}]
        ds = srcs[0].get("dataset", "?")
        if ds == "OpenStreetMap":
            continue  # ya incluido desde OSM directamente
        g = shape(f["geometry"])
        parts = []
        for poly in polygon_parts(g):
            x, n = frame.xn(*zip(*poly.exterior.coords))
            holes = []
            for r in poly.interiors:
                hx, hn = frame.xn(*zip(*r.coords))
                holes.append(list(zip(hx, hn)))
            parts.append(Polygon(list(zip(x, n)), holes))
        if not parts:
            continue
        geom = unary_union(parts)
        # Espacios abiertos mapeados en OSM (parques, plazas): las detecciones ML ahí son falsos positivos
        if open_spaces is not None and open_spaces.contains(geom.representative_point()):
            counts["descartado_espacio_abierto_osm"] += 1
            continue
        overlap = sum(geom.intersection(tree_osm.geometries[i]).area for i in tree_osm.query(geom))
        if overlap > max_ov * geom.area:
            counts["descartado_solape_osm"] += 1
            continue
        counts[ds] += 1
        out.append({"src": f"overture:{ds}", "osm": None, "tags": {"building": props.get("subtype") or "yes"},
                    "geom": geom, "ov_height": props.get("height"), "ov_floors": props.get("num_floors"),
                    "ov_id": props.get("id") or f.get("id"), "license": srcs[0].get("license")})
    return out, dict(counts)


def assign_archetype(b, levels_known, dist_core, arterial_tree, arterial_info):
    r = BLD_CFG["archetypeRules"]
    t = b["tags"]
    btag = t.get("building", "yes")
    if b.get("landmark"):
        return "hito", "hito: huella real OSM (catálogo de hitos)"
    if levels_known is not None and levels_known >= r["modernMinLevels"]:
        return "moderno", f"pisos conocidos >= {r['modernMinLevels']}"
    if btag in r["modernTags"]:
        return "moderno", f"building={btag}"
    if btag in r["commercialTags"]:
        return "comercial", f"building={btag}"
    for k in r["commercialTagKeys"]:
        if k in t:
            return "comercial", f"tiene {k}=*"
    g = b["geom"]
    for i in arterial_tree.query(g.buffer(r["commercialRoadDistance"] + 6)):
        w, hw = arterial_info[i]
        if g.distance(arterial_tree.geometries[i]) <= w / 2 + r["commercialRoadDistance"]:
            return "comercial", f"frente a vía {hw} (<= {r['commercialRoadDistance']} m de la calzada)"
    if dist_core <= r["historicCoreRadius"] and btag in r["colonialTags"] and (
            levels_known is None or levels_known <= r["colonialMaxLevels"]):
        return "colonial", f"a {dist_core:.0f} m de la plaza (<= {r['historicCoreRadius']} m), <= {r['colonialMaxLevels']} pisos"
    return "casa_tradicional", "por defecto (fuera del núcleo histórico o sin otra regla)"


# ---------------------------------------------------------------- textura de suelo

class GroundPainter:
    def __init__(self):
        cfg = ROADS_CFG["groundTexture"]
        self.size = cfg["size"]
        self.S = cfg["size"] * cfg["supersample"]
        self.img = Image.new("RGB", (self.S, self.S), ROADS_CFG["surfaces"]["outside"])

    def px(self, x, n):
        return ((x + T_HALF) / (2 * T_HALF) * self.S, (-n + T_HALF) / (2 * T_HALF) * self.S)

    def fill(self, geom, color):
        polys = polygon_parts(geom)
        if not polys:
            return
        mask = Image.new("L", (self.S, self.S), 0)
        dr = ImageDraw.Draw(mask)
        for p in polys:
            dr.polygon([self.px(x, n) for x, n in p.exterior.coords], fill=255)
            for r in p.interiors:
                dr.polygon([self.px(x, n) for x, n in r.coords], fill=0)
        self.img.paste(color, (0, 0), mask)

    def save(self, path):
        self.img.resize((self.size, self.size), Image.LANCZOS).save(path, optimize=True)


# ---------------------------------------------------------------- main

def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    raw = json.loads((CACHE / "osm_raw.json").read_text(encoding="utf-8"))
    osm_meta = json.loads((CACHE / "osm_meta.json").read_text(encoding="utf-8"))
    dem_meta = json.loads((CACHE / "dem_meta.json").read_text(encoding="utf-8"))
    osm = OSM(raw)

    plaza_utm = find_plaza(osm)
    tmp_inv = Transformer.from_crs(EPSG_UTM, 4326, always_xy=True)
    lon0, lat0 = tmp_inv.transform(plaza_utm.centroid.x, plaza_utm.centroid.y)
    frame = Frame(lon0, lat0)
    log(f"origen (centroide plaza) lat {lat0:.7f} lon {lon0:.7f}; UTM E {frame.E0:.2f} N {frame.N0:.2f}; "
        f"k = {frame.k:.6f}; convergencia {frame.convergence:.3f}°")
    plaza_ll = [tmp_inv.transform(x, y) for x, y in plaza_utm.exterior.coords]
    pxs, pns = frame.xn([p[0] for p in plaza_ll], [p[1] for p in plaza_ll])
    plaza = Polygon(list(zip(pxs, pns)))
    log(f"plaza {plaza.area:.0f} m², centroide local ({plaza.centroid.x:.3f}, {plaza.centroid.y:.3f})")

    terrain = Terrain(frame)
    cat_way = osm.ways[CATHEDRAL_WAY]
    cll = way_coords_ll(osm, cat_way)
    cx_, cn_ = frame.xn([q[0] for q in cll], [q[1] for q in cll])
    cat_map = orient(Polygon(list(zip(cx_, cn_))), 1.0)          # (x, n)
    plaza_game = Polygon([(x, -n) for x, n in plaza.exterior.coords])
    cat_game = Polygon([(x, -n) for x, n in cat_map.exterior.coords])
    plane = None
    if PLAZA_CFG["terrain"]["flatten"]:
        plane = flatten_terrain(terrain, plaza_game, cat_game)
    park_planes = {}
    park_ways = set()
    for key, pcfg in PARKS_CFG.items():
        ll = way_coords_ll(osm, osm.ways[pcfg["osmPark"]])
        px_, pn_ = frame.xn([q[0] for q in ll], [q[1] for q in ll])
        park_planes[key] = flatten_park(terrain, Polygon(list(zip(px_, -pn_))), pcfg["terrain"], pcfg["name"])
        park_ways.add(pcfg["osmPark"])
    terrain.heights.astype("<f4").tofile(OUT / "terrain.bin")

    area_box = box(-HALF, -HALF, HALF, HALF)
    terrain_box = box(-T_HALF, -T_HALF, T_HALF, T_HALF)

    # ---------------- vías
    classes = ROADS_CFG["classes"]
    roads, road_lines = [], []
    for w in osm.ways.values():
        t = w.get("tags", {})
        hw = t.get("highway")
        if hw not in classes:
            continue
        ll = way_coords_ll(osm, w)
        if len(ll) < 2:
            continue
        x, n = frame.xn([p[0] for p in ll], [p[1] for p in ll])
        line = LineString(list(zip(x, n)))
        is_area = t.get("area") == "yes" and w["nodes"][0] == w["nodes"][-1]
        cls = classes[hw]
        width = parse_float(t.get("width")) or cls["width"]
        sidewalk = 0.0 if t.get("sidewalk") == "no" else cls["sidewalk"]
        surface = t.get("surface") or cls["surface"]
        if surface not in ROADS_CFG["surfaces"]:
            surface = cls["surface"]
        rec = {"id": w["id"], "name": t.get("name"), "highway": hw, "width": round(width, 2),
               "widthSource": "osm:width" if t.get("width") else "estimado:clase", "sidewalk": sidewalk,
               "surface": surface, "oneway": t.get("oneway") == "yes", "area": is_area,
               "nodes": w["nodes"], "geom": line}
        road_lines.append(rec)
        if not line.intersects(terrain_box):
            continue
        clipped = line.intersection(terrain_box)
        parts = [clipped] if isinstance(clipped, LineString) else [g for g in getattr(clipped, "geoms", []) if isinstance(g, LineString)]
        for part in parts:
            roads.append({k: rec[k] for k in ("id", "name", "highway", "width", "sidewalk", "surface", "oneway", "area")}
                         | {"pts": [[round(px, 2), round(-pn, 2)] for px, pn in part.coords]})
    log(f"vías: {len(roads)} tramos")

    # ---------------- textura del suelo
    surf = ROADS_CFG["surfaces"]
    gp = GroundPainter()
    gp.fill(terrain_box, surf["lot"])
    green = []
    for w in osm.ways.values():
        t = w.get("tags", {})
        if w["id"] in park_ways:
            continue
        if (t.get("leisure") in ("park", "garden", "pitch", "playground") or t.get("landuse") in (
                "grass", "meadow", "forest", "recreation_ground")) and w["nodes"][0] == w["nodes"][-1]:
            ll = way_coords_ll(osm, w)
            if len(ll) >= 4:
                x, n = frame.xn([p[0] for p in ll], [p[1] for p in ll])
                green.append(make_valid(Polygon(list(zip(x, n)))))
    gp.fill(unary_union(green).intersection(terrain_box) if green else Polygon(), surf["grass"])
    sidewalks = [r["geom"].buffer(r["width"] / 2 + r["sidewalk"], cap_style=1) for r in road_lines if r["sidewalk"] > 0 and not r["area"]]
    gp.fill(unary_union(sidewalks).intersection(terrain_box), surf["sidewalk"])
    ped_areas = [Polygon(r["geom"].coords) for r in road_lines if r["area"]]
    gp.fill(unary_union(ped_areas + [plaza]).intersection(terrain_box), surf["plaza"])
    for key, pcfg in PARKS_CFG.items():
        ll = way_coords_ll(osm, osm.ways[pcfg["osmPark"]])
        px_, pn_ = frame.xn([q[0] for q in ll], [q[1] for q in ll])
        gp.fill(Polygon(list(zip(px_, pn_))), pcfg["paving"]["textureColor"])
    order = ["track", "path", "footway", "cycleway", "steps", "pedestrian", "service", "living_street",
             "residential", "unclassified", "tertiary", "secondary", "primary"]
    for hw in order:
        by_surface = defaultdict(list)
        for r in road_lines:
            if r["highway"] == hw and not r["area"]:
                by_surface[r["surface"]].append(r["geom"].buffer(r["width"] / 2, cap_style=1 if hw in VEHICULAR else 2))
        for s, geoms in by_surface.items():
            gp.fill(unary_union(geoms).intersection(terrain_box), surf[s])
    gp.save(OUT / "ground.png")
    log("ground.png escrito")

    # ---------------- plaza adoquinada: la cara OSM llega al eje de las calles; se recorta la calzada vehicular
    carriage = unary_union([r["geom"].buffer(r["width"] / 2, cap_style=2) for r in road_lines
                            if r["highway"] in VEHICULAR and not r["area"]])
    paved = max(polygon_parts(plaza.difference(carriage)), key=lambda q: q.area)
    plaza_paved_ring = [[round(x, 2), round(-n, 2)] for x, n in orient(paved, 1.0).exterior.coords]
    log(f"plaza adoquinada: {paved.area:.0f} m² (sin calzadas vehiculares)")

    # ---------------- esquinas (para el test de distancias)
    node_streets = defaultdict(set)
    for r in road_lines:
        if r["highway"] in VEHICULAR and r["name"]:
            for nid in r["nodes"]:
                node_streets[nid].add(r["name"])
    corners = []
    for nid, names in node_streets.items():
        if len(names) >= 2 and nid in osm.nodes:
            nd = osm.nodes[nid]
            x, n = frame.xn(nd["lon"], nd["lat"])
            if abs(x) <= HALF and abs(n) <= HALF:
                corners.append({"node": nid, "lat": nd["lat"], "lon": nd["lon"], "x": round(float(x), 3),
                                "z": round(float(-n), 3), "streets": sorted(names)})
    corners.sort(key=lambda c: c["node"])
    log(f"esquinas: {len(corners)}")

    # ---------------- manzanas
    edges = [r["geom"] for r in road_lines if r["highway"] in BLOCK_EDGES and not r["area"]]
    blocks = [p for p in polygonize(unary_union(edges)) if p.intersects(area_box) and p.area > 50]
    block_tree = STRtree(blocks)
    log(f"manzanas: {len(blocks)}")

    # ---------------- edificios
    blds = collect_buildings(osm, frame)
    gcfg = BLD_CFG["geometry"]
    clean = []
    for b in blds:
        parts = [p.simplify(gcfg["simplify"]) for p in polygon_parts(make_valid(b["geom"]))]
        parts = [p for p in parts if p.is_valid and p.area >= gcfg["minArea"]]
        if not parts:
            continue
        b["geom"] = unary_union(parts)
        rp = b["geom"].representative_point()
        if abs(rp.x) <= HALF and abs(rp.y) <= HALF:
            clean.append(b)
    osm_tree = STRtree([b["geom"] for b in clean])
    excl = BLD_CFG["geometry"]["overtureExcludeOpenSpaces"]
    open_polys = [plaza]
    for w in osm.ways.values():
        t = w.get("tags", {})
        if w["nodes"][0] != w["nodes"][-1] or len(w["nodes"]) < 4 or "building" in t:
            continue
        if t.get("leisure") in excl["leisure"] or t.get("place") in excl["place"] or (
                t.get("highway") in excl["highway"] and t.get("area") == "yes"):
            ll = way_coords_ll(osm, w)
            x, n = frame.xn([q[0] for q in ll], [q[1] for q in ll])
            open_polys.append(make_valid(Polygon(list(zip(x, n)))))
    ov, ov_counts = collect_overture(frame, osm_tree, unary_union(open_polys))
    for b in ov:
        parts = [p.simplify(gcfg["simplify"]) for p in polygon_parts(make_valid(b["geom"]))]
        parts = [p for p in parts if p.is_valid and p.area >= gcfg["minArea"]]
        if not parts:
            continue
        b["geom"] = unary_union(parts)
        rp = b["geom"].representative_point()
        if abs(rp.x) <= HALF and abs(rp.y) <= HALF:
            clean.append(b)
    log(f"edificios en el área: {sum(1 for b in clean if b['src'] == 'osm')} OSM + {sum(1 for b in clean if b['src'] != 'osm')} Overture "
        f"(candidatos Overture no-OSM sin solape en la caja de descarga: {ov_counts})")

    arterials = [r for r in road_lines if r["highway"] in BLD_CFG["archetypeRules"]["commercialRoadClasses"]]
    arterial_tree = STRtree([r["geom"] for r in arterials])
    arterial_info = [(r["width"], r["highway"]) for r in arterials]

    landmarks_cfg = BLD_CFG["landmarks"]
    fh = BLD_CFG["floorHeight"]
    rex = BLD_CFG["roofExtra"]
    est = BLD_CFG["heightEstimate"]
    blocks_mesh = defaultdict(lambda: defaultdict(MeshBuilder))
    meta = []
    landmark_out = []
    lm_model = None
    stats = defaultdict(int)
    for i, b in enumerate(clean):
        t = b["tags"]
        wid = b.get("way_id")
        lm = landmarks_cfg.get(str(wid)) if wid else None
        b["landmark"] = lm is not None
        g = b["geom"]
        rp = g.representative_point()
        dist_core = math.hypot(rp.x, rp.y)

        # pisos/altura conocidos
        h_known, lv_known, hsrc = parse_float(t.get("height")), parse_float(t.get("building:levels")), None
        if h_known:
            hsrc = "osm:height"
        elif lv_known:
            hsrc = "osm:building:levels"
        elif b.get("ov_height"):
            h_known, hsrc = float(b["ov_height"]), "overture:height"
        elif b.get("ov_floors"):
            lv_known, hsrc = float(b["ov_floors"]), "overture:num_floors"

        arch, rule = assign_archetype(b, lv_known, dist_core, arterial_tree, arterial_info)
        estimated = False
        if h_known:
            height, levels = h_known, round(h_known / fh[arch], 1)
        elif lv_known:
            levels = lv_known
            height = lv_known * fh[arch] + rex[arch]
        elif lm:
            height, levels, estimated, hsrc = lm["height"], None, lm.get("estimated", True), "estimado:hito"
        else:
            levels = est["smallLevels"] if g.area < est["smallArea"] else est["levels"][arch]
            height = levels * fh[arch] + rex[arch]
            estimated, hsrc = True, "estimado:regla"

        # altura del suelo bajo la huella
        samples = []
        for p in polygon_parts(g):
            c = np.asarray(p.exterior.coords)
            samples.append(c)
        samples.append(np.array([[rp.x, rp.y]]))
        s = np.vstack(samples)
        gy = terrain.y(s[:, 0], -s[:, 1])
        g_min, g_mean, g_max = float(gy.min()), float(gy.mean()), float(gy.max())
        y_bottom = g_min - gcfg["foundationDepth"]
        y_top = max(g_mean + height, g_max + 2.4)

        blk_idx = [j for j in block_tree.query(rp) if blocks[j].contains(rp)]
        blk = f"m{blk_idx[0]}" if blk_idx else f"g{int((rp.x + HALF) // 100)}_{int((rp.y + HALF) // 100)}"
        if lm:
            blk = f"hito_{wid}"

        color = tint(b["osm"] or str(b.get("ov_id")), 0.06 if arch in ("colonial", "hito") else 0.12)
        pr = BLD_CFG["pitchedRoof"]
        bc = BLD_CFG["balconies"]
        for p in ([] if (lm and lm.get("model")) else polygon_parts(g)):
            if arch in pr["archetypes"] and p.area >= pr["minArea"]:
                eave_rel = y_top - g_mean
                col4 = (*color, min(1.0, eave_rel / 25.0))  # alfa = alero relativo / 25 m (sin vanos en hastiales)
                add_pitched(blocks_mesh[blk][f"wall_{arch}"], blocks_mesh[blk]["roof_tile"], p, y_bottom, y_top, g_mean,
                            col4, pr["pitchDeg"], pr["maxRun"], pr["overhang"][arch])
                stats["cubierta_dos_aguas"] += 1
                if arch in bc["archetypes"] and (levels or 0) >= 2:
                    stats["balcones"] += add_balconies(blocks_mesh[blk]["balcony_wood"], p, plaza, g_mean + fh[arch],
                                                       tint(b["osm"] or "x", 0.08), bc)
            else:
                add_prism(blocks_mesh[blk][f"wall_{arch}"], p, y_bottom, y_top, g_mean, color, top=True)
                if arch in gcfg["eaveOverhang"]:
                    ov_poly = p.buffer(gcfg["eaveOverhang"][arch], join_style=2, mitre_limit=2.0)
                    for q in polygon_parts(ov_poly):
                        add_prism(blocks_mesh[blk]["roof_tile"], q, y_top, y_top + gcfg["roofSlab"], y_top, color, top=True, bottom=True)
        stats[f"arquetipo:{arch}"] += 1
        stats[f"fuente:{b['src']}"] += 1
        stats["altura_estimada" if estimated else "altura_dato"] += 1
        m = {"i": i, "src": b["src"], "osm": b["osm"], "ov": b.get("ov_id"), "arch": arch, "rule": rule,
             "h": round(height, 2), "lv": levels, "est": estimated, "hsrc": hsrc, "blk": blk,
             "area": round(g.area, 1), "c": [round(rp.x, 1), round(-rp.y, 1)], "gy": round(g_mean, 2)}
        if t.get("name"):
            m["name"] = t["name"]
        meta.append(m)
        if lm:
            if lm.get("model") == "catedral":
                lm_model = build_cathedral(g, terrain)
            landmark_out.append({"osm": b["osm"], "name": lm["name"], "model": lm_model if lm.get("model") else None, "x": round(g.centroid.x, 2), "z": round(-g.centroid.y, 2),
                                 "height": height, "estimated": estimated, "groundY": round(g_mean, 2),
                                 "area": round(g.area, 1),
                                 "ring": [[round(x, 2), round(-n, 2)] for x, n in orient(polygon_parts(g)[0], 1.0).exterior.coords]})

    material_names = ["wall_colonial", "wall_casa_tradicional", "wall_comercial", "wall_moderno", "wall_hito", "roof_tile",
                      "balcony_wood"]
    meshes = []
    tri_total = 0
    for blk in sorted(blocks_mesh):
        prims = []
        for mat in material_names:
            if mat in blocks_mesh[blk] and blocks_mesh[blk][mat].count > 0:
                arr = blocks_mesh[blk][mat].arrays()
                tri_total += len(arr[4]) // 3
                prims.append((mat, *arr))
        meshes.append((blk, prims))
    write_glb(OUT / "buildings.glb", meshes, material_names)

    # ---------------- vías: grafo, semáforos, andenes con sardinel y señalización
    park_map = []
    for pcfg in PARKS_CFG.values():
        ll = way_coords_ll(osm, osm.ways[pcfg["osmPark"]])
        px_, pn_ = frame.xn([q[0] for q in ll], [q[1] for q in ll])
        park_map.append(Polygon(list(zip(px_, pn_))))
    exclude = unary_union(park_map + [cat_map.buffer(3.0), paved.buffer(-1.6)])
    bunion = unary_union([b["geom"] for b in clean if not b.get("landmark")])
    graph, rmesh, rstats = vias_model.build(osm, frame, terrain, road_lines, TRAFFIC_CFG, HALF, T_HALF, bunion, exclude, None)
    (OUT / "roadgraph.json").write_text(json.dumps(graph, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    rnames = sorted(rmesh.d)
    rprims = []
    for mat in rnames:
        m = rmesh.d[mat]
        pos = np.asarray(m["p"], np.float32)
        rprims.append((mat, pos, np.asarray(m["n"], np.float32), np.asarray(m["uv"], np.float32),
                       np.ones((len(pos), 3), np.float32), np.asarray(m["i"], np.uint32)))
    write_glb(OUT / "roads.glb", [("vias", rprims)], rnames)
    log(f"vías: {rstats}")
    stats["vias"] = rstats
    log(f"buildings.glb: {len(meshes)} mallas (manzanas), {tri_total} triángulos")

    # ---------------- props (árboles y postes OSM)
    props = []
    for nd in osm.nodes.values():
        t = nd.get("tags", {})
        kind = "tree" if t.get("natural") == "tree" else "lamp" if t.get("highway") == "street_lamp" else None
        if not kind:
            continue
        x, n = frame.xn(nd["lon"], nd["lat"])
        if abs(x) <= HALF and abs(n) <= HALF:
            props.append({"kind": kind, "osm": f"node/{nd['id']}", "x": round(float(x), 2), "z": round(float(-n), 2),
                          "y": round(float(terrain.y(x, -n)[0]), 2)})
    for w in osm.ways.values():
        if w.get("tags", {}).get("natural") == "tree_row":
            ll = way_coords_ll(osm, w)
            x, n = frame.xn([p[0] for p in ll], [p[1] for p in ll])
            line = LineString(list(zip(x, n)))
            for d in np.arange(0, line.length + 0.01, 8.0):  # espaciado procedural sobre una línea real
                p = line.interpolate(d)
                if abs(p.x) <= HALF and abs(p.y) <= HALF:
                    props.append({"kind": "tree", "osm": f"way/{w['id']}", "procedural": True, "x": round(p.x, 2),
                                  "z": round(-p.y, 2), "y": round(float(terrain.y(p.x, -p.y)[0]), 2)})
    log(f"props: {len(props)}")

    # ---------------- salidas JSON
    (OUT / "roads.json").write_text(json.dumps(roads, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (OUT / "corners.json").write_text(json.dumps(corners, ensure_ascii=False, indent=0), encoding="utf-8")
    (OUT / "buildings.json").write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (OUT / "props.json").write_text(json.dumps(props, separators=(",", ":")), encoding="utf-8")

    world = {
        "version": 1,
        "generatedUtc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "origin": {"lat": lat0, "lon": lon0, "epsg": EPSG_UTM, "utmE": round(frame.E0, 3), "utmN": round(frame.N0, 3),
                   "scaleFactor": frame.k, "convergenceDeg": frame.convergence, "elevation": round(terrain.h0, 2),
                   "definition": "centroide de la Plaza de los Comuneros (cara de la red vial OSM delimitada por ways "
                                 + ", ".join(map(str, PLAZA_BOUNDARY_WAYS)) + ")"},
        "area": {"half": HALF},
        "terrain": {"file": "terrain.bin", "n": terrain.n, "spacing": T_STEP, "half": T_HALF,
                    "minY": float(terrain.heights.min()), "maxY": float(terrain.heights.max())},
        "ground": {"file": "ground.png", "half": T_HALF},
        "plaza": {"area": round(plaza.area, 1), "ring": [[round(x, 2), round(-n, 2)] for x, n in plaza.exterior.coords],
                  "paved": plaza_paved_ring,
                  "plane": plane,
                  "planters": [{"osm": p["osm"], "x": p["x"], "z": p["z"], "y": p["y"]} for p in props
                               if p["kind"] == "tree" and plaza.buffer(1.0).contains(Point(p["x"], -p["z"]))]},
        "landmarks": landmark_out,
        "parks": [park_export(osm, frame, k, c, park_planes[k]) for k, c in PARKS_CFG.items()],
        "files": {"buildings": "buildings.glb", "buildingsMeta": "buildings.json", "roads": "roads.json",
                  "roadGraph": "roadgraph.json", "roadMesh": "roads.glb",
                  "corners": "corners.json", "props": "props.json"},
        "stats": dict(stats) | {"manzanas": len(blocks), "mallasEdificios": len(meshes), "triangulosEdificios": tri_total,
                                "tramosVia": len(roads), "esquinas": len(corners), "props": len(props),
                                "overture": ov_counts},
        "sources": {"osm": osm_meta, "dem": dem_meta,
                    "overture": json.loads((CACHE / "overture_buildings.geojson.state").read_text(encoding="utf-8"))
                    if (CACHE / "overture_buildings.geojson.state").exists() else None},
        "attribution": [
            "© OpenStreetMap contributors (ODbL)",
            "Overture Maps Foundation — buildings (Google Open Buildings, Microsoft ML Buildings)",
            "Copernicus DEM GLO-30 © DLR e.V. 2010-2014 y © Airbus Defence and Space GmbH 2014-2018, provisto bajo COPERNICUS por la Unión Europea y la ESA",
        ],
    }
    (OUT / "world.json").write_text(json.dumps(world, ensure_ascii=False, indent=2), encoding="utf-8")
    log("world.json escrito")
    return 0


if __name__ == "__main__":
    sys.exit(main())
