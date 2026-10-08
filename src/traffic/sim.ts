/**
 * Simulación de tráfico (pura). Modelo de seguimiento IDM (Treiber et al.), semáforos de dos fases por cruce,
 * prelación por ocupación en cruces sin semáforo, y obstáculos externos (jugador, moto) ante los que se frena y pita.
 */
import { LaneGraph, type Connector, type Lane, type Piece, type RoadGraph } from './graph';

export type VehicleType = 'carro' | 'taxi' | 'moto' | 'buseta' | 'camioneta';
export const DIMS: Record<VehicleType, { length: number; width: number; v0: number }> = {
  carro: { length: 4.3, width: 1.75, v0: 1.0 },
  taxi: { length: 3.6, width: 1.6, v0: 1.05 },
  moto: { length: 2.0, width: 0.75, v0: 1.1 },
  buseta: { length: 7.5, width: 2.3, v0: 0.85 },
  camioneta: { length: 5.2, width: 1.9, v0: 0.95 },
};

export interface TrafficCfg {
  vehicles: number; mix: Record<string, number>; idm: { a: number; b: number; s0: number; T: number; delta: number };
  lookahead: number; respawnMinDistance: number; junctionWaitTimeout: number; honkAfter: number;
  /** Burbuja de tráfico alrededor del jugador: radio donde circulan y distancia a la que reaparecen. */
  bubbleRadius?: number; despawnDistance?: number;
}
export interface SignalCfg { green: number; yellow: number; allRed: number }

export interface Vehicle {
  id: number; type: VehicleType; length: number; width: number; v: number; v0f: number;
  path: Piece[]; s: number;
  x: number; z: number; tx: number; tz: number;
  px: number; pz: number; ptx: number; ptz: number;   // estado anterior (interpolación)
  wait: number; blockedByPlayer: number; lastHonk: number; braking: boolean;
  /** Conector del cruce reservado (el vehículo ya tiene paso) hasta que su cola salga del cruce. */
  res: Connector | null;
}
export interface Obstacle { x: number; z: number; r: number; isPlayer: boolean }

export class Controller {
  lanes: { lane: Lane; phase: 0 | 1 }[] = [];
  constructor(public x: number, public z: number, public offset: number, public source: string) {}
}

/** Generador determinista (mulberry32) para que las pruebas sean reproducibles. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class TrafficSim {
  readonly lg: LaneGraph;
  vehicles: Vehicle[] = [];
  controllers: Controller[] = [];
  time = 0;
  honks: Vehicle[] = [];
  private rand: () => number;
  private occupancy = new Map<number, Set<number>>();   // nodo → vehículos con reserva en ese cruce
  /** Conflictos entre trayectorias de un mismo cruce (se cruzan o confluyen). */
  private conflicts = new Map<number, Set<number>>();
  /** Por carril: menor s ocupada en este paso (espacio libre a la salida del cruce). */
  private laneTail = new Map<number, number>();
  private signalOf = new Map<number, Controller>();

  constructor(g: RoadGraph, readonly cfg: TrafficCfg, readonly sig: SignalCfg, seed = 7, readonly areaHalf = 400,
    center: { x: number; z: number } | null = null) {
    this.lg = new LaneGraph(g);
    this.rand = rng(seed);
    // controladores: semáforos a < 15 m comparten ciclo (cruces dobles)
    for (const s of g.signals) {
      let c = this.controllers.find((k) => Math.hypot(k.x - s.x, k.z - s.z) < 15);
      if (!c) { c = new Controller(s.x, s.z, this.rand() * this.cycle, s.source); this.controllers.push(c); }
      this.signalOf.set(s.node, c);
    }
    for (const c of this.controllers) {
      const approaches = this.lg.lanes.filter((l) => {
        const k = this.signalOf.get(l.to);
        return k === c && this.signalOf.get(l.from) !== c;   // aristas internas del cruce doble no se controlan
      });
      let ref: { tx: number; tz: number } | null = null;
      for (const l of approaches) {
        const t = l.poly.at(l.poly.length);
        if (!ref) ref = { tx: t.tx, tz: t.tz };
        const phase: 0 | 1 = Math.abs(t.tx * ref.tx + t.tz * ref.tz) > 0.7 ? 0 : 1;
        l.signal = { controller: this.controllers.indexOf(c), phase };
        c.lanes.push({ lane: l, phase });
      }
    }
    // conflictos: dos conectores del mismo cruce que no salen del mismo carril y cuyas trayectorias pasan a < 2,2 m
    const byNode = new Map<number, Connector[]>();
    for (const c of this.lg.connectors) {
      if ((this.lg.nodes.get(c.node)?.radius ?? 0) <= 0) continue;
      if (!byNode.has(c.node)) byNode.set(c.node, []);
      byNode.get(c.node)!.push(c);
    }
    const samples = (c: Connector) => {
      const out: [number, number][] = [];
      for (let d = 0; d <= c.poly.length; d += 0.75) { const q = c.poly.at(d); out.push([q.x, q.z]); }
      return out;
    };
    for (const list of byNode.values()) {
      const sm = list.map(samples);
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          if (list[i].from === list[j].from) continue;
          let hit = list[i].to === list[j].to;
          for (const [ax, az] of sm[i]) { if (hit) break; for (const [bx, bz] of sm[j]) if (Math.hypot(ax - bx, az - bz) < 2.2) { hit = true; break; } }
          if (!hit) continue;
          for (const [a, b] of [[list[i], list[j]], [list[j], list[i]]]) {
            if (!this.conflicts.has(a.id)) this.conflicts.set(a.id, new Set());
            this.conflicts.get(a.id)!.add(b.id);
          }
        }
      }
    }
    const mix = Object.entries(cfg.mix);
    for (let i = 0; i < cfg.vehicles; i++) {
      let r = this.rand(), type = mix[0][0] as VehicleType;
      for (const [k, w] of mix) { if (r < w) { type = k as VehicleType; break; } r -= w; }
      const v = this.newVehicle(this.vehicles.length, type);
      if (this.place(v, center, 10)) this.vehicles.push(v);
    }
  }

  get cycle() { return 2 * (this.sig.green + this.sig.yellow + this.sig.allRed); }

  /** Estado del semáforo para una fase: 'G' | 'Y' | 'R'. */
  light(c: Controller, phase: 0 | 1): 'G' | 'Y' | 'R' {
    const half = this.sig.green + this.sig.yellow + this.sig.allRed;
    const t = (this.time + c.offset) % this.cycle;
    const local = phase === 0 ? t : (t + half) % this.cycle;
    if (local < this.sig.green) return 'G';
    if (local < this.sig.green + this.sig.yellow) return 'Y';
    return 'R';
  }

  private newVehicle(id: number, type: VehicleType): Vehicle {
    const d = DIMS[type];
    return { id, type, length: d.length, width: d.width, v: 0, v0f: d.v0 * (0.9 + this.rand() * 0.2), path: [], s: 0,
      x: 0, z: 0, tx: 0, tz: 1, px: 0, pz: 0, ptx: 0, ptz: 1, wait: 0, blockedByPlayer: 0, lastHonk: -99, braking: false,
      res: null };
  }

  /**
   * Coloca el vehículo en un carril libre. Con `center` (el jugador), dentro de la burbuja de tráfico y a más de
   * `minD` m de él (para que no aparezca a la vista); sin centro, en cualquier parte del área.
   */
  private place(v: Vehicle, center: { x: number; z: number } | null, minD = this.cfg.respawnMinDistance) {
    const lanes = this.lg.lanes;
    const R = this.cfg.bubbleRadius ?? Infinity;
    for (let tries = 0; tries < 120; tries++) {
      const l = lanes[Math.floor(this.rand() * lanes.length)];
      if (l.poly.length < 12) continue;
      const s = 4 + this.rand() * (l.poly.length - 8);
      const p = l.poly.at(s);
      if (Math.abs(p.x) > this.areaHalf || Math.abs(p.z) > this.areaHalf) continue;
      if (center) {
        const d = Math.hypot(p.x - center.x, p.z - center.z);
        if (d < minD || d > R) continue;
      }
      if (this.vehicles.some((o) => o !== v && Math.hypot(o.x - p.x, o.z - p.z) < 14)) continue;
      v.path = [l];
      v.s = s;
      v.v = l.speed * 0.5;
      v.wait = 0;
      this.extend(v);
      this.updatePose(v);
      v.px = v.x; v.pz = v.z; v.ptx = v.tx; v.ptz = v.tz;
      return true;
    }
    return false;
  }

  /** Asegura que el camino cubra la distancia de anticipación eligiendo giros al azar. */
  private extend(v: Vehicle) {
    let ahead = v.path[0].poly.length - v.s;
    for (let i = 1; i < v.path.length; i++) ahead += v.path[i].poly.length;
    while (ahead < this.cfg.lookahead + 10) {
      const last = v.path[v.path.length - 1];
      let next: Piece | undefined;
      if (last.kind === 'lane') {
        if (!last.outs.length) break;
        // preferencia por seguir recto; las U sólo en callejones sin salida
        const opts = last.outs;
        const w = opts.map((c) => (c.turn === 'S' ? 3 : c.turn === 'U' ? 0.2 : 1));
        let r = this.rand() * w.reduce((a, b) => a + b, 0);
        next = opts[opts.length - 1];
        for (let k = 0; k < opts.length; k++) { if (r < w[k]) { next = opts[k]; break; } r -= w[k]; }
      } else {
        next = last.to;
      }
      v.path.push(next);
      ahead += next.poly.length;
    }
  }

  private updatePose(v: Vehicle) {
    const p = v.path[0].poly.at(v.s);
    v.x = p.x; v.z = p.z; v.tx = p.tx; v.tz = p.tz;
  }

  /** Distancia libre hasta el obstáculo más cercano en el camino (otros vehículos, jugador, semáforo, cruce ocupado). */
  private gapAhead(v: Vehicle, grid: Map<string, Vehicle[]>, obstacles: Obstacle[]) {
    let best = Infinity, leaderV = 0, player = false;
    const look = this.cfg.lookahead;
    // muestras del camino futuro cada 1,5 m (distancia d medida desde el vehículo)
    const samples: { s: number; x: number; z: number }[] = [];
    let startD = -v.s;                       // distancia del vehículo al inicio de la pieza
    for (const piece of v.path) {
      const L = piece.poly.length;
      for (let s = Math.max(0, -startD + 0.5); s <= L; s += 1.5) {
        const d = startD + s;
        if (d > look) break;
        const p = piece.poly.at(s);
        samples.push({ s: d, x: p.x, z: p.z });
      }
      startD += L;
      if (startD > look) break;
    }
    const check = (ox: number, oz: number, halfLen: number, halfW: number, ov: number, isPlayer: boolean) => {
      for (const sm of samples) {
        if (sm.s > best) break;
        const d = Math.hypot(ox - sm.x, oz - sm.z);
        if (d < v.width / 2 + halfW + 0.25) {
          const gap = sm.s - v.length / 2 - halfLen;
          if (gap < best) { best = gap; leaderV = ov; player = isPlayer; }
          break;
        }
      }
    };
    const cx = Math.floor(v.x / 20), cz = Math.floor(v.z / 20);
    for (let i = -2; i <= 2; i++) {
      for (let j = -2; j <= 2; j++) {
        for (const o of grid.get(`${cx + i},${cz + j}`) ?? []) {
          if (o === v) continue;
          // detrás de mí: ignorar
          if ((o.x - v.x) * v.tx + (o.z - v.z) * v.tz < 0) continue;
          check(o.x, o.z, o.length / 2, o.width / 2, Math.max(0, o.v * (o.tx * v.tx + o.tz * v.tz)), false);
        }
      }
    }
    for (const ob of obstacles) {
      if ((ob.x - v.x) * v.tx + (ob.z - v.z) * v.tz < 0) continue;
      check(ob.x, ob.z, ob.r, ob.r, 0, ob.isPlayer);
    }
    // semáforos y cruces sin semáforo: parada virtual al final del carril
    let dist = v.path[0].poly.length - v.s;
    for (let i = 0; i < v.path.length; i++) {
      const piece = v.path[i];
      if (i > 0) dist += piece.poly.length;
      if (piece.kind !== 'lane') continue;
      if (dist > look) break;
      const stopGap = dist - v.length / 2 - 0.5;
      const next = v.path[i + 1] as Connector | undefined;
      const atJunction = !!next && next.kind === 'conn' && (this.lg.nodes.get(next.node)?.radius ?? 0) > 0;
      if (!atJunction && !piece.signal) break;
      if (next && v.res === next) break;                         // ya tiene paso reservado
      let go = true;
      if (piece.signal) {
        const st = this.light(this.controllers[piece.signal.controller], piece.signal.phase);
        const canStop = stopGap > (v.v * v.v) / (2 * this.cfg.idm.b) - 1;
        if (st === 'R' || (st === 'Y' && canStop)) go = false;
      }
      if (go && atJunction && next) {
        // ningún ocupante con trayectoria en conflicto, y espacio a la salida ("no bloquear el cruce")
        const conf = this.conflicts.get(next.id);
        for (const id of this.occupancy.get(next.node) ?? []) {
          const o = this.vehicles[id];
          if (o && o !== v && o.res && conf?.has(o.res.id)) { go = false; break; }
        }
        const tail = this.laneTail.get(next.to.id) ?? Infinity;
        if (tail < v.length + this.cfg.idm.s0 + 1) go = false;
        // reserva atómica cuando ya está cerca de la línea de pare
        const commit = (v.v * v.v) / (2 * this.cfg.idm.b) + 3;
        if (go && stopGap < commit) {
          v.res = next;
          if (!this.occupancy.has(next.node)) this.occupancy.set(next.node, new Set());
          this.occupancy.get(next.node)!.add(v.id);
        }
        if (go && v.res !== next && stopGap < commit + 6) go = stopGap >= commit;   // aún no puede reservar
      }
      if (!go && stopGap < best && stopGap > -1.5) { best = Math.max(0.01, stopGap); leaderV = 0; player = false; }
      break;   // sólo el próximo final de carril
    }
    return { gap: best, leaderV, player };
  }

  private release(v: Vehicle) {
    if (v.res) this.occupancy.get(v.res.node)?.delete(v.id);
    v.res = null;
  }

  step(dt: number, obstacles: Obstacle[] = [], playerPos: { x: number; z: number } | null = null) {
    this.time += dt;
    this.honks.length = 0;
    const grid = new Map<string, Vehicle[]>();
    for (const v of this.vehicles) {
      const k = `${Math.floor(v.x / 20)},${Math.floor(v.z / 20)}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k)!.push(v);
    }
    this.laneTail.clear();
    for (const v of this.vehicles) {
      const p0 = v.path[0];
      if (p0?.kind === 'lane') {
        const tailS = v.s - v.length / 2;
        if (tailS < (this.laneTail.get(p0.id) ?? Infinity)) this.laneTail.set(p0.id, tailS);
      }
    }
    const { a, b, s0, T, delta } = this.cfg.idm;
    for (const v of this.vehicles) {
      const lane = v.path[0].kind === 'lane' ? v.path[0] : (v.path[0] as Connector).to;
      const v0 = Math.max(2, lane.speed * v.v0f * (v.path[0].kind === 'conn' ? 0.55 : 1));
      const { gap, leaderV, player } = this.gapAhead(v, grid, obstacles);
      let acc = a * (1 - Math.pow(v.v / v0, delta));
      if (gap < Infinity) {
        const sStar = s0 + Math.max(0, v.v * T + (v.v * (v.v - leaderV)) / (2 * Math.sqrt(a * b)));
        acc -= a * Math.pow(sStar / Math.max(gap, 0.1), 2);
      }
      acc = Math.max(-9, acc);
      v.braking = acc < -1;
      v.v = Math.max(0, v.v + acc * dt);
      if (v.v < 0.3) v.wait += dt; else v.wait = 0;
      // pito si el jugador le cierra el paso
      if (player && v.v < 0.5) {
        v.blockedByPlayer += dt;
        if (v.blockedByPlayer > this.cfg.honkAfter && this.time - v.lastHonk > 4) { this.honks.push(v); v.lastHonk = this.time; }
      } else v.blockedByPlayer = 0;

      v.px = v.x; v.pz = v.z; v.ptx = v.tx; v.ptz = v.tz;
      v.s += v.v * dt;
      while (v.path.length && v.s > v.path[0].poly.length) {
        const done = v.path.shift()!;
        v.s -= done.poly.length;
        if (!v.path.length) break;
      }
      // la reserva se libera cuando la cola del vehículo ya salió del cruce
      if (v.res && v.path[0] === v.res.to && v.s > v.length + 1) this.release(v);
      // fuera de la burbuja de tráfico → reaparece cerca del jugador (fuera de su vista inmediata)
      if (playerPos && this.cfg.despawnDistance && Math.hypot(v.x - playerPos.x, v.z - playerPos.z) > this.cfg.despawnDistance) {
        this.release(v);
        this.place(v, playerPos);
        continue;
      }
      // salida del área o callejón sin continuación → reaparece en otro lugar
      const node = v.path.length ? this.lg.nodes.get(v.path[0].kind === 'lane' ? (v.path[0] as Lane).to : (v.path[0] as Connector).node) : null;
      if (!v.path.length || (v.path.length === 1 && v.path[0].kind === 'lane' && !(v.path[0] as Lane).outs.length) || (node?.exit && v.path[0].kind === 'lane' && v.path[0].poly.length - v.s < 2)) {
        this.release(v);
        if (!this.place(v, playerPos)) { v.path = [this.lg.lanes[0]]; v.s = 0; }
        continue;
      }
      this.extend(v);
      this.updatePose(v);
    }
  }
}
