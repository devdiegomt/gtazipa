/**
 * Simulación de tráfico (pura). Modelo de seguimiento IDM (Treiber et al.), semáforos de dos fases por cruce,
 * prelación por ocupación en cruces sin semáforo, y obstáculos externos (jugador, moto) ante los que se frena y pita.
 * Los vehículos aparecen y desaparecen sólo donde el jugador no los ve (callback `visible` de step()).
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
  /** Más allá de esta distancia se reciclan aunque estén a la vista (la niebla ya los oculta). */
  despawnHardDistance?: number;
  /** Intentos de colocación por paso entre todos los vehículos inactivos (acota el costo de reaparecer). */
  spawnTriesPerStep?: number;
  /** Último recurso: un vehículo interbloqueado (o tras un obstáculo que no es el jugador) más de estos s se recicla si no se ve. */
  stuckRecycle?: number;
}
export interface SignalCfg { green: number; yellow: number; allRed: number }

/** Restricción que frena al vehículo: otro vehículo, jugador, obstáculo, semáforo, cruce ocupado, salida llena, fin del camino. */
export type WaitReason = 'none' | 'leader' | 'player' | 'obstacle' | 'signal' | 'junction' | 'exit' | 'end';
/** ¿El jugador ve este punto del suelo? (main.ts: frustum + distancia + rayo de oclusión). */
export type Visibility = (x: number, z: number) => boolean;

export interface Vehicle {
  id: number; type: VehicleType; length: number; width: number; v: number; v0f: number;
  path: Piece[]; s: number;
  x: number; z: number; tx: number; tz: number;
  px: number; pz: number; ptx: number; ptz: number;   // estado anterior (interpolación)
  wait: number; blockedByPlayer: number; lastHonk: number; braking: boolean;
  /** Conector del cruce reservado (el vehículo ya tiene paso) hasta que su cola salga del cruce. */
  res: Connector | null;
  /** false = estacionado fuera del mundo esperando un punto de aparición oculto: no se dibuja ni interactúa. */
  active: boolean;
  /** Motivo de la restricción más cercana y vehículo que la causa (-1 si no es un vehículo). */
  why: WaitReason; blocker: number;
  /** Segundos detenido esperando sólo el cruce (conflicto de reserva o salida llena). */
  jam: number;
  /** Turno pedido tras junctionWaitTimeout s: nadie más reserva un conector en conflicto hasta que este pase. */
  claim: Connector | null;
  /** Prelación concedida para romper un interbloqueo: ignora reservas ajenas y salida llena en el próximo cruce. */
  force: boolean;
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

const HIDDEN: Visibility = () => false;
/** Los inactivos se guardan lejos del mapa (separados: main.ts mueve allí sus cuerpos cinemáticos). */
const PARK = 10000;
/** Un vehículo visible que sale del mapa se detiene a esta distancia del borde (aún sobre el terreno) hasta dejar de verse. */
const EXIT_STOP = 20;
/** Raíz de una cadena de espera (unjam): se resuelve sola, ciclo (interbloqueo) u obstáculo que no es el jugador. */
const ROOT_FREE = 1, ROOT_CYCLE = 2, ROOT_OBSTACLE = 3;

export class TrafficSim {
  readonly lg: LaneGraph;
  vehicles: Vehicle[] = [];
  controllers: Controller[] = [];
  time = 0;
  /**
   * Pitos acumulados desde el último drainHonks(); step() ya no los borra. El ciclo de render debe usar drainHonks()
   * (no iterar este arreglo) para que cada pito suene una sola vez sin importar los FPS.
   */
  honks: Vehicle[] = [];
  private rand: () => number;
  private occupancy = new Map<number, Set<number>>();   // nodo → vehículos con reserva en ese cruce
  private claims = new Map<number, Set<number>>();      // nodo → vehículos que pidieron turno en ese cruce
  /** Conflictos entre trayectorias de un mismo cruce (se cruzan o confluyen). */
  private conflicts = new Map<number, Set<number>>();
  /** Por carril: menor s ocupada en este paso (espacio libre a la salida del cruce) y quién la ocupa. */
  private laneTail = new Map<number, number>();
  private laneTailId = new Map<number, number>();
  private signalOf = new Map<number, Controller>();
  private spent = 0;        // intentos de colocación gastados en este paso
  private cursor = 0;       // reparto equitativo de los intentos entre inactivos
  private mark: Int8Array;  // estado del recorrido de cadenas de espera

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
    // todos los vehículos existen desde el inicio (id === índice); el que no cabe cerca del centro va a cualquier
    // parte del área (step() lo recicla si queda lejos) y, si tampoco, espera inactivo
    const mix = Object.entries(cfg.mix);
    for (let i = 0; i < cfg.vehicles; i++) {
      let r = this.rand(), type = mix[0][0] as VehicleType;
      for (const [k, w] of mix) { if (r < w) { type = k as VehicleType; break; } r -= w; }
      const v = this.newVehicle(this.vehicles.length, type);
      this.vehicles.push(v);
      if (!this.place(v, center, 10) && !(center && this.place(v, null, 0))) this.park(v);
    }
    this.mark = new Int8Array(this.vehicles.length);
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

  /** Devuelve los pitos acumulados (cada uno una sola vez) y vacía `honks`. */
  drainHonks(): Vehicle[] {
    return this.honks.splice(0);
  }

  private newVehicle(id: number, type: VehicleType): Vehicle {
    const d = DIMS[type];
    return { id, type, length: d.length, width: d.width, v: 0, v0f: d.v0 * (0.9 + this.rand() * 0.2), path: [], s: 0,
      x: 0, z: 0, tx: 0, tz: 1, px: 0, pz: 0, ptx: 0, ptz: 1, wait: 0, blockedByPlayer: 0, lastHonk: -99, braking: false,
      res: null, active: false, why: 'none', blocker: -1, jam: 0, claim: null, force: false };
  }

  /**
   * Coloca el vehículo en un carril libre y lo activa. Con `center` (el jugador), dentro de la burbuja de tráfico y a
   * más de `minD` m de él; sin centro, en cualquier parte del área. Nunca en un punto que el jugador vea.
   */
  private place(v: Vehicle, center: { x: number; z: number } | null, minD = this.cfg.respawnMinDistance,
    visible: Visibility = HIDDEN, tries = 120) {
    const lanes = this.lg.lanes;
    const R = this.cfg.bubbleRadius ?? Infinity;
    for (let k = 0; k < tries; k++) {
      this.spent++;
      const l = lanes[Math.floor(this.rand() * lanes.length)];
      if (l.poly.length < 12) continue;
      const s = 4 + this.rand() * (l.poly.length - 8);
      const p = l.poly.at(s);
      if (Math.abs(p.x) > this.areaHalf || Math.abs(p.z) > this.areaHalf) continue;
      if (center) {
        const d = Math.hypot(p.x - center.x, p.z - center.z);
        if (d < minD || d > R) continue;
      }
      if (this.vehicles.some((o) => o.active && o !== v && Math.hypot(o.x - p.x, o.z - p.z) < 14)) continue;
      if (visible(p.x, p.z)) continue;
      v.active = true;
      v.path = [l];
      v.s = s;
      v.v = l.speed * 0.5;
      v.wait = 0; v.jam = 0; v.blockedByPlayer = 0; v.braking = false; v.force = false; v.why = 'none'; v.blocker = -1;
      this.extend(v);
      this.updatePose(v);
      v.px = v.x; v.pz = v.z; v.ptx = v.tx; v.ptz = v.tz;
      return true;
    }
    return false;
  }

  /** Desactiva el vehículo (sin reserva, fuera del mundo) hasta que haya dónde reaparecer sin que se vea. */
  private park(v: Vehicle) {
    this.release(v);
    this.unclaim(v);
    v.active = false;
    v.v = 0; v.wait = 0; v.jam = 0; v.blockedByPlayer = 0; v.braking = false; v.force = false; v.why = 'none'; v.blocker = -1;
    v.x = v.px = PARK + v.id * 12; v.z = v.pz = PARK;
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

  /** Ya entró al último carril de un callejón sin salida, o llegó a su parada al final (si ese carril es muy corto). */
  private deadEnd(v: Vehicle) {
    const last = v.path[v.path.length - 1];
    if (last.kind !== 'lane' || last.outs.length) return false;
    let rem = -v.s;
    for (const p of v.path) rem += p.poly.length;
    return v.path.length === 1 || rem < v.length / 2 + this.cfg.idm.s0 + 2;   // IDM se detiene a s0 de la parada
  }

  private outside(x: number, z: number, m = 0) { return Math.abs(x) > this.areaHalf + m || Math.abs(z) > this.areaHalf + m; }

  /** Distancia libre hasta el obstáculo más cercano en el camino (otros vehículos, jugador, semáforo, cruce ocupado). */
  private gapAhead(v: Vehicle, grid: Map<string, Vehicle[]>, obstacles: Obstacle[]) {
    let best = Infinity, leaderV = 0, why: WaitReason = 'none', blk = -1;
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
    const check = (ox: number, oz: number, halfLen: number, halfW: number, ov: number, w: WaitReason, id: number) => {
      for (const sm of samples) {
        if (sm.s > best) break;
        const d = Math.hypot(ox - sm.x, oz - sm.z);
        if (d < v.width / 2 + halfW + 0.25) {
          const gap = sm.s - v.length / 2 - halfLen;
          if (gap < best) { best = gap; leaderV = ov; why = w; blk = id; }
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
          check(o.x, o.z, o.length / 2, o.width / 2, Math.max(0, o.v * (o.tx * v.tx + o.tz * v.tz)), 'leader', o.id);
        }
      }
    }
    for (const ob of obstacles) {
      if ((ob.x - v.x) * v.tx + (ob.z - v.z) * v.tz < 0) continue;
      check(ob.x, ob.z, ob.r, ob.r, 0, ob.isPlayer ? 'player' : 'obstacle', -1);
    }
    // fin del camino: callejón sin salida, o salida del mapa (sólo llega allí quien sigue a la vista)
    const stopAt = (d: number) => {
      const g = d - v.length / 2 - 0.5;
      if (g < best) { best = Math.max(0.01, g); leaderV = 0; why = 'end'; blk = -1; }
    };
    const last = v.path[v.path.length - 1];
    if (startD <= look && last.kind === 'lane' && !last.outs.length) stopAt(startD);
    for (const sm of samples) if (this.outside(sm.x, sm.z, EXIT_STOP)) { stopAt(sm.s); break; }
    // semáforos y cruces sin semáforo: parada virtual al final del carril (se mira al menos la distancia de frenado,
    // para no descubrir un amarillo cuando ya no hay cómo parar)
    const brake = (v.v * v.v) / (2 * this.cfg.idm.b);
    let dist = v.path[0].poly.length - v.s;
    for (let i = 0; i < v.path.length; i++) {
      const piece = v.path[i];
      if (i > 0) dist += piece.poly.length;
      if (piece.kind !== 'lane') continue;
      if (dist > Math.max(look, brake + 5)) break;
      const stopGap = dist - v.length / 2 - 0.5;
      const next = v.path[i + 1] as Connector | undefined;
      const atJunction = !!next && next.kind === 'conn' && (this.lg.nodes.get(next.node)?.radius ?? 0) > 0;
      if (!atJunction && !piece.signal) break;
      const reserved = !!next && v.res === next;
      let go = true, w: WaitReason = 'signal', id = -1;
      if (piece.signal) {
        const st = this.light(this.controllers[piece.signal.controller], piece.signal.phase);
        const canStop = stopGap > brake - 1;
        // con paso reservado sólo se detiene ante el rojo si aún puede (p. ej. lo frenó el de adelante)
        if (reserved ? st === 'R' && canStop : st === 'R' || (st === 'Y' && canStop)) go = false;
      }
      if (reserved) {
        if (go) break;                                           // ya tiene paso reservado
        this.release(v);
      }
      if (go && atJunction && next) {
        // ningún ocupante con trayectoria en conflicto, espacio a la salida ("no bloquear el cruce") y respeto del
        // turno pedido por quien lleva más esperando; con prelación (interbloqueo) sólo cuenta el choque físico,
        // que vigilan las muestras de arriba
        if (!v.force) {
          const conf = this.conflicts.get(next.id);
          for (const oid of this.occupancy.get(next.node) ?? []) {
            const o = this.vehicles[oid];
            if (o !== v && o.res && conf?.has(o.res.id)) { go = false; w = 'junction'; id = oid; break; }
          }
          const tail = this.laneTail.get(next.to.id) ?? Infinity;
          if (go && tail < v.length + this.cfg.idm.s0 + 1) { go = false; w = 'exit'; id = this.laneTailId.get(next.to.id)!; }
          if (go) {
            for (const oid of this.claims.get(next.node) ?? []) {
              const o = this.vehicles[oid];
              if (o !== v && o.claim && conf?.has(o.claim.id) && (o.jam > v.jam || (o.jam === v.jam && o.id < v.id))) {
                go = false; w = 'junction'; id = oid; break;
              }
            }
          }
          // tras junctionWaitTimeout s esperando el cruce pide turno (evita que un flujo continuo lo deje sin paso)
          if (!go && v.jam > this.cfg.junctionWaitTimeout) {
            v.claim = next;
            if (!this.claims.has(next.node)) this.claims.set(next.node, new Set());
            this.claims.get(next.node)!.add(v.id);
          }
        }
        // reserva atómica cuando ya está cerca de la línea de pare
        const commit = (v.v * v.v) / (2 * this.cfg.idm.b) + 3;
        if (go && stopGap < commit) {
          this.release(v);
          this.unclaim(v);
          v.res = next;
          v.force = false;
          if (!this.occupancy.has(next.node)) this.occupancy.set(next.node, new Set());
          this.occupancy.get(next.node)!.add(v.id);
        }
      }
      if (!go && stopGap < best && stopGap > -1.5) { best = Math.max(0.01, stopGap); leaderV = 0; why = w; blk = id; }
      break;   // sólo el próximo final de carril
    }
    return { gap: best, leaderV, why: why as WaitReason, blk };
  }

  private release(v: Vehicle) {
    if (v.res) this.occupancy.get(v.res.node)?.delete(v.id);
    v.res = null;
  }

  private unclaim(v: Vehicle) {
    if (v.claim) this.claims.get(v.claim.node)?.delete(v.id);
    v.claim = null;
  }

  /**
   * Avanza la simulación. `visible(x, z)` dice si el jugador ve ese punto del suelo; sin él, nada se considera visible.
   * Sólo se aparece en puntos no visibles; el que pasa de despawnDistance se recicla sólo si no se ve (o si pasa de
   * despawnHardDistance), y el resto sigue circulando.
   */
  step(dt: number, obstacles: Obstacle[] = [], playerPos: { x: number; z: number } | null = null, visible?: Visibility) {
    const vis = visible ?? HIDDEN;
    this.time += dt;
    const grid = new Map<string, Vehicle[]>();
    this.laneTail.clear();
    this.laneTailId.clear();
    for (const v of this.vehicles) {
      if (!v.active) continue;
      const k = `${Math.floor(v.x / 20)},${Math.floor(v.z / 20)}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k)!.push(v);
      const p0 = v.path[0];
      if (p0.kind === 'lane') {
        const tailS = v.s - v.length / 2;
        if (tailS < (this.laneTail.get(p0.id) ?? Infinity)) { this.laneTail.set(p0.id, tailS); this.laneTailId.set(p0.id, v.id); }
      }
    }
    const { a, b, s0, T, delta } = this.cfg.idm;
    const far = this.cfg.despawnDistance ?? Infinity, hard = this.cfg.despawnHardDistance ?? Infinity;
    let jammed = false;
    for (const v of this.vehicles) {
      if (!v.active) continue;
      const lane = v.path[0].kind === 'lane' ? v.path[0] : (v.path[0] as Connector).to;
      const v0 = Math.max(2, lane.speed * v.v0f * (v.path[0].kind === 'conn' ? 0.55 : 1));
      this.unclaim(v);   // gapAhead lo renueva si sigue esperando el mismo cruce
      const { gap, leaderV, why, blk } = this.gapAhead(v, grid, obstacles);
      v.why = why; v.blocker = blk; v.force = false;
      let acc = a * (1 - Math.pow(v.v / v0, delta));
      if (gap < Infinity) {
        const sStar = s0 + Math.max(0, v.v * T + (v.v * (v.v - leaderV)) / (2 * Math.sqrt(a * b)));
        acc -= a * Math.pow(sStar / Math.max(gap, 0.1), 2);
      }
      acc = Math.max(-9, acc);
      v.braking = acc < -1;
      v.v = Math.max(0, v.v + acc * dt);
      if (v.v < 0.3) {
        v.wait += dt;
        // sólo cuenta la espera por el cruce (no el rojo, ni el jugador, ni el de adelante)
        v.jam = why === 'junction' || why === 'exit' ? v.jam + dt : 0;
      } else { v.wait = 0; v.jam = 0; }
      // pito si el jugador le cierra el paso
      if (why === 'player' && v.v < 0.5) {
        v.blockedByPlayer += dt;
        if (v.blockedByPlayer > this.cfg.honkAfter && this.time - v.lastHonk > 4) {
          this.honks.push(v); v.lastHonk = this.time;
          if (this.honks.length > 64) this.honks.shift();   // nadie los consume: no crecer sin límite
        }
      } else v.blockedByPlayer = 0;

      v.px = v.x; v.pz = v.z; v.ptx = v.tx; v.ptz = v.tz;
      v.s += v.v * dt;
      // el camino nunca queda vacío: en la última pieza (callejón sin salida) se detiene en el extremo
      while (v.path.length > 1 && v.s > v.path[0].poly.length) v.s -= v.path.shift()!.poly.length;
      if (v.s > v.path[0].poly.length) { v.s = v.path[0].poly.length; v.v = 0; }
      // la reserva se libera cuando la cola del vehículo ya salió del cruce (o si el camino ya lo dejó atrás)
      if (v.res && (v.path[0] === v.res.to ? v.s > v.length + 1 : !v.path.includes(v.res))) this.release(v);
      this.extend(v);
      this.updatePose(v);
      const d = playerPos ? Math.hypot(v.x - playerPos.x, v.z - playerPos.z) : 0;
      // fuera de la burbuja de tráfico → se recicla, pero sólo donde no se ve (o tras la niebla)
      if (d > far && (d > hard || !vis(v.x, v.z))) { this.park(v); continue; }
      // salida del área o callejón sin continuación → se recicla si no se ve; a la vista sigue (o espera en el
      // extremo, ver gapAhead) hasta dejar de verse o quedar tras la niebla
      if ((this.deadEnd(v) || this.outside(v.x, v.z)) && (d > hard || !vis(v.x, v.z))) { this.park(v); continue; }
      if (v.jam > this.cfg.junctionWaitTimeout || v.wait > (this.cfg.stuckRecycle ?? Infinity)) jammed = true;
    }
    if (jammed) this.unjam(vis);
    this.spawn(playerPos, vis);
  }

  /**
   * Interbloqueos: sigue la cadena "quién espera a quién" desde cada vehículo atascado. Si cierra un ciclo (todos
   * detenidos), el miembro que más lleva esperando el cruce (empate: menor id) recibe prelación tras junctionWaitTimeout;
   * si el ciclo es sólo físico (nadie espera el cruce), o si la cadena acaba en un obstáculo que no es el jugador, tras
   * stuckRecycle s se reciclan los que no se ven.
   * Las cadenas que acaban en un semáforo, el jugador o un vehículo en marcha se resuelven solas.
   */
  private unjam(vis: Visibility) {
    const V = this.vehicles, mark = this.mark, chain: number[] = [];
    const timeout = this.cfg.junctionWaitTimeout, stuck = this.cfg.stuckRecycle ?? Infinity;
    const recycle: Vehicle[] = [];
    mark.fill(0);   // 0 sin visitar, -1 en la cadena actual, >0 raíz ya resuelta
    for (const v0 of V) {
      if (mark[v0.id] || !(v0.jam > timeout || v0.wait > stuck)) continue;
      chain.length = 0;
      let u = v0, root = ROOT_FREE;
      for (;;) {
        if (mark[u.id] > 0) { root = mark[u.id]; break; }
        if (mark[u.id] < 0) {
          root = ROOT_CYCLE;
          const cyc = chain.slice(chain.indexOf(u.id)).map((id) => V[id]);
          let pick: Vehicle | null = null;
          for (const c of cyc) {
            if ((c.why === 'junction' || c.why === 'exit') && (!pick || c.jam > pick.jam || (c.jam === pick.jam && c.id < pick.id))) pick = c;
          }
          if (pick) { if (pick.jam > timeout) pick.force = true; }
          else for (const c of cyc) if (c.wait > stuck) recycle.push(c);
          break;
        }
        mark[u.id] = -1; chain.push(u.id);
        if (!u.active || u.v >= 0.3) break;
        if (u.why === 'obstacle') { root = ROOT_OBSTACLE; break; }
        if ((u.why !== 'leader' && u.why !== 'junction' && u.why !== 'exit') || u.blocker < 0) break;
        u = V[u.blocker];
      }
      for (const id of chain) mark[id] = root;
      if (root === ROOT_OBSTACLE) for (const id of chain) if (V[id].wait > stuck) recycle.push(V[id]);
    }
    for (const v of recycle) if (v.active && !vis(v.x, v.z)) this.park(v);
  }

  /** Reaparición de inactivos en puntos ocultos, con un presupuesto fijo de intentos por paso. */
  private spawn(playerPos: { x: number; z: number } | null, vis: Visibility) {
    const n = this.vehicles.length, budget = this.cfg.spawnTriesPerStep ?? 80;
    this.spent = 0;
    for (let k = 0; k < n && this.spent < budget; k++) {
      const v = this.vehicles[(this.cursor + k) % n];
      if (v.active) continue;
      this.place(v, playerPos, this.cfg.respawnMinDistance, vis, Math.min(40, budget - this.spent));
      this.cursor = (v.id + 1) % n;
    }
  }
}
