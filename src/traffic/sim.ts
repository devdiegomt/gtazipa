/**
 * Simulación de tráfico (pura). Modelo de seguimiento IDM (Treiber et al.), semáforos de dos fases por cruce,
 * prelación por ocupación en cruces sin semáforo, y obstáculos externos (jugador, moto) ante los que se frena y pita.
 * Los vehículos aparecen y desaparecen sólo donde el jugador no los ve (callback `visible` de step()).
 * Fase 1 (vida): las motos filtran entre la fila (desplazamiento lateral `lat`) y quedan adelante en los semáforos; las
 * busetas paran en paraderos (ESTIMADOS) con luces de parqueo; cada vehículo expone direccionales y luz de freno.
 * step() no reserva memoria en el camino normal (rejilla y búferes reutilizados).
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

/** Motos que filtran (trafico.json traffic.filtering). */
export interface FilterCfg {
  /** IDM propio de las motos (más ágiles que los carros). */
  a: number; s0: number; T: number;
  /** Rapidez lateral (m/s) y holgura lateral al pasar a otro vehículo (m). */
  latSpeed: number; clear: number;
  /** Filtra si el de adelante va a menos de `slow` m/s y está a menos de `look` m. */
  slow: number; look: number;
  /** Desplazamiento lateral preferido al filtrar y tope (m). */
  cruise: number; maxLat: number;
  /** Detenida en el pare, el frente queda a esto del final del carril (delante de los carros, antes de la cebra). */
  stopFront: number;
  /**
   * Desplazada no entra a los últimos (ni empieza a filtrar en los primeros) `zone` m del carril, donde barren los que
   * giran o tuercen; sólo avanza hasta la línea si el puesto de adelante está libre y el primero de la fila detenido.
   */
  zone: number;
}
/** Paraderos de buseta (trafico.json traffic.busStops). */
export interface BusStopCfg {
  classes: string[]; spacing: number; fromJunction: number; fromCrossing: number; edgeMargin: number;
  /** Probabilidad de que un candidato sea paradero y de que una buseta pare en él. */
  prob: number; use: number;
  /** Segundos detenida [mín, máx] y distancia a la que empieza a orillarse. */
  dwell: [number, number]; approach: number; seed: number;
}
/**
 * Carril de parqueo: ancho reservado junto al sardinel y holgura mínima entre carriles y sardinel para tenerlo; las vías
 * de un sentido de las clases `oneLane` circulan por un solo carril (junto al sardinel derecho) y parquean al otro lado.
 */
export interface ParkingCfg { width: number; minSpare: number; oneLane?: string[] }

export interface TrafficCfg {
  vehicles: number; mix: Record<string, number>; idm: { a: number; b: number; s0: number; T: number; delta: number };
  lookahead: number; respawnMinDistance: number; junctionWaitTimeout: number; honkAfter: number;
  /** Burbuja de tráfico alrededor del jugador: radio donde circulan y distancia a la que reaparecen. */
  bubbleRadius?: number; despawnDistance?: number;
  /**
   * Más allá de esta distancia se reciclan aunque `visible` diga que se ven (respaldo: la prueba de main.ts ya descarta
   * lo que la niebla oculta, por profundidad de vista, no por distancia).
   */
  despawnHardDistance?: number;
  /** Intentos de colocación por paso entre todos los vehículos inactivos (acota el costo de reaparecer). */
  spawnTriesPerStep?: number;
  /**
   * Último recurso: un vehículo interbloqueado (o tras un obstáculo que no es el jugador, o en la cola de uno retenido al
   * final del camino) más de estos s se recicla si no se ve.
   */
  stuckRecycle?: number;
  /** Sin estos bloques no hay filtrado, paraderos ni carriles de parqueo (comportamiento de la Fase 0). */
  filtering?: FilterCfg; busStops?: BusStopCfg; parking?: ParkingCfg;
}
export interface SignalCfg { green: number; yellow: number; allRed: number }

/**
 * Restricción que frena al vehículo: otro vehículo, jugador, obstáculo, semáforo, cruce ocupado, salida llena, fin del
 * camino, moto que debe volver al carril antes del cruce, buseta en su paradero.
 */
export type WaitReason = 'none' | 'leader' | 'player' | 'obstacle' | 'signal' | 'junction' | 'exit' | 'end' | 'merge' | 'busstop';
/** ¿El jugador ve este punto del suelo? (main.ts: frustum + distancia + rayo de oclusión). */
export type Visibility = (x: number, z: number) => boolean;

export interface Vehicle {
  id: number; type: VehicleType; length: number; width: number; v: number; v0f: number;
  path: Piece[]; s: number;
  /** Pieza que acaba de dejar atrás (la cola aún puede estar en ella), o null. */
  prev: Piece | null;
  /** Posición (con el desplazamiento lateral) y tangente del carril. */
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
  /**
   * Prelación concedida para romper un interbloqueo: en el próximo cruce ignora la salida llena, los turnos pedidos y
   * las reservas de quien sigue detenido antes de su línea (se las quita); no la de quien ya está dentro o entrando.
   */
  force: boolean;
  /** Momento en que obtuvo por prelación la reserva que tiene (-Infinity si no la obtuvo así). */
  forcedAt: number;
  /** Distancia libre (parachoques) a la restricción más cercana del último paso (Infinity si nada). */
  gap: number;
  /**
   * Desplazamiento lateral respecto al eje del carril (m, + = derecha de la marcha), el que persigue (moto que filtra,
   * buseta que se orilla) y su rapidez (m/s, para inclinar el rumbo al dibujar). x/z ya lo incluyen.
   */
  lat: number; latT: number; latV: number;
  /** Direccional: -1 izquierda, 1 derecha, 0 apagada (giro a < 30 m, maniobra lateral, orillarse). */
  blink: -1 | 0 | 1;
  /** Luces de parqueo (buseta detenida en el paradero). */
  hazard: boolean;
  /** Buseta: paradero hacia el que va (-1 ninguno), s que le quedan detenida y último paradero atendido o descartado. */
  stop: number; dwell: number; lastStop: number;
  /** Moto que filtra por la línea central: clave (arista·2 + sentido) + 1 que ocupa, 0 si no. */
  centre: number;
  /** Moto que avanza desplazada hasta la línea de pare para ponerse adelante: id del carril + 1, 0 si no. */
  run: number;
}
export interface Obstacle { x: number; z: number; r: number; isPlayer: boolean }
/**
 * Paradero de buseta (ESTIMADO, procedimental y determinista): (x, z) punto de espera en el andén (0,9 m tras el
 * sardinel); (bx, bz) donde para la buseta (carril `lane`, distancia `s` desde su inicio, `lat` m hacia el sardinel);
 * (tx, tz) sentido de la marcha.
 */
export interface BusStop { x: number; z: number; bx: number; bz: number; lane: number; s: number; lat: number; tx: number; tz: number }

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

/** Direccionales y luces de parqueo: ~1,5 Hz con el reloj de la simulación (se congelan en pausa), desfasadas por id. */
export function blinkOn(time: number, id: number) {
  const t = time * 1.5 + id * 0.37;
  return t - Math.floor(t) < 0.5;
}
/** Luz de freno encendida: frenando o detenido (en el semáforo, en la fila, en el paradero). */
export function brakeLit(v: Vehicle) { return v.braking || v.v < 0.3; }

const HIDDEN: Visibility = () => false;
/** Los inactivos se guardan lejos del mapa (separados: main.ts mueve allí sus cuerpos cinemáticos). */
const PARK = 10000;
/**
 * Un vehículo visible que sale del mapa se detiene a esta distancia del borde hasta dejar de verse: aún sobre el terreno
 * (60 m más allá del área) y con espacio para que la cola de la salida no llegue a los cruces del borde.
 */
const EXIT_STOP = 50;
/**
 * Raíz de una cadena de espera (unjam): se resuelve sola, ciclo (interbloqueo), obstáculo que no es el jugador o
 * vehículo retenido al final del camino (salida del mapa o callejón, mientras se vea).
 */
const ROOT_FREE = 1, ROOT_CYCLE = 2, ROOT_OBSTACLE = 3, ROOT_END = 4;
/** Rejilla de vecinos: celdas de 20 m (como en la Fase 0) y muestras del camino cada 1,5 m. */
const CELL = 20, SMAX = 160;
const MOTO_HW = DIMS.moto.width / 2, BUS_HW = DIMS.buseta.width / 2, BUS_HL = DIMS.buseta.length / 2;
/** Holgura lateral con los del mismo sentido / sentido contrario (la moto por la línea central les pasa al ras). */
const LAT_MARGIN = 0.15, SWEEP_MARGIN = 0.1, ONC_MARGIN = 0.03, MOVE_MARGIN = 0.05;
/** Separación de la moto al sardinel; |lat| máximo para entrar a un cruce; rapidez lateral de la buseta (m/s). */
const CURB_CLEAR = 0.15, LAT_CONN = 0.5, BUS_LAT_SPEED = 0.7;
/** Distancia (desde el frente) a la que se enciende la direccional antes de un giro. */
const BLINK_DIST = 30;

/** ¿Se tocan dos cajas orientadas en el plano? (ejes separadores; t = eje largo, medias longitudes hl/hw). */
function obbHit(ax: number, az: number, atx: number, atz: number, ahl: number, ahw: number,
  bx: number, bz: number, btx: number, btz: number, bhl: number, bhw: number) {
  const dx = bx - ax, dz = bz - az;
  const c = Math.abs(atx * btx + atz * btz), s = Math.abs(atx * btz - atz * btx);
  if (Math.abs(dx * atx + dz * atz) > ahl + bhl * c + bhw * s) return false;
  if (Math.abs(dz * atx - dx * atz) > ahw + bhl * s + bhw * c) return false;
  if (Math.abs(dx * btx + dz * btz) > bhl + ahl * c + ahw * s) return false;
  return Math.abs(dz * btx - dx * btz) <= bhw + ahl * s + ahw * c;
}

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
  /** Paraderos de buseta (ESTIMADOS; ver BusStop). */
  readonly busStops: BusStop[] = [];
  /**
   * Por arista (índice = id): holgura entre el borde de sus carriles y el sardinel derecho / izquierdo, en el sentido de
   * sus puntos, y si a ese lado hay carril de parqueo (holgura ≥ parking.minSpare; parked.ts estaciona sólo allí).
   */
  spareR!: Float64Array; spareL!: Float64Array;
  parkR!: Uint8Array; parkL!: Uint8Array;
  private rand: () => number;
  /** Decisiones de la Fase 1 (paraderos): generador aparte para no alterar la secuencia del tráfico base. */
  private rand2: () => number;
  private occupancy = new Map<number, Set<number>>();   // nodo → vehículos con reserva en ese cruce
  private claims = new Map<number, Set<number>>();      // nodo → vehículos que pidieron turno en ese cruce
  /** Conflictos entre trayectorias de un mismo cruce (se cruzan o confluyen). */
  private conflicts = new Map<number, Set<number>>();
  /** Por carril: menor s ocupada en este paso (espacio libre a la salida del cruce) y quién la ocupa. */
  private laneTail: Float64Array;
  private laneTailId: Int32Array;
  private signalOf = new Map<number, Controller>();
  private spent = 0;        // intentos de colocación gastados en este paso
  private cursor = 0;       // reparto equitativo de los intentos entre inactivos
  private mark: Int8Array;  // estado del recorrido de cadenas de espera
  // por carril: |lat| máximo de una moto a la derecha / izquierda, si a la izquierda está el sentido contrario, y
  // distancia del eje al sardinel derecho sin el carril de parqueo (Infinity si a la derecha hay otro carril)
  private roomR!: Float64Array; private roomL!: Float64Array; private onc!: Uint8Array; private curbR!: Float64Array;
  /** Motos que filtran por la línea central, por arista y sentido (una moto no la toma si la usa el contrario). */
  private centreCnt!: Int16Array;
  /** Por carril: moto que avanza hasta la línea (-1 ninguna); frente (s) y id del vehículo en el eje más adelantado. */
  private runner!: Int32Array; private laneHead!: Float64Array; private laneHeadId!: Int32Array;
  private stopsByLane = new Map<number, number[]>();
  // rejilla de vecinos (listas enlazadas en orden de id) y muestras del camino del vehículo en curso
  private gMin: number; private gN: number; private cellHead: Int32Array; private cellNext: Int32Array;
  private sS = new Float64Array(SMAX); private sX = new Float64Array(SMAX); private sZ = new Float64Array(SMAX);
  private sTX = new Float64Array(SMAX); private sTZ = new Float64Array(SMAX); private nS = 0;
  private pt = { x: 0, z: 0, tx: 0, tz: 1 }; private pr = { x: 0, z: 0, tx: 0, tz: 1 }; private pf = { x: 0, z: 0, tx: 0, tz: 1 };
  private obs: Obstacle[] = [];
  // resultado de gapAhead y de scanHome (campos para no reservar memoria)
  private gBest = Infinity; private gLV = 0; private gWhy: WaitReason = 'none'; private gBlk = -1;
  /** Barrido: contacto más cercano con un vehículo desplazado (distancia que puede avanzar el centro) y quién. */
  private gLatD = Infinity; private gLatId = -1;
  // carrocerías futuras del vehículo en curso (d = 0 y cada muestra) para el barrido
  private bD = new Float64Array(SMAX + 1); private bX = new Float64Array(SMAX + 1); private bZ = new Float64Array(SMAX + 1);
  private bTX = new Float64Array(SMAX + 1); private bTZ = new Float64Array(SMAX + 1); private bFor = -1;
  private q = { x: 0, z: 0, tx: 0, tz: 1 };
  private hFree = true; private hGap = Infinity; private hV = 0;

  constructor(g: RoadGraph, readonly cfg: TrafficCfg, readonly sig: SignalCfg, seed = 7, readonly areaHalf = 400,
    center: { x: number; z: number } | null = null) {
    // vías de un sentido con un solo carril de circulación y el resto para parquear (parking.oneLane)
    const one = cfg.parking?.oneLane ?? [];
    if (one.length) g = { ...g, edges: g.edges.map((e) => (e.fw === 0) === (e.bw === 0) || !one.includes(e.highway) ? e
      : { ...e, fw: Math.min(e.fw, 1), bw: Math.min(e.bw, 1) }) };
    this.lg = new LaneGraph(g);
    this.rand = rng(seed);
    this.rand2 = rng((seed * 2654435761 + 977) >>> 0);
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
    const nL = this.lg.lanes.length;
    this.laneTail = new Float64Array(nL);
    this.laneTailId = new Int32Array(nL);
    this.laneHead = new Float64Array(nL);
    this.laneHeadId = new Int32Array(nL);
    this.runner = new Int32Array(nL).fill(-1);
    this.layout(g);
    // rejilla que cubre el área con 400 m de sobra (salidas del mapa); lo que quede fuera va a la celda del borde
    this.gMin = Math.floor(-(areaHalf + 400) / CELL);
    this.gN = Math.ceil((2 * (areaHalf + 400)) / CELL) + 1;
    this.cellHead = new Int32Array(this.gN * this.gN);
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
    this.cellNext = new Int32Array(this.vehicles.length);
  }

  /** Holguras al sardinel, carriles de parqueo, espacio lateral de las motos por carril y paraderos de buseta. */
  private layout(g: RoadGraph) {
    const lanes = this.lg.lanes, nL = lanes.length;
    let nE = 0;
    for (const e of g.edges) nE = Math.max(nE, e.id + 1);
    this.spareR = new Float64Array(nE); this.spareL = new Float64Array(nE);
    this.parkR = new Uint8Array(nE); this.parkL = new Uint8Array(nE);
    this.centreCnt = new Int16Array(nE * 2);
    const lo = new Float64Array(nE).fill(Infinity), hi = new Float64Array(nE).fill(-Infinity);
    const oppW = new Float64Array(nE * 2);   // ancho del carril más a la izquierda de cada sentido
    for (const l of lanes) {
      const pos = l.dir === 1 ? l.offset : -l.offset, e = l.edge.id;
      lo[e] = Math.min(lo[e], pos - l.width / 2);
      hi[e] = Math.max(hi[e], pos + l.width / 2);
      if (l.idx === l.lanes - 1) oppW[e * 2 + (l.dir === 1 ? 0 : 1)] = l.width;
    }
    const pk = this.cfg.parking, minSpare = pk?.minSpare ?? Infinity, PW = pk?.width ?? 0;
    for (const e of g.edges) {
      if (hi[e.id] < lo[e.id]) continue;
      this.spareR[e.id] = Math.max(0, e.width / 2 - hi[e.id]);
      this.spareL[e.id] = Math.max(0, e.width / 2 + lo[e.id]);
      this.parkR[e.id] = this.spareR[e.id] >= minSpare ? 1 : 0;
      this.parkL[e.id] = this.spareL[e.id] >= minSpare ? 1 : 0;
    }
    this.roomR = new Float64Array(nL); this.roomL = new Float64Array(nL);
    this.onc = new Uint8Array(nL); this.curbR = new Float64Array(nL);
    const fc = this.cfg.filtering, cap = fc?.maxLat ?? 0;
    for (const l of lanes) {
      const e = l.edge, W = e.width / 2, twoWay = e.fw > 0 && e.bw > 0;
      // a la derecha de la marcha queda el sardinel derecho de la arista si dir = 1 (el izquierdo si dir = -1)
      const parkRight = l.dir === 1 ? this.parkR[e.id] : this.parkL[e.id];
      const parkLeft = l.dir === 1 ? this.parkL[e.id] : this.parkR[e.id];
      const curb = W - l.offset - (parkRight ? PW : 0);
      this.curbR[l.id] = l.idx === 0 ? curb : Infinity;
      let rr = l.idx > 0 ? l.width / 2 : curb - MOTO_HW - CURB_CLEAR, rl: number;
      if (l.idx < l.lanes - 1) rl = l.width / 2;                         // entre carriles del mismo sentido
      else if (twoWay) {
        // por la línea central: sin tocar una buseta en el carril contrario
        rl = l.offset + oppW[e.id * 2 + (l.dir === 1 ? 1 : 0)] / 2 - BUS_HW - MOTO_HW - 0.05;
        this.onc[l.id] = 1;
      } else rl = W + l.offset - (parkLeft ? PW : 0) - MOTO_HW - CURB_CLEAR;
      this.roomR[l.id] = Math.max(0, Math.min(cap, rr));
      this.roomL[l.id] = Math.max(0, Math.min(cap, rl));
    }
    // paraderos ESTIMADOS: en el carril derecho de vías de las clases dadas, lejos de cruces, cebras y bordes del mapa,
    // a lo sumo uno por cada `spacing` m de carril y separados `spacing` m de otro paradero del mismo sentido
    const bc = this.cfg.busStops;
    if (!bc) return;
    const r = rng(bc.seed), cross = (g.crossings ?? []) as { x: number; z: number }[];
    for (const l of lanes) {
      if (l.idx !== 0 || !bc.classes.includes(l.edge.highway)) continue;
      const L = l.poly.length, m = bc.fromJunction + BUS_HL;
      for (let s0 = m; s0 <= L - m; s0 += bc.spacing) {
        const s = s0 + r() * Math.min(bc.spacing, L - m - s0);
        if (r() > bc.prob) continue;
        const p = l.poly.at(s);
        if (Math.abs(p.x) > this.areaHalf - bc.edgeMargin || Math.abs(p.z) > this.areaHalf - bc.edgeMargin) continue;
        if (cross.some((c) => Math.hypot(c.x - p.x, c.z - p.z) < bc.fromCrossing)) continue;
        if (this.busStops.some((b) => Math.hypot(b.bx - p.x, b.bz - p.z) < (b.tx * p.tx + b.tz * p.tz > 0 ? bc.spacing : 12))) continue;
        const lat = Math.max(0, Math.min(this.curbR[l.id] - BUS_HW - 0.25, 1.9));
        const wait = l.edge.width / 2 - l.offset + 0.9, nx = -p.tz, nz = p.tx;
        const k = this.busStops.length;
        this.busStops.push({ x: p.x + nx * wait, z: p.z + nz * wait, bx: p.x + nx * lat, bz: p.z + nz * lat, lane: l.id, s, lat,
          tx: p.tx, tz: p.tz });
        if (!this.stopsByLane.has(l.id)) this.stopsByLane.set(l.id, []);
        this.stopsByLane.get(l.id)!.push(k);
      }
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

  /** Devuelve los pitos acumulados (cada uno una sola vez) y vacía `honks`. */
  drainHonks(): Vehicle[] {
    return this.honks.splice(0);
  }

  /** |lat| máximo de una moto en el carril hacia la derecha (side 1) o la izquierda (-1); 0 si no cabe. */
  laneRoom(laneId: number, side: 1 | -1) { return side > 0 ? this.roomR[laneId] : this.roomL[laneId]; }

  private newVehicle(id: number, type: VehicleType): Vehicle {
    const d = DIMS[type];
    return { id, type, length: d.length, width: d.width, v: 0, v0f: d.v0 * (0.9 + this.rand() * 0.2), path: [], s: 0, prev: null,
      x: 0, z: 0, tx: 0, tz: 1, px: 0, pz: 0, ptx: 0, ptz: 1, wait: 0, blockedByPlayer: 0, lastHonk: -99, braking: false,
      res: null, active: false, why: 'none', blocker: -1, jam: 0, claim: null, force: false, forcedAt: -Infinity, gap: Infinity,
      lat: 0, latT: 0, latV: 0, blink: 0, hazard: false, stop: -1, dwell: 0, lastStop: -1, centre: 0, run: 0 };
  }

  /** Sin maniobras laterales ni paradero (al aparecer o reciclarse). */
  private resetLife(v: Vehicle) {
    this.releaseCentre(v);
    this.endRun(v);
    v.lat = v.latT = v.latV = 0; v.blink = 0; v.hazard = false; v.stop = -1; v.dwell = 0; v.lastStop = -1; v.gap = Infinity;
  }

  /**
   * Coloca el vehículo en un carril libre y lo activa. Con `center` (el jugador), dentro de la burbuja de tráfico y a
   * más de `minD` m de él; sin centro, en cualquier parte del área. Nunca en un punto que el jugador vea, ni en un
   * carril sin salida (se reciclaría en el paso siguiente).
   */
  private place(v: Vehicle, center: { x: number; z: number } | null, minD = this.cfg.respawnMinDistance,
    visible: Visibility = HIDDEN, tries = 120) {
    const lanes = this.lg.lanes;
    const R = this.cfg.bubbleRadius ?? Infinity;
    for (let k = 0; k < tries; k++) {
      this.spent++;
      const l = lanes[Math.floor(this.rand() * lanes.length)];
      if (l.poly.length < 12 || !l.outs.length) continue;
      const s = 4 + this.rand() * (l.poly.length - 8);
      const p = l.poly.at(s, this.pt);
      if (Math.abs(p.x) > this.areaHalf || Math.abs(p.z) > this.areaHalf) continue;
      if (center) {
        const d = Math.hypot(p.x - center.x, p.z - center.z);
        if (d < minD || d > R) continue;
      }
      if (this.crowded(v, p.x, p.z)) continue;
      if (visible(p.x, p.z)) continue;
      v.active = true;
      v.path = [l];
      v.prev = null;
      v.s = s;
      v.v = l.speed * 0.5;
      v.wait = 0; v.jam = 0; v.blockedByPlayer = 0; v.braking = false; v.force = false; v.why = 'none'; v.blocker = -1;
      v.forcedAt = -Infinity;
      this.resetLife(v);
      this.extend(v);
      this.updatePose(v);
      v.px = v.x; v.pz = v.z; v.ptx = v.tx; v.ptz = v.tz;
      return true;
    }
    return false;
  }

  /** Hay otro activo a < 14 m del punto. */
  private crowded(v: Vehicle, x: number, z: number) {
    for (const o of this.vehicles) if (o.active && o !== v && Math.hypot(o.x - x, o.z - z) < 14) return true;
    return false;
  }

  /** Desactiva el vehículo (sin reserva, fuera del mundo) hasta que haya dónde reaparecer sin que se vea. */
  private park(v: Vehicle) {
    this.release(v);
    this.unclaim(v);
    this.resetLife(v);
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
        let sum = 0;
        for (const c of opts) sum += c.turn === 'S' ? 3 : c.turn === 'U' ? 0.2 : 1;
        let r = this.rand() * sum;
        next = opts[opts.length - 1];
        for (const c of opts) { const w = c.turn === 'S' ? 3 : c.turn === 'U' ? 0.2 : 1; if (r < w) { next = c; break; } r -= w; }
      } else {
        next = last.to;
      }
      v.path.push(next);
      ahead += next.poly.length;
    }
  }

  /** Punto del camino de v a la distancia d de su centro (d < 0: hacia atrás, en la pieza que acaba de dejar). */
  private pathAt(v: Vehicle, d: number, out: { x: number; z: number; tx: number; tz: number }) {
    let s = v.s + d;
    if (s < 0) {
      const pr = v.prev, p0 = v.path[0];
      const linked = !!pr && (pr.kind === 'conn' ? pr.to === p0 : p0.kind === 'conn' && p0.from === pr);
      if (linked && pr!.poly.length > 0.01 && s > -pr!.poly.length) return pr!.poly.at(pr!.poly.length + s, out);
      v.path[0].poly.at(0, out);
    } else {
      const P = v.path;
      for (let i = 0; i < P.length; i++) {
        const L = P[i].poly.length;
        if (s <= L && (L > 0.01 || i === P.length - 1)) return P[i].poly.at(s, out);
        s -= L;
      }
      P[P.length - 1].poly.at(Infinity, out);
    }
    out.x += out.tx * s; out.z += out.tz * s;   // más allá de los extremos: recta
    return out;
  }

  /**
   * Pose: la carrocería es la cuerda entre los puntos del camino bajo sus parachoques (desplazados `lat`), así la cola
   * sigue por dentro de las curvas y no barre hacia afuera (en un tramo recto, el punto del camino en s).
   */
  private updatePose(v: Vehicle) {
    const hl = v.length / 2, r = this.pathAt(v, -hl, this.pr), f = this.pathAt(v, hl, this.pf);
    const rx = r.x - r.tz * v.lat, rz = r.z + r.tx * v.lat, fx = f.x - f.tz * v.lat, fz = f.z + f.tx * v.lat;
    let tx = fx - rx, tz = fz - rz;
    const L = Math.sqrt(tx * tx + tz * tz);
    if (L > 1e-6) { tx /= L; tz /= L; } else { tx = f.tx; tz = f.tz; }
    v.x = (rx + fx) / 2; v.z = (rz + fz) / 2; v.tx = tx; v.tz = tz;
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

  private cellOf(x: number) {
    const c = Math.floor(x / CELL) - this.gMin;
    return c < 0 ? 0 : c >= this.gN ? this.gN - 1 : c;
  }

  /** Rejilla de vecinos (en cada celda, en orden de id) y cola de cada carril (para la regla de salida libre). */
  private buildGrid() {
    const V = this.vehicles, head = this.cellHead, next = this.cellNext;
    head.fill(-1);
    this.laneTail.fill(Infinity);
    this.laneTailId.fill(-1);
    this.laneHead.fill(-Infinity);
    this.laneHeadId.fill(-1);
    for (let i = V.length - 1; i >= 0; i--) {
      const v = V[i];
      if (!v.active) continue;
      const c = this.cellOf(v.x) * this.gN + this.cellOf(v.z);
      next[i] = head[c]; head[c] = i;
    }
    for (const v of V) {
      if (!v.active) continue;
      const p0 = v.path[0];
      if (p0.kind === 'lane') {
        const tailS = v.s - v.length / 2, headS = v.s + v.length / 2;
        if (tailS < this.laneTail[p0.id]) { this.laneTail[p0.id] = tailS; this.laneTailId[p0.id] = v.id; }
        if (Math.abs(v.lat) <= LAT_CONN && headS > this.laneHead[p0.id]) { this.laneHead[p0.id] = headS; this.laneHeadId[p0.id] = v.id; }
      }
    }
  }

  /** Muestras del camino futuro cada 1,5 m (distancia d medida desde el vehículo) en los búferes sS/sX/sZ/sTX/sTZ. */
  private sample(v: Vehicle) {
    const look = this.cfg.lookahead;
    let n = 0, startD = -v.s;                       // distancia del vehículo al inicio de la pieza
    for (const piece of v.path) {
      const L = piece.poly.length;
      for (let s = Math.max(0, -startD + 0.5); s <= L; s += 1.5) {
        const d = startD + s;
        if (d > look || n >= SMAX) break;
        const p = piece.poly.at(s, this.pt);
        this.sS[n] = d; this.sX[n] = p.x; this.sZ[n] = p.z; this.sTX[n] = p.tx; this.sTZ[n] = p.tz; n++;
      }
      startD += L;
      if (startD > look) break;
    }
    this.nS = n;
    return startD;
  }

  private setBest(gap: number, lv: number, w: WaitReason, id: number) {
    this.gBest = gap; this.gLV = lv; this.gWhy = w; this.gBlk = id;
  }

  /** Prueba de la Fase 0 (sin desplazamientos laterales): primera muestra del camino a menos de la suma de anchos. */
  private checkRound(v: Vehicle, ox: number, oz: number, halfLen: number, halfW: number, ov: number, w: WaitReason, id: number) {
    const thr = v.width / 2 + halfW + 0.25, thr2 = thr * thr, hl = v.length / 2;
    for (let k = 0; k < this.nS; k++) {
      const s = this.sS[k];
      if (s - hl - halfLen > this.gBest) break;   // gBest es de parachoques a parachoques
      const dx = ox - this.sX[k], dz = oz - this.sZ[k];
      if (dx * dx + dz * dz < thr2) {
        const gap = s - hl - halfLen;
        if (gap < this.gBest) this.setBest(gap, ov, w, id);
        break;
      }
    }
  }

  /** Punto del eje del camino de v a la distancia d de su centro, interpolado de las muestras (recta en los extremos). */
  private bufAt(v: Vehicle, d: number, out: { x: number; z: number; tx: number; tz: number }) {
    const n = this.nS, S = this.sS;
    const ax = v.x + v.tz * v.lat, az = v.z - v.tx * v.lat;   // d = 0: centro de v sobre el eje
    if (d <= 0 || n === 0) { out.x = ax + v.tx * d; out.z = az + v.tz * d; out.tx = v.tx; out.tz = v.tz; return out; }
    let lo = 0, hi = n;
    while (lo < hi) { const m = (lo + hi) >> 1; if (S[m] < d) lo = m + 1; else hi = m; }
    if (lo >= n) {
      const k = n - 1, e = d - S[k];
      out.x = this.sX[k] + this.sTX[k] * e; out.z = this.sZ[k] + this.sTZ[k] * e; out.tx = this.sTX[k]; out.tz = this.sTZ[k];
      return out;
    }
    const d0 = lo ? S[lo - 1] : 0, x0 = lo ? this.sX[lo - 1] : ax, z0 = lo ? this.sZ[lo - 1] : az;
    const t = S[lo] - d0 > 1e-6 ? (d - d0) / (S[lo] - d0) : 1;
    out.x = x0 + (this.sX[lo] - x0) * t; out.z = z0 + (this.sZ[lo] - z0) * t; out.tx = this.sTX[lo]; out.tz = this.sTZ[lo];
    return out;
  }

  /** Carrocería de v con el centro a la distancia d (cuerda entre parachoques, en el corredor c) → q (x, z, tx, tz). */
  private bodyAt(v: Vehicle, d: number, c: number) {
    const hl = v.length / 2, r = this.bufAt(v, d - hl, this.pr), f = this.bufAt(v, d + hl, this.pf);
    const rx = r.x - r.tz * c, rz = r.z + r.tx * c, fx = f.x - f.tz * c, fz = f.z + f.tx * c;
    let tx = fx - rx, tz = fz - rz;
    const L = Math.sqrt(tx * tx + tz * tz);
    if (L > 1e-6) { tx /= L; tz /= L; } else { tx = f.tx; tz = f.tz; }
    const q = this.q;
    q.x = (rx + fx) / 2; q.z = (rz + fz) / 2; q.tx = tx; q.tz = tz;
    return q;
  }

  /**
   * Prueba de barrido para pares con desplazamiento lateral: las carrocerías futuras de v (cuerda entre parachoques en
   * cada muestra de su camino, en su corredor c ± hw) contra la caja orientada del otro (ya ensanchada hacia donde va).
   * Devuelve cuánto puede avanzar el centro de v antes de tocarla (Infinity si nunca en la anticipación).
   */
  private sweep(v: Vehicle, c: number, hw: number, ox: number, oz: number, otx: number, otz: number, ohl: number, ohw: number) {
    const hl = v.length / 2;
    if (this.bFor !== v.id) {
      // carrocerías en d = 0 y en cada muestra (una vez por vehículo y paso)
      this.bFor = v.id;
      const n = this.nS;
      for (let k = 0; k <= n; k++) {
        const d = k ? this.sS[k - 1] : 0, q = this.bodyAt(v, d, c);
        this.bD[k] = d; this.bX[k] = q.x; this.bZ[k] = q.z; this.bTX[k] = q.tx; this.bTZ[k] = q.tz;
      }
    }
    const n = this.nS + 1;
    for (let k = 0; k < n; k++) {
      if (k && this.bD[k - 1] >= this.gBest) break;   // ya no mejora
      if (!obbHit(this.bX[k], this.bZ[k], this.bTX[k], this.bTZ[k], hl, hw, ox, oz, otx, otz, ohl, ohw)) continue;
      if (!k) return 0;
      // se toca entre la muestra anterior y esta: bisección
      let lo = this.bD[k - 1], hi = this.bD[k];
      for (let it = 0; it < 4; it++) {
        const m = (lo + hi) / 2, q = this.bodyAt(v, m, c);
        if (obbHit(q.x, q.z, q.tx, q.tz, hl, hw, ox, oz, otx, otz, ohl, ohw)) hi = m; else lo = m;
      }
      return lo;
    }
    return Infinity;
  }

  /** Par con desplazamiento lateral: barrido de v contra o (con el lado al que va o) y su holgura lateral. */
  private checkSweep(v: Vehicle, o: Vehicle, c: number, hw: number, ov: number) {
    const cos = o.tx * v.tx + o.tz * v.tz, dl = o.latT - o.lat, sh = dl / 2;
    const d = this.sweep(v, c, hw, o.x - o.tz * sh, o.z + o.tx * sh, o.tx, o.tz, o.length / 2,
      o.width / 2 + Math.abs(dl) / 2 + (cos < -0.5 ? ONC_MARGIN : SWEEP_MARGIN));
    if (d < this.gLatD) { this.gLatD = d; this.gLatId = o.id; }
    if (d < this.gBest) this.setBest(d, ov, 'leader', o.id);
  }

  /**
   * Distancia libre hasta la restricción más cercana en el camino (otros vehículos, jugador, semáforo, cruce ocupado,
   * moto que debe volver al carril, paradero). Deja el resultado en gBest/gLV/gWhy/gBlk.
   */
  private gapAhead(v: Vehicle, obstacles: Obstacle[]) {
    this.gBest = Infinity; this.gLV = 0; this.gWhy = 'none'; this.gBlk = -1;
    this.gLatD = Infinity; this.gLatId = -1; this.bFor = -1;
    const look = this.cfg.lookahead, fc = this.cfg.filtering;
    const startD = this.sample(v);
    // corredor lateral de v: entre donde está y adonde va
    const lateral = v.lat !== 0 || v.latT !== 0;
    const cV = (v.lat + v.latT) / 2, hwV = v.width / 2 + Math.abs(v.latT - v.lat) / 2;
    const V = this.vehicles, head = this.cellHead, next = this.cellNext, N = this.gN;
    const cx = this.cellOf(v.x), cz = this.cellOf(v.z);
    for (let i = -2; i <= 2; i++) {
      const gx = cx + i;
      if (gx < 0 || gx >= N) continue;
      for (let j = -2; j <= 2; j++) {
        const gz = cz + j;
        if (gz < 0 || gz >= N) continue;
        for (let oi = head[gx * N + gz]; oi >= 0; oi = next[oi]) {
          const o = V[oi];
          if (o === v) continue;
          // detrás de mí: ignorar
          if ((o.x - v.x) * v.tx + (o.z - v.z) * v.tz < 0) continue;
          const ov = Math.max(0, o.v * (o.tx * v.tx + o.tz * v.tz));
          if (lateral || o.lat !== 0 || o.latT !== 0) this.checkSweep(v, o, cV, hwV, ov);
          else this.checkRound(v, o.x, o.z, o.length / 2, o.width / 2, ov, 'leader', o.id);
        }
      }
    }
    for (const ob of obstacles) {
      if ((ob.x - v.x) * v.tx + (ob.z - v.z) * v.tz < 0) continue;
      const w: WaitReason = ob.isPlayer ? 'player' : 'obstacle';
      if (lateral) {
        const d = this.sweep(v, cV, hwV, ob.x, ob.z, v.tx, v.tz, ob.r, ob.r + 0.25);
        if (d < this.gBest) this.setBest(d, 0, w, -1);
      } else this.checkRound(v, ob.x, ob.z, ob.r, ob.r, 0, w, -1);
    }
    // fin del camino: callejón sin salida, o salida del mapa (sólo llega allí quien sigue a la vista)
    const last = v.path[v.path.length - 1];
    if (startD <= look && last.kind === 'lane' && !last.outs.length) this.stopAt(v, startD);
    for (let k = 0; k < this.nS; k++) if (this.outside(this.sX[k], this.sZ[k], EXIT_STOP)) { this.stopAt(v, this.sS[k]); break; }
    const p0 = v.path[0];
    const moto = v.type === 'moto' && !!fc;
    // la moto se detiene más adelante que los carros (su frente a stopFront m del final del carril)
    const adv = moto ? fc!.s0 - fc!.stopFront : -0.5;
    // buseta hacia su paradero: el centro se detiene en él (la reserva del cruce espera a que salga)
    let held = false;
    if (v.stop >= 0) {
      const d = this.stopDist(v, v.stop);
      if (d > -2) {
        const g = d + this.cfg.idm.s0;
        if (g < this.gBest) this.setBest(Math.max(0.01, g), 0, 'busstop', -1);
        held = this.busStops[v.stop].lane === p0.id && p0.kind === 'lane';
      }
    }
    // moto fuera del eje del carril: debe volver a él antes del final del carril (no entra así al cruce ni lo reserva) y
    // se queda antes de la zona de giro, salvo si avanza hasta la línea
    if (p0.kind === 'lane' && (Math.abs(v.lat) > LAT_CONN || Math.abs(v.latT) > LAT_CONN)) {
      const out = fc && this.runner[p0.id] !== v.id ? fc.zone - fc.stopFront : 0;
      const g = p0.poly.length - v.s - v.length / 2 + adv - out;
      if (g < this.gBest) this.setBest(Math.max(0.01, g), 0, 'merge', -1);
      held = true;
    }
    if (held) {
      if (v.res && v.res.from === p0) this.release(v);
      return;
    }
    // semáforos y cruces sin semáforo: parada virtual al final del carril (se mira al menos la distancia de frenado,
    // para no descubrir un amarillo cuando ya no hay cómo parar)
    const brake = (v.v * v.v) / (2 * this.cfg.idm.b);
    let dist = p0.poly.length - v.s;
    for (let i = 0; i < v.path.length; i++) {
      const piece = v.path[i];
      if (i > 0) dist += piece.poly.length;
      if (piece.kind !== 'lane') continue;
      if (dist > Math.max(look, brake + 5)) break;
      const stopGap = dist - v.length / 2 + adv;
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
      // un vehículo desplazado (moto que filtra) quedaría barrido en el cruce o a su salida, o una moto de su carril
      // avanza hasta la línea para ponerse adelante: espera en la línea, no adentro
      if (go && (!reserved || stopGap > brake - 1)) {
        // (salvo quien ya está en el puesto de adelante: ese sale primero)
        const run = i === 0 ? this.runner[piece.id] : -1, R = run >= 0 ? this.vehicles[run] : v;
        if (R !== v && v.s - v.length / 2 < piece.poly.length - (fc ? fc.stopFront : 0) - R.length) { go = false; w = 'exit'; id = run; }
        else if (this.gLatD > dist - v.length / 2 - 1 && this.gLatD < dist + (next ? next.poly.length : 0) + v.length) {
          go = false; w = 'exit'; id = this.gLatId;
        }
      }
      if (reserved) {
        if (go) break;                                           // ya tiene paso reservado
        this.release(v);
      }
      if (go && atJunction && next) {
        // ningún ocupante con trayectoria en conflicto, espacio a la salida ("no bloquear el cruce") y respeto del
        // turno pedido por quien lleva más esperando; con prelación (interbloqueo) sólo cuentan los que ya están
        // dentro o entrando (los detenidos antes de su línea pierden la reserva al confirmarse la prelación)
        const conf = this.conflicts.get(next.id);
        for (const oid of this.occupancy.get(next.node) ?? []) {
          const o = this.vehicles[oid];
          if (o !== v && o.res && conf?.has(o.res.id) && (!v.force || o.v >= 0.3 || this.entered(o))) {
            go = false; w = 'junction'; id = oid; break;
          }
        }
        if (!v.force) {
          const tail = this.laneTail[next.to.id];
          if (go && tail < v.length + this.cfg.idm.s0 + 1) { go = false; w = 'exit'; id = this.laneTailId[next.to.id]; }
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
          if (v.force) {
            for (const oid of [...(this.occupancy.get(next.node) ?? [])]) {
              const o = this.vehicles[oid];
              if (o.res && conf?.has(o.res.id)) this.release(o);   // esperan su turno de nuevo
            }
          }
          v.res = next;
          v.forcedAt = v.force ? this.time : -Infinity;
          v.force = false;
          if (!this.occupancy.has(next.node)) this.occupancy.set(next.node, new Set());
          this.occupancy.get(next.node)!.add(v.id);
        }
      }
      if (!go && stopGap < this.gBest && stopGap > -1.5) this.setBest(Math.max(0.01, stopGap), 0, w, id);
      break;   // sólo el próximo final de carril
    }
  }

  /** Parada al final del camino a la distancia d (desde el centro del vehículo). */
  private stopAt(v: Vehicle, d: number) {
    const g = d - v.length / 2 - 0.5;
    if (g < this.gBest) this.setBest(Math.max(0.01, g), 0, 'end', -1);
  }

  private release(v: Vehicle) {
    if (v.res) this.occupancy.get(v.res.node)?.delete(v.id);
    v.res = null;
    v.forcedAt = -Infinity;
  }

  /** Con reserva: está físicamente en el cruce (pasó su línea de pare y la cola aún no salió). */
  private entered(o: Vehicle) {
    const r = o.res!, p0 = o.path[0];
    return p0 === r || (p0 === r.to && o.s < o.length / 2 + 0.5) ||
      (p0 === r.from && o.s + o.length / 2 > r.from.poly.length - 0.5);
  }

  private unclaim(v: Vehicle) {
    if (v.claim) this.claims.get(v.claim.node)?.delete(v.id);
    v.claim = null;
  }

  // ------------------------------------------------------------------ Fase 1: filtrado, paraderos, direccionales

  /** Clave de la línea central de un carril: la propia (sentido del carril) o la del sentido contrario. */
  private centreKey(l: Lane, opposite: boolean) { return l.edge.id * 2 + ((l.dir === 1) !== opposite ? 0 : 1); }

  private releaseCentre(v: Vehicle) {
    if (v.centre) { this.centreCnt[v.centre - 1]--; v.centre = 0; }
  }

  private endRun(v: Vehicle) {
    if (v.run) { if (this.runner[v.run - 1] === v.id) this.runner[v.run - 1] = -1; v.run = 0; }
  }


  /**
   * ¿Algún vehículo u obstáculo ocupa la franja lateral [c − hw, c + hw] (marco del carril de v en su posición) entre
   * `behind` m detrás de su cola y `ahead` m delante de su frente? `intent`: cuenta también el lado al que van los demás;
   * a quien viene detrás se le exige además `headway`·v m. Devuelve su id (-2 si es un obstáculo) o -1.
   */
  private blockedBand(v: Vehicle, c: number, hw: number, ahead: number, behind: number, intent: boolean, headway: number,
    margin: number) {
    const tx = v.tx, tz = v.tz, bx = v.x + tz * v.lat, bz = v.z - tx * v.lat, hl = v.length / 2;
    const V = this.vehicles, head = this.cellHead, next = this.cellNext, N = this.gN;
    const cx = this.cellOf(v.x), cz = this.cellOf(v.z);
    for (let i = -1; i <= 1; i++) {
      const gx = cx + i;
      if (gx < 0 || gx >= N) continue;
      for (let j = -1; j <= 1; j++) {
        const gz = cz + j;
        if (gz < 0 || gz >= N) continue;
        for (let oi = head[gx * N + gz]; oi >= 0; oi = next[oi]) {
          const o = V[oi];
          if (o === v || !o.active) continue;
          const dx = o.x - bx, dz = o.z - bz, along = dx * tx + dz * tz;
          const cos = o.tx * tx + o.tz * tz, ac = Math.abs(cos), as = Math.abs(o.tx * tz - o.tz * tx);
          let lat = dz * tx - dx * tz, hwE = ac * (o.width / 2) + as * (o.length / 2);
          const hlE = ac * (o.length / 2) + as * (o.width / 2);
          if (intent && o.latT !== o.lat) { lat += ((o.latT - o.lat) / 2) * cos; hwE += (Math.abs(o.latT - o.lat) / 2) * ac; }
          if (Math.abs(lat - c) >= hw + hwE + (cos < -0.5 ? Math.min(margin, ONC_MARGIN) : margin)) continue;
          const back = along < 0 ? behind + headway * o.v : behind;
          if (along + hlE > -hl - back && along - hlE < hl + ahead) return o.id;
        }
      }
    }
    for (const ob of this.obs) {
      const dx = ob.x - bx, dz = ob.z - bz, along = dx * tx + dz * tz, lat = dz * tx - dx * tz;
      if (Math.abs(lat - c) < hw + ob.r + margin && along + ob.r > -hl - behind && along - ob.r < hl + ahead) return -2;
    }
    return -1;
  }

  /**
   * Moto que filtra: ¿está libre su puesto en el eje del carril (con distancia para quien viene detrás)? y la fila que
   * aún tiene al lado o adelante en el eje (brecha desde su frente, rapidez). Resultado en hFree/hGap/hV.
   */
  private scanHome(v: Vehicle) {
    this.hFree = true; this.hGap = Infinity; this.hV = 0;
    const tx = v.tx, tz = v.tz, bx = v.x + tz * v.lat, bz = v.z - tx * v.lat, hl = v.length / 2, hw = v.width / 2 + 0.1;
    const V = this.vehicles, head = this.cellHead, next = this.cellNext, N = this.gN;
    const cx = this.cellOf(v.x), cz = this.cellOf(v.z);
    for (let i = -1; i <= 1; i++) {
      const gx = cx + i;
      if (gx < 0 || gx >= N) continue;
      for (let j = -1; j <= 1; j++) {
        const gz = cz + j;
        if (gz < 0 || gz >= N) continue;
        for (let oi = head[gx * N + gz]; oi >= 0; oi = next[oi]) {
          const o = V[oi];
          if (o === v || !o.active) continue;
          const dx = o.x - bx, dz = o.z - bz, along = dx * tx + dz * tz;
          const cos = o.tx * tx + o.tz * tz, ac = Math.abs(cos), as = Math.abs(o.tx * tz - o.tz * tx);
          let lat = dz * tx - dx * tz, hwE = ac * (o.width / 2) + as * (o.length / 2);
          const hlE = ac * (o.length / 2) + as * (o.width / 2);
          if (o.latT !== o.lat) { lat += ((o.latT - o.lat) / 2) * cos; hwE += (Math.abs(o.latT - o.lat) / 2) * ac; }
          if (Math.abs(lat) >= hw + hwE) continue;
          // detrás: distancia según su rapidez (al que está detenido esperándola le basta no tocarlo)
          const back = along >= 0 ? 0.3 : o.v < 0.3 && o.blocker === v.id ? 0.05 : 0.3 + 0.7 * o.v;
          if (along + hlE > -hl - back && along - hlE < hl + 0.4) this.hFree = false;
          if (along + hlE > -hl) {
            const g = along - hlE - hl;
            if (g < this.hGap) { this.hGap = g; this.hV = o.v; }
          }
        }
      }
    }
    for (const ob of this.obs) {
      const dx = ob.x - bx, dz = ob.z - bz, along = dx * tx + dz * tz, lat = dz * tx - dx * tz;
      if (Math.abs(lat) < hw + ob.r && along + ob.r > -hl - 0.3 && along - ob.r < hl + 0.4) this.hFree = false;
    }
  }

  /**
   * Moto: empieza a filtrar si el de adelante (en su carril, no otra moto) va lento y cerca, y hay espacio a un lado
   * (sardinel, entre carriles o la línea central si el contrario no la usa); vuelve al eje cuando ya no tiene fila al
   * lado ni adelante (o quedó atascada en su franja) y su puesto está libre. Siempre vuelve antes del cruce (gapAhead).
   */
  private filterLogic(v: Vehicle, fc: FilterCfg) {
    const p0 = v.path[0];
    if (v.run && (p0.id !== v.run - 1 || p0.kind !== 'lane' || (v.latT === 0 && Math.abs(v.lat) <= LAT_CONN))) this.endRun(v);
    if (p0.kind !== 'lane') { v.latT = 0; return; }
    const L = p0.poly.length, hl = v.length / 2;
    if (v.latT === 0) {
      if (v.lat !== 0 || v.res || v.why !== 'leader' || v.blocker < 0 || v.gap > fc.look) return;
      const o = this.vehicles[v.blocker];
      if (!o.active || o.type === 'moto' || o.v > fc.slow || o.path[0] !== p0) return;
      if (p0.poly.length - v.s < v.length + 4) return;
      const rR = this.roomR[p0.id], rL = this.roomL[p0.id], ohw = o.width / 2;
      let pick = 0;
      for (let k = 0; k < 2 && !pick; k++) {
        // primero el lado con más espacio (a la par: la izquierda, entre carriles o por la línea central)
        const side = (k === 0) === (rR > rL + 0.3) ? 1 : -1;
        const room = side > 0 ? rR : rL;
        const req = (side > 0 ? o.lat : -o.lat) + ohw + MOTO_HW + fc.clear;
        if (room < req) continue;
        if (v.s - hl < fc.zone || L - v.s - hl < fc.zone + 1) continue;   // zonas de giro
        if (side < 0 && this.onc[p0.id] && this.centreCnt[this.centreKey(p0, true)] > 0) continue;
        const t = side * Math.min(room, Math.max(req, fc.cruise));
        if (this.blockedBand(v, t, MOTO_HW, 1, 0.3, true, 0.7, LAT_MARGIN) !== -1) continue;
        pick = t;
      }
      if (!pick) return;
      v.latT = pick;
      if (pick < 0 && this.onc[p0.id]) { const k = this.centreKey(p0, false); this.centreCnt[k]++; v.centre = k + 1; }
      return;
    }
    this.scanHome(v);
    const queue = this.hGap < fc.look && this.hV < fc.slow + 1;
    const stuck = v.why === 'leader' && v.v < 0.5 && v.gap < 1.5;
    if (this.hFree && (!queue || stuck)) { v.latT = 0; return; }
    // junto a la zona de giro: avanza hasta la línea si el puesto de adelante está libre y el primero de la fila está
    // detenido esperando en ella (una moto por carril; mientras tanto el resto del carril no entra al cruce)
    if (!v.run && this.runner[p0.id] < 0 && L - v.s - hl < fc.zone + 3) {
      const h = this.laneHeadId[p0.id], H = h >= 0 ? this.vehicles[h] : null;
      if (H && H.v < 0.3 && (H.why === 'signal' || H.why === 'junction' || H.why === 'exit') &&
        this.laneHead[p0.id] <= L - fc.stopFront - v.length - 0.35) { this.runner[p0.id] = v.id; v.run = p0.id + 1; }
    }
  }

  /** Distancia por el camino del centro de la buseta a su paradero k (-Infinity si ya no está en el camino). */
  private stopDist(v: Vehicle, k: number) {
    const b = this.busStops[k];
    let base = -v.s;
    for (const p of v.path) { if (p.kind === 'lane' && p.id === b.lane) return base + b.s; base += p.poly.length; }
    return -Infinity;
  }

  /** Buseta: elige paradero al verlo venir (no siempre), se orilla, para con luces de parqueo y vuelve al carril. */
  private busLogic(v: Vehicle, dt: number, bc: BusStopCfg) {
    if (v.dwell > 0) {
      v.dwell -= dt;
      if (v.dwell <= 0) { v.dwell = 0; v.hazard = false; v.lastStop = v.stop; v.stop = -1; v.latT = 0; }
      return;
    }
    if (v.stop >= 0) {
      const d = this.stopDist(v, v.stop);
      if (d < -1.5) { v.lastStop = v.stop; v.stop = -1; v.latT = 0; return; }   // se lo pasó o cambió de camino
      if (d < bc.approach) v.latT = this.busStops[v.stop].lat;
      if (d < 1 && v.v < 0.2) { v.dwell = bc.dwell[0] + this.rand2() * (bc.dwell[1] - bc.dwell[0]); v.hazard = true; }
      return;
    }
    // próximo paradero en el camino, dentro de la anticipación y con espacio para frenar con calma
    const look = this.cfg.lookahead, need = (v.v * v.v) / 4 + 4;
    let base = -v.s;
    for (const p of v.path) {
      if (base > look) break;
      if (p.kind === 'lane') {
        const list = this.stopsByLane.get(p.id);
        if (list) {
          for (const k of list) {
            const d = base + this.busStops[k].s;
            if (d < need || k === v.lastStop) continue;
            if (d > look) break;
            if (this.rand2() < bc.use) v.stop = k; else v.lastStop = k;
            return;
          }
        }
      }
      base += p.poly.length;
    }
  }

  /** Movimiento lateral hacia latT si la franja barrida está libre (si no, espera en su sitio). */
  private moveLat(v: Vehicle, dt: number, fc: FilterCfg | undefined) {
    const dl = v.latT - v.lat;
    if (dl === 0) { v.latV = 0; return; }
    const rate = (v.type === 'moto' ? fc?.latSpeed ?? 1 : BUS_LAT_SPEED) * Math.min(1, 0.35 + v.v / 4);
    const st = Math.max(-rate * dt, Math.min(rate * dt, dl));
    if (this.blockedBand(v, v.lat + st / 2, v.width / 2 + Math.abs(st) / 2, 0.05, 0.05, false, 0, MOVE_MARGIN) !== -1) {
      v.latV = 0;
      return;
    }
    v.lat += st;
    v.x -= v.tz * st; v.z += v.tx * st;
    v.latV = st / dt;
    if (v.latT === 0 && Math.abs(v.lat) < 0.3) this.releaseCentre(v);
  }

  /**
   * Direccional: orillarse al paradero, giro del próximo cruce a < BLINK_DIST m del frente (manda sobre la maniobra
   * lateral: la moto que vuelve al eje antes de girar a la izquierda no pone la derecha, ni la buseta que va a un
   * paradero después del giro) o maniobra lateral.
   */
  private updateBlink(v: Vehicle) {
    let b: -1 | 0 | 1 = 0, turn: -1 | 0 | 1 = 0;
    const dl = v.latT - v.lat;
    let d = -v.s - v.length / 2;
    for (const p of v.path) {
      if (p.kind === 'conn') { if (d <= BLINK_DIST) turn = p.turn === 'R' ? 1 : p.turn === 'S' ? 0 : -1; break; }
      d += p.poly.length;
      if (d > BLINK_DIST) break;
    }
    // orillarse manda si el paradero está antes del cruce (en el carril actual); si está después, primero el giro
    const p0 = v.path[0], stopHere = v.stop >= 0 && p0.kind === 'lane' && this.busStops[v.stop].lane === p0.id;
    if (v.hazard) b = 0;
    else if (stopHere || (v.stop >= 0 && !turn)) b = 1;
    else if (turn) b = turn;
    else if (dl > 0.2) b = 1;
    else if (dl < -0.2) b = -1;
    v.blink = b;
  }

  /**
   * Avanza la simulación. `visible(x, z)` dice si el jugador ve ese punto del suelo; sin él, nada se considera visible.
   * Sólo se aparece en puntos no visibles; el que pasa de despawnDistance se recicla sólo si no se ve (o si pasa de
   * despawnHardDistance), y el resto sigue circulando.
   */
  step(dt: number, obstacles: Obstacle[] = [], playerPos: { x: number; z: number } | null = null, visible?: Visibility) {
    const vis = visible ?? HIDDEN;
    this.time += dt;
    this.obs = obstacles;
    this.buildGrid();
    const idm = this.cfg.idm, fc = this.cfg.filtering, bc = this.cfg.busStops;
    const far = this.cfg.despawnDistance ?? Infinity, hard = this.cfg.despawnHardDistance ?? Infinity;
    let jammed = false;
    for (const v of this.vehicles) {
      if (!v.active) continue;
      const lane = v.path[0].kind === 'lane' ? v.path[0] : (v.path[0] as Connector).to;
      const v0 = Math.max(2, lane.speed * v.v0f * (v.path[0].kind === 'conn' ? 0.55 : 1));
      this.unclaim(v);   // gapAhead lo renueva si sigue esperando el mismo cruce
      if (bc && v.type === 'buseta') this.busLogic(v, dt, bc);
      const moto = fc && v.type === 'moto' ? fc : null;
      if (moto) this.filterLogic(v, moto);
      this.gapAhead(v, obstacles);
      const gap = this.gBest, leaderV = this.gLV, why = this.gWhy;
      v.why = why; v.blocker = this.gBlk; v.force = false; v.gap = gap;
      const a = moto ? moto.a : idm.a, s0 = moto ? moto.s0 : idm.s0, T = moto ? moto.T : idm.T;
      let acc = a * (1 - Math.pow(v.v / v0, idm.delta));
      if (gap < Infinity) {
        const sStar = s0 + Math.max(0, v.v * T + (v.v * (v.v - leaderV)) / (2 * Math.sqrt(a * idm.b)));
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
      while (v.path.length > 1 && v.s > v.path[0].poly.length) { v.prev = v.path.shift()!; v.s -= v.prev.poly.length; }
      if (v.s > v.path[0].poly.length) { v.s = v.path[0].poly.length; v.v = 0; }
      // la reserva se libera cuando la cola del vehículo ya salió del cruce (o si el camino ya lo dejó atrás); no se
      // espera a recorrer un largo entero: en un tramo corto entre dos cruces quien espera el segundo retendría el
      // primero, y dos vehículos en sentidos opuestos se bloquearían para siempre
      if (v.res && (v.path[0] === v.res.to ? v.s > v.length / 2 + 1 : !v.path.includes(v.res))) this.release(v);
      this.extend(v);
      this.updatePose(v);
      if (v.path[0].kind === 'conn') v.latT = 0;   // en el cruce siempre hacia el eje
      this.moveLat(v, dt, fc);
      this.updateBlink(v);
      const d = playerPos ? Math.hypot(v.x - playerPos.x, v.z - playerPos.z) : 0;
      // fuera de la burbuja de tráfico → se recicla, pero sólo donde no se ve (o más allá de despawnHardDistance)
      if (d > far && (d > hard || !vis(v.x, v.z))) { this.park(v); continue; }
      // salida del área o callejón sin continuación → se recicla si no se ve; a la vista sigue (o espera en el
      // extremo, ver gapAhead) hasta dejar de verse (o, si tarda, ver unjam)
      if ((this.deadEnd(v) || this.outside(v.x, v.z)) && (d > hard || !vis(v.x, v.z))) { this.park(v); continue; }
      if (v.jam > this.cfg.junctionWaitTimeout || v.wait > (this.cfg.stuckRecycle ?? Infinity)) jammed = true;
    }
    if (jammed) this.unjam(vis);
    this.spawn(playerPos, vis);
  }

  /**
   * Interbloqueos: sigue la cadena "quién espera a quién" desde cada vehículo atascado. Si cierra un ciclo (todos
   * detenidos), el miembro que más lleva esperando el cruce (empate: menor id) recibe prelación tras junctionWaitTimeout,
   * salvo que otro del ciclo ya esté cruzando con prelación desde hace menos de eso. Si el ciclo sigue tras
   * stuckRecycle s (sólo físico, o la prelación no pudo entrar), o si la cadena acaba en un obstáculo que no es el
   * jugador o en un vehículo retenido al final del camino, se reciclan los que no se ven (a la vista, nunca).
   * Las cadenas que acaban en un semáforo, el jugador, un vehículo en marcha, una buseta en su paradero o una moto que
   * espera hueco para volver al carril se resuelven solas.
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
          const crossing = cyc.some((c) => this.time - c.forcedAt < timeout);
          if (pick && pick.jam > timeout && !crossing) pick.force = true;
          for (const c of cyc) if (c.wait > stuck) recycle.push(c);
          break;
        }
        mark[u.id] = -1; chain.push(u.id);
        if (!u.active || u.v >= 0.3) break;
        if (u.why === 'obstacle') { root = ROOT_OBSTACLE; break; }
        if (u.why === 'end') { root = ROOT_END; break; }
        if ((u.why !== 'leader' && u.why !== 'junction' && u.why !== 'exit') || u.blocker < 0) break;
        u = V[u.blocker];
      }
      for (const id of chain) mark[id] = root;
      if (root === ROOT_OBSTACLE || root === ROOT_END) for (const id of chain) if (V[id].wait > stuck) recycle.push(V[id]);
    }
    for (const v of recycle) if (v.active && !vis(v.x, v.z)) this.park(v);
  }

  /** Reaparición de inactivos en puntos ocultos, con un presupuesto fijo de intentos por paso. */
  private spawn(playerPos: { x: number; z: number } | null, vis: Visibility) {
    const n = this.vehicles.length, budget = this.cfg.spawnTriesPerStep ?? 80, c0 = this.cursor;
    this.spent = 0;
    for (let k = 0; k < n && this.spent < budget; k++) {
      const v = this.vehicles[(c0 + k) % n];
      if (v.active) continue;
      this.place(v, playerPos, this.cfg.respawnMinDistance, vis, Math.min(40, budget - this.spent));
      this.cursor = (v.id + 1) % n;   // el próximo paso sigue tras el último que lo intentó
    }
  }
}
