"""Vías: grafo vial para el tráfico, semáforos, andenes con sardinel y señalización horizontal.

Coordenadas: mapa local (x = este, n = norte) para la geometría con shapely; se exporta en coordenadas del juego
(x, z = -n). Parámetros en src/data/trafico.json.
"""
from __future__ import annotations

import math
from collections import defaultdict

import mapbox_earcut as earcut
import numpy as np
import shapely
from shapely.geometry import LineString, Point, Polygon, box
from shapely.geometry.polygon import orient
from shapely.ops import unary_union

VEHICULAR = {"primary", "secondary", "tertiary", "unclassified", "residential", "living_street"}


def _parts(g):
    if g.is_empty:
        return []
    if isinstance(g, Polygon):
        return [g]
    out = []
    for x in getattr(g, "geoms", []):
        out += _parts(x)
    return out


class Mesh:
    """Acumulador simple por material (posiciones, normales, uv, índices) en coordenadas del juego."""

    def __init__(self):
        self.d = defaultdict(lambda: {"p": [], "n": [], "uv": [], "i": []})

    def tris(self, mat, pts, tri, normal, uvs):
        m = self.d[mat]
        base = len(m["p"])
        P = [np.asarray(q, float) for q in pts]
        m["p"] += [tuple(q) for q in P]
        m["n"] += [tuple(normal)] * len(P)
        m["uv"] += [tuple(u) for u in uvs]
        for a, b, c in tri:
            if np.dot(np.cross(P[b] - P[a], P[c] - P[a]), normal) < 0:
                b, c = c, b
            m["i"] += [base + a, base + b, base + c]

    def quad(self, mat, pts, normal, uvs):
        self.tris(mat, pts, [(0, 1, 2), (0, 2, 3)], normal, uvs)


def lanes_for(tags: dict, width: float, cfg: dict):
    """(forward, backward) carriles según oneway/lanes de OSM o el ancho."""
    ow = tags.get("oneway")
    oneway = 1 if ow in ("yes", "1", "true") or tags.get("junction") == "roundabout" else -1 if ow == "-1" else 0
    lanes = tags.get("lanes")
    try:
        lanes = int(str(lanes).split(";")[0]) if lanes else None
    except ValueError:
        lanes = None
    if oneway:
        n = lanes or (2 if width >= cfg["graph"]["lanesOnewayMinWidth"] else 1)
        return (n, 0) if oneway == 1 else (0, n), oneway, lanes is not None
    per = max(1, (lanes or 2) // 2)
    return (per, per), 0, lanes is not None


def build(osm, frame, terrain, road_lines, cfg, area_half, terrain_half, buildings_map, exclude_map, keep_band_map):
    """Devuelve (grafo, mesh de andenes/señalización, estadísticas)."""
    G = cfg["graph"]
    tb = box(-terrain_half + 3, -terrain_half + 3, terrain_half - 3, terrain_half - 3)

    def gxz(nid):
        nd = osm.nodes[nid]
        x, n = frame.xn(nd["lon"], nd["lat"])
        return float(x), float(-n)

    # ---------------- grafo: vías vehiculares partidas en los cruces
    veh = [r for r in road_lines if r["highway"] in VEHICULAR and not r["area"]]
    use = defaultdict(int)
    for r in veh:
        for nid in set(r["nodes"]):
            use[nid] += 1
        use[r["nodes"][0]] += 1
        use[r["nodes"][-1]] += 1
    edges, nodes = [], {}
    for r in veh:
        tags = osm.ways[r["id"]].get("tags", {})
        (fw, bw), oneway, lanes_tag = lanes_for(tags, r["width"], cfg)
        try:
            vmax = float(str(tags.get("maxspeed", "")).split()[0])
            vsrc = "osm:maxspeed"
        except (ValueError, IndexError):
            vmax, vsrc = G["speedKmh"].get(r["highway"], 30), "estimado:clase"
        ids = [n for n in r["nodes"] if n in osm.nodes]
        cut = [i for i, n in enumerate(ids) if i == 0 or i == len(ids) - 1 or use[n] >= 2]
        for a, b in zip(cut[:-1], cut[1:]):
            seg = ids[a:b + 1]
            pts = [gxz(n) for n in seg]
            line = LineString(pts)
            if line.length < 0.5 or not line.intersects(tb):
                continue
            e = {"id": len(edges), "way": r["id"], "name": r["name"], "highway": r["highway"], "from": seg[0], "to": seg[-1],
                 "pts": [[round(x, 2), round(z, 2)] for x, z in pts], "width": r["width"], "surface": r["surface"],
                 "fw": fw, "bw": bw, "oneway": oneway, "lanesSource": "osm:lanes" if lanes_tag else "estimado:ancho",
                 "speed": vmax, "speedSource": vsrc, "length": round(line.length, 2)}
            edges.append(e)
            for nid in (seg[0], seg[-1]):
                if nid not in nodes:
                    x, z = gxz(nid)
                    nodes[nid] = {"id": nid, "x": round(x, 2), "z": round(z, 2), "y": round(float(terrain.y(x, z)[0]), 2),
                                  "edges": [], "exit": abs(x) > area_half or abs(z) > area_half}
                nodes[nid]["edges"].append(e["id"])
    for n in nodes.values():
        n["degree"] = len(n["edges"])
        hw = max(edges[i]["width"] / 2 for i in n["edges"])
        n["radius"] = round(hw + 1.0, 2) if n["degree"] >= 3 else 0.0

    # ---------------- semáforos (OSM + estimados)
    S = cfg["signals"]
    junctions = [n for n in nodes.values() if n["degree"] >= 3 and not n["exit"]]
    signals = {}
    for nd in osm.nodes.values():
        if nd.get("tags", {}).get("highway") != "traffic_signals":
            continue
        x, n_ = frame.xn(nd["lon"], nd["lat"])
        x, z = float(x), float(-n_)
        if abs(x) > area_half or abs(z) > area_half:
            continue
        best = min(junctions, key=lambda j: math.hypot(j["x"] - x, j["z"] - z), default=None)
        if best and math.hypot(best["x"] - x, best["z"] - z) <= S["osmSnapDistance"]:
            sg = signals.setdefault(best["id"], {"node": best["id"], "x": best["x"], "z": best["z"], "source": "osm", "osm": []})
            sg["osm"].append(nd["id"])
    if S["inferEnabled"]:
        # ESTIMADOS: cruces de 4 o más accesos donde una vía principal se cruza con otra calle (nunca sobre adoquín),
        # por orden de importancia y separados al menos minSpacing de cualquier otro semáforo.
        cands = []
        for j in junctions:
            if j["id"] in signals or j["degree"] < 4:
                continue
            inc = [edges[i] for i in j["edges"]]
            if any(e["surface"] in cfg["markings"]["noMarkSurfaces"] for e in inc):
                continue
            art = {e["name"] or f"way{e['way']}" for e in inc if e["highway"] in S["inferClasses"]}
            names = {e["name"] or f"way{e['way']}" for e in inc}
            if not art or len(names) < 2:
                continue
            rank = {"primary": 3, "secondary": 2, "tertiary": 1}
            score = sum(rank.get(e["highway"], 0) for e in inc) + j["degree"]
            cands.append((score, j, sorted(names)))
        for score, j, names in sorted(cands, key=lambda c: -c[0]):
            if any(math.hypot(s_["x"] - j["x"], s_["z"] - j["z"]) < S["minSpacing"] for s_ in signals.values()):
                continue
            signals[j["id"]] = {"node": j["id"], "x": j["x"], "z": j["z"], "source": "estimado", "osm": [],
                                "rule": "cruce de " + " × ".join(names)}
    M = cfg["markings"]
    for sid in signals:
        n = nodes[sid]
        hw = max(edges[i]["width"] / 2 for i in n["edges"])
        n["core"] = round(hw + 1.6, 2)                                    # caja del cruce + andén
        n["radius"] = round(n["core"] + M["zebraDepth"] + 1.2, 2)        # la línea de pare queda antes de la cebra

    # ---------------- andenes con sardinel
    W = cfg["sidewalks"]
    side = [r["geom"].buffer(r["width"] / 2 + r["sidewalk"], cap_style=1) for r in road_lines if r["sidewalk"] > 0 and not r["area"]]
    carriage = [r["geom"].buffer(r["width"] / 2, cap_style=1) for r in road_lines
                if (r["highway"] in VEHICULAR or r["highway"] == "service") and not r["area"]]
    area = unary_union(side).difference(unary_union(carriage)).difference(buildings_map).difference(exclude_map)
    area = area.intersection(box(-terrain_half + 2, -terrain_half + 2, terrain_half - 2, terrain_half - 2))
    if keep_band_map is not None:
        area = area.union(keep_band_map.intersection(unary_union(side))).difference(unary_union(carriage)).difference(buildings_map)
    polys = []
    for p in _parts(area.simplify(0.03)):
        if p.area < 2 or p.buffer(-W["minWidth"] / 2).is_empty:
            continue
        polys.append(orient(shapely.segmentize(p, W["segment"]), 1.0))
    mesh = Mesh()
    h = W["height"]
    for p in polys:
        rings = [np.asarray(p.exterior.coords)[:-1]] + [np.asarray(r.coords)[:-1] for r in p.interiors]
        verts = np.vstack(rings)
        ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
        tri = earcut.triangulate_float64(verts, ends).reshape(-1, 3).tolist()
        ys = terrain.y(verts[:, 0], -verts[:, 1])
        top = [(float(x), float(y) + h, float(-n)) for (x, n), y in zip(verts, ys)]
        mesh.tris("sidewalk", top, tri, (0.0, 1.0, 0.0), [(float(x), float(n)) for x, n in verts])
        # sardinel: cara vertical en todo el contorno (hacia la calzada, o enterrada contra los edificios)
        for ring in [p.exterior, *p.interiors]:
            c = np.asarray(ring.coords)
            yy = terrain.y(c[:, 0], -c[:, 1])
            s = 0.0
            for (x0, n0), (x1, n1), y0, y1 in zip(c[:-1], c[1:], yy[:-1], yy[1:]):
                L = math.hypot(x1 - x0, n1 - n0)
                if L < 1e-3:
                    continue
                nrm = ((n1 - n0) / L, 0.0, (x1 - x0) / L)     # CCW en (x, n): afuera = (dn, -dx) → juego (dn, 0, dx)
                pts = [(x0, y0 - 0.12, -n0), (x1, y1 - 0.12, -n1), (x1, y1 + h, -n1), (x0, y0 + h, -n0)]
                mesh.quad("curb", pts, nrm, [(s, 0), (s + L, 0), (s + L, h + 0.12), (s, h + 0.12)])
                s += L

    # ---------------- señalización horizontal
    def strip(mat, a, b, w, lift=0.028):
        (x0, z0), (x1, z1) = a, b
        L = math.hypot(x1 - x0, z1 - z0)
        if L < 1e-3:
            return
        px, pz = -(z1 - z0) / L * w / 2, (x1 - x0) / L * w / 2
        ya, yb = (float(v) + lift for v in terrain.y(np.array([x0, x1]), np.array([z0, z1])))
        mesh.quad(mat, [(x0 - px, ya, z0 - pz), (x1 - px, yb, z1 - pz), (x1 + px, yb, z1 + pz), (x0 + px, ya, z0 + pz)],
                  (0.0, 1.0, 0.0), [(0, 0), (L, 0), (L, w), (0, w)])

    def offset_line(pts, off):
        ln = LineString(pts)
        if abs(off) < 1e-6:
            return ln
        o = ln.offset_curve(off, join_style=2)
        return o if isinstance(o, LineString) and not o.is_empty else None

    def paint_line(mat, line, start, end, dashed, solid_ends):
        if line is None or end - start < 1.0:
            return
        s = start
        step = 2.0
        while s < end - 1e-6:
            e = min(end, s + step)
            mid = (s + e) / 2
            near = mid - start < solid_ends or end - mid < solid_ends
            if (not dashed) or near or ((mid - start) % (M["dash"] + M["gap"])) < M["dash"]:
                a, b = line.interpolate(s), line.interpolate(e)
                strip(mat, (a.x, a.y), (b.x, b.y), M["lineWidth"])
            s = e

    n_lines = n_zebras = 0
    for e in edges:
        if e["surface"] in M["noMarkSurfaces"] or e["width"] < 5:
            continue
        line = LineString(e["pts"])
        r0 = nodes[e["from"]]["radius"] or 0.0
        r1 = nodes[e["to"]]["radius"] or 0.0
        start, end = r0 + 0.5, line.length - r1 - 0.5
        if e["oneway"] == 0:
            paint_line("mark_yellow", line, start, end, True, M["solidNearJunction"])
            n_lines += 1
        else:
            n = e["fw"] or e["bw"]
            lw = e["width"] / n
            for k in range(1, n):
                paint_line("mark_white", offset_line(e["pts"], -e["width"] / 2 + k * lw), start, end, True, 0)
                n_lines += 1
    # cebras y líneas de pare en cada acceso de los cruces semaforizados
    crossings = []
    for sid in signals:
        n = nodes[sid]
        for ei in n["edges"]:
            e = edges[ei]
            pts = e["pts"] if e["from"] == sid else e["pts"][::-1]
            line = LineString(pts)
            if line.length < n["radius"] + 1:
                continue
            a = line.interpolate(n["core"])
            b = line.interpolate(n["core"] + 0.5)
            dx, dz = b.x - a.x, b.y - a.y
            L = math.hypot(dx, dz) or 1
            dx, dz = dx / L, dz / L
            crossings.append({"x": round(a.x + dx * M["zebraDepth"] / 2, 2), "z": round(a.y + dz * M["zebraDepth"] / 2, 2),
                              "dir": [round(dx, 4), round(dz, 4)], "width": e["width"], "source": "estimado:semaforo"})
            # la línea de pare cubre los carriles que ENTRAN al cruce (lado derecho de quien llega)
            incoming_lanes = e["bw"] if e["from"] == sid else e["fw"]
            if incoming_lanes:
                d_stop = n["core"] + M["zebraDepth"] + 0.8
                c = line.interpolate(d_stop)
                px, pz = -dz, dx          # perpendicular
                if e["oneway"]:
                    s0, s1 = -e["width"] / 2, e["width"] / 2
                else:
                    s0, s1 = -e["width"] / 2, 0.0   # quien llega viene en sentido contrario a `dir` → su derecha es -perp
                strip("mark_white", (c.x + px * s0, c.y + pz * s0), (c.x + px * s1, c.y + pz * s1), M["stopLineWidth"])
    for nd in osm.nodes.values():
        if nd.get("tags", {}).get("highway") == "crossing":
            x, n_ = frame.xn(nd["lon"], nd["lat"])
            x, z = float(x), float(-n_)
            if abs(x) > area_half or abs(z) > area_half:
                continue
            best = None
            for e in edges:
                d = LineString(e["pts"]).distance(Point(x, z))
                if d < 3 and (best is None or d < best[0]):
                    best = (d, e)
            if best:
                ln = LineString(best[1]["pts"])
                t = ln.project(Point(x, z))
                a, b = ln.interpolate(max(0, t - 0.5)), ln.interpolate(min(ln.length, t + 0.5))
                L = math.hypot(b.x - a.x, b.y - a.y) or 1
                crossings.append({"x": round(x, 2), "z": round(z, 2), "dir": [round((b.x - a.x) / L, 4), round((b.y - a.y) / L, 4)],
                                  "width": best[1]["width"], "source": f"osm:node/{nd['id']}"})
    for c in crossings:
        dx, dz = c["dir"]
        px, pz = -dz, dx
        k = -c["width"] / 2 + 0.4
        while k + M["zebraStripe"] <= c["width"] / 2 - 0.3:
            m = k + M["zebraStripe"] / 2
            cx, cz = c["x"] + px * m, c["z"] + pz * m
            h2 = M["zebraDepth"] / 2
            # franja paralela al sentido de circulación
            for t in np.arange(-h2, h2, 1.0):
                strip("mark_white", (cx + dx * t, cz + dz * t), (cx + dx * min(h2, t + 1.0), cz + dz * min(h2, t + 1.0)), M["zebraStripe"], 0.03)
            k += M["zebraStripe"] + M["zebraGap"]
        n_zebras += 1

    graph = {"nodes": list(nodes.values()), "edges": edges, "signals": list(signals.values()), "crossings": crossings}
    stats = {"aristas": len(edges), "nodos": len(nodes), "cruces": len(junctions),
             "semaforos_osm": sum(1 for s in signals.values() if s["source"] == "osm"),
             "semaforos_estimados": sum(1 for s in signals.values() if s["source"] == "estimado"),
             "andenes_poligonos": len(polys), "lineas": n_lines, "cebras": n_zebras}
    return graph, mesh, stats
