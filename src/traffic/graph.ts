/**
 * Grafo de carriles a partir de roadgraph.json (pipeline/vias.py). Puro (sin three ni Rapier): se prueba con vitest.
 * Tránsito por la derecha (Colombia). Cada arista OSM genera carriles por sentido; en los cruces, conectores curvos
 * (Bézier cuadrática) unen el final de un carril con el inicio del siguiente.
 */

export interface RNode { id: number; x: number; z: number; y: number; edges: number[]; exit: boolean; degree: number; radius: number; core?: number }
export interface REdge {
  id: number; way: number; name: string | null; highway: string; from: number; to: number; pts: [number, number][];
  width: number; surface: string; fw: number; bw: number; oneway: number; speed: number; length: number;
}
export interface RSignal { node: number; x: number; z: number; source: string; osm: number[]; rule?: string }
export interface RoadGraph { nodes: RNode[]; edges: REdge[]; signals: RSignal[]; crossings: unknown[] }

export class Poly {
  readonly x: Float64Array;
  readonly z: Float64Array;
  readonly cum: Float64Array;
  readonly length: number;
  constructor(pts: [number, number][]) {
    this.x = new Float64Array(pts.map((p) => p[0]));
    this.z = new Float64Array(pts.map((p) => p[1]));
    this.cum = new Float64Array(pts.length);
    for (let i = 1; i < pts.length; i++) this.cum[i] = this.cum[i - 1] + Math.hypot(this.x[i] - this.x[i - 1], this.z[i] - this.z[i - 1]);
    this.length = this.cum[pts.length - 1];
  }
  /** Punto y tangente a la distancia s. */
  at(s: number, out = { x: 0, z: 0, tx: 0, tz: 1 }) {
    const n = this.x.length;
    s = Math.max(0, Math.min(this.length, s));
    let i = 1;
    let lo = 1, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.cum[mid] < s) lo = mid + 1; else hi = mid; }
    i = lo;
    const L = this.cum[i] - this.cum[i - 1] || 1e-9;
    const t = (s - this.cum[i - 1]) / L;
    const dx = this.x[i] - this.x[i - 1], dz = this.z[i] - this.z[i - 1];
    out.x = this.x[i - 1] + dx * t;
    out.z = this.z[i - 1] + dz * t;
    const d = Math.hypot(dx, dz) || 1;
    out.tx = dx / d; out.tz = dz / d;
    return out;
  }
}

export interface Lane {
  kind: 'lane'; id: number; edge: REdge; dir: 1 | -1; idx: number; lanes: number; from: number; to: number;
  poly: Poly; speed: number; offset: number; width: number; outs: Connector[];
  /** Semáforo que controla el final del carril (si lo hay). */
  signal?: { controller: number; phase: 0 | 1 };
}
export interface Connector { kind: 'conn'; id: number; node: number; from: Lane; to: Lane; poly: Poly; turn: 'S' | 'L' | 'R' | 'U' }
export type Piece = Lane | Connector;

function offsetPolyline(pts: [number, number][], off: number): [number, number][] {
  const n = pts.length;
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let tx = b[0] - a[0], tz = b[1] - a[1];
    const L = Math.hypot(tx, tz) || 1;
    tx /= L; tz /= L;
    // derecha de la marcha = (-tz, tx)
    out.push([pts[i][0] - tz * off, pts[i][1] + tx * off]);
  }
  return out;
}

function trim(pts: [number, number][], start: number, end: number): [number, number][] | null {
  const p = new Poly(pts);
  if (p.length - start - end < 1.0) return null;
  const res: [number, number][] = [];
  const a = p.at(start);
  res.push([a.x, a.z]);
  for (let i = 1; i < pts.length - 1; i++) if (p.cum[i] > start && p.cum[i] < p.length - end) res.push(pts[i]);
  const b = p.at(p.length - end);
  res.push([b.x, b.z]);
  return res;
}

export class LaneGraph {
  lanes: Lane[] = [];
  connectors: Connector[] = [];
  nodes = new Map<number, RNode>();
  constructor(readonly g: RoadGraph, laneWidth = 3.0) {
    for (const n of g.nodes) this.nodes.set(n.id, n);
    for (const e of g.edges) {
      for (const dir of [1, -1] as const) {
        const n = dir === 1 ? e.fw : e.bw;
        if (!n) continue;
        const pts = dir === 1 ? e.pts : [...e.pts].reverse();
        const from = dir === 1 ? e.from : e.to, to = dir === 1 ? e.to : e.from;
        const twoWay = e.fw > 0 && e.bw > 0;
        const lw = Math.min(laneWidth, twoWay ? e.width / 2 / n : e.width / n);
        for (let i = 0; i < n; i++) {
          // i = 0 es el carril de más a la derecha
          const offset = twoWay ? (n - i - 0.5) * lw : e.width / 2 - (i + 0.5) * lw;
          const r0 = this.nodes.get(from)!.radius, r1 = this.nodes.get(to)!.radius;
          const t = trim(offsetPolyline(pts, offset), r0, r1);
          if (!t) continue;
          this.lanes.push({ kind: 'lane', id: this.lanes.length, edge: e, dir, idx: i, lanes: n, from, to, poly: new Poly(t),
            speed: e.speed / 3.6, offset, width: lw, outs: [] });
        }
      }
    }
    // conectores en cada nodo
    const incoming = new Map<number, Lane[]>(), outgoing = new Map<number, Lane[]>();
    for (const l of this.lanes) {
      if (!incoming.has(l.to)) incoming.set(l.to, []);
      if (!outgoing.has(l.from)) outgoing.set(l.from, []);
      incoming.get(l.to)!.push(l);
      outgoing.get(l.from)!.push(l);
    }
    for (const [nid, ins] of incoming) {
      const outs = outgoing.get(nid) ?? [];
      const node = this.nodes.get(nid)!;
      for (const a of ins) {
        const ea = a.poly.at(a.poly.length);
        for (const b of outs) {
          const uturn = b.edge.id === a.edge.id;
          if (uturn && node.degree > 1) continue;
          const sb = b.poly.at(0);
          const cross = ea.tx * sb.tz - ea.tz * sb.tx;
          const dot = ea.tx * sb.tx + ea.tz * sb.tz;
          const ang = Math.atan2(cross, dot);
          const turn: Connector['turn'] = uturn ? 'U' : Math.abs(ang) < 0.6 ? 'S' : ang > 0 ? 'R' : 'L';
          // selección de carril: derecha↔derecha, izquierda↔izquierda, recto conserva índice
          if (turn === 'R' && (a.idx !== 0 || b.idx !== 0)) continue;
          if (turn === 'L' && (a.idx !== a.lanes - 1 || b.idx !== b.lanes - 1)) continue;
          if (turn === 'S' && Math.min(a.idx, b.lanes - 1) !== b.idx) continue;
          if (turn === 'U' && (a.idx !== a.lanes - 1 || b.idx !== b.lanes - 1)) continue;
          // Bézier cuadrática: control en el cruce de las tangentes (o en el punto medio)
          const p0 = [ea.x, ea.z], p2 = [sb.x, sb.z];
          let c = [(p0[0] + p2[0]) / 2, (p0[1] + p2[1]) / 2];
          const den = ea.tx * sb.tz - ea.tz * sb.tx;
          if (Math.abs(den) > 0.15) {
            const t = ((p2[0] - p0[0]) * sb.tz - (p2[1] - p0[1]) * sb.tx) / den;
            if (t > 0 && t < 40) c = [p0[0] + ea.tx * t, p0[1] + ea.tz * t];
          } else if (turn === 'U') {
            c = [p0[0] + ea.tx * 4, p0[1] + ea.tz * 4];
          }
          const pts: [number, number][] = [];
          for (let k = 0; k <= 8; k++) {
            const t = k / 8, u = 1 - t;
            pts.push([u * u * p0[0] + 2 * u * t * c[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p2[1]]);
          }
          const conn: Connector = { kind: 'conn', id: this.connectors.length, node: nid, from: a, to: b, poly: new Poly(pts), turn };
          this.connectors.push(conn);
          a.outs.push(conn);
        }
      }
    }
  }
}
