/**
 * Simulación de peatones (pura: sin three ni Rapier). Burbuja alrededor del jugador como el tráfico: hasta `peatones`
 * personas que aparecen y desaparecen sólo donde el jugador no ve (callback `visible`), con más gente en la plaza, el
 * parque y las calles cerca del centro. Caminan por la red peatonal (nav.ts) hacia destinos, solos o en grupos de 2–3,
 * se sientan en las bancas de las materas, conversan en corrillos, esperan para cruzar (semáforo: rojo para los
 * vehículos de la vía cruzada con tiempo suficiente; sin semáforo: brecha entre vehículos), se apartan del jugador,
 * huyen de la moto o de un vehículo que se les viene encima y, si la moto los atropella, caen y luego salen corriendo.
 * Determinista para una semilla. step() no reserva memoria (arreglos y objetos reutilizados).
 */
import type { Ped, PedPose } from './types';
import { K_AREA, ZONE_PARK, ZONE_PLAZA, ZONE_STREET, type PedNav } from './nav';
import peatones from '../data/peatones.json';

export type PedSimCfg = typeof peatones.sim;
/** ¿El jugador ve este punto del suelo? (mismo callback que TrafficSim.step). */
export type Visibility = (x: number, z: number) => boolean;

/**
 * Peligro o estorbo que pasa step(): el jugador a pie ('player': espacio personal), la moto del jugador ('moto':
 * asusta y, a más de caida.velMin m/s, atropella) u otro vehículo ('vehicle': asusta y atropella). Velocidad en m/s.
 */
export interface PedHazard { x: number; z: number; vx: number; vz: number; r: number; kind: 'player' | 'moto' | 'vehicle' }
/** Obstáculo para TrafficSim.step (mismo formato que Obstacle de traffic/sim.ts). */
export interface PedObstacle { x: number; z: number; r: number; isPlayer: boolean }

/** Lo que se lee del tráfico (TrafficSim cumple esta interfaz): vehículos, controladores y estado del semáforo. */
export interface TrafficControllerLike {
  x: number; z: number;
  lanes: readonly { lane: { poly: { length: number; at(s: number): { x: number; z: number; tx: number; tz: number } } }; phase: 0 | 1 }[];
}
export interface TrafficLike {
  vehicles: readonly { active: boolean; x: number; z: number; tx: number; tz: number; v: number; length: number; width: number }[];
  controllers: readonly TrafficControllerLike[];
  light(c: TrafficControllerLike, phase: 0 | 1): 'G' | 'Y' | 'R';
}

/** Modos internos. */
const M_OFF = 0, M_WALK = 1, M_WAIT = 2, M_STAND = 3, M_SIT = 4, M_FALLEN = 5;
/** Los inactivos se guardan lejos del mapa. */
const PARK = -10000;
const HIDDEN: Visibility = () => false;
const TAU = Math.PI * 2;
/** √(x² + z²) sin Math.hypot (variádica: reserva memoria en V8). */
const hyp = (x: number, z: number) => Math.sqrt(x * x + z * z);

/** Generador determinista (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Agent extends Ped {
  mode: number;
  /** Id del líder si va acompañando a alguien; -1 si va solo o es el líder. */
  leader: number;
  /** Acompañantes (sólo el líder) y puesto en el grupo (0 = líder). */
  fol: number[]; slot: number;
  // ---- tramo actual: origen, dirección unitaria, largo, media franja lateral, arista (-1 = recta libre), nodos, cruce
  ax: number; az: number; dx: number; dz: number; len: number; wl: number;
  edge: number; from: number; to: number; cross: number;
  /** Avance sobre el tramo, lateral (+ = derecha de la marcha; en el líder, centro del grupo) y su objetivo. */
  s: number; lat: number; latT: number; latPref: number;
  // ---- tramo anterior (los acompañantes que van detrás lo usan)
  pax: number; paz: number; pdx: number; pdz: number; plen: number; pwl: number;
  /** Velocidad preferida y actual (m/s). */
  vPref: number; v: number;
  /** Atractor de destino (-1 = sin destino: pasea por su zona mientras wander > 0). */
  goal: number; prev: number; wander: number;
  /** Tiempo restante de la actividad (sentado, corrillo, quieto) o de la caída. */
  timer: number;
  seat: number; zoneNow: number;
  /** Punto y rumbo donde está quieto (corrillo, mirando, sentado). */
  hx: number; hz: number; hh: number;
  waitT: number; fleeT: number; fleeX: number; fleeZ: number;
  blockT: number; ghostT: number;
  /** Superficie en caché (se recalcula al moverse). */
  lastYx: number; lastYz: number;
}

export class PedSim {
  readonly peds: Ped[];
  readonly cfg: PedSimCfg;
  time = 0;
  /** Atropellos desde el último drainFalls() (para sonido): ids de los peatones que cayeron. */
  falls: number[] = [];
  private A: Agent[];
  private rand: () => number;
  private vis: Visibility = HIDDEN;
  private player: { x: number; z: number } | null = null;
  private steps = 0;
  private cursor = 0;
  // ---- rejilla espacial de peatones (hash de celdas de 2 m)
  private head = new Int32Array(2048).fill(-1);
  private next: Int32Array;
  // ---- semáforos: controlador y fase de la vía cruzada por cruce, y medida del rojo
  private crossCtrl: Int32Array; private crossPhase: Int8Array;
  private sigState: Int8Array; private redStart: Float64Array; private redLen: Float64Array;
  // ---- aparición ponderada por celdas de 32 m
  private cellStart: Int32Array; private cellNodes: Int32Array; private cellCum: Float64Array; private cellW: Float64Array;
  private cellX: Float64Array; private cellZ: Float64Array; private cellN: number; private cellDim: number;
  private candCell: Int32Array; private candCum: Float64Array; private nCand = 0; private candTotal = 0;
  private seatOwner: Int32Array;
  // ---- obstáculos para el tráfico (reutilizados)
  private obsPool: PedObstacle[];
  private obs: PedObstacle[] = [];
  private zoneCount = new Int32Array(3);

  /**
   * `traffic` (opcional): el TrafficSim del juego, para semáforos, brechas y vehículos que se vienen encima. `center`:
   * dónde está el jugador al empezar (todos se colocan alrededor sin mirar la visibilidad, como el tráfico).
   */
  constructor(readonly nav: PedNav, readonly traffic: TrafficLike | null = null, cfg: PedSimCfg = peatones.sim, seed = 17,
    center: { x: number; z: number } | null = null) {
    this.cfg = cfg;
    this.rand = rng(seed);
    const N = cfg.peatones;
    this.next = new Int32Array(N);
    this.A = [];
    for (let i = 0; i < N; i++) this.A.push(this.newAgent(i));
    this.peds = this.A;
    this.seatOwner = new Int32Array(nav.seats.length).fill(-1);
    this.obsPool = this.A.map(() => ({ x: 0, z: 0, r: 0.4, isPlayer: false }));
    // ---- cruces semaforizados: controlador más cercano y fase de los carriles de la vía cruzada
    const nc = nav.crossings.length;
    this.crossCtrl = new Int32Array(nc).fill(-1);
    this.crossPhase = new Int8Array(nc);
    const ctrls = traffic?.controllers ?? [];
    const R = peatones.nav.cruce.radioSemaforo;
    nav.crossings.forEach((c, i) => {
      if (!c.signalized) return;
      let best = -1, bd = R;
      ctrls.forEach((k, j) => { const d = hyp(k.x - c.cx, k.z - c.cz); if (d < bd) { bd = d; best = j; } });
      if (best < 0) return;
      // fase de los carriles de acceso paralelos a la vía cruzada (el más cercano); si no hay, la contraria a los perpendiculares
      let par = -1, perp = -1, dp = Infinity, dq = Infinity;
      for (const { lane, phase } of ctrls[best].lanes) {
        const t = lane.poly.at(lane.poly.length), d = hyp(t.x - c.cx, t.z - c.cz);
        if (Math.abs(t.tx * c.dx + t.tz * c.dz) > 0.7) { if (d < dp) { dp = d; par = phase; } } else if (d < dq) { dq = d; perp = phase; }
      }
      const ph = par >= 0 ? par : perp >= 0 ? 1 - perp : -1;
      if (ph < 0) return;
      this.crossCtrl[i] = best; this.crossPhase[i] = ph;
    });
    this.sigState = new Int8Array(ctrls.length * 2).fill(-1);
    this.redStart = new Float64Array(ctrls.length * 2).fill(NaN);
    this.redLen = new Float64Array(ctrls.length * 2).fill(cfg.semaforo.rojoEstimado);
    // ---- celdas de aparición (nodos de calle con peso; las componentes diminutas pesan menos)
    const C = 32, H = 480;
    this.cellDim = Math.ceil((2 * H) / C);
    this.cellN = this.cellDim * this.cellDim;
    const { comp } = nav;
    const csize = new Int32Array(nav.n);
    for (let i = 0; i < nav.n; i++) csize[comp[i]]++;
    const w = (i: number) => nav.weight[i] * (csize[comp[i]] < 30 ? 0.3 : 1);
    const count = new Int32Array(this.cellN + 1);
    const cellOf = (i: number) => Math.min(this.cellDim - 1, Math.max(0, Math.floor((nav.x[i] + H) / C))) +
      this.cellDim * Math.min(this.cellDim - 1, Math.max(0, Math.floor((nav.z[i] + H) / C)));
    for (let i = 0; i < nav.n; i++) if (w(i) > 0) count[cellOf(i) + 1]++;
    for (let c = 0; c < this.cellN; c++) count[c + 1] += count[c];
    this.cellStart = count.slice();
    const fill = count.slice();
    this.cellNodes = new Int32Array(count[this.cellN]);
    this.cellCum = new Float64Array(count[this.cellN]);
    this.cellW = new Float64Array(this.cellN);
    for (let i = 0; i < nav.n; i++) {
      if (w(i) <= 0) continue;
      const c = cellOf(i);
      this.cellW[c] += w(i);
      this.cellCum[fill[c]] = this.cellW[c];
      this.cellNodes[fill[c]++] = i;
    }
    this.cellX = new Float64Array(this.cellN); this.cellZ = new Float64Array(this.cellN);
    for (let c = 0; c < this.cellN; c++) { this.cellX[c] = -H + (c % this.cellDim + 0.5) * C; this.cellZ[c] = -H + (Math.floor(c / this.cellDim) + 0.5) * C; }
    this.candCell = new Int32Array(this.cellN); this.candCum = new Float64Array(this.cellN);
    // ---- población inicial alrededor del centro (sin mirar la visibilidad)
    this.player = center;
    this.gatherCells();
    for (let k = 0; k < N * 6 && this.inactive() > 0; k++) this.spawnOne(HIDDEN);
  }

  private newAgent(id: number): Agent {
    return { id, active: false, x: PARK, z: PARK, y: 0, heading: 0, px: PARK, py: 0, pz: PARK, pheading: 0, speed: 0, phase: 0,
      pose: 'idle', poseTime: 0, seatH: 0, look: 0, height: 1,
      mode: M_OFF, leader: -1, fol: [], slot: 0,
      ax: 0, az: 0, dx: 1, dz: 0, len: 0, wl: 0, edge: -1, from: -1, to: -1, cross: -1, s: 0, lat: 0, latT: 0, latPref: 0,
      pax: 0, paz: 0, pdx: 1, pdz: 0, plen: 0, pwl: 0, vPref: 1.3, v: 0, goal: -1, prev: -1, wander: 0, timer: 0, seat: -1,
      zoneNow: 0, hx: 0, hz: 0, hh: 0, waitT: 0, fleeT: 0, fleeX: 0, fleeZ: 0, blockT: 0, ghostT: 0, lastYx: NaN, lastYz: NaN };
  }

  /** Atropellos acumulados (cada uno una vez) y vacía la lista. */
  drainFalls(): number[] { return this.falls.splice(0); }

  /** Cruce que está recorriendo (o esperando) el peatón; -1 si ninguno. Para pruebas y depuración. */
  crossingOf(id: number) { const a = this.A[id]; return a.active && (a.mode === M_WALK || a.mode === M_WAIT || a.mode === M_FALLEN) ? a.cross : -1; }
  /** ¿Está esperando para cruzar? */
  waiting(id: number) { return this.A[id].mode === M_WAIT; }
  /** Controlador y fase de semáforo resueltos para un cruce (-1 si se cruza por brecha). */
  signalOf(crossing: number) { return { controller: this.crossCtrl[crossing], phase: this.crossPhase[crossing] as 0 | 1 }; }

  /**
   * Peatones sobre la calzada (en un cruce, también caídos) como obstáculos para TrafficSim.step: el arreglo y sus
   * objetos se reutilizan (no guardar la referencia entre pasos).
   */
  obstaclesForTraffic(): readonly PedObstacle[] { return this.obs; }

  /** Diagnóstico: activos, en la plaza, en el parque, sentados, esperando para cruzar, cruzando. */
  stats() {
    let active = 0, sit = 0, wait = 0, cross = 0;
    for (const a of this.A) {
      if (!a.active) continue;
      active++;
      if (a.mode === M_SIT) sit++;
      if (a.mode === M_WAIT) wait++;
      if (a.mode === M_WALK && a.cross >= 0) cross++;
    }
    return { active, plaza: this.zoneCount[ZONE_PLAZA], park: this.zoneCount[ZONE_PARK], sit, wait, cross };
  }

  // =================================================================================================== paso
  /**
   * Avanza dt s. `playerPos`: centro de la burbuja (null: sin burbuja ni reciclaje por distancia). `hazards`: el jugador
   * y lo que pueda asustar o atropellar (ver PedHazard). `visible(x, z)`: si el jugador ve ese punto; sin él, nada se
   * considera visible. Sólo se aparece y se desaparece donde no se ve.
   */
  step(dt: number, playerPos: { x: number; z: number } | null = null, hazards: readonly PedHazard[] = [], visible?: Visibility) {
    this.time += dt;
    this.steps++;
    this.vis = visible ?? HIDDEN;
    this.player = playerPos;
    this.trackSignals();
    this.buildGrid();
    const A = this.A;
    for (const a of A) {
      if (!a.active) continue;
      a.px = a.x; a.py = a.y; a.pz = a.z; a.pheading = a.heading;
    }
    // líderes y solos; luego acompañantes (siguen al líder ya movido)
    for (const a of A) {
      if (!a.active || a.leader >= 0) continue;
      this.hazardCheck(a, hazards, dt);
      if (a.active && a.leader < 0) this.update(a, dt, hazards);
    }
    for (const a of A) {
      if (!a.active || a.leader < 0) continue;
      this.hazardCheck(a, hazards, dt);
      if (a.active && a.leader >= 0) this.follow(a, dt);
      else if (a.active) this.update(a, dt, hazards);
    }
    this.zoneCount.fill(0);
    this.obs.length = 0;
    for (const a of A) {
      if (!a.active) continue;
      this.finish(a, dt);
      this.zoneCount[a.zoneNow]++;
      if (a.cross >= 0 && a.mode !== M_WAIT && a.mode !== M_OFF && this.nav.carriagewayDist(a.x, a.z) < 0.4) {
        const o = this.obsPool[this.obs.length];
        o.x = a.x; o.z = a.z; o.r = 0.4;
        this.obs.push(o);
      }
    }
    this.recycle();
    if (this.inactive() > 0) {
      this.gatherCells();
      for (let k = 0; k < this.cfg.intentosPorPaso && this.inactive() > 0; k++) this.spawnOne(this.vis);
    }
  }

  // =================================================================================================== semáforos
  /** Mide cuánto dura el rojo de cada fase (sin depender de los tiempos internos del semáforo). */
  private trackSignals() {
    const T = this.traffic;
    if (!T) return;
    for (let c = 0; c < T.controllers.length; c++) {
      for (let ph = 0; ph < 2; ph++) {
        const k = c * 2 + ph, st = T.light(T.controllers[c], ph as 0 | 1) === 'R' ? 1 : 0;
        const before = this.sigState[k];
        if (st === 1 && before === 0) this.redStart[k] = this.time;
        if (st === 0 && before === 1 && !Number.isNaN(this.redStart[k])) this.redLen[k] = this.time - this.redStart[k];
        if (st === 1 && before === -1) this.redStart[k] = NaN;   // ya estaba en rojo: no se sabe cuánto le queda
        this.sigState[k] = st;
      }
    }
  }

  /** ¿Puede empezar a cruzar ya? (semáforo con tiempo suficiente, o brecha entre vehículos). */
  private canCross(a: Agent) {
    const cr = this.nav.crossings[a.cross];
    const S = this.cfg, len = a.len;
    const k = this.crossCtrl[a.cross];
    if (k >= 0 && this.traffic) {
      const key = k * 2 + this.crossPhase[a.cross];
      if (this.sigState[key] !== 1 || Number.isNaN(this.redStart[key])) return false;
      const left = this.redLen[key] - (this.time - this.redStart[key]);
      if (left < len / (a.vPref * S.velocidad.cruzar) + S.semaforo.margen) return false;
      return !this.vehicleBlocks(cr.ax, cr.az, cr.bx, cr.bz, 1.5);
    }
    const hurry = a.waitT > S.brecha.paciencia;
    const need = hurry ? len / S.velocidad.correr + 0.5 : len / (a.vPref * S.velocidad.cruzar) + S.brecha.margen;
    return !this.vehicleBlocks(cr.ax, cr.az, cr.bx, cr.bz, need);
  }

  /** ¿Algún vehículo está sobre el cruce a–b o llega a él antes de `need` s? */
  private vehicleBlocks(ax: number, az: number, bx: number, bz: number, need: number) {
    const T = this.traffic;
    if (!T) return false;
    const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1, reach = this.cfg.brecha.alcance;
    for (const v of T.vehicles) {
      if (!v.active) continue;
      let t = ((v.x - ax) * ex + (v.z - az) * ez) / L2;
      t = t < -0.15 ? -0.15 : t > 1.15 ? 1.15 : t;
      const cx = ax + ex * t - v.x, cz = az + ez * t - v.z, d = hyp(cx, cz);
      if (d > reach) continue;
      const front = d - v.length / 2;
      if (front < 1.2) return true;
      if (v.v < 0.3) continue;
      const closing = v.v * ((v.tx * cx + v.tz * cz) / (d || 1));
      if (closing > 0.2 && front / closing < need) return true;
    }
    return false;
  }

  // =================================================================================================== rejilla
  private hash(ix: number, iz: number) { return ((ix * 73856093) ^ (iz * 19349663)) & 2047; }
  private buildGrid() {
    this.head.fill(-1);
    for (const a of this.A) {
      if (!a.active) continue;
      const h = this.hash(Math.floor(a.x / 2), Math.floor(a.z / 2));
      this.next[a.id] = this.head[h];
      this.head[h] = a.id;
    }
  }

  // =================================================================================================== peligros
  private hazardCheck(a: Agent, hazards: readonly PedHazard[], dt: number) {
    if (a.mode === M_FALLEN || a.mode === M_OFF) return;
    const E = this.cfg.evitar;
    for (const h of hazards) {
      const rx = a.x - h.x, rz = a.z - h.z;
      if (rx * rx + rz * rz > 400) continue;
      const hv = hyp(h.vx, h.vz);
      if (h.kind !== 'player' && hv > this.cfg.caida.velMin) {
        // barrido del paso: del punto anterior al actual
        const sx = h.vx * dt, sz = h.vz * dt, L2 = sx * sx + sz * sz;
        let t = L2 > 0 ? ((a.x - (h.x - sx)) * sx + (a.z - (h.z - sz)) * sz) / L2 : 1;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        if (hyp(h.x - sx + sx * t - a.x, h.z - sz + sz * t - a.z) < h.r + E.radio) { this.fall(a, h); return; }
      }
      if (h.kind === 'player') {
        // espacio personal: quien está quieto da un paso atrás
        const d = hyp(rx, rz);
        if ((a.mode === M_STAND || a.mode === M_WAIT) && d < E.espacioJugador * 0.6 && d > 1e-3) this.nudge(a, rx / d, rz / d, 0.5);
        continue;
      }
      if (hv < E.velPeligro) continue;
      const tca = (rx * h.vx + rz * h.vz) / (hv * hv);
      if (tca <= 0 || tca > E.alerta) continue;
      const dca = hyp(rx - h.vx * tca, rz - h.vz * tca);
      if (dca < h.r + E.holgura) this.scare(a, h);
    }
  }

  /** Corre un paso (dentro de lo permitido) a lo lejos del jugador sin cambiar de actividad. */
  private nudge(a: Agent, ux: number, uz: number, d: number) {
    const x = a.hx + ux * d * 0.1, z = a.hz + uz * d * 0.1;
    if (a.mode === M_STAND && this.nav.allowed(x, z)) { a.hx = x; a.hz = z; }
  }

  /** Asustado por algo que se le viene encima: deja lo que hace y corre lejos de su trayectoria. */
  private scare(a: Agent, h: PedHazard) {
    if (a.leader >= 0) this.release(a);
    a.fleeX = h.x - h.vx * 0.5; a.fleeZ = h.z - h.vz * 0.5;
    if (a.fleeT > 0) { a.fleeT = Math.max(a.fleeT, 1.5); return; }
    a.fleeT = 2.5;
    while (a.fol.length) { const m = this.A[a.fol[a.fol.length - 1]]; this.release(m); this.scare(m, h); }
    if (a.mode === M_WALK) {
      if (a.cross >= 0) return;   // en la calzada: apurarse hacia el otro lado
      // al lado contrario de la trayectoria del peligro; si viene de frente, media vuelta
      const cr = h.vx * (a.z - h.z) - h.vz * (a.x - h.x);
      a.latT = (cr >= 0 ? 1 : -1) * (h.vx * a.dx + h.vz * a.dz >= 0 ? 1 : -1) * a.wl;
      if ((h.x - a.x) * a.dx + (h.z - a.z) * a.dz > 0 && h.vx * a.dx + h.vz * a.dz < 0) this.reverse(a);
      return;
    }
    // quieto, sentado o esperando: arranca desde su nodo
    const n = a.mode === M_SIT ? this.nav.seats[a.seat].node : a.mode === M_WAIT ? a.from : a.to;
    this.leaveSeat(a);
    this.startFrom(a, n >= 0 ? n : this.nearNode(a));
  }

  private fall(a: Agent, h: PedHazard) {
    if (a.leader >= 0) this.release(a);
    while (a.fol.length) { const m = this.A[a.fol[a.fol.length - 1]]; this.release(m); this.scare(m, h); }
    if (a.mode !== M_WALK) {
      const n = a.mode === M_SIT ? this.nav.seats[a.seat].node : a.mode === M_WAIT ? a.from : a.to;
      this.leaveSeat(a);
      if (a.mode === M_WAIT) this.reverse(a);
      else this.startFrom(a, n >= 0 ? n : this.nearNode(a));
      a.s = Math.min(a.s, 0.01);
    }
    a.mode = M_FALLEN;
    a.v = 0;
    const C = this.cfg.caida;
    a.timer = C.suelo[0] + this.rand() * (C.suelo[1] - C.suelo[0]);
    a.heading = Math.atan2(-h.vx, -h.vz);
    a.fleeX = h.x; a.fleeZ = h.z;
    this.falls.push(a.id);
    if (this.falls.length > 64) this.falls.shift();
  }

  // =================================================================================================== movimiento
  private update(a: Agent, dt: number, hazards: readonly PedHazard[]) {
    if (a.fleeT > 0) a.fleeT -= dt;
    switch (a.mode) {
      case M_FALLEN:
        a.timer -= dt;
        if (a.timer <= 0) {
          a.mode = M_WALK;
          a.fleeT = this.cfg.caida.huida;
          const p = this.player;
          if (p) { a.fleeX = p.x; a.fleeZ = p.z; }
          // de espaldas al jugador
          if ((a.fleeX - a.x) * a.dx + (a.fleeZ - a.z) * a.dz > 0 && a.cross < 0) this.reverse(a);
        }
        return;
      case M_SIT:
      case M_STAND:
        a.timer -= dt;
        if (a.timer <= 0) this.endActivity(a);
        return;
      case M_WAIT:
        a.waitT += dt;
        a.v = 0;
        if (this.canCross(a)) {
          a.mode = M_WALK;
          if (a.waitT > this.cfg.brecha.paciencia && this.crossCtrl[a.cross] < 0) a.fleeT = Math.max(a.fleeT, a.len / this.cfg.velocidad.correr + 0.5);
        }
        return;
      case M_WALK:
        this.walk(a, dt, hazards);
    }
  }

  private walk(a: Agent, dt: number, hazards: readonly PedHazard[]) {
    const V = this.cfg.velocidad;
    if (a.wander > 0) a.wander -= dt;
    let vT = a.fleeT > 0 ? V.correr : a.vPref * (a.cross >= 0 ? V.cruzar : 1);
    for (const f of a.fol) vT = Math.min(vT, this.A[f].vPref * (a.cross >= 0 ? V.cruzar : 1));
    vT *= this.avoid(a, hazards, dt);
    const dv = vT - a.v;
    a.v += dv > 0 ? Math.min(dv, 1.6 * dt) : Math.max(dv, -4 * dt);
    const span = this.halfSpan(a);
    const lim = Math.max(0, a.wl - span);
    const lt = a.latT < -lim ? -lim : a.latT > lim ? lim : a.latT;
    const dl = lt - a.lat, rate = (a.fleeT > 0 ? 1.6 : 0.7) * dt;
    a.lat += dl > rate ? rate : dl < -rate ? -rate : dl;
    a.s += a.v * dt;
    for (let guard = 0; a.s >= a.len && a.mode === M_WALK && guard < 4; guard++) {
      const over = a.s - a.len;
      this.arrive(a);
      if (!a.active || a.mode !== M_WALK) break;
      a.s = Math.min(over, a.len);
    }
  }

  /** Evasión local: devuelve el factor de velocidad y mueve el lateral objetivo (rejilla espacial, sin O(n²)). */
  private avoid(a: Agent, hazards: readonly PedHazard[], dt: number) {
    const E = this.cfg.evitar;
    if (a.ghostT > 0) { a.ghostT -= dt; return 1; }
    const px = -a.dz, pz = a.dx;
    const span = this.halfSpan(a), need = E.distancia + span;
    let slow = 1, push = 0;
    const ix = Math.floor(a.x / 2), iz = Math.floor(a.z / 2);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (let k = this.head[this.hash(ix + i, iz + j)]; k >= 0; k = this.next[k]) {
          const o = this.A[k];
          if (o === a || o.leader === a.id) continue;
          const rx = o.x - a.x, rz = o.z - a.z;
          const along = rx * a.dx + rz * a.dz;
          if (along <= 0.05 || along > 2.4) continue;
          const side = rx * px + rz * pz;
          if (Math.abs(side) >= need) continue;
          const ova = o.speed * (-Math.sin(o.heading) * a.dx - Math.cos(o.heading) * a.dz);
          if (ova > 0.3) {
            // misma dirección: seguir a distancia y adelantar si va lento
            slow = Math.min(slow, along < 0.7 ? 0 : Math.max(0, ova + (along - 0.9) * 1.5) / Math.max(0.3, a.vPref));
            if (ova < 0.75 * a.vPref) push += side >= 0 ? -0.6 : 0.6;
          } else {
            // quieto o de frente: apartarse (de frente, cada uno hacia su derecha)
            push += (side >= 0 ? -1 : 1) * (need - Math.abs(side)) / need;
            if (ova < -0.3) push += 0.4;
            if (along < 1.1 && Math.abs(side) < 0.5) slow = Math.min(slow, Math.max(0, (along - 0.55) / 0.55));
          }
        }
      }
    }
    // espacio personal ante el jugador a pie
    for (const h of hazards) {
      if (h.kind !== 'player') continue;
      const rx = h.x - a.x, rz = h.z - a.z;
      const along = rx * a.dx + rz * a.dz, side = rx * px + rz * pz;
      if (along <= 0 || along > 2.6 || Math.abs(side) >= E.espacioJugador + span) continue;
      push += (side >= 0 ? -1 : 1) * 1.2;
      if (along < 1.4 && Math.abs(side) < 0.6) slow = Math.min(slow, Math.max(0, (along - 0.8) / 0.6));
    }
    const wl = a.wl;
    if (a.fleeT <= 0) a.latT = Math.max(-wl, Math.min(wl, (a.latPref + push) * wl));
    if (slow < 0.15) {
      a.blockT += dt;
      // atascado en un andén angosto: se aprieta y pasa (como en la vida real)
      if (a.blockT > 2.5) { a.blockT = 0; a.ghostT = 1.2; return 1; }
    } else a.blockT = 0;
    return slow;
  }

  /** Media anchura de la formación del grupo (lado a lado) o 0. */
  private halfSpan(a: Agent) {
    const k = 1 + a.fol.length;
    if (k < 2) return 0;
    const sp = this.cfg.grupos.separacion, hs = ((k - 1) / 2) * sp;
    if (a.wl >= hs) return hs;
    return k === 3 && a.wl >= sp / 2 ? sp / 2 : 0;
  }

  /** Puesto en la formación: lateral relativo al centro y distancia detrás del líder. */
  private slotOf(L: Agent, i: number, wl: number, out: { lat: number; back: number }) {
    const k = 1 + L.fol.length, sp = this.cfg.grupos.separacion, hs = ((k - 1) / 2) * sp;
    if (wl >= hs) { out.lat = (i - (k - 1) / 2) * sp; out.back = 0; return out; }
    if (k === 3 && wl >= sp / 2) { out.lat = i === 2 ? 0 : (i - 0.5) * sp; out.back = i === 2 ? 0.85 : 0; return out; }
    out.lat = 0; out.back = i * 0.85;
    return out;
  }
  private slotTmp = { lat: 0, back: 0 };

  /** Acompañante: copia el modo del líder y toma su puesto en la formación. */
  private follow(f: Agent, dt: number) {
    const L = this.A[f.leader];
    if (!L.active) { this.release(f); return; }
    if (L.mode === M_STAND) {
      // su puesto en el corrillo lo fijó el líder; si el líder sólo se detuvo, espera donde está
      if (f.mode !== M_STAND) { f.mode = M_STAND; f.timer = L.timer; f.hx = f.x; f.hz = f.z; f.hh = f.heading; }
      return;
    }
    f.mode = L.mode === M_WAIT ? M_WAIT : M_WALK;
    f.fleeT = L.fleeT;
    f.cross = L.cross; f.from = L.from; f.to = L.to; f.edge = L.edge;
    f.v = L.v;
    const sl = this.slotOf(L, f.slot, L.wl, this.slotTmp);
    let s = L.s - sl.back;
    let ax = L.ax, az = L.az, dx = L.dx, dz = L.dz, wl = L.wl, len = L.len;
    if (s < 0 && L.plen > 0) { ax = L.pax; az = L.paz; dx = L.pdx; dz = L.pdz; wl = L.pwl; len = L.plen; s = Math.max(0, L.plen + s); }
    else if (s < 0) s = 0;
    let lat = L.lat + sl.lat;
    lat = lat < -wl ? -wl : lat > wl ? wl : lat;
    f.ax = ax; f.az = az; f.dx = dx; f.dz = dz; f.wl = wl; f.s = s; f.lat = lat; f.len = len;
    f.zoneNow = L.zoneNow;
    void dt;
  }

  /** Llega al final del tramo: decide el siguiente (ruta, paseo, actividad, cruce, entrar a un local). */
  private arrive(a: Agent) {
    const nav = this.nav, n = a.to;
    a.prev = a.from;
    a.zoneNow = nav.zone[n];
    a.cross = -1;
    // ¿iba a sentarse?
    if (a.seat >= 0 && this.seatOwner[a.seat] === a.id && n === nav.seats[a.seat].node) { this.sit(a); return; }
    if (a.fleeT > 0) { this.takeEdge(a, n, this.fleeNext(a, n)); return; }
    if (a.goal >= 0) {
      const D = nav.attractors[a.goal].dist;
      if (D[n] < 5) { this.reachGoal(a, n); return; }
      if (D[n] >= 1e8) { this.pickGoal(a, n); }
      else { this.takeEdge(a, n, this.routeNext(a, n)); return; }
      if (a.goal >= 0) { this.takeEdge(a, n, this.routeNext(a, n)); return; }
    }
    if (a.wander > 0 && nav.zone[n] !== ZONE_STREET) {
      this.takeEdge(a, n, this.wanderNext(a, n));
      return;
    }
    if (nav.zone[n] !== ZONE_STREET && nav.kind[n] === K_AREA) { this.zoneActivity(a, n); return; }
    // calle sin destino: a un callejón sin salida → entra a un local si no se ve; si no, busca destino o pasea
    if (nav.degree(n) <= 1 && this.tryEnter(a)) return;
    this.pickGoal(a, n);
    this.takeEdge(a, n, a.goal >= 0 ? this.routeNext(a, n) : this.wanderNext(a, n));
  }

  /** Llegó a su destino: actividad en la plaza/parque, o en la calle "entra a un local" (si no se ve) o sigue. */
  private reachGoal(a: Agent, n: number) {
    const zone = this.nav.attractors[a.goal].zone;
    a.goal = -1;
    if (zone !== ZONE_STREET && this.nav.kind[n] === K_AREA) { this.zoneActivity(a, n); return; }
    if (zone !== ZONE_STREET) { a.wander = 20 + this.rand() * 30; this.takeEdge(a, n, this.wanderNext(a, n)); return; }
    if (this.tryEnter(a)) return;
    this.pickGoal(a, n);
    this.takeEdge(a, n, a.goal >= 0 ? this.routeNext(a, n) : this.wanderNext(a, n));
  }

  /** Entra a una casa o local: desaparece con su grupo si nadie del grupo se ve. */
  private tryEnter(a: Agent) {
    if (this.vis(a.x, a.z)) return false;
    for (const f of a.fol) if (this.vis(this.A[f].x, this.A[f].z)) return false;
    this.parkGroup(a);
    return true;
  }

  /** Elige destino entre los atractores de su componente (prefiere los que quedan a 40–250 m). */
  private pickGoal(a: Agent, n: number, streetOnly = false) {
    const nav = this.nav, list = nav.compAttr[nav.comp[n]];
    a.goal = -1;
    if (!list || !list.length) { a.wander = 30; return; }
    let total = 0;
    for (const g of list) total += this.goalWeight(g, n, streetOnly);
    if (total <= 0) { a.wander = 30; return; }
    let r = this.rand() * total;
    for (const g of list) {
      r -= this.goalWeight(g, n, streetOnly);
      if (r <= 0) { a.goal = g; break; }
    }
    if (a.goal < 0) a.goal = list[list.length - 1];
    a.wander = 0;
  }
  private goalWeight(g: number, n: number, streetOnly: boolean) {
    const at = this.nav.attractors[g], d = at.dist[n];
    if (d >= 1e8 || d < 12 || (streetOnly && at.zone !== ZONE_STREET)) return 0;
    return at.weight * (d < 40 ? 0.3 : d > 250 ? 0.4 : 1);
  }

  /** Siguiente nodo hacia el destino: cualquiera que acorte la distancia (al azar, preferencia por seguir derecho). */
  private routeNext(a: Agent, n: number) {
    const nav = this.nav, D = nav.attractors[a.goal].dist, pen = peatones.nav.cruce.penalizacion;
    let total = 0, pick = -1, fallback = -1, fb = Infinity;
    for (let pass = 0; pass < 2; pass++) {
      let r = pass ? this.rand() * total : 0;
      for (let k = nav.adjStart[n]; k < nav.adjStart[n + 1]; k++) {
        const m = nav.adjNode[k], e = nav.adjEdge[k];
        const c = D[m] + nav.elen[e] + (nav.ecross[e] >= 0 ? pen : 0);
        if (!pass && c < fb) { fb = c; fallback = k; }
        if (c > D[n] + 0.75 || (m === a.prev && nav.degree(n) > 1)) continue;
        const w = 1 + 2 * Math.max(0, ((nav.x[m] - nav.x[n]) * a.dx + (nav.z[m] - nav.z[n]) * a.dz) / (nav.elen[e] || 1));
        if (!pass) total += w;
        else { r -= w; if (r <= 0) { pick = k; break; } }
      }
      if (!pass && total <= 0) break;
    }
    return pick >= 0 ? pick : fallback;
  }

  /** Paseo: vecino al azar dentro de la misma zona, con preferencia por seguir derecho. */
  private wanderNext(a: Agent, n: number) {
    const nav = this.nav, zone = nav.zone[n];
    let total = 0, pick = -1, any = -1;
    for (let pass = 0; pass < 2; pass++) {
      let r = pass ? this.rand() * total : 0;
      for (let k = nav.adjStart[n]; k < nav.adjStart[n + 1]; k++) {
        const m = nav.adjNode[k], e = nav.adjEdge[k];
        if (nav.ecross[e] >= 0 && zone !== ZONE_STREET) continue;
        any = k;
        if ((zone !== ZONE_STREET && nav.zone[m] !== zone) || (m === a.prev && nav.degree(n) > 1)) continue;
        const w = 0.4 + Math.max(0, ((nav.x[m] - nav.x[n]) * a.dx + (nav.z[m] - nav.z[n]) * a.dz) / (nav.elen[e] || 1)) ** 2 * 3;
        if (!pass) total += w;
        else { r -= w; if (r <= 0) { pick = k; break; } }
      }
      if (!pass && total <= 0) break;
    }
    return pick >= 0 ? pick : any;
  }

  /** Huyendo: el vecino que más lo aleja del peligro (sin cruzar la calle si hay otra salida). */
  private fleeNext(a: Agent, n: number) {
    const nav = this.nav;
    let best = -1, bd = -Infinity;
    for (let k = nav.adjStart[n]; k < nav.adjStart[n + 1]; k++) {
      const m = nav.adjNode[k];
      const d = hyp(nav.x[m] - a.fleeX, nav.z[m] - a.fleeZ) - (nav.ecross[nav.adjEdge[k]] >= 0 ? 6 : 0);
      if (d > bd) { bd = d; best = k; }
    }
    return best;
  }

  /** Toma la arista de adyacencia k desde n (si es un cruce, espera en el borde hasta poder pasar). */
  private takeEdge(a: Agent, n: number, k: number) {
    const nav = this.nav;
    if (k < 0) { a.mode = M_STAND; a.timer = 5; this.standHere(a, n); return; }
    const m = nav.adjNode[k], e = nav.adjEdge[k];
    this.setLeg(a, n, m, e);
    const c = nav.ecross[e];
    if (c >= 0) {
      a.cross = c;
      a.waitT = 0;
      a.latT = a.lat = (this.rand() * 2 - 1) * a.wl * 0.7;
      if (!this.canCross(a)) { a.mode = M_WAIT; a.v = 0; this.waitSlot(a); }
    }
  }

  /**
   * Puesto libre en el borde del cruce: a lo largo del sardinel (dentro de la franja de la cebra) y, si hace falta, un
   * paso atrás sobre el andén. Así los que esperan no se encaraman unos sobre otros.
   */
  private waitSlot(a: Agent) {
    const nav = this.nav, R = this.cfg.evitar.distancia * 0.8;
    let best = 0, bl = 0, bs = 0, bc = Infinity;
    for (const back of [0, -0.6]) {
      for (const k of [0, 1, -1, 2, -2]) {
        const lat = a.latT + k * 0.6;
        if (Math.abs(lat) > a.wl + 1e-6 && k !== 0) continue;
        const l = Math.max(-a.wl, Math.min(a.wl, lat));
        const x = a.ax + a.dx * back - a.dz * l, z = a.az + a.dz * back + a.dx * l;
        if (back < 0 && !nav.allowed(x, z)) continue;
        // ocupación: los vecinos en la rejilla (posiciones del comienzo del paso)
        let crowd = 0;
        const ix = Math.floor(x / 2), iz = Math.floor(z / 2);
        for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
          for (let q = this.head[this.hash(ix + i, iz + j)]; q >= 0; q = this.next[q]) {
            const o = this.A[q];
            if (o !== a && o.leader !== a.id && hyp(o.x - x, o.z - z) < R) crowd++;
          }
        }
        const cost = crowd * 10 + Math.abs(back) + Math.abs(k) * 0.1;
        if (cost < bc) { bc = cost; best = 1; bl = l; bs = back; }
        if (!crowd) break;
      }
      if (bc < 1) break;
    }
    a.s = best ? bs : 0;
    a.lat = a.latT = best ? bl : a.lat;
  }

  private setLeg(a: Agent, from: number, to: number, e: number) {
    const nav = this.nav;
    // guarda el tramo anterior para los que van detrás
    a.pax = a.ax; a.paz = a.az; a.pdx = a.dx; a.pdz = a.dz; a.plen = a.len; a.pwl = a.wl;
    const ax = nav.x[from], az = nav.z[from], bx = nav.x[to], bz = nav.z[to];
    const L = hyp(bx - ax, bz - az) || 1e-3;
    // lateral continuo: se reexpresa la posición actual en el nuevo tramo
    const ndx = (bx - ax) / L, ndz = (bz - az) / L;
    const rel = (a.x - ax) * -ndz + (a.z - az) * ndx;
    a.ax = ax; a.az = az; a.dx = ndx; a.dz = ndz; a.len = L;
    a.edge = e; a.from = from; a.to = to; a.cross = -1;
    a.wl = e >= 0 ? nav.ewl[e] : 0;
    a.lat = Math.max(-a.wl, Math.min(a.wl, Number.isFinite(rel) ? rel : 0));
    a.s = 0;
  }

  private reverse(a: Agent) {
    const from = a.to, to = a.from;
    if (from < 0 || to < 0) return;
    const s = a.len - a.s, lat = -a.lat, cross = a.cross;
    this.setLeg(a, from, to, a.edge);
    a.s = Math.max(0, s); a.lat = lat; a.latT = -a.latT; a.cross = cross;
    if (a.mode === M_WAIT) a.mode = M_WALK;
  }

  /** Empieza a caminar desde el nodo n (hacia su destino, paseando o huyendo). */
  private startFrom(a: Agent, n: number) {
    if (n < 0) { this.park(a); return; }
    a.mode = M_WALK;
    a.v = 0.3;
    a.to = n; a.from = n;
    a.len = 0;   // sin tramo anterior válido (los acompañantes no deben usar uno viejo)
    const k = a.fleeT > 0 ? this.fleeNext(a, n) : a.goal >= 0 ? this.routeNext(a, n) : this.wanderNext(a, n);
    this.takeEdge(a, n, k);
  }

  private nearNode(a: Agent) { return this.nav.nearestNode(a.x, a.z, 12); }

  // =================================================================================================== actividades
  /** En la plaza o el parque: sentarse, conversar, quedarse mirando, pasear o seguir de largo. */
  private zoneActivity(a: Agent, n: number) {
    const T = this.cfg.actividad, G = this.cfg.grupos;
    if (a.fol.length) {
      if (this.rand() < 0.6 && this.freeChatSpot(this.nav.x[n], this.nav.z[n])) { this.startChat(a, n); return; }
      a.wander = this.dur(T.duracionPaseo);
      this.takeEdge(a, n, this.wanderNext(a, n));
      return;
    }
    const r = this.rand();
    if (r < T.sentarse && this.goSit(a, n)) return;
    if (r < T.sentarse + T.quieto) {
      // un punto libre cerca del nodo (si no hay, sigue paseando)
      for (let k = 0; k < 4; k++) {
        const ang = this.rand() * TAU, d = k ? 0.4 + this.rand() * 0.6 : 0;
        const x = this.nav.x[n] + Math.cos(ang) * d, z = this.nav.z[n] + Math.sin(ang) * d;
        if (!this.free(x, z, 0.9) || !this.nav.allowed(x, z)) continue;
        a.mode = M_STAND; a.timer = this.dur(T.duracionQuieto); a.v = 0; a.to = n;
        a.hx = x; a.hz = z; a.hh = this.rand() * TAU;
        return;
      }
    }
    if (r < T.sentarse + T.quieto + T.pasear) {
      a.wander = this.dur(T.duracionPaseo);
      this.takeEdge(a, n, this.wanderNext(a, n));
      return;
    }
    void G;
    this.pickGoal(a, n, true);
    if (a.goal < 0) this.pickGoal(a, n);
    this.takeEdge(a, n, a.goal >= 0 ? this.routeNext(a, n) : this.wanderNext(a, n));
  }

  private dur(r: number[]) { return r[0] + this.rand() * (r[1] - r[0]); }

  /** Termina sentado/corrillo/quieto: se queda en la zona con otra actividad o se va. */
  private endActivity(a: Agent) {
    const n = a.mode === M_SIT ? this.nav.seats[a.seat].node : a.to;
    this.leaveSeat(a);
    // corrillo de 4: se separa en dos parejas
    if (a.fol.length === 3) {
      const b = this.A[a.fol[2]], c = this.A[a.fol[1]];
      a.fol.length = 1;
      b.leader = -1; b.fol.length = 0; b.fol.push(c.id); c.leader = b.id; c.slot = 1;
      b.goal = -1;
      this.pickGoal(b, n, true);
      this.startFrom(b, n);
    }
    const stay = this.rand() < this.cfg.actividad.seQueda && this.nav.zone[n] !== ZONE_STREET;
    a.goal = -1;
    if (stay) { a.wander = this.dur(this.cfg.actividad.duracionPaseo) * 0.5; }
    else { this.pickGoal(a, n, true); if (a.goal < 0) this.pickGoal(a, n); }
    this.startFrom(a, n);
  }

  /** Busca una banca libre cercana a la que se llegue en línea recta y va hacia ella. */
  private goSit(a: Agent, n: number) {
    const nav = this.nav, zone = nav.zone[n];
    // las 3 bancas libres más cercanas (a ≤ 22 m); la primera a la que se llegue en línea recta
    let b0 = -1, b1 = -1, b2 = -1, d0 = 22, d1 = 22, d2 = 22;
    for (let i = 0; i < nav.seats.length; i++) {
      const st = nav.seats[i];
      if (st.zone !== zone || this.seatOwner[i] >= 0) continue;
      const d = hyp(st.fx - nav.x[n], st.fz - nav.z[n]);
      if (d < d0) { b2 = b1; d2 = d1; b1 = b0; d1 = d0; b0 = i; d0 = d; }
      else if (d < d1) { b2 = b1; d2 = d1; b1 = i; d1 = d; }
      else if (d < d2) { b2 = i; d2 = d; }
    }
    let best = -1;
    for (let k = 0; k < 3 && best < 0; k++) {
      const i = k === 0 ? b0 : k === 1 ? b1 : b2;
      if (i >= 0 && nav.clearSegment(nav.x[n], nav.z[n], nav.seats[i].fx, nav.seats[i].fz, 0.75)) best = i;
    }
    if (best < 0) return false;
    const st = nav.seats[best];
    this.seatOwner[best] = a.id;
    a.seat = best;
    a.mode = M_WALK;
    // tramo recto hasta los pies de la banca (nodo de acceso)
    this.setLeg(a, n, st.node, -1);
    return true;
  }

  private sit(a: Agent) {
    const st = this.nav.seats[a.seat];
    a.mode = M_SIT;
    a.v = 0;
    a.hx = st.x; a.hz = st.z; a.hh = st.heading;
    // altura del suelo bajo los pies (adoquín frente a la banca) y del asiento sobre él
    a.y = this.nav.groundY(st.fx, st.fz);
    a.seatH = st.seatY - a.y;
    a.timer = this.dur(this.cfg.actividad.duracionSentado);
    a.goal = -1;
  }

  private leaveSeat(a: Agent) {
    if (a.seat >= 0 && this.seatOwner[a.seat] === a.id) this.seatOwner[a.seat] = -1;
    a.seat = -1;
    a.seatH = 0;
  }

  private standHere(a: Agent, n: number) {
    a.hx = n >= 0 ? this.nav.x[n] + a.lat * -a.dz : a.x;
    a.hz = n >= 0 ? this.nav.z[n] + a.lat * a.dx : a.z;
    if (!this.nav.allowed(a.hx, a.hz)) { a.hx = n >= 0 ? this.nav.x[n] : a.x; a.hz = n >= 0 ? this.nav.z[n] : a.z; }
    a.hh = a.heading;
    a.v = 0;
    a.to = n;
  }

  /** ¿No hay otro corrillo a menos de 4,5 m? */
  private freeChatSpot(x: number, z: number) {
    for (const o of this.A) {
      if (o.active && o.mode === M_STAND && o.leader < 0 && o.fol.length && hyp(o.hx - x, o.hz - z) < 4.5) return false;
    }
    return true;
  }

  /** El grupo se para en círculo alrededor del nodo n, mirando al centro. */
  private startChat(a: Agent, n: number) {
    const k = 1 + a.fol.length, r = 0.45 + 0.13 * k, a0 = this.rand() * TAU;
    const cx = this.nav.x[n], cz = this.nav.z[n];
    const T = this.dur(this.cfg.actividad.duracionCorrillo);
    for (let i = 0; i < k; i++) {
      const m = i === 0 ? a : this.A[a.fol[i - 1]];
      const ang = a0 + (TAU * i) / k + (this.rand() - 0.5) * 0.4;
      m.mode = M_STAND; m.timer = T; m.v = 0; m.to = n;
      m.hx = cx + Math.cos(ang) * r; m.hz = cz + Math.sin(ang) * r;
      m.hh = Math.atan2(m.hx - cx, m.hz - cz);   // de frente al centro: avance (-sin h, -cos h) apunta al centro
      m.zoneNow = this.nav.zone[n];
    }
  }

  /** Suelta al acompañante de su grupo: sigue solo desde el tramo actual del que era su líder. */
  private release(f: Agent) {
    const L = f.leader >= 0 ? this.A[f.leader] : null;
    f.leader = -1;
    f.slot = 0;
    if (!L) return;
    let j = 0;
    for (let i = 0; i < L.fol.length; i++) if (L.fol[i] !== f.id) { L.fol[j] = L.fol[i]; this.A[L.fol[j]].slot = j + 1; j++; }
    L.fol.length = j;
    if (f.mode !== M_WALK && f.mode !== M_WAIT) return;
    f.ax = L.ax; f.az = L.az; f.dx = L.dx; f.dz = L.dz; f.len = L.len; f.wl = L.wl;
    f.edge = L.edge; f.from = L.from; f.to = L.to; f.cross = L.cross; f.goal = L.goal; f.prev = L.prev; f.wander = L.wander;
    f.s = Math.max(0, Math.min(f.len, (f.x - f.ax) * f.dx + (f.z - f.az) * f.dz));
    f.lat = f.latT = Math.max(-f.wl, Math.min(f.wl, (f.x - f.ax) * -f.dz + (f.z - f.az) * f.dx));
    f.plen = 0;
    f.v = Math.max(f.v, 0.5);
    if (f.from < 0 || f.to < 0) this.startFrom(f, this.nearNode(f));
  }

  // =================================================================================================== pose y altura
  /** Posición final, altura, rumbo, velocidad, fase del paso y postura. */
  private finish(a: Agent, dt: number) {
    const nav = this.nav;
    let tx: number, tz: number;
    if (a.mode === M_STAND || a.mode === M_SIT) { tx = a.hx; tz = a.hz; }
    else if (a.mode === M_FALLEN) { tx = a.x; tz = a.z; }
    else {
      let lat = a.lat;
      if (a.leader < 0 && a.fol.length) lat += this.slotOf(a, 0, a.wl, this.slotTmp).lat;
      const s = a.s < -0.8 ? -0.8 : a.s > a.len ? a.len : a.s;   // < 0: un paso atrás en el borde de un cruce
      tx = a.ax + a.dx * s - a.dz * lat;
      tz = a.az + a.dz * s + a.dx * lat;
    }
    // persecución suave del punto ideal (sin saltos en los quiebres)
    const ex = tx - a.x, ez = tz - a.z, ed = hyp(ex, ez);
    const maxStep = (Math.max(a.v, a.mode === M_SIT ? 0.8 : 0.6) + 1.2) * dt;
    if (ed > 3) { a.x = tx; a.z = tz; }
    else if (ed > maxStep) { a.x += (ex / ed) * maxStep; a.z += (ez / ed) * maxStep; }
    else { a.x = tx; a.z = tz; }
    const mx = a.x - a.px, mz = a.z - a.pz, moved = hyp(mx, mz);
    a.speed = moved / dt;
    // altura del suelo (sólo se recalcula si se movió)
    if (a.mode !== M_SIT) {
      if (Math.abs(a.x - a.lastYx) + Math.abs(a.z - a.lastYz) > 0.05) { a.y = nav.groundY(a.x, a.z); a.lastYx = a.x; a.lastYz = a.z; }
      a.seatH = 0;
    }
    // rumbo: hacia donde avanza; quieto, hacia su punto de interés
    let target = a.heading;
    if (a.mode === M_STAND || a.mode === M_SIT || a.mode === M_WAIT) {
      target = a.mode === M_WAIT ? Math.atan2(-a.dx, -a.dz) : a.hh;
      if (moved > 0.02 && ed > 0.3) target = Math.atan2(-mx, -mz);
    } else if (a.mode !== M_FALLEN && moved > 0.01) target = Math.atan2(-mx, -mz);
    let dh = target - a.heading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    const turn = (a.mode === M_FALLEN ? 0 : a.fleeT > 0 ? 9 : 5) * dt;
    a.heading += dh > turn ? turn : dh < -turn ? -turn : dh;
    if (a.heading > Math.PI) a.heading -= TAU; else if (a.heading < -Math.PI) a.heading += TAU;
    a.phase += (moved / (1.45 * a.height)) * TAU;
    let pose: PedPose;
    switch (a.mode) {
      case M_SIT: pose = 'sit'; break;
      case M_FALLEN: pose = 'fallen'; break;
      case M_WAIT: pose = a.speed > 0.4 ? 'walk' : 'wait'; break;
      case M_STAND: pose = a.speed > 0.4 ? 'walk' : 'idle'; break;
      default: pose = a.fleeT > 0 && a.speed > 1.8 ? 'run' : a.speed < 0.2 ? 'idle' : 'walk';
    }
    if (pose !== a.pose) { a.pose = pose; a.poseTime = 0; } else a.poseTime += dt;
  }

  // =================================================================================================== burbuja
  private inactive() {
    let k = 0;
    for (const a of this.A) if (!a.active) k++;
    return k;
  }

  /** Recicla (sin que se vea) a los que quedaron lejos del jugador; por turnos para acotar las pruebas de visibilidad. */
  private recycle() {
    const p = this.player;
    if (!p) return;
    const S = this.cfg;
    for (const a of this.A) {
      if (!a.active || a.leader >= 0 || (this.steps + a.id) % 8 !== 0) continue;
      const d = hyp(a.x - p.x, a.z - p.z);
      if (d < S.distDesaparicion) continue;
      if (d > S.distDesaparicionDura) { this.parkGroup(a); continue; }
      if (this.vis(a.x, a.z)) continue;
      let seen = false;
      for (const f of a.fol) if (this.vis(this.A[f].x, this.A[f].z)) { seen = true; break; }
      if (!seen) this.parkGroup(a);
    }
  }

  private parkGroup(a: Agent) {
    while (a.fol.length) this.park(this.A[a.fol[a.fol.length - 1]]);   // park() lo saca de a.fol
    this.park(a);
  }

  private park(a: Agent) {
    this.leaveSeat(a);
    if (a.leader >= 0) this.release(a);
    while (a.fol.length) this.release(this.A[a.fol[a.fol.length - 1]]);
    a.active = false;
    a.mode = M_OFF;
    a.x = a.px = PARK - a.id * 3; a.z = a.pz = PARK;
    a.v = 0; a.speed = 0; a.cross = -1; a.goal = -1; a.fleeT = 0; a.edge = -1; a.from = a.to = -1; a.len = 0; a.plen = 0;
    a.pose = 'idle'; a.poseTime = 0; a.seatH = 0; a.lastYx = NaN;
  }

  /** Celdas de aparición dentro de la burbuja (suma acumulada de pesos). */
  private gatherCells() {
    const p = this.player, R = this.cfg.radioBurbuja + 23;
    this.nCand = 0; this.candTotal = 0;
    for (let c = 0; c < this.cellN; c++) {
      if (this.cellW[c] <= 0) continue;
      if (p && hyp(this.cellX[c] - p.x, this.cellZ[c] - p.z) > R) continue;
      this.candTotal += this.cellW[c];
      this.candCell[this.nCand] = c;
      this.candCum[this.nCand++] = this.candTotal;
    }
  }

  private nextInactive() {
    const N = this.A.length;
    for (let k = 0; k < N; k++) {
      const a = this.A[(this.cursor + k) % N];
      if (!a.active) { this.cursor = (a.id + 1) % N; return a; }
    }
    return null;
  }

  /** Un intento de aparición: cupo de la plaza y el parque primero, si no un nodo de calle ponderado. */
  private spawnOne(vis: Visibility) {
    const p = this.player, S = this.cfg, N = this.A.length, nav = this.nav;
    const near = (x: number, z: number, extra: number) => !p || hyp(x - p.x, z - p.z) < S.radioBurbuja + extra;
    const plazaDef = near(nav.plazaCenter.x, nav.plazaCenter.z, 30) ? S.cupo.plaza * N - this.zoneCount[ZONE_PLAZA] : 0;
    const pc = nav.parkCenters[0];
    const parkDef = pc && near(pc.x, pc.z, 30) ? S.cupo.parque * N - this.zoneCount[ZONE_PARK] : 0;
    const r = this.rand();
    let ok = false;
    if (plazaDef > 0 && r < 0.65) ok = this.spawnZone(ZONE_PLAZA, vis);
    else if (parkDef > 0 && r < 0.85) ok = this.spawnZone(ZONE_PARK, vis);
    else ok = this.spawnStreet(vis);
    return ok;
  }

  /** ¿Sirve este punto para aparecer? (oculto, en la burbuja y no encima del jugador). */
  private spawnPointOk(x: number, z: number, vis: Visibility) {
    const p = this.player;
    if (p) {
      const d = hyp(x - p.x, z - p.z);
      if (d < this.cfg.distMinAparicion || d > this.cfg.radioBurbuja) return false;
    }
    return this.free(x, z, 0.8) && !vis(x, z);
  }

  /** ¿Nadie a menos de r m? (recorrido directo: sólo al aparecer o al escoger dónde quedarse quieto). */
  private free(x: number, z: number, r: number) {
    for (const o of this.A) if (o.active && Math.abs(o.x - x) < r && Math.abs(o.z - z) < r && hyp(o.x - x, o.z - z) < r) return false;
    return true;
  }

  private personal(a: Agent) {
    const V = this.cfg.velocidad;
    a.vPref = V.min + this.rand() * (V.max - V.min);
    a.height = 0.9 + this.rand() * 0.16;
    a.look = Math.floor(this.rand() * 0x7fffffff);
    a.latPref = (this.rand() * 2 - 1) * 0.6 + 0.15;   // costumbre de ir algo a la derecha
    a.phase = this.rand() * TAU;
    a.fol.length = 0; a.leader = -1; a.slot = 0;
    a.goal = -1; a.wander = 0; a.fleeT = 0; a.waitT = 0; a.blockT = 0; a.ghostT = 0; a.seat = -1; a.cross = -1;
    a.plen = 0; a.len = 0; a.lastYx = NaN; a.poseTime = 0;
  }

  private activate(a: Agent, x: number, z: number, heading: number) {
    a.active = true;
    a.x = a.px = x; a.z = a.pz = z;
    a.heading = a.pheading = heading;
    if (a.mode !== M_SIT) a.y = this.nav.groundY(x, z);
    a.py = a.y;
    a.lastYx = x; a.lastYz = z;
    a.speed = 0;
    this.zoneCount[a.zoneNow]++;
  }

  /** En la calle: caminando (solo o en grupo de 2–3) a mitad de una arista hacia un destino de su componente. */
  private spawnStreet(vis: Visibility) {
    if (this.candTotal <= 0) return false;
    const nav = this.nav;
    // celda y nodo ponderados
    let r = this.rand() * this.candTotal, lo = 0, hi = this.nCand - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.candCum[m] < r) lo = m + 1; else hi = m; }
    const c = this.candCell[lo];
    r = this.rand() * this.cellW[c];
    let i0 = this.cellStart[c], i1 = this.cellStart[c + 1] - 1;
    while (i0 < i1) { const m = (i0 + i1) >> 1; if (this.cellCum[m] < r) i0 = m + 1; else i1 = m; }
    const n = this.cellNodes[i0];
    const deg = nav.degree(n);
    if (!deg) return false;
    const k = nav.adjStart[n] + Math.floor(this.rand() * deg);
    if (nav.ecross[nav.adjEdge[k]] >= 0) return false;
    const a = this.nextInactive();
    if (!a) return false;
    const s = this.rand() * nav.elen[nav.adjEdge[k]];
    const m = nav.adjNode[k];
    // posición sobre la arista
    const L = nav.elen[nav.adjEdge[k]] || 1e-3, dx = (nav.x[m] - nav.x[n]) / L, dz = (nav.z[m] - nav.z[n]) / L;
    const wl = nav.ewl[nav.adjEdge[k]];
    const want = this.rand() < this.cfg.grupos.caminan ? (this.rand() < 0.3 ? 3 : 2) : 1;
    const size = Math.min(want, 1 + this.inactive() - 1);
    // líder (centro del grupo) y acompañantes en formación: todos ocultos
    const latC = Math.max(-wl, Math.min(wl, (this.rand() * 2 - 1) * wl * 0.6));
    const tmpLeader = a;
    this.personal(tmpLeader);
    for (let i = 0; i < size - 1; i++) tmpLeader.fol.push(-1);   // sólo para calcular la formación
    for (let i = 0; i < size; i++) {
      const sl = this.slotOf(tmpLeader, i, wl, this.slotTmp);
      const ss = Math.max(0, s - sl.back), lat = Math.max(-wl, Math.min(wl, latC + sl.lat));
      const x = nav.x[n] + dx * ss - dz * lat, z = nav.z[n] + dz * ss + dx * lat;
      if (!this.spawnPointOk(x, z, vis)) { tmpLeader.fol.length = 0; return false; }
    }
    tmpLeader.fol.length = 0;
    // alta
    a.prev = -1;
    a.ax = nav.x[n]; a.az = nav.z[n]; a.x = a.ax + dx * s; a.z = a.az + dz * s;
    this.setLeg(a, n, m, nav.adjEdge[k]);
    a.s = s; a.lat = a.latT = latC;
    a.mode = M_WALK; a.v = a.vPref; a.zoneNow = nav.zone[n];
    this.pickGoal(a, m);
    // el destino debe quedar adelante; si no, media vuelta
    if (a.goal >= 0 && nav.attractors[a.goal].dist[m] > nav.attractors[a.goal].dist[n]) { this.reverse(a); }
    const head = Math.atan2(-a.dx, -a.dz);
    this.activate(a, a.ax + a.dx * a.s - a.dz * a.lat, a.az + a.dz * a.s + a.dx * a.lat, head);
    for (let i = 1; i < size; i++) {
      const f = this.nextInactive();
      if (!f) break;
      this.personal(f);
      f.leader = a.id; f.slot = i; a.fol.push(f.id);
      f.mode = M_WALK; f.zoneNow = a.zoneNow;
      this.follow(f, 0);
      const sl = this.slotOf(a, i, a.wl, this.slotTmp);
      const ss = Math.max(0, a.s - sl.back);
      this.activate(f, a.ax + a.dx * ss - a.dz * (a.lat + sl.lat), a.az + a.dz * ss + a.dx * (a.lat + sl.lat), head);
    }
    if (a.fol.length) {
      // el líder también toma su puesto
      const sl = this.slotOf(a, 0, a.wl, this.slotTmp);
      a.x = a.px = a.ax + a.dx * a.s - a.dz * (a.lat + sl.lat); a.z = a.pz = a.az + a.dz * a.s + a.dx * (a.lat + sl.lat);
    }
    return true;
  }

  /** En la plaza o el parque: sentado en una banca, corrillo, quieto mirando o paseando. */
  private spawnZone(zone: number, vis: Visibility) {
    const nav = this.nav, T = this.cfg.actividad;
    const a = this.nextInactive();
    if (!a) return false;
    const r = this.rand();
    if (r < 0.45) {
      // banca libre al azar
      const i = Math.floor(this.rand() * nav.seats.length);
      const st = nav.seats[i];
      if (!st || st.zone !== zone || this.seatOwner[i] >= 0 || !this.spawnPointOk(st.fx, st.fz, vis) || vis(st.x, st.z)) return false;
      this.personal(a);
      this.seatOwner[i] = a.id; a.seat = i;
      a.to = st.node; a.from = st.node; a.zoneNow = zone;
      this.sit(a);
      a.timer *= this.rand();   // ya llevaba un rato sentado
      this.activate(a, st.x, st.z, st.heading);
      return true;
    }
    // nodo del área al azar (rejilla de la zona)
    const n = this.randomAreaNode(zone);
    if (n < 0) return false;
    const x = nav.x[n], z = nav.z[n];
    if (r < 0.8) {
      // corrillo de 2–4
      const k = Math.min(2 + Math.floor(this.rand() * 3), this.inactive());
      if (k < 2 || !this.freeChatSpot(x, z)) return false;
      const rad = 0.45 + 0.13 * k, a0 = this.rand() * TAU;
      for (let i = 0; i < k; i++) {
        const ang = a0 + (TAU * i) / k;
        if (!this.spawnPointOk(x + Math.cos(ang) * rad, z + Math.sin(ang) * rad, vis)) return false;
      }
      this.personal(a);
      a.to = a.from = n; a.zoneNow = zone; a.edge = -1;
      for (let i = 1; i < k; i++) {
        const f = this.nextInactive();
        if (!f) break;
        this.personal(f);
        f.leader = a.id; f.slot = i; a.fol.push(f.id);
        f.to = f.from = n;
      }
      this.startChat(a, n);
      const left = this.rand();
      for (let i = 0; i <= a.fol.length; i++) {
        const m = i === 0 ? a : this.A[a.fol[i - 1]];
        m.timer *= left;
        this.activate(m, m.hx, m.hz, m.hh);
      }
      return true;
    }
    if (!this.spawnPointOk(x, z, vis)) return false;
    this.personal(a);
    a.to = a.from = n; a.zoneNow = zone;
    this.activate(a, x, z, this.rand() * TAU);
    if (r < 0.9) {
      a.mode = M_STAND; a.timer = this.dur(T.duracionQuieto);
      a.hx = x; a.hz = z; a.hh = a.heading;
    } else {
      a.wander = this.dur(T.duracionPaseo);
      a.dx = Math.sin(a.heading); a.dz = Math.cos(a.heading);
      this.startFrom(a, n);
      a.x = a.px = x; a.z = a.pz = z;
    }
    return true;
  }

  private areaNodes: Int32Array[] = [];
  private randomAreaNode(zone: number) {
    if (!this.areaNodes.length) {
      for (const zn of [ZONE_STREET, ZONE_PLAZA, ZONE_PARK]) {
        const l: number[] = [];
        for (let i = 0; i < this.nav.n; i++) if (this.nav.zone[i] === zn && this.nav.kind[i] === K_AREA && this.nav.degree(i) > 0) l.push(i);
        this.areaNodes[zn] = new Int32Array(l);
      }
    }
    const l = this.areaNodes[zone];
    return l.length ? l[Math.floor(this.rand() * l.length)] : -1;
  }
}
