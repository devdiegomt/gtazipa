/**
 * Red peatonal (pura: sin three ni Rapier; se prueba con vitest). Se construye con los datos del mundo:
 * - andenes: polilíneas desplazadas ±(ancho/2 + andén/2) del eje de cada vía con andén, recortadas a los triángulos
 *   caminables de la malla 'sidewalk' (los edificios y las calzadas cortan andenes); las esquinas, tes y entradas de
 *   garaje se unen enlazando los extremos de cada tramo con los nodos cercanos sin pisar calzada;
 * - senderos (footway/path/pedestrian/steps) por su eje;
 * - plaza y parque: rejilla de puntos dentro del adoquín sin materas, fuente ni monumento, más los puestos de las bancas
 *   circulares (y del borde de la fuente), mirando hacia afuera;
 * - cruces: todas las cebras del grafo vial, cruces de esquina estimados (sin semáforo) en los cruces de calles sin
 *   cebra y los de los senderos que atraviesan una calle. Son las únicas aristas sobre la calzada.
 * Las rutas usan campos de distancia precalculados hacia unos pocos destinos (atractores).
 */
import type { Road, WorldMeta } from '../world/types';
import type { RoadGraph } from '../traffic/graph';
import plazaCfg from '../data/plaza.json';
import parquesCfg from '../data/parques.json';
import trafico from '../data/trafico.json';
import peatones from '../data/peatones.json';

export type NavCfg = typeof peatones.nav;

/** Zonas: calle (andenes, senderos y cruces), Plaza de los Comuneros, parque. */
export const ZONE_STREET = 0, ZONE_PLAZA = 1, ZONE_PARK = 2;
/** Tipos de nodo: andén, sendero, área abierta (plaza/parque), acceso a un asiento, borde de un cruce. */
export const K_SIDEWALK = 0, K_PATH = 1, K_AREA = 2, K_SEAT = 3, K_CURB = 4;
/** Superficies (altura del suelo): terreno, andén, adoquín de la plaza, adoquín del parque. */
export const S_GROUND = 0, S_SIDEWALK = 1, S_PLAZA = 2, S_PARK = 3;

/** Cebra de roadgraph.json: centro sobre el eje, dirección de la vía, ancho de calzada. */
export interface Zebra { x: number; z: number; dir: [number, number]; width: number; source: string }

export interface NavInput {
  roads: Road[];
  graph: RoadGraph;
  meta: Pick<WorldMeta, 'plaza' | 'parks' | 'landmarks'>;
  /** Triángulos 2D de la cara superior del andén (malla 'sidewalk' de roads.glb): [x0,z0, x1,z1, x2,z2, …]. */
  walk: Float32Array;
  heightAt: (x: number, z: number) => number;
}

export interface Crossing {
  id: number;
  /** Nodos de la red en cada andén y arista que los une (la única parte que pisa la calzada). */
  a: number; b: number; edge: number;
  ax: number; az: number; bx: number; bz: number;
  /** Centro sobre el eje de la vía, dirección de la vía (unitaria) y media calzada. */
  cx: number; cz: number; dx: number; dz: number; half: number;
  /**
   * 'cebra' (grafo vial), 'esquina' (estimado, afuera de la caja de un cruce de calles), 'sendero' (un sendero OSM
   * atraviesa la calle) o 'calle' (a mitad de cuadra, estimado: sólo donde une trozos de andén que de otro modo quedan
   * aislados, como hace la gente cuando el andén se acaba).
   */
  kind: 'cebra' | 'esquina' | 'sendero' | 'calle';
  /** Hay un semáforo del grafo vial cerca: PedSim resuelve con el tráfico el controlador y la fase de la vía cruzada. */
  signalized: boolean;
  /** Arista del grafo vial cruzada. */
  roadEdge: number;
}

export interface Seat {
  /** Donde se apoya la cadera (sobre la banca) y altura absoluta del asiento. */
  x: number; z: number; seatY: number;
  /** Punto de los pies (acceso desde la red) y nodo de acceso. */
  fx: number; fz: number; node: number;
  /** Mirando hacia afuera de la matera o de la fuente. */
  heading: number;
  zone: number;
}

export interface Attractor { node: number; zone: number; weight: number; dist: Float32Array }

const BIG = 1e9;

/** Segmentos con media anchura (ejes de calzadas o senderos) y la arista o vía a la que pertenecen. */
interface SegSet { ax: Float64Array; az: Float64Array; bx: Float64Array; bz: Float64Array; hw: Float64Array; edge: Int32Array }

/** Índice espacial estático (celdas cuadradas, listas compactas). */
class Grid {
  constructor(readonly x0: number, readonly z0: number, readonly cell: number, readonly nx: number, readonly nz: number,
    readonly start: Int32Array, readonly items: Int32Array) {}
  /** Construye a partir de cajas [minx, minz, maxx, maxz] por elemento. */
  static build(x0: number, z0: number, size: number, cell: number, n: number, box: (i: number, b: number[]) => void) {
    const nx = Math.ceil(size / cell), nz = nx;
    const count = new Int32Array(nx * nz + 1), b = [0, 0, 0, 0];
    const range = (i: number, f: (c: number) => void) => {
      box(i, b);
      const i0 = Math.max(0, Math.floor((b[0] - x0) / cell)), i1 = Math.min(nx - 1, Math.floor((b[2] - x0) / cell));
      const j0 = Math.max(0, Math.floor((b[1] - z0) / cell)), j1 = Math.min(nz - 1, Math.floor((b[3] - z0) / cell));
      for (let j = j0; j <= j1; j++) for (let k = i0; k <= i1; k++) f(j * nx + k);
    };
    for (let i = 0; i < n; i++) range(i, (c) => count[c + 1]++);
    for (let c = 0; c < nx * nz; c++) count[c + 1] += count[c];
    const start = count.slice(), fill = count.slice(), items = new Int32Array(count[nx * nz]);
    for (let i = 0; i < n; i++) range(i, (c) => { items[fill[c]++] = i; });
    return new Grid(x0, z0, cell, nx, nz, start, items);
  }
  cellOf(x: number, z: number) {
    const i = Math.floor((x - this.x0) / this.cell), j = Math.floor((z - this.z0) / this.cell);
    return i < 0 || j < 0 || i >= this.nx || j >= this.nz ? -1 : j * this.nx + i;
  }
}

/** Distancia² de (px, pz) al segmento a–b. */
function segDist2(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
  let t = L2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - px, qz = az + dz * t - pz;
  return qx * qx + qz * qz;
}

function inPoly(poly: [number, number][], x: number, z: number) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i], pj = poly[j], xi = pi[0], zi = pi[1], xj = pj[0], zj = pj[1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function polyDist(poly: [number, number][], x: number, z: number) {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const e = segDist2(x, z, poly[j][0], poly[j][1], poly[i][0], poly[i][1]);
    if (e < d) d = e;
  }
  return Math.sqrt(d);
}

/** Polilínea desplazada `off` m a la derecha de la marcha (derecha = (-tz, tx), como graph.ts), con inglete limitado. */
function offsetLine(pts: [number, number][], off: number): [number, number][] {
  const n = pts.length, out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    let nx = 0, nz = 0;
    for (const k of [i - 1, i]) {
      if (k < 0 || k + 1 >= n) continue;
      const dx = pts[k + 1][0] - pts[k][0], dz = pts[k + 1][1] - pts[k][1], L = Math.hypot(dx, dz) || 1;
      nx += -dz / L; nz += dx / L;
    }
    const L = Math.hypot(nx, nz) || 1;
    nx /= L; nz /= L;
    // inglete: en un quiebre de ángulo θ el desplazamiento crece 1/cos(θ/2) (limitado a 2×)
    let m = 1;
    if (i > 0 && i < n - 1) {
      const dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1], Ls = Math.hypot(dx, dz) || 1;
      m = Math.min(2, 1 / Math.max(0.5, nx * (-dz / Ls) + nz * (dx / Ls)));
    }
    out.push([pts[i][0] + nx * off * m, pts[i][1] + nz * off * m]);
  }
  return out;
}

/** Muestras a lo largo de la polilínea: cada `step` m y en los quiebres marcados (> 25°). */
function resample(pts: [number, number][], step: number): [number, number][] {
  const out: [number, number][] = [[pts[0][0], pts[0][1]]];
  let since = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
    const L = Math.hypot(bx - ax, bz - az);
    let s = 0;
    while (since + (L - s) >= step) {
      s += step - since;
      since = 0;
      out.push([ax + ((bx - ax) * s) / L, az + ((bz - az) * s) / L]);
    }
    since += L - s;
    if (i < pts.length - 1 && since > 0.8) {
      const [cx, cz] = pts[i + 1];
      const d1x = bx - ax, d1z = bz - az, d2x = cx - bx, d2z = cz - bz;
      const cos = (d1x * d2x + d1z * d2z) / ((Math.hypot(d1x, d1z) * Math.hypot(d2x, d2z)) || 1);
      if (cos < 0.9) { out.push([bx, bz]); since = 0; }
    }
  }
  const [lx, lz] = pts[pts.length - 1], [px, pz] = out[out.length - 1];
  if (Math.hypot(lx - px, lz - pz) > 0.3) out.push([lx, lz]);
  return out;
}

/** Punto y tangente a la distancia d a lo largo de la polilínea. */
function pointAt(pts: [number, number][], d: number) {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const sx = pts[i][0] - pts[i - 1][0], sz = pts[i][1] - pts[i - 1][1], sl = Math.hypot(sx, sz);
    if (sl > 0 && (acc + sl >= d || i === pts.length - 1)) {
      const t = Math.min(1, Math.max(0, (d - acc) / sl));
      return { x: pts[i - 1][0] + sx * t, z: pts[i - 1][1] + sz * t, tx: sx / sl, tz: sz / sl };
    }
    acc += sl;
  }
  return { x: pts[0][0], z: pts[0][1], tx: 1, tz: 0 };
}

/** Montículo binario de mínimos sobre nodos (Dijkstra). */
class Heap {
  private ids: Int32Array; private keys: Float64Array; size = 0;
  constructor(n: number) { this.ids = new Int32Array(n * 4 + 16); this.keys = new Float64Array(n * 4 + 16); }
  push(id: number, k: number) {
    if (this.size >= this.ids.length) {
      const ids = new Int32Array(this.ids.length * 2), keys = new Float64Array(this.ids.length * 2);
      ids.set(this.ids); keys.set(this.keys); this.ids = ids; this.keys = keys;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= k) break;
      this.ids[i] = this.ids[p]; this.keys[i] = this.keys[p]; i = p;
    }
    this.ids[i] = id; this.keys[i] = k;
  }
  pop(): number {
    const top = this.ids[0], n = --this.size;
    const id = this.ids[n], k = this.keys[n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && this.keys[c + 1] < this.keys[c]) c++;
      if (this.keys[c] >= k) break;
      this.ids[i] = this.ids[c]; this.keys[i] = this.keys[c]; i = c;
    }
    this.ids[i] = id; this.keys[i] = k;
    return top;
  }
  topKey() { return this.keys[0]; }
}

export class PedNav {
  readonly cfg: NavCfg;
  // ---- nodos
  n = 0;
  x!: Float64Array; z!: Float64Array;
  kind!: Uint8Array; zone!: Uint8Array;
  /** Peso de aparición (nodos de calle; 0 en plaza, parque, asientos y bordes de cruce). */
  weight!: Float32Array;
  /** Adyacencia compacta: vecinos de i en adj[start[i] .. start[i+1]) (nodo y arista). */
  adjStart!: Int32Array; adjNode!: Int32Array; adjEdge!: Int32Array;
  // ---- aristas
  m = 0;
  ea!: Int32Array; eb!: Int32Array; elen!: Float32Array;
  /** Media franja lateral (m) por la que se puede repartir la gente a cada lado del eje de la arista. */
  ewl!: Float32Array;
  /** Cruce al que pertenece la arista (-1 si no pisa calzada). */
  ecross!: Int32Array;
  crossings: Crossing[] = [];
  seats: Seat[] = [];
  attractors: Attractor[] = [];
  /** Componente conexa de cada nodo y atractores alcanzables desde cada componente. */
  comp!: Int32Array;
  compAttr: number[][] = [];
  /** Polígonos de las zonas abiertas: plaza (adoquín sin calzadas) y parques. */
  plaza: [number, number][] = [];
  parks: [number, number][][] = [];
  plazaCenter = { x: 0, z: 0 };
  parkCenters: { x: number; z: number }[] = [];
  /** Diagnóstico de la construcción. */
  stats: Record<string, number> = {};

  private walk: Float32Array;
  private walkGrid: Grid;
  private road: SegSet;
  private roadGrid: Grid;
  private path: SegSet;
  private pathGrid: Grid;
  private circles: { x: number; z: number; r: number }[] = [];
  private rects: { x: number; z: number; ux: number; uz: number; fx: number; fz: number; hl: number; hw: number }[] = [];
  private blocked: { ring: [number, number][]; x0: number; z0: number; x1: number; z1: number }[] = [];
  private nodeGrid!: Grid;
  private heightAt: (x: number, z: number) => number;
  private swH = trafico.sidewalks.height;

  constructor(inp: NavInput, cfg: NavCfg = peatones.nav) {
    this.cfg = cfg;
    this.heightAt = inp.heightAt;
    const H = 470, SIZE = 2 * H;
    // ---- triángulos caminables del andén (se descartan los degenerados)
    const keep: number[] = [];
    const W = inp.walk;
    for (let i = 0; i + 5 < W.length; i += 6) {
      const a = (W[i + 2] - W[i]) * (W[i + 5] - W[i + 1]) - (W[i + 3] - W[i + 1]) * (W[i + 4] - W[i]);
      if (Math.abs(a) > 1e-5) keep.push(i);
    }
    this.walk = new Float32Array(keep.length * 6);
    keep.forEach((src, k) => this.walk.set(W.subarray(src, src + 6), k * 6));
    const T = this.walk;
    this.walkGrid = Grid.build(-H, -H, SIZE, 3, keep.length, (i, b) => {
      const o = i * 6;
      b[0] = Math.min(T[o], T[o + 2], T[o + 4]); b[2] = Math.max(T[o], T[o + 2], T[o + 4]);
      b[1] = Math.min(T[o + 1], T[o + 3], T[o + 5]); b[3] = Math.max(T[o + 1], T[o + 3], T[o + 5]);
    });
    // ---- calzadas: aristas del grafo vial (por donde circula el tráfico) con media calzada
    const segs = (list: { pts: [number, number][]; hw: number; id: number }[]): SegSet => {
      const ax: number[] = [], az: number[] = [], bx: number[] = [], bz: number[] = [], hw: number[] = [], id: number[] = [];
      for (const r of list) for (let i = 1; i < r.pts.length; i++) {
        ax.push(r.pts[i - 1][0]); az.push(r.pts[i - 1][1]); bx.push(r.pts[i][0]); bz.push(r.pts[i][1]); hw.push(r.hw); id.push(r.id);
      }
      return { ax: new Float64Array(ax), az: new Float64Array(az), bx: new Float64Array(bx), bz: new Float64Array(bz),
        hw: new Float64Array(hw), edge: new Int32Array(id) };
    };
    const segGrid = (s: SegSet) => Grid.build(-H, -H, SIZE, 8, s.ax.length, (i, b) => {
      b[0] = Math.min(s.ax[i], s.bx[i]) - s.hw[i]; b[2] = Math.max(s.ax[i], s.bx[i]) + s.hw[i];
      b[1] = Math.min(s.az[i], s.bz[i]) - s.hw[i]; b[3] = Math.max(s.az[i], s.bz[i]) + s.hw[i];
    });
    this.road = segs(inp.graph.edges.map((e) => ({ pts: e.pts, hw: e.width / 2, id: e.id })));
    this.roadGrid = segGrid(this.road);
    const PATHS = new Set(['footway', 'path', 'pedestrian', 'steps', 'service', 'cycleway']);
    this.path = segs(inp.roads.filter((r) => PATHS.has(r.highway) && !r.area).map((r) => ({ pts: r.pts, hw: r.width / 2, id: r.id })));
    this.pathGrid = segGrid(this.path);
    // ---- zonas abiertas y obstáculos
    const PL = plazaCfg.planter, PK = parquesCfg.independencia;
    this.plaza = inp.meta.plaza.paved ?? inp.meta.plaza.ring;
    for (const p of inp.meta.plaza.planters ?? []) this.circles.push({ x: p.x, z: p.z, r: PL.outerRadius });
    for (const pk of inp.meta.parks ?? []) {
      this.parks.push(pk.ring);
      for (const f of pk.fountains) this.circles.push({ x: f.x, z: f.z, r: Math.max(1.2, f.radius) + 0.05 });
      for (const mo of pk.monuments) {
        this.rects.push({ x: mo.x, z: mo.z, ux: mo.axis[0], uz: mo.axis[1], fx: mo.front[0], fz: mo.front[1],
          hl: mo.length / 2 + cfg.margenMonumento, hw: mo.width / 2 + cfg.margenMonumento });
      }
    }
    for (const l of inp.meta.landmarks ?? []) {
      const xs = l.ring.map((p) => p[0]), zs = l.ring.map((p) => p[1]);
      this.blocked.push({ ring: l.ring, x0: Math.min(...xs) - 0.5, z0: Math.min(...zs) - 0.5, x1: Math.max(...xs) + 0.5, z1: Math.max(...zs) + 0.5 });
    }
    /** Centroide de área (los anillos OSM repiten vértices: el promedio simple se sesga). */
    const centroid = (poly: [number, number][]) => {
      let A = 0, sx = 0, sz = 0;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const c = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
        A += c; sx += (poly[j][0] + poly[i][0]) * c; sz += (poly[j][1] + poly[i][1]) * c;
      }
      return Math.abs(A) > 1e-6 ? { x: sx / (3 * A), z: sz / (3 * A) } : { x: poly[0][0], z: poly[0][1] };
    };
    this.plazaCenter = centroid(this.plaza);
    this.parkCenters = this.parks.map(centroid);

    // ================= construcción de la red
    const nx: number[] = [], nz: number[] = [], nkind: number[] = [], nstretch: number[] = [], nclass: number[] = [];
    const E: { a: number; b: number; wl: number; cross: number }[] = [];
    const linked = new Set<string>();
    const addNode = (x: number, z: number, k: number, stretch: number, cls = 1) => {
      nx.push(x); nz.push(z); nkind.push(k); nstretch.push(stretch); nclass.push(cls);
      return nx.length - 1;
    };
    const addEdge = (a: number, b: number, wl: number, cross = -1) => {
      if (a === b) return -1;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (linked.has(key)) return -1;
      linked.add(key);
      E.push({ a, b, wl, cross });
      return E.length - 1;
    };
    const popNode = () => { nx.pop(); nz.pop(); nkind.pop(); nstretch.pop(); nclass.pop(); };
    const popEdge = () => { const e = E.pop()!; linked.delete(e.a < e.b ? `${e.a},${e.b}` : `${e.b},${e.a}`); };
    const step = cfg.muestreo;
    /** ¿El segmento a–b queda sobre superficie caminable (sin pisar calzada)? */
    const segOk = (ax: number, az: number, bx: number, bz: number) => {
      const L = Math.hypot(bx - ax, bz - az), k = Math.max(1, Math.ceil(L / step));
      for (let i = 0; i <= k; i++) if (!this.allowed(ax + ((bx - ax) * i) / k, az + ((bz - az) * i) / k)) return false;
      return true;
    };
    const onStreet = (x: number, z: number) => this.onWalk(x, z) && !this.onCarriageway(x, z);
    /** Recorre una polilínea: tramos de muestras válidas unidas por segmentos válidos, con extremos refinados. */
    let stretches = 0;
    const trace = (line: [number, number][], kind: number, valid: (x: number, z: number) => boolean, wl: number, cls: number,
      gaps?: (a: [number, number], b: [number, number]) => void) => {
      const q = resample(line, cfg.paso);
      // (g válido): último punto de g hacia b que sigue siendo válido y alcanzable en línea recta
      const refine = (gx: number, gz: number, bx: number, bz: number): [number, number] => {
        let lo = 0, hi = 1;
        for (let it = 0; it < 9; it++) {
          const t = (lo + hi) / 2, x = gx + (bx - gx) * t, z = gz + (bz - gz) * t;
          if (valid(x, z) && segOk(gx, gz, x, z)) lo = t; else hi = t;
        }
        return [gx + (bx - gx) * lo, gz + (bz - gz) * lo];
      };
      let prev = -1, lastEnd: [number, number] | null = null;
      for (let i = 0; i < q.length; i++) {
        const [x, z] = q[i];
        const ok = valid(x, z);
        if (ok && prev >= 0 && segOk(nx[prev], nz[prev], x, z)) {
          const id = addNode(x, z, kind, stretches, cls);
          addEdge(prev, id, wl);
          prev = id;
          continue;
        }
        if (prev >= 0) {
          // fin del tramo: extremo refinado hacia la muestra que falló
          const end = refine(nx[prev], nz[prev], x, z);
          if (Math.hypot(end[0] - nx[prev], end[1] - nz[prev]) > 0.4) addEdge(prev, addNode(end[0], end[1], kind, stretches, cls), wl);
          lastEnd = end;
          prev = -1;
        }
        if (!ok) continue;
        // comienzo de un tramo: extremo refinado hacia la muestra anterior
        stretches++;
        if (i > 0) {
          const start = refine(x, z, q[i - 1][0], q[i - 1][1]);
          if (lastEnd && gaps) gaps(lastEnd, start);
          if (Math.hypot(start[0] - x, start[1] - z) > 0.4) prev = addNode(start[0], start[1], kind, stretches, cls);
        }
        const id = addNode(x, z, kind, stretches, cls);
        if (prev >= 0) addEdge(prev, id, wl);
        prev = id;
        lastEnd = null;
      }
      stretches++;
    };
    // ---- andenes
    const roadById = new Map(inp.roads.map((r) => [r.id, r]));
    const D = cfg.densidad.clase as Record<string, number>;
    for (const r of inp.roads) {
      if (r.sidewalk <= 0 || r.area || r.pts.length < 2) continue;
      const off = r.width / 2 + r.sidewalk / 2;
      for (const side of [1, -1]) {
        trace(offsetLine(r.pts, side * off), K_SIDEWALK, onStreet, Math.max(0, r.sidewalk / 2 - cfg.margenFranja), D[r.highway] ?? 1);
      }
    }
    const nSidewalk = nx.length;
    // ---- senderos por su eje (si atraviesan una calle, cruce estimado entre los dos lados)
    const pathGaps: [number, number, number, number][] = [];
    const WALKS = new Set(['footway', 'path', 'pedestrian', 'steps']);
    for (const r of inp.roads) {
      if (!WALKS.has(r.highway) || r.area || r.pts.length < 2) continue;
      trace(r.pts, K_PATH, (x, z) => this.allowed(x, z), Math.max(0, r.width / 2 - cfg.margenFranja), D.sendero ?? 0.5,
        (a, b) => pathGaps.push([a[0], a[1], b[0], b[1]]));
    }
    const nLinear = nx.length;
    let nodeGrid = Grid.build(-H, -H, SIZE, 6, nx.length, (i, b) => { b[0] = b[2] = nx[i]; b[1] = b[3] = nz[i]; });
    const near = (x: number, z: number, R: number, out: number[], filter?: (j: number) => boolean) => {
      out.length = 0;
      const c = nodeGrid.cell;
      const i0 = Math.floor((x - R + H) / c), i1 = Math.floor((x + R + H) / c);
      const j0 = Math.floor((z - R + H) / c), j1 = Math.floor((z + R + H) / c);
      for (let j = Math.max(0, j0); j <= Math.min(nodeGrid.nz - 1, j1); j++) {
        for (let i = Math.max(0, i0); i <= Math.min(nodeGrid.nx - 1, i1); i++) {
          const cell = j * nodeGrid.nx + i;
          for (let k = nodeGrid.start[cell]; k < nodeGrid.start[cell + 1]; k++) {
            const id = nodeGrid.items[k];
            if (Math.hypot(nx[id] - x, nz[id] - z) <= R && (!filter || filter(id))) out.push(id);
          }
        }
      }
      out.sort((p, q) => Math.hypot(nx[p] - x, nz[p] - z) - Math.hypot(nx[q] - x, nz[q] - z) || p - q);
      return out;
    };
    // ---- enlaces: extremos de tramo (esquinas, tes) y solapes entre tramos distintos
    const deg = new Int32Array(nx.length);
    for (const e of E) { deg[e.a]++; deg[e.b]++; }
    const cand: number[] = [];
    const nbrs = new Map<number, Set<number>>();
    const isNbr = (a: number, b: number) => nbrs.get(a)?.has(b) ?? false;
    const noteNbr = (a: number, b: number) => {
      if (!nbrs.has(a)) nbrs.set(a, new Set()); if (!nbrs.has(b)) nbrs.set(b, new Set());
      nbrs.get(a)!.add(b); nbrs.get(b)!.add(a);
    };
    for (const e of E) noteNbr(e.a, e.b);
    const wlOf = (a: number, b: number) => (nkind[a] === K_SIDEWALK && nkind[b] === K_SIDEWALK ? 0.3 : 0.4);
    let endLinks = 0, nearLinks = 0;
    for (let i = 0; i < nLinear; i++) {
      if (deg[i] > 1) continue;
      let made = 0;
      for (const j of near(nx[i], nz[i], cfg.enlaceExtremo, cand, (j) => j !== i && (nstretch[j] !== nstretch[i] || Math.abs(j - i) > 3))) {
        if (made >= 2) break;
        if (isNbr(i, j) || !segOk(nx[i], nz[i], nx[j], nz[j])) continue;
        if (addEdge(i, j, wlOf(i, j)) >= 0) { noteNbr(i, j); made++; endLinks++; }
      }
    }
    for (let i = 0; i < nLinear; i++) {
      let made = 0;
      for (const j of near(nx[i], nz[i], cfg.enlaceCercano, cand, (j) => j > i && nstretch[j] !== nstretch[i])) {
        if (made >= 2) break;
        if (isNbr(i, j) || !segOk(nx[i], nz[i], nx[j], nz[j])) continue;
        if (addEdge(i, j, wlOf(i, j)) >= 0) { noteNbr(i, j); made++; nearLinks++; }
      }
    }

    // ---- plaza y parque: rejilla dentro del adoquín, alineada con su lado más largo
    const areaGrid = (poly: [number, number][], spacing: number) => {
      let best = 0, ux = 1, uz = 0;
      for (let i = 1; i < poly.length; i++) {
        const dx = poly[i][0] - poly[i - 1][0], dz = poly[i][1] - poly[i - 1][1], L = Math.hypot(dx, dz);
        if (L > best) { best = L; ux = dx / L; uz = dz / L; }
      }
      const vx = -uz, vz = ux;
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const [x, z] of poly) {
        const u = x * ux + z * uz, v = x * vx + z * vz;
        u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
      }
      const ids = new Map<string, number>();
      for (let i = 0; u0 + (i + 0.5) * spacing < u1; i++) {
        for (let j = 0; v0 + (j + 0.5) * spacing < v1; j++) {
          const u = u0 + (i + 0.5) * spacing, v = v0 + (j + 0.5) * spacing;
          const x = u * ux + v * vx, z = u * uz + v * vz;
          if (!inPoly(poly, x, z) || polyDist(poly, x, z) < cfg.margenBorde || !this.allowed(x, z)) continue;
          if (this.obstacleClearance(x, z) < 0) continue;
          ids.set(`${i},${j}`, addNode(x, z, K_AREA, -1, 0));
        }
      }
      for (const [key, id] of ids) {
        const [i, j] = key.split(',').map(Number);
        for (const [di, dj] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
          const o = ids.get(`${i + di},${j + dj}`);
          if (o === undefined || !segOk(nx[id], nz[id], nx[o], nz[o])) continue;
          addEdge(id, o, spacing * 0.35);
        }
      }
      return [...ids.values()];
    };
    const plazaNodes = this.plaza.length ? areaGrid(this.plaza, cfg.rejillaPlaza) : [];
    const parkNodes = this.parks.flatMap((p) => areaGrid(p, cfg.rejillaParque));
    // ---- asientos: bancas circulares de las materas (plaza) y borde de la fuente (parque), mirando hacia afuera
    const seatSpots: { cx: number; cz: number; cy: number; rHip: number; rFoot: number; h: number; k: number; zone: number }[] = [];
    for (const p of inp.meta.plaza.planters ?? []) {
      seatSpots.push({ cx: p.x, cz: p.z, cy: inp.heightAt(p.x, p.z), rHip: PL.outerRadius - PL.benchDepth / 2,
        rFoot: PL.outerRadius + 0.55, h: PL.seatHeight, k: cfg.asientosPorMatera, zone: ZONE_PLAZA });
    }
    for (const pk of inp.meta.parks ?? []) for (const f of pk.fountains) {
      const R = Math.max(1.2, f.radius);
      seatSpots.push({ cx: f.x, cz: f.z, cy: inp.heightAt(f.x, f.z), rHip: R - PK.fountain.rimWidth / 2, rFoot: R + 0.5,
        h: PK.fountain.rimHeight, k: cfg.asientosFuente, zone: ZONE_PARK });
    }
    const areaNodes = [...plazaNodes, ...parkNodes];
    nodeGrid = Grid.build(-H, -H, SIZE, 6, nx.length, (i, b) => { b[0] = b[2] = nx[i]; b[1] = b[3] = nz[i]; });
    seatSpots.forEach((sp, si) => {
      const a0 = (si * 0.37) % (2 * Math.PI / sp.k);   // giro distinto por matera (determinista)
      for (let k = 0; k < sp.k; k++) {
        const a = a0 + (2 * Math.PI * k) / sp.k, c = Math.cos(a), s = Math.sin(a);
        const fx = sp.cx + c * sp.rFoot, fz = sp.cz + s * sp.rFoot;
        if (!this.allowed(fx, fz)) continue;
        const node = addNode(fx, fz, K_SEAT, -1, 0);
        let made = 0;
        for (const j of near(fx, fz, cfg.rejillaPlaza * 1.6, cand, (j) => nkind[j] === K_AREA)) {
          if (made >= 2) break;
          if (segOk(fx, fz, nx[j], nz[j]) && addEdge(node, j, 0.2) >= 0) made++;
        }
        if (!made) { popNode(); continue; }
        this.seats.push({ x: sp.cx + c * sp.rHip, z: sp.cz + s * sp.rHip, seatY: sp.cy + sp.h, fx, fz, node,
          heading: Math.atan2(-c, -s), zone: sp.zone });
      }
    });
    // bordes del área ↔ andenes y senderos
    let areaLinks = 0;
    for (const i of areaNodes) {
      let made = 0;
      for (const j of near(nx[i], nz[i], cfg.enlaceArea, cand, (j) => j < nLinear)) {
        if (made >= 2) break;
        if (isNbr(i, j) || !segOk(nx[i], nz[i], nx[j], nz[j])) continue;
        if (addEdge(i, j, 0.4) >= 0) { noteNbr(i, j); made++; areaLinks++; }
      }
    }
    nodeGrid = Grid.build(-H, -H, SIZE, 6, nx.length, (i, b) => { b[0] = b[2] = nx[i]; b[1] = b[3] = nz[i]; });

    // ================= cruces
    const C = cfg.cruce;
    const signals = inp.graph.signals;
    const nearestEdge = (x: number, z: number) => {
      let best = -1, bd = Infinity;
      const cell = this.roadGrid.cellOf(x, z);
      if (cell < 0) return { edge: -1, d: Infinity };
      for (let k = this.roadGrid.start[cell]; k < this.roadGrid.start[cell + 1]; k++) {
        const s = this.roadGrid.items[k], R = this.road;
        const d = segDist2(x, z, R.ax[s], R.az[s], R.bx[s], R.bz[s]);
        if (d < bd) { bd = d; best = R.edge[s]; }
      }
      return { edge: best, d: Math.sqrt(bd) };
    };
    const edgeSidewalk = (ei: number) => roadById.get(inp.graph.edges[ei].way)?.sidewalk || 1.6;
    /** Une un extremo de cruce con hasta 2 nodos de la red cercanos (a cada lado a lo largo de la vía si se puede). */
    const attach = (x: number, z: number, dx: number, dz: number) => {
      const id = addNode(x, z, K_CURB, -1, 0);
      let made = 0, side = 0;
      for (const j of near(x, z, 5, cand, (j) => j < id && nkind[j] !== K_CURB && nkind[j] !== K_SEAT)) {
        if (made >= 2) break;
        const sd = Math.sign((nx[j] - x) * dx + (nz[j] - z) * dz) || 1;
        if (made === 1 && sd === side) continue;
        if (!segOk(x, z, nx[j], nz[j])) continue;
        if (addEdge(id, j, 0.3) >= 0) { side = sd; made++; }
      }
      if (!made) { popNode(); return -1; }
      return id;
    };
    const crossings: Crossing[] = [];
    const tryCrossing = (cx: number, cz: number, dx: number, dz: number, half: number, sw: number, kind: Crossing['kind'],
      roadEdge: number, wl: number) => {
      const sep = kind === 'cebra' ? 2 : C.minSeparacion;
      if (crossings.some((o) => Math.hypot(o.cx - cx, o.cz - cz) < sep)) return false;
      const px = -dz, pz = dx, off = half + sw / 2;
      // si el centro del andén no es caminable (andén recortado), se busca cerca a lo ancho
      const fit = (sx: number, sz: number, sgn: number) => {
        for (const o of [0, -0.3, 0.3, -0.6, 0.6]) {
          const x = sx + px * sgn * o, z = sz + pz * sgn * o;
          if (this.allowed(x, z)) return [x, z];
        }
        return null;
      };
      const A = fit(cx + px * off, cz + pz * off, 1), B = fit(cx - px * off, cz - pz * off, -1);
      if (!A || !B) return false;
      const [ax, az] = A, [bx, bz] = B;
      const e0 = E.length;
      const a = attach(ax, az, dx, dz);
      if (a < 0) return false;
      const b = attach(bx, bz, dx, dz);
      if (b < 0) { while (E.length > e0) popEdge(); popNode(); return false; }
      // franja: ±wl a lo largo de la vía, caminable en ambos extremos
      let w = wl;
      while (w > 0.05 && !(this.allowed(ax + dx * w, az + dz * w) && this.allowed(ax - dx * w, az - dz * w) &&
        this.allowed(bx + dx * w, bz + dz * w) && this.allowed(bx - dx * w, bz - dz * w))) w *= 0.5;
      const id = crossings.length;
      const edge = addEdge(a, b, w > 0.05 ? w : 0, id);
      const signalized = signals.some((s) => Math.hypot(s.x - cx, s.z - cz) < C.radioSemaforo);
      crossings.push({ id, a, b, edge, ax, az, bx, bz, cx, cz, dx, dz, half, kind, signalized, roadEdge });
      return true;
    };
    let zebraFail = 0;
    for (const zb of inp.graph.crossings as Zebra[]) {
      const ne = nearestEdge(zb.x, zb.z);
      const L = Math.hypot(zb.dir[0], zb.dir[1]) || 1;
      if (!tryCrossing(zb.x, zb.z, zb.dir[0] / L, zb.dir[1] / L, zb.width / 2, ne.edge >= 0 ? edgeSidewalk(ne.edge) : 1.6, 'cebra',
        ne.edge, C.franjaCebra)) zebraFail++;
    }
    const zebras = crossings.length;
    // esquinas: en cada cruce de calles (grado ≥ 3), un cruce por acceso afuera de la caja del cruce
    for (const nd of inp.graph.nodes) {
      if (nd.degree < 3 || nd.exit) continue;
      for (const ei of nd.edges) {
        const e = inp.graph.edges[ei];
        const pts = e.from === nd.id ? e.pts : [...e.pts].reverse();
        let total = 0;
        for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        const r0 = nd.radius || Math.max(...nd.edges.map((k) => inp.graph.edges[k].width / 2)) + 1;
        for (const extra of [0, 1.5, 3, 5]) {
          const d = r0 + C.distEsquina + extra;
          if (total < d + 3) break;
          const q = pointAt(pts, d);
          if (tryCrossing(q.x, q.z, q.tx, q.tz, e.width / 2, edgeSidewalk(ei), 'esquina', ei, C.franjaEsquina)) break;
        }
      }
    }
    // senderos que atraviesan una calle
    for (const [ax, az, bx, bz] of pathGaps) {
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 2 || L > 16) continue;
      const mx = (ax + bx) / 2, mz = (az + bz) / 2, ne = nearestEdge(mx, mz);
      if (ne.edge < 0 || ne.d > 1.5) continue;
      const e = inp.graph.edges[ne.edge];
      // dirección de la vía en ese punto
      let tx = 1, tz = 0, bd = Infinity;
      for (let i = 1; i < e.pts.length; i++) {
        const d = segDist2(mx, mz, e.pts[i - 1][0], e.pts[i - 1][1], e.pts[i][0], e.pts[i][1]);
        if (d < bd) { bd = d; const sx = e.pts[i][0] - e.pts[i - 1][0], sz = e.pts[i][1] - e.pts[i - 1][1], sl = Math.hypot(sx, sz) || 1; tx = sx / sl; tz = sz / sl; }
      }
      tryCrossing(mx, mz, tx, tz, e.width / 2, Math.max(0.6, (L - e.width) ), 'sendero', ne.edge, C.franjaEsquina);
    }
    // a mitad de cuadra: sólo donde une componentes de la red que de otro modo quedan separadas
    const uf = new Int32Array(nx.length + 4 * inp.graph.edges.length).map((_, i) => i);
    const find = (i: number): number => { while (uf[i] !== i) { uf[i] = uf[uf[i]]; i = uf[i]; } return i; };
    const unite = (a: number, b: number) => { uf[find(a)] = find(b); };
    for (const e of E) unite(e.a, e.b);
    let bridges = 0;
    const sideNode = (x: number, z: number) => {
      for (const j of near(x, z, 3, cand, (j) => nkind[j] !== K_CURB && nkind[j] !== K_SEAT)) if (segOk(x, z, nx[j], nz[j])) return j;
      return -1;
    };
    for (const e of inp.graph.edges) {
      const nA = inp.graph.nodes.find((k) => k.id === e.from)!, nB = inp.graph.nodes.find((k) => k.id === e.to)!;
      let total = 0;
      for (let i = 1; i < e.pts.length; i++) total += Math.hypot(e.pts[i][0] - e.pts[i - 1][0], e.pts[i][1] - e.pts[i - 1][1]);
      const sw = edgeSidewalk(e.id), off = e.width / 2 + sw / 2;
      for (let d = (nA.radius || 0) + 6; d < total - (nB.radius || 0) - 6; d += 4) {
        const q = pointAt(e.pts, d), px = -q.tz, pz = q.tx;
        const a = sideNode(q.x + px * off, q.z + pz * off), b = sideNode(q.x - px * off, q.z - pz * off);
        if (a < 0 || b < 0 || find(a) === find(b)) continue;
        const e0 = E.length;
        if (!tryCrossing(q.x, q.z, q.tx, q.tz, e.width / 2, sw, 'calle', e.id, C.franjaEsquina)) continue;
        for (let k = e0; k < E.length; k++) unite(E[k].a, E[k].b);
        bridges++;
        d += C.minSeparacion * 2;
      }
    }
    this.crossings = crossings;

    // ================= compactación
    const n = nx.length;
    this.n = n;
    this.x = new Float64Array(nx); this.z = new Float64Array(nz);
    this.kind = new Uint8Array(nkind);
    this.zone = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      this.zone[i] = this.plaza.length && inPoly(this.plaza, nx[i], nz[i]) ? ZONE_PLAZA
        : this.parks.some((p) => inPoly(p, nx[i], nz[i])) ? ZONE_PARK : ZONE_STREET;
    }
    for (const s of this.seats) s.zone = this.zone[s.node];
    // franja lateral validada: se reduce hasta que ambos bordes queden sobre superficie caminable
    this.m = E.length;
    this.ea = new Int32Array(E.map((e) => e.a)); this.eb = new Int32Array(E.map((e) => e.b));
    this.elen = new Float32Array(E.map((e) => Math.hypot(nx[e.b] - nx[e.a], nz[e.b] - nz[e.a])));
    this.ecross = new Int32Array(E.map((e) => e.cross));
    this.ewl = new Float32Array(E.length);
    E.forEach((e, k) => {
      if (e.cross >= 0) { this.ewl[k] = e.wl; return; }
      const ax = nx[e.a], az = nz[e.a], bx = nx[e.b], bz = nz[e.b], L = this.elen[k] || 1;
      const px = -(bz - az) / L, pz = (bx - ax) / L;
      let w = e.wl;
      while (w > 0.04 && !(segOk(ax + px * w, az + pz * w, bx + px * w, bz + pz * w) && segOk(ax - px * w, az - pz * w, bx - px * w, bz - pz * w))) w *= 0.6;
      this.ewl[k] = w > 0.04 ? w : 0;
    });
    // adyacencia compacta
    const dg = new Int32Array(n + 1);
    for (const e of E) { dg[e.a + 1]++; dg[e.b + 1]++; }
    for (let i = 0; i < n; i++) dg[i + 1] += dg[i];
    this.adjStart = dg.slice();
    const fill = dg.slice();
    this.adjNode = new Int32Array(E.length * 2); this.adjEdge = new Int32Array(E.length * 2);
    E.forEach((e, k) => {
      this.adjNode[fill[e.a]] = e.b; this.adjEdge[fill[e.a]++] = k;
      this.adjNode[fill[e.b]] = e.a; this.adjEdge[fill[e.b]++] = k;
    });
    this.nodeGrid = Grid.build(-H, -H, SIZE, 6, n, (i, b) => { b[0] = b[2] = nx[i]; b[1] = b[3] = nz[i]; });
    // peso de aparición en la calle: clase de vía × cercanía al centro (ESTIMADO)
    this.weight = new Float32Array(n);
    const DN = cfg.densidad;
    for (let i = 0; i < n; i++) {
      if (this.zone[i] !== ZONE_STREET || (nkind[i] !== K_SIDEWALK && nkind[i] !== K_PATH) || this.degree(i) === 0) continue;
      const d = Math.hypot(nx[i] - this.plazaCenter.x, nz[i] - this.plazaCenter.z);
      this.weight[i] = nclass[i] * (1 + DN.centro * Math.exp(-d / DN.radioCentro));
    }
    this.buildAttractors();
    this.stats = { nodos: n, aristas: this.m, andenes: nSidewalk, senderos: nLinear - nSidewalk, plaza: plazaNodes.length,
      parque: parkNodes.length, asientos: this.seats.length, cebras: zebras, cebrasFallidas: zebraFail,
      cruces: crossings.length, puentes: bridges, enlacesExtremo: endLinks, enlacesCercanos: nearLinks, enlacesArea: areaLinks,
      triangulos: this.walk.length / 6 };
  }

  degree(i: number) { return this.adjStart[i + 1] - this.adjStart[i]; }

  // ================= consultas espaciales
  /** ¿Sobre un triángulo caminable del andén? */
  onWalk(x: number, z: number) {
    const g = this.walkGrid, c = g.cellOf(x, z);
    if (c < 0) return false;
    const T = this.walk, E = 1e-7;
    for (let k = g.start[c]; k < g.start[c + 1]; k++) {
      const o = g.items[k] * 6;
      const ax = T[o], az = T[o + 1], bx = T[o + 2], bz = T[o + 3], cx = T[o + 4], cz = T[o + 5];
      const d1 = (bx - ax) * (z - az) - (bz - az) * (x - ax);
      const d2 = (cx - bx) * (z - bz) - (cz - bz) * (x - bx);
      const d3 = (ax - cx) * (z - cz) - (az - cz) * (x - cx);
      if (!((d1 < -E || d2 < -E || d3 < -E) && (d1 > E || d2 > E || d3 > E))) return true;
    }
    return false;
  }

  /** Distancia de (x, z) al borde de la calzada más cercana (negativa = sobre la calzada); Infinity lejos de toda vía. */
  carriagewayDist(x: number, z: number) {
    const g = this.roadGrid, c = g.cellOf(x, z);
    if (c < 0) return Infinity;
    const R = this.road;
    let best = Infinity;
    for (let k = g.start[c]; k < g.start[c + 1]; k++) {
      const s = g.items[k];
      const d = Math.sqrt(segDist2(x, z, R.ax[s], R.az[s], R.bx[s], R.bz[s])) - R.hw[s];
      if (d < best) best = d;
    }
    return best;
  }

  /** ¿Sobre la calzada por donde circula el tráfico (aristas del grafo vial, con 5 cm de tolerancia en el sardinel)? */
  onCarriageway(x: number, z: number) { return this.carriagewayDist(x, z) < -0.05; }

  /** ¿Sobre un sendero, una vía de servicio o una entrada (sin andén, el peatón puede pisarlas)? */
  onPath(x: number, z: number) {
    const g = this.pathGrid, c = g.cellOf(x, z);
    if (c < 0) return false;
    const P = this.path;
    for (let k = g.start[c]; k < g.start[c + 1]; k++) {
      const s = g.items[k];
      if (segDist2(x, z, P.ax[s], P.az[s], P.bx[s], P.bz[s]) < P.hw[s] * P.hw[s]) return true;
    }
    return false;
  }

  inPlaza(x: number, z: number) { return this.plaza.length > 0 && inPoly(this.plaza, x, z); }
  inPark(x: number, z: number) {
    for (const p of this.parks) if (inPoly(p, x, z)) return true;
    return false;
  }

  /** Holgura (m) del centro de un peatón a los obstáculos de la plaza y el parque (materas, fuente, monumento). */
  obstacleClearance(x: number, z: number) {
    let d = Infinity;
    for (const c of this.circles) d = Math.min(d, Math.hypot(x - c.x, z - c.z) - c.r - this.cfg.margenMatera);
    for (const r of this.rects) {
      const dx = x - r.x, dz = z - r.z, u = Math.abs(dx * r.ux + dz * r.uz) - r.hl, v = Math.abs(dx * r.fx + dz * r.fz) - r.hw;
      d = Math.min(d, u > 0 || v > 0 ? Math.hypot(Math.max(u, 0), Math.max(v, 0)) : Math.max(u, v));
    }
    return d;
  }

  /** ¿Puede estar aquí el centro de un peatón? Andén, plaza, parque o sendero; nunca la calzada ni un obstáculo. */
  allowed(x: number, z: number) {
    if (this.onCarriageway(x, z)) return false;
    if (this.onWalk(x, z)) return true;   // el andén ya está recortado contra edificios, catedral, plaza y parque
    if (!(this.inPlaza(x, z) || this.inPark(x, z) || this.onPath(x, z))) return false;
    for (const c of this.circles) { const dx = x - c.x, dz = z - c.z, r = c.r + 0.25; if (dx * dx + dz * dz < r * r) return false; }
    for (const r of this.rects) {
      const dx = x - r.x, dz = z - r.z;
      if (Math.abs(dx * r.ux + dz * r.uz) < r.hl && Math.abs(dx * r.fx + dz * r.fz) < r.hw) return false;
    }
    for (const b of this.blocked) {
      if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
      if (inPoly(b.ring, x, z) || polyDist(b.ring, x, z) < 0.4) return false;
    }
    return true;
  }

  /** Superficie bajo (x, z): andén, plaza, parque o terreno. */
  surface(x: number, z: number) {
    return this.onWalk(x, z) ? S_SIDEWALK : this.inPlaza(x, z) ? S_PLAZA : this.inPark(x, z) ? S_PARK : S_GROUND;
  }

  /** Altura del suelo para los pies: terreno + 0,15 en el andén, + 0,025 en la plaza, + 0,03 en el parque. */
  groundY(x: number, z: number) {
    const s = this.surface(x, z), A = this.cfg.alturas;
    return this.heightAt(x, z) + (s === S_SIDEWALK ? this.swH : s === S_PLAZA ? A.plaza : s === S_PARK ? A.parque : 0);
  }

  /** ¿Se puede caminar en línea recta de a a b? (muestras cada `step` m sobre superficie permitida). */
  clearSegment(ax: number, az: number, bx: number, bz: number, step = 0.5) {
    const L = Math.hypot(bx - ax, bz - az), k = Math.max(1, Math.ceil(L / step));
    for (let i = 0; i <= k; i++) if (!this.allowed(ax + ((bx - ax) * i) / k, az + ((bz - az) * i) / k)) return false;
    return true;
  }

  /** Nodo más cercano a (x, z) dentro de maxD (con filtro opcional); -1 si no hay. */
  nearestNode(x: number, z: number, maxD: number, filter?: (i: number) => boolean) {
    const g = this.nodeGrid, c = g.cell, H = -g.x0;
    let best = -1, bd = maxD;
    const i0 = Math.max(0, Math.floor((x - maxD + H) / c)), i1 = Math.min(g.nx - 1, Math.floor((x + maxD + H) / c));
    const j0 = Math.max(0, Math.floor((z - maxD + H) / c)), j1 = Math.min(g.nz - 1, Math.floor((z + maxD + H) / c));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const cell = j * g.nx + i;
      for (let k = g.start[cell]; k < g.start[cell + 1]; k++) {
        const id = g.items[k];
        const dx = this.x[id] - x, dz = this.z[id] - z, d = Math.sqrt(dx * dx + dz * dz);
        if (d < bd && this.degree(id) > 0 && (!filter || filter(id))) { bd = d; best = id; }
      }
    }
    return best;
  }

  /** Arista entre a y b (-1 si no son vecinos). */
  edgeBetween(a: number, b: number) {
    for (let k = this.adjStart[a]; k < this.adjStart[a + 1]; k++) if (this.adjNode[k] === b) return this.adjEdge[k];
    return -1;
  }

  /** Componentes conexas: etiqueta por nodo y tamaño de la mayor. */
  components() {
    const comp = new Int32Array(this.n).fill(-1), sizes: number[] = [];
    const stack: number[] = [];
    for (let s = 0; s < this.n; s++) {
      if (comp[s] >= 0) continue;
      const c = sizes.length;
      let size = 0;
      comp[s] = c; stack.push(s);
      while (stack.length) {
        const u = stack.pop()!;
        size++;
        for (let k = this.adjStart[u]; k < this.adjStart[u + 1]; k++) {
          const v = this.adjNode[k];
          if (comp[v] < 0) { comp[v] = c; stack.push(v); }
        }
      }
      sizes.push(size);
    }
    return { comp, sizes, largest: Math.max(0, ...sizes) };
  }

  /** Campo de distancias por la red (m) desde `src`, con el costo extra de los cruces. */
  distanceField(src: number) {
    const dist = new Float32Array(this.n).fill(BIG);
    const heap = new Heap(this.n);
    const pen = this.cfg.cruce.penalizacion;
    dist[src] = 0;
    heap.push(src, 0);
    while (heap.size) {
      const k0 = heap.topKey(), u = heap.pop();
      if (k0 > dist[u]) continue;
      for (let k = this.adjStart[u]; k < this.adjStart[u + 1]; k++) {
        const v = this.adjNode[k], e = this.adjEdge[k];
        const d = k0 + this.elen[e] + (this.ecross[e] >= 0 ? pen : 0);
        if (d < dist[v]) { dist[v] = d; heap.push(v, d); }
      }
    }
    return dist;
  }

  /**
   * Atractores: puntos de la plaza y del parque y nodos de calle repartidos por cada componente conexa de la red
   * (muestreo del más lejano, empezando por el de más peso), cada uno con su campo de distancias por la red. En el
   * centro histórico casi no hay andén (las fachadas OSM llegan al borde de la calzada estimada), así que la red queda
   * partida en barrios: cada uno tiene sus propios destinos.
   */
  private buildAttractors() {
    const A = this.cfg.atractores;
    const { comp, sizes } = this.components();
    this.comp = comp;
    this.compAttr = sizes.map(() => []);
    const spread = (cands: number[], k: number, first: number) => {
      const out: number[] = [];
      if (!cands.length) return out;
      const dmin = new Float64Array(cands.length).fill(Infinity);
      let pick = first;
      for (let it = 0; it < k && pick >= 0; it++) {
        out.push(cands[pick]);
        let bi = -1, bd = 0;
        for (let j = 0; j < cands.length; j++) {
          dmin[j] = Math.min(dmin[j], Math.hypot(this.x[cands[j]] - this.x[cands[pick]], this.z[cands[j]] - this.z[cands[pick]]));
          if (dmin[j] > bd) { bd = dmin[j]; bi = j; }
        }
        pick = bd > 15 ? bi : -1;
      }
      return out;
    };
    const closest = (cands: number[], x: number, z: number) => {
      let bi = 0, bd = Infinity;
      cands.forEach((c, j) => { const d = Math.hypot(this.x[c] - x, this.z[c] - z); if (d < bd) { bd = d; bi = j; } });
      return bi;
    };
    const add = (nodes: number[], zone: number, w: (i: number) => number) => {
      for (const node of nodes) {
        this.compAttr[comp[node]].push(this.attractors.length);
        this.attractors.push({ node, zone, weight: w(node), dist: this.distanceField(node) });
      }
    };
    const zoneNodes = (zn: number) => {
      const r: number[] = [];
      for (let i = 0; i < this.n; i++) if (this.zone[i] === zn && this.kind[i] === K_AREA && this.degree(i) > 0) r.push(i);
      // sólo la componente mayor de la zona
      const cnt = new Map<number, number>();
      for (const i of r) cnt.set(comp[i], (cnt.get(comp[i]) ?? 0) + 1);
      let best = -1, bc = 0;
      for (const [c, k] of cnt) if (k > bc) { bc = k; best = c; }
      return r.filter((i) => comp[i] === best);
    };
    const pl = zoneNodes(ZONE_PLAZA), pk = zoneNodes(ZONE_PARK);
    add(spread(pl, A.plaza, closest(pl, this.plazaCenter.x, this.plazaCenter.z)), ZONE_PLAZA, () => A.pesoPlaza);
    const pc = this.parkCenters[0];
    if (pc) add(spread(pk, A.parque, closest(pk, pc.x, pc.z)), ZONE_PARK, () => A.pesoParque);
    // calle: por componente, ~1 destino cada `nodosPorAtractor` nodos (mínimo 2 si la componente es grande)
    const byComp = new Map<number, number[]>();
    for (let i = 0; i < this.n; i++) {
      if (this.weight[i] <= 0 || Math.hypot(this.x[i] - this.plazaCenter.x, this.z[i] - this.plazaCenter.z) > A.radioCalle) continue;
      if (sizes[comp[i]] < A.minComponente) continue;
      if (!byComp.has(comp[i])) byComp.set(comp[i], []);
      byComp.get(comp[i])!.push(i);
    }
    for (const c of [...byComp.keys()].sort((a, b) => a - b)) {
      const cands = byComp.get(c)!;
      const k = Math.max(sizes[c] >= 4 * A.minComponente ? 2 : 1, Math.min(A.maxPorComponente, Math.round(sizes[c] / A.nodosPorAtractor)));
      let heavy = 0;
      cands.forEach((v, j) => { if (this.weight[v] > this.weight[cands[heavy]]) heavy = j; });
      add(spread(cands, k, heavy), ZONE_STREET, (i) => this.weight[i]);
    }
  }
}

/** Atajo: construye la red con la configuración de peatones.json. */
export function buildNav(inp: NavInput, cfg: NavCfg = peatones.nav) {
  return new PedNav(inp, cfg);
}
