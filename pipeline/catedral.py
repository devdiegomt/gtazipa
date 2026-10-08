"""Modelo de la Catedral Diocesana de Zipaquirá ajustado a su huella OSM.

Fuentes y nivel de certeza: ver src/data/catedral.json (_doc) y docs/INFORME_CATEDRAL.md.

Marco local (metros, dextrógiro):
  X = u  a lo largo de la fachada (+X hacia la torre oriental, la del reloj)
  Y      altura sobre el piso del atrio
  Z = -v hacia la plaza (la fachada mira a +Z; el templo ocupa Z < 0)
"""
from __future__ import annotations

import math
from collections import defaultdict

import mapbox_earcut as earcut
import numpy as np
from shapely.geometry import LineString, MultiPolygon, Point, Polygon, box
from shapely.geometry.polygon import orient
from shapely.ops import split, unary_union

V3 = np.ndarray


def _parts(g):
    if g.is_empty:
        return []
    if isinstance(g, Polygon):
        return [g]
    if hasattr(g, "geoms"):
        out = []
        for x in g.geoms:
            out += _parts(x)
        return out
    return []


class Builder:
    """Acumula geometría por material. Corrige el sentido de cada triángulo según la normal."""

    def __init__(self):
        self.d = defaultdict(lambda: {"p": [], "n": [], "uv": [], "i": []})

    def tris(self, mat, pts, tris, normals, uvs):
        m = self.d[mat]
        base = len(m["p"])
        pts = [np.asarray(p, float) for p in pts]
        if isinstance(normals, (tuple, list)) and len(normals) == 3 and np.isscalar(normals[0]):
            normals = [normals] * len(pts)
        m["p"] += [tuple(p) for p in pts]
        m["n"] += [tuple(n) for n in normals]
        m["uv"] += [tuple(u) for u in uvs]
        for a, b, c in tris:
            fn = np.cross(pts[b] - pts[a], pts[c] - pts[a])
            ref = np.asarray(normals[a]) + np.asarray(normals[b]) + np.asarray(normals[c])
            if np.dot(fn, ref) < 0:
                b, c = c, b
            m["i"] += [base + a, base + b, base + c]

    def face(self, mat, pts, n, uvs):
        """Polígono convexo (fan)."""
        self.tris(mat, pts, [(0, k, k + 1) for k in range(1, len(pts) - 1)], n, uvs)

    # ------------------------------------------------------------ primitivas

    def box(self, mat, x0, x1, y0, y1, z0, z1, skip=()):
        if x1 - x0 < 1e-4 or y1 - y0 < 1e-4 or z1 - z0 < 1e-4:
            return
        P = lambda x, y, z: (x, y, z)
        faces = {
            "+z": ([P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)], (0, 0, 1), lambda p: (p[0], p[1])),
            "-z": ([P(x0, y0, z0), P(x1, y0, z0), P(x1, y1, z0), P(x0, y1, z0)], (0, 0, -1), lambda p: (-p[0], p[1])),
            "+x": ([P(x1, y0, z0), P(x1, y0, z1), P(x1, y1, z1), P(x1, y1, z0)], (1, 0, 0), lambda p: (-p[2], p[1])),
            "-x": ([P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1), P(x0, y1, z0)], (-1, 0, 0), lambda p: (p[2], p[1])),
            "+y": ([P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1)], (0, 1, 0), lambda p: (p[0], p[2])),
            "-y": ([P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1)], (0, -1, 0), lambda p: (p[0], p[2])),
        }
        for k, (pts, n, uvf) in faces.items():
            if k not in skip:
                self.face(mat, pts, n, [uvf(p) for p in pts])

    def extrude(self, mat, poly, origin, e1, e2, n, d0, d1, front=True, back=False, sides=True, side_mat=None):
        """Extruye un polígono 2D (con huecos) del plano (e1, e2) entre d0 y d1 a lo largo de n.
        Cara frontal en d1 (normal +n). UV en metros."""
        origin, e1, e2, n = (np.asarray(v, float) for v in (origin, e1, e2, n))
        for p in _parts(poly):
            p = orient(p, 1.0)
            to3 = lambda a, b, t: origin + a * e1 + b * e2 + t * n
            if front or back:
                rings = [np.asarray(p.exterior.coords)[:-1]] + [np.asarray(r.coords)[:-1] for r in p.interiors]
                verts = np.vstack(rings)
                ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
                tri = earcut.triangulate_float64(verts, ends).reshape(-1, 3).tolist()
                uvs = [(a, b) for a, b in verts]
                if front:
                    self.tris(mat, [to3(a, b, d1) for a, b in verts], tri, tuple(n), uvs)
                if back:
                    self.tris(mat, [to3(a, b, d0) for a, b in verts], tri, tuple(-n), uvs)
            if sides:
                for ring in [p.exterior, *p.interiors]:
                    c = np.asarray(ring.coords)
                    s = 0.0
                    for (a0, b0), (a1, b1) in zip(c[:-1], c[1:]):
                        L = math.hypot(a1 - a0, b1 - b0)
                        if L < 1e-5:
                            continue
                        da, db = (a1 - a0) / L, (b1 - b0) / L
                        nn = db * e1 - da * e2  # exterior: anillo CCW → derecha = afuera
                        pts = [to3(a0, b0, d0), to3(a1, b1, d0), to3(a1, b1, d1), to3(a0, b0, d1)]
                        self.face(side_mat or mat, pts, tuple(nn), [(s, d0), (s + L, d0), (s + L, d1), (s, d1)])
                        s += L

    def walls(self, mat, ring_xz, y0, top, skip_edge=None):
        """Muros verticales desde y0 hasta top(x, z) en cada vértice (anillo en planta X,Z)."""
        poly = orient(Polygon(ring_xz), 1.0)  # CCW en (X, Z)
        c = np.asarray(poly.exterior.coords)
        s = 0.0
        for (x0, z0), (x1, z1) in zip(c[:-1], c[1:]):
            L = math.hypot(x1 - x0, z1 - z0)
            if L < 1e-5:
                continue
            if skip_edge and skip_edge((x0 + x1) / 2, (z0 + z1) / 2):
                s += L
                continue
            dx, dz = (x1 - x0) / L, (z1 - z0) / L
            nn = (dz, 0.0, -dx)  # CCW en (X,Z): afuera = (dz, -dx)
            t0, t1 = top(x0, z0), top(x1, z1)
            pts = [(x0, y0, z0), (x1, y0, z1), (x1, t1, z1), (x0, t0, z0)]
            self.face(mat, pts, nn, [(s, y0), (s + L, y0), (s + L, t1), (s, t0)])
            s += L

    def roof_planar(self, mat, poly_xz, height, uv_axis):
        """Cubierta: triangula el polígono (planta X,Z) con y = height(x, z) (lineal en la pieza)."""
        for p in _parts(poly_xz):
            p = orient(p, 1.0)
            rings = [np.asarray(p.exterior.coords)[:-1]] + [np.asarray(r.coords)[:-1] for r in p.interiors]
            verts = np.vstack(rings)
            ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
            tri = earcut.triangulate_float64(verts, ends).reshape(-1, 3).tolist()
            pts = [(x, height(x, z), z) for x, z in verts]
            if len(pts) >= 3:
                a, b, c = (np.asarray(pts[i]) for i in tri[0]) if tri else (None, None, None)
                nrm = np.cross(b - a, c - a) if tri else np.array([0, 1, 0])
                nrm = nrm / (np.linalg.norm(nrm) + 1e-9)
                if nrm[1] < 0:
                    nrm = -nrm
                self.tris(mat, pts, tri, tuple(nrm), [uv_axis(x, z) for x, z in verts])

    def fan(self, mat, apex, ring_pts):
        """Cubierta cónica aproximada: triángulos del ápice a cada arista del anillo."""
        ax, ay, az = apex
        for (x0, y0, z0), (x1, y1, z1) in zip(ring_pts[:-1], ring_pts[1:]):
            a, b, c = np.array([ax, ay, az]), np.array([x0, y0, z0]), np.array([x1, y1, z1])
            nrm = np.cross(b - a, c - a)
            if np.linalg.norm(nrm) < 1e-6:
                continue
            nrm /= np.linalg.norm(nrm)
            if nrm[1] < 0:
                nrm = -nrm
            r0 = math.hypot(x0 - ax, z0 - az)
            r1 = math.hypot(x1 - ax, z1 - az)
            ang0 = math.atan2(z0 - az, x0 - ax)
            ang1 = math.atan2(z1 - az, x1 - ax)
            self.tris(mat, [a, b, c], [(0, 1, 2)], tuple(nrm), [(0, 0), (ang0 * 4, r0), (ang1 * 4, r1)])

    def lathe(self, mat, profile, segments, cx, cy, cz, phase=0.0, rib_uv=False, cap_top=False):
        """Sólido de revolución facetado (normales planas). profile = [(r, y)] de abajo arriba."""
        prof = [(float(r), float(y)) for r, y in profile]
        lens = [0.0]
        for (r0, y0), (r1, y1) in zip(prof[:-1], prof[1:]):
            lens.append(lens[-1] + math.hypot(r1 - r0, y1 - y0))
        for i in range(segments):
            a0 = phase + 2 * math.pi * i / segments
            a1 = phase + 2 * math.pi * (i + 1) / segments
            am = (a0 + a1) / 2
            radial = np.array([math.cos(am), 0, math.sin(am)])
            for j in range(len(prof) - 1):
                (r0, y0), (r1, y1) = prof[j], prof[j + 1]
                P = lambda r, y, a: (cx + r * math.cos(a), cy + y, cz + r * math.sin(a))
                pts = [P(r0, y0, a0), P(r0, y0, a1), P(r1, y1, a1), P(r1, y1, a0)]
                u0, u1 = (0.0, 1.0) if rib_uv else (i / segments * 2 * math.pi * r0, (i + 1) / segments * 2 * math.pi * r0)
                uvs = [(u0, lens[j]), (u1, lens[j]), (u1, lens[j + 1]), (u0, lens[j + 1])]
                q = [np.asarray(p) for p in pts]
                nrm = np.cross(q[1] - q[0], q[3] - q[0])
                if np.linalg.norm(nrm) < 1e-9:
                    nrm = np.cross(q[2] - q[1], q[3] - q[1])
                if np.linalg.norm(nrm) < 1e-9:
                    continue
                nrm /= np.linalg.norm(nrm)
                ref = radial * (1 if (r0 + r1) > 1e-6 else 0) + np.array([0, 1e-3 if y1 >= y0 else -1e-3, 0])
                if abs(np.dot(nrm, radial)) < 0.05:
                    ref = np.array([0, 1 if r1 < r0 else -1, 0])
                if np.dot(nrm, ref) < 0:
                    nrm = -nrm
                if r0 < 1e-6 or r1 < 1e-6:
                    tri_pts = [pts[0], pts[2], pts[3]] if r0 < 1e-6 else [pts[0], pts[1], pts[2]]
                    tri_uv = [uvs[0], uvs[2], uvs[3]] if r0 < 1e-6 else [uvs[0], uvs[1], uvs[2]]
                    self.tris(mat, tri_pts, [(0, 1, 2)], tuple(nrm), tri_uv)
                else:
                    self.face(mat, pts, tuple(nrm), uvs)
            if cap_top:
                r, y = prof[-1]
                if r > 1e-6:
                    P = lambda a: (cx + r * math.cos(a), cy + y, cz + r * math.sin(a))
                    self.tris(mat, [(cx, cy + y, cz), P(a0), P(a1)], [(0, 1, 2)], (0, 1, 0), [(0, 0), (1, 0), (1, 1)])

    def pyramid(self, mat, cx, cz, y0, base, height):
        h = base / 2
        apex = np.array([cx, y0 + height, cz])
        corners = [(cx - h, cz - h), (cx + h, cz - h), (cx + h, cz + h), (cx - h, cz + h)]
        for (xa, za), (xb, zb) in zip(corners, corners[1:] + corners[:1]):
            a, b = np.array([xa, y0, za]), np.array([xb, y0, zb])
            nrm = np.cross(b - a, apex - a)
            mid = (a + b) / 2 - np.array([cx, y0, cz])
            if np.dot(nrm, mid) < 0:
                nrm = -nrm
            nrm /= np.linalg.norm(nrm)
            self.tris(mat, [a, b, apex], [(0, 1, 2)], tuple(nrm), [(0, 0), (base, 0), (base / 2, height)])

    def cross_iron(self, mat, cx, y0, cz, height, facing="z"):
        t = 0.12
        w = height * 0.5
        self.box(mat, cx - t / 2, cx + t / 2, y0, y0 + height, cz - t / 2, cz + t / 2)
        if facing == "z":
            self.box(mat, cx - w / 2, cx + w / 2, y0 + height * 0.62, y0 + height * 0.62 + t, cz - t / 2, cz + t / 2)
        else:
            self.box(mat, cx - t / 2, cx + t / 2, y0 + height * 0.62, y0 + height * 0.62 + t, cz - w / 2, cz + w / 2)

    def sphere(self, mat, cx, cy, cz, r, seg=10):
        prof = [(r * math.sin(math.pi * k / 6), -r * math.cos(math.pi * k / 6)) for k in range(7)]
        self.lathe(mat, prof, seg, cx, cy, cz)


# ---------------------------------------------------------------- formas 2D

def rect(cx, y0, w, h):
    return box(cx - w / 2, y0, cx + w / 2, y0 + h)


def arch(cx, y0, w, h, n=14):
    r = w / 2
    yc = y0 + h - r
    pts = [(cx - r, y0), (cx + r, y0)]
    pts += [(cx + r * math.cos(math.pi * k / n), yc + r * math.sin(math.pi * k / n)) for k in range(n + 1)]
    return Polygon(pts)


def circle(cx, cy, r, n=24):
    return Point(cx, cy).buffer(r, quad_segs=max(4, n // 4))


def frame_band(shape, t, y_min=None):
    band = shape.buffer(t, join_style=2).difference(shape)
    if y_min is not None:
        minx, _, maxx, maxy = band.bounds
        band = band.intersection(box(minx - 1, y_min, maxx + 1, maxy + 1))
    return band


def insert_crossings(ring, axis, value):
    """Inserta vértices donde el anillo cruza la recta coord[axis] = value."""
    out = []
    for p, q in zip(ring[:-1], ring[1:]):
        out.append(p)
        a, b = p[axis] - value, q[axis] - value
        if a * b < 0:
            t = a / (a - b)
            out.append((p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])))
    out.append(ring[-1])
    return out


# ---------------------------------------------------------------- catedral

def build(cfg: dict, footprint_uv: Polygon, width: float, y_bottom: float) -> Builder:
    """footprint_uv: huella en (u, v) con la fachada sobre v = 0, u ∈ [-width/2, width/2]."""
    B = Builder()
    T = cfg["towers"]
    C = cfg["center"]
    BD = cfg["body"]
    W = width
    hw = W / 2
    tw = T["width"]
    xl, xr = -hw + tw, hw - tw
    yb = y_bottom
    L = [0.0] + T["bodies"]
    cor = T["cornice"]
    cp = T["cornerPilaster"]
    wall_t = 1.0
    tan = lambda deg: math.tan(math.radians(deg))

    # ------------------------------------------------ atrio y gradas
    st = cfg["steps"]
    landing = 0.6
    B.box("cat_zocalo", -hw - 0.3, hw + 0.3, yb, 0.0, 0.0, landing, skip=("-z",))
    for k in range(1, st["count"]):
        z0 = landing + st["tread"] * (k - 1)
        B.box("cat_zocalo", -hw - 0.3, hw + 0.3, yb, -st["rise"] * k, z0, z0 + st["tread"], skip=("-z",))

    # ------------------------------------------------ torres
    for side in ("west", "east"):
        x0, x1 = (-hw, -hw + tw) if side == "west" else (hw - tw, hw)
        xc = (x0 + x1) / 2
        is_clock = side == T["clock"]["tower"]
        outer = "-x" if side == "west" else "+x"
        for k in range(3):
            ya, yt = (yb if k == 0 else L[k]), L[k + 1]
            # agujeros por cara: front, back, outer, inner (coordenadas 2D de cada cara: (a, y))
            holes = {"front": [], "back": [], "outer": [], "inner": []}
            panels = {"front": [], "back": [], "outer": [], "inner": []}
            if k == 0:
                for f, ac in (("front", xc), ("outer", -tw / 2)):
                    s = rect(ac, T["slit"]["y"], T["slit"]["w"], T["slit"]["h"])
                    o = circle(ac, T["oculus"]["y"], T["oculus"]["r"])
                    holes[f] += [s, o]
                    panels[f] += [s, o]
            elif k == 1:
                for f, ac in (("front", xc), ("outer", -tw / 2)):
                    w2 = rect(ac, T["window2"]["y"], T["window2"]["w"], T["window2"]["h"])
                    holes[f].append(w2)
                    panels[f].append(w2)
            else:
                b = T["belfry"]
                for f in ("front", "back", "outer", "inner"):
                    ac = xc if f in ("front", "back") else -tw / 2
                    if f == "front" and is_clock:
                        holes[f].append(arch(ac, T["belfryClockFace"]["sill"], b["w"], T["belfryClockFace"]["h"]))
                    else:
                        holes[f].append(arch(ac, b["sill"], b["w"], b["h"]))
            mat = "cat_piedra" if k == 0 else "cat_sillar"
            belfry = k == 2

            def wall(face, poly):
                if face == "front":
                    B.extrude(mat, poly, (0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1), -wall_t, 0.0, back=belfry)
                elif face == "back":
                    B.extrude(mat, poly, (0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, -1), tw - wall_t, tw, back=belfry)
                else:
                    xo = x0 if (face == "outer") == (side == "west") else x1
                    sgn = -1 if xo == x0 else 1
                    B.extrude(mat, poly, (xo, 0, 0), (0, 0, 1), (0, 1, 0), (sgn, 0, 0), -wall_t, 0.0, back=belfry)

            def face_poly(face):
                if face in ("front", "back"):
                    base = box(x0, ya, x1, yt)
                else:
                    base = box(-tw + wall_t, ya, -wall_t, yt)
                for h_ in holes[face]:
                    base = base.difference(h_)
                return base

            for f in ("front", "back", "outer", "inner"):
                wall(f, face_poly(f))
                # paneles (vidrio oscuro) dentro de los vanos cerrados
                for pnl in panels[f]:
                    if f == "front":
                        B.extrude("cat_vano", pnl, (0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1), -0.45, -0.4, sides=False)
                        B.extrude("cat_moldura", frame_band(pnl, 0.18), (0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1), 0.0, 0.1)
                    else:
                        xo = x0 if side == "west" else x1
                        sgn = -1 if side == "west" else 1
                        B.extrude("cat_vano", pnl, (xo, 0, 0), (0, 0, 1), (0, 1, 0), (sgn, 0, 0), -0.45, -0.4, sides=False)
                        B.extrude("cat_moldura", frame_band(pnl, 0.18), (xo, 0, 0), (0, 0, 1), (0, 1, 0), (sgn, 0, 0), 0.0, 0.1)
            # pilastras de esquina
            for (cxp, czp) in ((x0, 0.0), (x1, 0.0), (x0, -tw), (x1, -tw)):
                sx = -1 if cxp == x0 else 1
                sz = 1 if czp == 0.0 else -1
                xa, xb = sorted((cxp + sx * cp["projection"], cxp - sx * (cp["width"] - cp["projection"])))
                za, zb = sorted((czp + sz * cp["projection"], czp - sz * (cp["width"] - cp["projection"])))
                B.box("cat_moldura", xa, xb, max(ya, 0.7 if k == 0 else ya), yt - cor["height"], za, zb)
            # cornisa (dos molduras)
            ch, cpj = cor["height"], cor["projection"]
            B.box("cat_moldura", x0 - cpj * 0.55, x1 + cpj * 0.55, yt - ch, yt - ch * 0.45, -tw - cpj * 0.55, cpj * 0.55)
            B.box("cat_moldura", x0 - cpj, x1 + cpj, yt - ch * 0.45, yt, -tw - cpj, cpj)
        # zócalo de la torre
        B.box("cat_zocalo", x0 - 0.15, x1 + 0.15, yb, 0.7, -tw - 0.15, 0.15)
        # piso y techo del campanario
        B.box("cat_sillar", x0 + wall_t, x1 - wall_t, L[2] - 0.4, L[2], -tw + wall_t, -wall_t)
        B.box("cat_sillar", x0 + wall_t, x1 - wall_t, L[3] - 0.9, L[3] - 0.5, -tw + wall_t, -wall_t)
        # campana y viga
        b = T["belfry"]
        bell_y = b["sill"] + 0.6
        B.box("cat_madera", x0 + wall_t, x1 - wall_t, bell_y + 2.35, bell_y + 2.6, -tw / 2 - 0.15, -tw / 2 + 0.15)
        bell = [(0.0, 0.0), (0.72, 0.0), (0.66, 0.18), (0.5, 0.55), (0.42, 1.1), (0.36, 1.45), (0.22, 1.62), (0.0, 1.66)]
        B.lathe("cat_bronce", bell, 14, xc, bell_y + 0.65, -tw / 2)
        # reloj
        if is_clock:
            ck = T["clock"]
            disc = circle(xc, ck["y"], ck["r"], 32)
            B.extrude("cat_moldura", frame_band(disc, 0.2), (0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1), 0.0, 0.14)
            B.extrude("cat_reloj", disc, (0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1), 0.0, 0.08)
            # manecillas a las 10:10 (ángulo horario desde las 12)
            for ang_deg, ln, wd in ((305.0, 0.5, 0.09), (60.0, 0.8, 0.06)):
                th = math.radians(ang_deg)
                hand = [(-wd / 2, -0.08), (wd / 2, -0.08), (wd / 2, ln), (-wd / 2, ln)]
                hand = Polygon([(xc + px * math.cos(th) + py * math.sin(th), ck["y"] - px * math.sin(th) + py * math.cos(th))
                                for px, py in hand])
                B.extrude("cat_hierro", hand, (0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1), 0.08, 0.12)
        # tambor + cúpula + linterna + cruz
        cu = T["cupola"]
        ytop = L[3]
        seg = cu["segments"]
        ph = math.pi / seg
        rb = cu["base"]
        dr = cu["drum"]
        # tambor octogonal: basa blanca, cuerpo de piedra, anillo blanco bajo la cúpula
        B.lathe("cat_blanco", [(rb + 0.35, 0.0), (rb + 0.35, 0.3), (rb + 0.15, 0.3)], seg, xc, ytop, -tw / 2, phase=ph)
        B.lathe("cat_sillar", [(rb + 0.15, 0.3), (rb + 0.15, dr - 0.35)], seg, xc, ytop, -tw / 2, phase=ph)
        B.lathe("cat_blanco", [(rb + 0.15, dr - 0.35), (rb + 0.45, dr - 0.3), (rb + 0.45, dr), (rb, dr)], seg, xc, ytop, -tw / 2, phase=ph)
        # bulbo apuntado con faldón blanco abocinado en la base (foto del usuario)
        H = cu["height"]
        B.lathe("cat_blanco", [(rb * 1.12, 0.0), (rb * 1.12, 0.12), (rb * 1.02, 0.35), (rb, 0.42)], seg, xc, ytop + dr, -tw / 2, phase=ph)
        prof = [(rb, 0.4), (rb * 0.98, 0.9), (rb * 0.9, 1.6), (rb * 0.77, 2.4), (rb * 0.6, 3.2), (rb * 0.43, 4.0),
                (rb * 0.28, 4.75), (rb * 0.15, 5.4), (rb * 0.07, H - 0.3), (0.0, H)]
        B.lathe("cat_cupula", prof, seg, xc, ytop + cu["drum"], -tw / 2, phase=ph, rib_uv=True)
        yk = ytop + cu["drum"] + cu["height"]
        B.sphere("cat_blanco", xc, yk + 0.12, -tw / 2, 0.24)
        B.cross_iron("cat_hierro", xc, yk + 0.3, -tw / 2, T["cross"])

    # ------------------------------------------------ tramo central, primer cuerpo
    md, sd = C["mainDoor"], C["sideDoor"]
    wam, was = C["windowAboveMain"], C["windowAboveSide"]
    doors = [rect(0, 0, md["w"], md["h"]), rect(-sd["u"], 0, sd["w"], sd["h"]), rect(sd["u"], 0, sd["w"], sd["h"])]
    wins1 = [rect(0, wam["y"], wam["w"], wam["h"]), rect(-sd["u"], was["y"], was["w"], was["h"]),
             rect(sd["u"], was["y"], was["w"], was["h"])]
    body1 = box(xl, yb, xr, L[1])
    for h_ in doors + wins1:
        body1 = body1.difference(h_)
    F = dict(origin=(0, 0, 0), e1=(1, 0, 0), e2=(0, 1, 0), n=(0, 0, 1))
    B.extrude("cat_piedra", body1, d0=-1.4, d1=0.0, **F)
    for d_ in doors:
        B.extrude("cat_madera", d_, d0=-0.75, d1=-0.6, sides=False, **F)
        B.extrude("cat_moldura", frame_band(d_, 0.28, y_min=0.0), d0=0.0, d1=0.14, **F)
        minx, _, maxx, maxy = d_.bounds
        B.box("cat_moldura", minx - 0.5, maxx + 0.5, maxy + 0.32, maxy + 0.62, 0.0, 0.32)
    for w_ in wins1:
        B.extrude("cat_vano", w_, d0=-0.5, d1=-0.45, sides=False, **F)
        B.extrude("cat_moldura", frame_band(w_, 0.2), d0=0.0, d1=0.12, **F)
        minx, _, maxx, maxy = w_.bounds
        B.box("cat_moldura", minx - 0.35, maxx + 0.35, maxy + 0.2, maxy + 0.45, 0.0, 0.26)
    # zócalo entre puertas
    cuts = sorted([(d_.bounds[0] - 0.28, d_.bounds[2] + 0.28) for d_ in doors])
    xs = [xl] + [v for c in cuts for v in c] + [xr]
    for a, b in zip(xs[0::2], xs[1::2]):
        B.box("cat_zocalo", a, b, yb, C["plinth"], 0.0, 0.16)
    pw, pp = C["pilasterWidth"], C["pilasterProjection"]
    for u in C["pilastersBody1U"]:
        B.box("cat_piedra", u - pw / 2, u + pw / 2, C["plinth"], L[1] - 0.95, 0.0, pp)
        B.box("cat_moldura", u - pw / 2 - 0.08, u + pw / 2 + 0.08, C["plinth"], C["plinth"] + 0.35, 0.0, pp + 0.08)
        B.box("cat_moldura", u - pw / 2 - 0.1, u + pw / 2 + 0.1, L[1] - 1.35, L[1] - 0.95, 0.0, pp + 0.1)
    # cornisa del primer cuerpo
    B.box("cat_moldura", xl, xr, L[1] - 0.95, L[1] - 0.4, -1.4, 0.32)
    B.box("cat_moldura", xl, xr, L[1] - 0.4, L[1], -1.4, 0.58)

    # ------------------------------------------------ segundo cuerpo
    cb = C["centralBay"]
    ytop2 = C["sideBodyTop"]
    body2 = unary_union([box(xl, L[1], xr, ytop2), box(-cb["halfWidth"], ytop2 - 0.1, cb["halfWidth"], cb["top"])])
    cw_, sw_ = C["centralWindow"], C["sideWindow"]
    wins2 = [arch(0, cw_["y"], cw_["w"], cw_["h"]), arch(-sw_["u"], sw_["y"], sw_["w"], sw_["h"]),
             arch(sw_["u"], sw_["y"], sw_["w"], sw_["h"])]
    for w_ in wins2:
        body2 = body2.difference(w_)
    B.extrude("cat_sillar", body2, d0=-1.2, d1=0.0, **F)
    for w_ in wins2:
        B.extrude("cat_vano", w_, d0=-0.5, d1=-0.45, sides=False, **F)
        B.extrude("cat_moldura", frame_band(w_, 0.22), d0=0.0, d1=0.12, **F)
    ar = C["archRelief"]
    ann = circle(0, ar["y"], ar["r"] + ar["band"], 40).difference(circle(0, ar["y"], ar["r"], 40))
    ann = ann.intersection(box(-10, ar["y"], 10, 40))
    B.extrude("cat_moldura", ann, d0=0.0, d1=0.18, **F)
    for u in C["pilastersBody2U"]:
        top = cb["top"] - 0.6 if abs(u) < cb["halfWidth"] + 0.1 else ytop2 - 0.6
        B.box("cat_sillar", u - pw / 2, u + pw / 2, L[1], top - 0.45, 0.0, pp)
        B.box("cat_moldura", u - pw / 2 - 0.12, u + pw / 2 + 0.12, top - 0.45, top, 0.0, pp + 0.12)
    # cornisas laterales y entablamento central
    for a, b in ((xl, -cb["halfWidth"]), (cb["halfWidth"], xr)):
        B.box("cat_moldura", a, b, ytop2 - 0.6, ytop2 - 0.25, -1.2, 0.3)
        B.box("cat_moldura", a, b, ytop2 - 0.25, ytop2, -1.2, 0.5)
    pdm = C["pediment"]
    B.box("cat_moldura", -pdm["halfWidth"], pdm["halfWidth"], cb["top"] - 0.6, cb["top"] - 0.25, -1.2, 0.32)
    B.box("cat_moldura", -pdm["halfWidth"], pdm["halfWidth"], cb["top"] - 0.25, cb["top"], -1.2, 0.52)
    # frontón triangular con cornisa inclinada
    tri_ = Polygon([(-pdm["halfWidth"], cb["top"]), (pdm["halfWidth"], cb["top"]), (0, pdm["apex"])])
    B.extrude("cat_sillar", tri_, d0=-1.0, d1=0.15, **F)
    inner = tri_.buffer(-0.38, join_style=2)
    rake = tri_.difference(inner).difference(box(-10, cb["top"] - 1, 10, cb["top"] + 0.3))
    B.extrude("cat_moldura", rake, d0=-1.0, d1=0.5, **F)
    B.cross_iron("cat_hierro", 0, pdm["apex"] - 0.05, -0.2, 1.6)
    # cartones avolutados + pirámides herrerianas
    vo = C["volute"]
    for sgn in (-1, 1):
        pts = [(sgn * cb["halfWidth"], ytop2), (sgn * cb["halfWidth"], ytop2 + vo["height"])]
        for k in range(1, 13):
            t = k / 12
            x = cb["halfWidth"] + t * (vo["uOuter"] - cb["halfWidth"])
            y = ytop2 + vo["height"] * (1 - t) ** 1.7 * (1 - 0.15 * math.sin(math.pi * t))
            pts.append((sgn * x, y))
        pts.append((sgn * vo["uOuter"], ytop2))
        vol = Polygon(pts)
        if sgn < 0:
            vol = orient(vol, 1.0)
        vol = unary_union([vol, circle(sgn * (vo["uOuter"] - 0.35), ytop2 + 0.42, 0.42)])
        B.extrude("cat_sillar", vol, d0=-0.7, d1=0.1, **F)
        B.extrude("cat_moldura", frame_band(vol, 0.12).intersection(box(-20, ytop2 + 0.05, 20, 40)), d0=-0.7, d1=0.2, **F)
        py = C["pyramids"]
        px = sgn * py["u"]
        B.box("cat_moldura", px - py["base"] / 2, px + py["base"] / 2, ytop2, ytop2 + 0.55, -0.55, 0.2)
        B.pyramid("cat_sillar", px, -0.18, ytop2 + 0.55, py["base"] * 0.8, py["height"] - 0.75)
        B.sphere("cat_moldura", px, ytop2 + py["height"] - 0.05, -0.18, 0.17)

    # ------------------------------------------------ cuerpo de naves
    D = BD["depth"]
    eave = BD["eave"]
    t_main = tan(BD["roofPitchDeg"])
    ridge = eave + hw * t_main
    gable = lambda x, z: eave + t_main * max(0.0, hw - abs(x))
    ring = [(-hw, -0.5), (-hw, -D), (0.0, -D), (hw, -D), (hw, -0.5)]
    B.walls("cat_muro", ring + [ring[0]], yb, gable, skip_edge=lambda x, z: z > -1.0)
    o = BD["overhang"]
    for sgn in (-1, 1):
        a = (sgn * (hw + o), eave - o * t_main)
        pts = [(a[0], a[1], -1.0), (0.0, ridge, -1.0), (0.0, ridge, -D - o), (a[0], a[1], -D - o)]
        slope_len = math.hypot(hw + o, ridge - a[1])
        nrm = np.cross(np.subtract(pts[1], pts[0]), np.subtract(pts[3], pts[0]))
        nrm = nrm / np.linalg.norm(nrm)
        if nrm[1] < 0:
            nrm = -nrm
        B.face("cat_teja", pts, tuple(nrm), [(-1.0, slope_len), (-1.0, 0.0), (-D - o, 0.0), (-D - o, slope_len)])
    B.box("cat_teja", -0.22, 0.22, ridge - 0.05, ridge + 0.2, -D - o, -1.0)
    # contrafuertes y ventanas altas en los muros laterales
    bt = BD["buttress"]
    sw = BD["sideWindow"]
    z = -tw - 1.2
    rear_left = footprint_uv.difference(box(-hw, 0, hw, D))
    bump_v = [(p.bounds[1], p.bounds[3]) for p in _parts(rear_left) if p.centroid.x < -hw + 0.5 and p.bounds[3] < D + 1]
    while z > -D + 0.8:
        for sgn in (-1, 1):
            v = -z
            if sgn < 0 and any(v0 - 1.5 <= v <= v1 + 1.5 for v0, v1 in bump_v):
                continue
            x0_ = sgn * hw
            xa, xb = sorted((x0_, x0_ + sgn * bt["projection"]))
            B.box("cat_muro", xa, xb, yb, eave - 1.6, z - bt["width"] / 2, z + bt["width"] / 2)
            B.box("cat_moldura", xa - 0.05, xb + 0.05, eave - 1.6, eave - 1.3, z - bt["width"] / 2 - 0.05, z + bt["width"] / 2 + 0.05)
        z -= BD["bayLength"]
    z = -tw - 1.2 - BD["bayLength"] / 2
    while z > -D + 2.0:
        for sgn in (-1, 1):
            v = -z
            if sgn < 0 and any(v0 - 2.5 <= v <= v1 + 2.5 for v0, v1 in bump_v):
                continue
            a_ = arch(z, sw["y"], sw["w"], sw["h"])
            orig = (sgn * hw, 0, 0)
            nrm = (sgn, 0, 0)
            e1 = (0, 0, 1)
            B.extrude("cat_vano", a_, orig, e1, (0, 1, 0), nrm, 0.0, 0.04, sides=False)
            B.extrude("cat_moldura", frame_band(a_, 0.2), orig, e1, (0, 1, 0), nrm, 0.0, 0.1)
        z -= BD["bayLength"]

    # ------------------------------------------------ partes traseras (huella OSM fuera del rectángulo)
    extra = footprint_uv.difference(box(-hw, -1, hw, D))
    pieces = [p for p in _parts(extra) if p.area > 12 and not p.buffer(-0.7).is_empty]
    rear = unary_union([p for p in pieces if p.centroid.y > D - 1.0])
    bumps = [p for p in pieces if p.centroid.y <= D - 1.0]
    ch = cfg["chancel"]
    if not rear.is_empty:
        chancel = rear.intersection(box(ch["uMin"], D - 2, ch["uMax"], D + 100))
        sacr = rear.difference(box(ch["uMin"], D - 2, ch["uMax"], D + 100))
        uc = (ch["uMin"] + ch["uMax"]) / 2
        hwc = (ch["uMax"] - ch["uMin"]) / 2
        tc = tan(ch["roofPitchDeg"])
        vmax = chancel.bounds[3]
        va = vmax - hwc
        def roof_c(u, v):
            if v <= va:
                return ch["eave"] + tc * max(0.0, hwc - abs(u - uc))
            return ch["eave"] + tc * max(0.0, hwc - math.hypot(u - uc, v - va))
        for p in _parts(chancel):
            ring_uv = list(orient(p, 1.0).exterior.coords)
            ring_uv = insert_crossings(insert_crossings(ring_uv, 1, va), 0, uc)
            B.walls("cat_muro", [(u, -v) for u, v in ring_uv], yb, lambda x, z: roof_c(x, -z),
                    skip_edge=lambda x, z: abs(-z - D) < 0.3)
            front = p.intersection(box(-100, -1, 100, va))
            for half in (box(-100, -1, uc, 200), box(uc, -1, 100, 200)):
                piece = front.intersection(half)
                if piece.is_empty:
                    continue
                pxz = unary_union([Polygon([(u, -v) for u, v in q.exterior.coords]) for q in _parts(piece)])
                B.roof_planar("cat_teja", pxz, lambda x, z: roof_c(x, -z), lambda x, z: (-z, x))
            back = p.intersection(box(-100, va, 100, 200))
            for q in _parts(back):
                rq = list(orient(q, 1.0).exterior.coords)
                rq = insert_crossings(rq, 0, uc)
                B.fan("cat_teja", (uc, roof_c(uc, va), -va), [(u, roof_c(u, v), -v) for u, v in rq])
        ts = tan(cfg["sacristy"]["roofPitchDeg"])
        for q in _parts(sacr):
            if q.area < 8:
                continue
            minu, _, maxu, _ = q.bounds
            left = q.centroid.x < uc
            hfun = (lambda u, v, a=minu: cfg["sacristy"]["eave"] + ts * (u - a)) if left else \
                   (lambda u, v, b=maxu: cfg["sacristy"]["eave"] + ts * (b - u))
            ring_uv = list(orient(q, 1.0).exterior.coords)
            B.walls("cat_muro", [(u, -v) for u, v in ring_uv], yb, lambda x, z, h=hfun: h(x, -z),
                    skip_edge=lambda x, z: abs(-z - D) < 0.3)
            B.roof_planar("cat_teja", Polygon([(u, -v) for u, v in ring_uv]), lambda x, z, h=hfun: h(x, -z),
                          lambda x, z: (-z, x))
    te = cfg["transeptApse"]["eave"]
    for q in bumps:
        minu, minv, maxu, maxv = q.bounds
        edge_u = -hw if q.centroid.x < 0 else hw
        apex_uv = (edge_u, (minv + maxv) / 2)
        r = max(math.hypot(u - apex_uv[0], v - apex_uv[1]) for u, v in q.exterior.coords)
        hb = lambda u, v: te + t_main * max(0.0, r - math.hypot(u - apex_uv[0], v - apex_uv[1]))
        ring_uv = list(orient(q, 1.0).exterior.coords)
        B.walls("cat_muro", [(u, -v) for u, v in ring_uv], yb, lambda x, z: hb(x, -z),
                skip_edge=lambda x, z: abs(abs(x) - hw) < 0.3)
        B.fan("cat_teja", (apex_uv[0], hb(*apex_uv), -apex_uv[1]), [(u, hb(u, v), -v) for u, v in ring_uv])
    return B
