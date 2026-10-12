/**
 * Lógica pura del audio de la ciudad (sin WebAudio, probada en Node): espacialización respecto a la cámara, reparto de
 * las voces de motor entre los vehículos más cercanos (con histéresis), modelo de motor por tipo, campanas (parciales y
 * horario de repiques en tiempo de JUEGO), detección de pasos desde la fase del caminado y mezcla del ambiente por zona.
 * Nada de esto reserva memoria por frame. Las cifras son de diseño (no hay grabaciones de Zipaquirá): plausibles.
 */

/** Generador determinista (mulberry32), valores en [0, 1). */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const clamp01 = (v: number) => clamp(v, 0, 1);

/** Oyente: la cámara (posición) y su dirección de vista en el plano (fx, fz; no hace falta normalizarla). */
export interface Listener { x: number; y: number; z: number; fx: number; fz: number }
/** Lo que el audio lee de un vehículo del tráfico (Vehicle de traffic/sim.ts lo cumple). */
export interface AudioVehicle { x: number; z: number; v: number; type: string; active: boolean }

export interface Spatial {
  /** Distancia (m). */ d: number;
  /** Paneo estéreo −1..1 (derecha +). */ pan: number;
  /** Atenuación por distancia 0..1. */ gain: number;
  /** Corte del paso bajo (Hz): aire, edificios y fuente a la espalda. */ lp: number;
}
export const newSpatial = (): Spatial => ({ d: 0, pan: 0, gain: 0, lp: 18000 });

/**
 * Fuente en (x, y, z) vista desde el oyente. gain = ref / max(ref, d) (distancia inversa) y se apaga suave entre
 * 0,7·maxD y maxD; pan = componente lateral (derecha = (−fz, fx)), recortado a ±0,8 para no sonar en un solo oído y
 * menor si la fuente está casi encima; lp baja con la distancia y si la fuente queda detrás.
 */
export function spatialize(L: Listener, x: number, y: number, z: number, ref: number, maxD: number, out: Spatial) {
  const dx = x - L.x, dy = y - L.y, dz = z - L.z;
  const h = Math.hypot(dx, dz);
  const d = Math.hypot(h, dy);
  const fl = Math.hypot(L.fx, L.fz) || 1;
  const fx = L.fx / fl, fz = L.fz / fl;
  const side = h > 1e-6 ? (-dx * fz + dz * fx) / Math.max(h, 2) : 0;
  const front = h > 1e-6 ? (dx * fx + dz * fz) / h : 1;
  let g = ref / Math.max(ref, d);
  if (d > 0.7 * maxD) g *= clamp01((maxD - d) / (0.3 * maxD));
  out.d = d;
  out.pan = clamp(side, -1, 1) * 0.8;
  out.gain = g;
  out.lp = (18000 / (1 + d / 35)) * (0.8 + 0.2 * front);
  return out;
}

// ---------------------------------------------------------------- motores

export interface EngineSpec {
  /** Cilindros: explosiones por ciclo de 4 tiempos (dos vueltas). La onda va a la frecuencia del ciclo, rpm/120. */
  cyl: number;
  /** rpm de ralentí y de cambio de marcha. */
  idle: number; shift: number;
  /** Velocidad (m/s) a la que cada marcha llega a `shift`. */
  gears: number[];
  /** Ganancia base, alcance relativo (para elegir qué vehículos suenan) y paso bajo base (Hz). */
  gain: number; loud: number; lp: number;
  /** Ruido de escape/admisión: banda (Hz), Q, golpeteo con cada explosión (diésel) y rodadura a velocidad. */
  noiseHz: number; noiseQ: number; clatter: number; hiss: number;
  /** Exponente de caída de los armónicos y peso de los órdenes que no son de encendido (desbalance, aspereza). */
  tilt: number; rough: number;
}

/**
 * Motores por tipo del tráfico. Moto: monocilíndrico 4T de 100–150 cc (Boxer, AKT): "tuc-tuc" a ralentí, zumbido
 * alto. Carro y camioneta: 4 cilindros de gasolina, suaves. Taxi: 3 cilindros de 1,0 L (Picanto): áspero.
 * Buseta: 4 cilindros diésel (NPR, Hino): grave, con traqueteo de inyección.
 */
export const ENGINES: Record<string, EngineSpec> = {
  moto: { cyl: 1, idle: 1400, shift: 7500, gears: [5.5, 9, 13, 17, 23], gain: 0.42, loud: 1.1, lp: 2600,
    noiseHz: 1500, noiseQ: 1.1, clatter: 0.22, hiss: 0.05, tilt: 0.8, rough: 1 },
  carro: { cyl: 4, idle: 800, shift: 3200, gears: [7, 12.5, 18.5, 25, 31], gain: 0.3, loud: 0.9, lp: 900,
    noiseHz: 750, noiseQ: 0.7, clatter: 0.04, hiss: 0.1, tilt: 1.15, rough: 0.12 },
  taxi: { cyl: 3, idle: 850, shift: 3800, gears: [6.5, 11.5, 17, 23], gain: 0.3, loud: 0.95, lp: 1300,
    noiseHz: 950, noiseQ: 0.8, clatter: 0.08, hiss: 0.09, tilt: 0.95, rough: 0.3 },
  buseta: { cyl: 4, idle: 700, shift: 2600, gears: [4.5, 8, 12.5, 17, 23], gain: 0.5, loud: 1.5, lp: 1100,
    noiseHz: 2600, noiseQ: 0.9, clatter: 0.35, hiss: 0.12, tilt: 0.85, rough: 0.35 },
  camioneta: { cyl: 4, idle: 750, shift: 3000, gears: [7, 12, 18, 25, 31], gain: 0.34, loud: 1.05, lp: 800,
    noiseHz: 650, noiseQ: 0.7, clatter: 0.08, hiss: 0.11, tilt: 1.05, rough: 0.2 },
};
export const engineSpec = (type: string) => ENGINES[type] ?? ENGINES.carro;

/**
 * Amplitud de los armónicos de la onda (frecuencia fundamental = ciclo de 4 tiempos, rpm/120). Los órdenes de
 * encendido (múltiplos de cyl) dominan; los demás llevan `rough` (desbalance). a[0] = 0 (sin continua).
 */
export function engineHarmonics(spec: EngineSpec, n = 96) {
  const a = new Float32Array(n);
  for (let k = 1; k < n; k++) {
    const fire = k % spec.cyl === 0;
    const order = k / spec.cyl;
    a[k] = (fire ? 1 : spec.rough) * Math.pow(Math.max(order, 1), -spec.tilt);
    if (spec.cyl === 1) a[k] *= (k % 2 === 0 ? 1.3 : 1) * (k < 3 ? 0.6 : 1);   // golpe del monocilíndrico
    if (fire && order < 1.5) a[k] *= 0.7;
  }
  return a;
}

export interface EngineState { rpm: number; /** frecuencia del ciclo, Hz */ f: number; load: number; gear: number }
export const newEngineState = (): EngineState => ({ rpm: 0, f: 0, load: 0, gear: 0 });

/**
 * Caja de cambios simple: la marcha es la primera cuya velocidad tope supera v; rpm = shift·v/tope (al cambiar cae),
 * nunca por debajo del ralentí (embrague). La carga sale de la aceleración (frenando o en rueda libre ≈ 0,1).
 */
export function engineState(spec: EngineSpec, v: number, accel: number, out: EngineState) {
  const s = Math.abs(v);
  const G = spec.gears;
  let g = 0;
  while (g < G.length - 1 && s > G[g]) g++;
  const rpm = Math.max(spec.idle, Math.min(spec.shift * 1.08, (spec.shift * s) / G[g]));
  out.rpm = rpm;
  out.f = rpm / 120;
  out.gear = g;
  out.load = s < 0.3 && accel < 0.3 ? 0.2 : clamp(0.3 + accel / 2.2, 0.1, 1);
  return out;
}

/** Densidad de tráfico audible alrededor del oyente: Σ (1 − d/R)² · (0,3 + 0,7·min(1, v/12)) · alcance del tipo. */
export function trafficDensity(vehicles: ArrayLike<AudioVehicle>, x: number, z: number, R = 150) {
  let s = 0;
  for (let i = 0; i < vehicles.length; i++) {
    const v = vehicles[i];
    if (!v.active) continue;
    const d = Math.hypot(v.x - x, v.z - z);
    if (d >= R) continue;
    const w = 1 - d / R;
    s += w * w * (0.3 + 0.7 * Math.min(1, Math.abs(v.v) / 12)) * engineSpec(v.type).loud;
  }
  return s;
}

/** Cuántos elementos activos hay a menos de r de (x, z) (p. ej. peatones cerca del oyente para `crowd`). */
export function countNear(items: ArrayLike<{ x: number; z: number; active: boolean }>, x: number, z: number, r: number) {
  let n = 0;
  const r2 = r * r;
  for (let i = 0; i < items.length; i++) {
    const p = items[i];
    if (p.active && (p.x - x) ** 2 + (p.z - z) ** 2 < r2) n++;
  }
  return n;
}

// ---------------------------------------------------------------- reparto de voces

export interface VoicePoolOpts {
  /** Voces que suenan a la vez (los vehículos más cercanos). */ active: number;
  /** Voces en total: las de sobra se desvanecen mientras otra entra (fundido cruzado sin clics). */ voices: number;
  /** Más allá de esto (m, dividido por el alcance del tipo) no suena. */ maxDist: number;
  /** Histéresis: un vehículo con voz sólo la pierde ante otro más cerca que hyst × su distancia. */ hyst: number;
  /** Salto (m) entre dos actualizaciones que delata un vehículo reciclado en otro lugar: voz nueva. */ jump: number;
}
export const VOICE_OPTS: VoicePoolOpts = { active: 6, voices: 8, maxDist: 80, hyst: 0.75, jump: 12 };

/**
 * Asigna voces a los vehículos activos más cercanos (distancia efectiva = d / alcance del tipo; con voz, × hyst).
 * Una voz que pierde su vehículo queda libre y se desvanece; un vehículo nuevo toma la voz libre que lleva más tiempo
 * libre (ya en silencio). Sin reservas de memoria tras el constructor.
 */
export class VoicePool {
  /** Índice del vehículo de cada voz (−1 = libre). */
  readonly veh: Int32Array;
  /** Momento (s, reloj del audio) en que la voz se asignó o se liberó. */
  readonly since: Float64Array;
  /** 1 = la voz se asignó en la última llamada; 2 = se liberó en la última llamada; 0 = sigue igual. */
  readonly changed: Uint8Array;
  /** Al asignarse: cuánto tiempo (s) llevaba libre la voz (≥ el fundido = ya en silencio; Infinity = nunca usada). */
  readonly freeFor: Float64Array;
  /** Última posición vista del vehículo de cada voz (para detectar reciclados). */
  private lx: Float64Array;
  private lz: Float64Array;
  private selI: Int32Array;
  private selE: Float64Array;
  private nSel = 0;

  constructor(readonly o: VoicePoolOpts = VOICE_OPTS) {
    const V = o.voices;
    this.veh = new Int32Array(V).fill(-1);
    this.since = new Float64Array(V).fill(-Infinity);
    this.changed = new Uint8Array(V);
    this.freeFor = new Float64Array(V).fill(Infinity);
    this.lx = new Float64Array(V);
    this.lz = new Float64Array(V);
    this.selI = new Int32Array(o.active);
    this.selE = new Float64Array(o.active);
  }

  /** Voz que tiene el vehículo i, o −1. */
  voiceOf(i: number) {
    for (let k = 0; k < this.veh.length; k++) if (this.veh[k] === i) return k;
    return -1;
  }

  assign(vehicles: ArrayLike<AudioVehicle>, x: number, z: number, now: number) {
    const o = this.o, V = o.voices, K = o.active;
    this.changed.fill(0);
    // reciclados (saltaron de sitio) o inactivos: liberar
    for (let k = 0; k < V; k++) {
      const i = this.veh[k];
      if (i < 0) continue;
      const v = vehicles[i];
      if (!v || !v.active || Math.hypot(v.x - this.lx[k], v.z - this.lz[k]) > o.jump) this.release(k, now);
    }
    // los K más cercanos (inserción en una lista corta ordenada)
    this.nSel = 0;
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i];
      if (!v.active) continue;
      const voiced = this.voiceOf(i) >= 0;
      let e = Math.hypot(v.x - x, v.z - z) / engineSpec(v.type).loud;
      if (e > o.maxDist * (voiced ? 1.1 : 1)) continue;
      if (voiced) e *= o.hyst;
      let p = this.nSel < K ? this.nSel++ : K;
      if (p === K && e >= this.selE[K - 1]) continue;
      if (p === K) p = K - 1;
      while (p > 0 && this.selE[p - 1] > e) { this.selE[p] = this.selE[p - 1]; this.selI[p] = this.selI[p - 1]; p--; }
      this.selE[p] = e; this.selI[p] = i;
    }
    // los que tenían voz y ya no están entre los elegidos: liberar
    for (let k = 0; k < V; k++) {
      const i = this.veh[k];
      if (i >= 0 && !this.selected(i)) this.release(k, now);
    }
    // elegidos sin voz: la libre más antigua
    for (let s = 0; s < this.nSel; s++) {
      const i = this.selI[s];
      if (this.voiceOf(i) >= 0) continue;
      let best = -1;
      for (let k = 0; k < V; k++) if (this.veh[k] < 0 && this.changed[k] !== 1 && (best < 0 || this.since[k] < this.since[best])) best = k;
      if (best < 0) break;
      this.freeFor[best] = now - this.since[best];
      this.veh[best] = i; this.since[best] = now; this.changed[best] = 1;
    }
    for (let k = 0; k < V; k++) {
      const i = this.veh[k];
      if (i >= 0) { this.lx[k] = vehicles[i].x; this.lz[k] = vehicles[i].z; }
    }
  }

  private selected(i: number) {
    for (let s = 0; s < this.nSel; s++) if (this.selI[s] === i) return true;
    return false;
  }

  private release(k: number, now: number) {
    this.veh[k] = -1; this.since[k] = now; this.changed[k] = 2;
  }
}

// ---------------------------------------------------------------- campanas

/** Parcial de una campana: nombre, razón respecto a la prima, amplitud relativa y constante de caída τ (s). */
export interface BellPartial { name: string; ratio: number; amp: number; tau: number; /** batido (Hz), 0 = sin doblete */ beat: number }

/**
 * Campana de bronce "afinada" (perfil de las campanas de iglesia europeas): hum una octava bajo la prima, prima,
 * tercera MENOR (tierce, 6/5: el color triste de la campana), quinta, nominal (octava de la prima: la nota que se oye
 * al golpe) y parciales altos inarmónicos que se apagan pronto. Los graves duran más (el hum, decenas de segundos).
 * Hum, prima y tercera son dobletes (dos modos casi iguales) que baten: el "ua-ua" de la campana al apagarse.
 */
export const BELL_PARTIALS: BellPartial[] = [
  { name: 'hum', ratio: 0.5, amp: 0.5, tau: 6, beat: 0.3 },
  { name: 'prima', ratio: 1, amp: 0.42, tau: 3.6, beat: 0.5 },
  { name: 'tercera', ratio: 1.2, amp: 0.5, tau: 2.8, beat: 0.7 },
  { name: 'quinta', ratio: 1.5, amp: 0.16, tau: 1.6, beat: 0 },
  { name: 'nominal', ratio: 2, amp: 0.75, tau: 2.2, beat: 0 },
  { name: 'décima', ratio: 2.5, amp: 0.3, tau: 1.3, beat: 0 },
  { name: 'undécima', ratio: 2.66, amp: 0.16, tau: 1.0, beat: 0 },
  { name: 'duodécima', ratio: 3.01, amp: 0.2, tau: 0.8, beat: 0 },
  { name: 'octava alta', ratio: 4.07, amp: 0.2, tau: 0.6, beat: 0 },
  { name: 'alto 1', ratio: 5.2, amp: 0.14, tau: 0.35, beat: 0 },
  { name: 'alto 2', ratio: 6.4, amp: 0.1, tau: 0.25, beat: 0 },
  { name: 'alto 3', ratio: 8.1, amp: 0.06, tau: 0.15, beat: 0 },
];

/** Las tres campanas del campanario (prima, Hz): mayor (sol₃), mediana (do₄) y menor (mi₄). ESTIMADAS. */
export const BELLS = [196, 261.6, 329.6];

/** Frecuencias de diseño de los parciales de la campana b (para generarla y para verificarla). */
export function bellFrequencies(b: number) {
  return BELL_PARTIALS.map((p) => BELLS[b] * p.ratio);
}

/**
 * Campanario: centro del vano de campanas de una torre de la fachada de la Catedral, a partir del modelo del hito
 * (world.json landmarks[].model: origen y ejes u = fachada, v = hacia dentro; piso del atrio) y de las torres de
 * data/catedral.json (ancho, vano). La torre con reloj es la oriental (+u). ESTIMADO como el modelo.
 */
export function belfryPosition(
  m: { origin: number[]; axisU: number[]; axisV: number[]; floorY: number; facadeWidth: number },
  towers: { width: number; belfry: { sill: number; h: number } }, east = true,
) {
  const u = (east ? 1 : -1) * (m.facadeWidth / 2 - towers.width / 2), v = towers.width / 2;
  return {
    x: m.origin[0] + u * m.axisU[0] + v * m.axisV[0],
    y: m.floorY + towers.belfry.sill + towers.belfry.h / 2,
    z: m.origin[1] + u * m.axisU[1] + v * m.axisV[1],
  };
}

/** Golpe de un repique: segundos desde su inicio, campana (0 = mayor) e intensidad 0..1. */
export interface PealStrike { t: number; bell: number; vel: number }

/**
 * Toque de llamada: tres campanadas lentas de la mayor, repique de las dos menores alternadas con la mayor marcando,
 * y una campanada final. Intensidades con variación determinista por semilla. ~18 s.
 */
export function pealPattern(seed = 7): PealStrike[] {
  const r = mulberry32(seed);
  const out: PealStrike[] = [];
  for (let i = 0; i < 3; i++) out.push({ t: i * 3.2, bell: 0, vel: 0.85 + 0.15 * r() });
  const t0 = 9;
  for (let i = 0; i < 16; i++) {
    out.push({ t: t0 + i * 0.42 + (r() - 0.5) * 0.04, bell: i % 2 === 0 ? 2 : 1, vel: 0.6 + 0.3 * r() });
    if (i % 4 === 0) out.push({ t: t0 + i * 0.42 + 0.21, bell: 0, vel: 0.75 + 0.2 * r() });
  }
  out.push({ t: t0 + 16 * 0.42 + 1.4, bell: 0, vel: 1 });
  return out.sort((a, b) => a.t - b.t);
}

/**
 * Horario de repiques en tiempo de JUEGO (no corre en pausa): uno a los `first` s y luego cada `period` s.
 * advance() deja en `out` los golpes que tocan (referencias al patrón: sin reservas) y devuelve cuántos.
 */
export class BellSchedule {
  /** Tiempo de juego acumulado (s). */
  t = 0;
  private at = 0;
  private i: number;
  private next: number;

  constructor(readonly pattern: PealStrike[], first = 3, readonly period = 300) {
    this.i = pattern.length;
    this.next = first;
  }

  get ringing() { return this.i < this.pattern.length; }
  get duration() { return this.pattern.length ? this.pattern[this.pattern.length - 1].t : 0; }

  /** Repique ahora (si no está sonando uno); el automático siguiente queda al menos medio periodo después. */
  ring() {
    if (this.ringing) return;
    this.at = this.t; this.i = 0;
    this.next = Math.max(this.next, this.t + this.period / 2);
  }

  advance(dt: number, out: PealStrike[]) {
    this.t += dt;
    if (!this.ringing && this.t >= this.next) {
      this.at = this.next; this.i = 0;
      this.next += this.period;
      if (this.next <= this.t) this.next = this.t + this.period;
    }
    let n = 0;
    while (this.i < this.pattern.length && this.at + this.pattern[this.i].t <= this.t) out[n++] = this.pattern[this.i++];
    return n;
  }
}

// ---------------------------------------------------------------- pasos

/**
 * Detecta pisadas a partir de la fase del caminado del avatar (Avatar.walkPhase): un pie apoya cada vez que la fase
 * cruza π/2 + kπ. Sin pasos parado, en el aire o casi quieto; al tocar el suelo tras ≥ 0,25 s en el aire, aterrizaje.
 */
export class StepDetector {
  private k = NaN;
  private air = 0;

  /** 0 = nada, 1 = pisada, 2 = aterrizaje. dt en s de juego. */
  update(phase: number, speed: number, grounded: boolean, dt: number): 0 | 1 | 2 {
    const k = Math.floor((phase - Math.PI / 2) / Math.PI);
    const prev = this.k;
    this.k = k;
    if (!grounded) { this.air += dt; return 0; }
    const landed = this.air >= 0.25;
    this.air = 0;
    if (landed) return 2;
    return k !== prev && !Number.isNaN(prev) && speed > 0.5 ? 1 : 0;
  }
}

/** Clases de pisada. */
export type FootClass = 'asfalto' | 'anden' | 'ladrillo' | 'piedra' | 'pasto' | 'tierra';

const FOOT_OF: Record<string, FootClass> = {
  asphalt: 'asfalto', paved: 'asfalto', asfalto: 'asfalto',
  concrete: 'anden', sidewalk: 'anden', lot: 'anden', anden: 'anden', 'andén': 'anden',
  plaza: 'ladrillo', brick: 'ladrillo', ladrillo: 'ladrillo', clay: 'ladrillo',
  paving_stones: 'piedra', sett: 'piedra', cobblestone: 'piedra', piedra: 'piedra', 'adoquín': 'piedra',
  grass: 'pasto', pasto: 'pasto', park: 'pasto',
  unpaved: 'tierra', dirt: 'tierra', gravel: 'tierra', ground: 'tierra', tierra: 'tierra',
};
/** Superficie (las de SurfaceMap de vehicles/surface.ts, 'sidewalk' o 'grass') → clase de pisada. */
export const footClass = (surface: string): FootClass => FOOT_OF[surface] ?? 'anden';

export interface FootSpec {
  /** Filtro del ruido del golpe: tipo, frecuencia (Hz) y Q, y paso bajo que lo redondea (Hz). */
  type: 'bandpass' | 'highpass' | 'lowpass'; hz: number; q: number; lp: number;
  /** Ataque y caída (s), ganancia, golpe grave del talón (Hz, ganancia) y dos golpes (talón y punta) separados por `gap` s. */
  attack: number; decay: number; gain: number; thudHz: number; thud: number; gap: number;
}
export const FOOT: Record<FootClass, FootSpec> = {
  asfalto: { type: 'bandpass', hz: 1500, q: 0.9, lp: 3500, attack: 0.002, decay: 0.05, gain: 0.6, thudHz: 85, thud: 0.35, gap: 0 },
  anden: { type: 'bandpass', hz: 2300, q: 1.3, lp: 5000, attack: 0.001, decay: 0.035, gain: 0.6, thudHz: 95, thud: 0.3, gap: 0 },
  ladrillo: { type: 'bandpass', hz: 1150, q: 1.6, lp: 2800, attack: 0.0015, decay: 0.05, gain: 0.65, thudHz: 120, thud: 0.4, gap: 0 },
  piedra: { type: 'bandpass', hz: 1900, q: 2.6, lp: 4500, attack: 0.001, decay: 0.03, gain: 0.7, thudHz: 130, thud: 0.3, gap: 0.032 },
  pasto: { type: 'bandpass', hz: 2600, q: 0.5, lp: 5500, attack: 0.012, decay: 0.12, gain: 0.4, thudHz: 60, thud: 0.12, gap: 0 },
  tierra: { type: 'bandpass', hz: 850, q: 0.7, lp: 2600, attack: 0.004, decay: 0.09, gain: 0.55, thudHz: 70, thud: 0.3, gap: 0 },
};

// ---------------------------------------------------------------- pitos

export interface HornSpec { hz: number[]; wave: OscillatorType; bp: number; gain: number; taps: [number, number][] }
/** Pitos por tipo: carro y taxi de dos tonos, moto delgado, buseta grave y fuerte (corneta). */
export const HORNS: Record<string, HornSpec> = {
  carro: { hz: [415, 523], wave: 'square', bp: 900, gain: 0.16, taps: [[0, 0.16], [0.22, 0.3]] },
  taxi: { hz: [440, 554], wave: 'square', bp: 1000, gain: 0.15, taps: [[0, 0.12], [0.18, 0.12], [0.36, 0.25]] },
  camioneta: { hz: [370, 466], wave: 'square', bp: 850, gain: 0.17, taps: [[0, 0.45]] },
  moto: { hz: [620], wave: 'square', bp: 1600, gain: 0.11, taps: [[0, 0.1], [0.16, 0.18]] },
  buseta: { hz: [294, 370, 440], wave: 'sawtooth', bp: 700, gain: 0.2, taps: [[0, 0.55]] },
};
export const hornSpec = (type: string) => HORNS[type] ?? HORNS.carro;

// ---------------------------------------------------------------- pájaros

/** Nota de un canto: inicio y duración (s), barrido de frecuencia (Hz) e intensidad. */
export interface BirdNote { t: number; dur: number; f0: number; f1: number; a: number }
export type BirdKind = 'copeton' | 'chip' | 'mirla';

/**
 * Cantos andinos sintetizados (pure: notas, la síntesis va en synth.ts). Copetón (Zonotrichia capensis, el pájaro
 * de la Sabana): dos silbidos deslizados y un trino final. Chip: llamadas cortas y agudas. Mirla (Turdus fuscater):
 * frase aflautada más grave, de notas variadas. Escribe en `out` (se reutiliza) y devuelve cuántas notas.
 */
export function birdSong(kind: BirdKind, r: () => number, out: BirdNote[]) {
  let n = 0;
  const put = (t: number, dur: number, f0: number, f1: number, a: number) => {
    const o = out[n] ?? (out[n] = { t: 0, dur: 0, f0: 0, f1: 0, a: 0 });
    o.t = t; o.dur = dur; o.f0 = f0; o.f1 = f1; o.a = a; n++;
  };
  const k = 0.92 + 0.16 * r();
  if (kind === 'copeton') {
    put(0, 0.3 + 0.06 * r(), 4300 * k, 3300 * k, 0.9);
    put(0.42, 0.26, 3500 * k, 4500 * k, 1);
    const trill = 5 + Math.floor(r() * 4), dt = 0.055 + 0.015 * r();
    for (let i = 0; i < trill; i++) put(0.78 + i * dt, dt * 0.6, 4700 * k, 3700 * k, 0.75 - i * 0.04);
  } else if (kind === 'chip') {
    const m = 1 + Math.floor(r() * 4);
    for (let i = 0; i < m; i++) put(i * (0.09 + 0.05 * r()), 0.025, 6800 * k, 5600 * k, 0.6);
  } else {
    const m = 4 + Math.floor(r() * 4);
    let t = 0;
    for (let i = 0; i < m; i++) {
      const f = (1700 + 1500 * r()) * k, dur = 0.08 + 0.12 * r();
      put(t, dur, f, f * (0.85 + 0.3 * r()), 0.6 + 0.4 * r());
      t += dur + 0.03 + 0.06 * r();
    }
  }
  return n;
}

// ---------------------------------------------------------------- ambiente

export interface ZoneIn {
  /** Peatones activos cerca del oyente (p. ej. a menos de 35 m). */ crowd: number;
  /** Pesos de zona 0..1: plaza, parque y calle. */ plaza: number; park: number; street: number;
  /** trafficDensity() alrededor del oyente. */ traffic: number;
}
export interface ZoneMix {
  /** Murmullo de la multitud (ruido con formantes), 0..1. */ murmur: number;
  /** Voces sueltas cercanas (sílabas con vocales), 0..1. */ talk: number;
  /** Cantos de pájaro por segundo. */ birds: number;
  /** Rumor del tráfico (graves), 0..1. */ rumble: number;
  /** Aire/viento de fondo, 0..1. */ air: number;
}
export const newZoneMix = (): ZoneMix => ({ murmur: 0, talk: 0, birds: 0, rumble: 0, air: 0 });

/**
 * Mezcla del ambiente por zona. La multitud satura (~40 personas = 86 %) y suena más en la plaza (abierta, empedrada);
 * los pájaros cantan sobre todo en el parque (algo en la plaza: árboles de las jardineras); el rumor del tráfico sale
 * de la densidad de vehículos y pesa más en la calle (encajonada entre fachadas).
 */
export function zoneMix(z: ZoneIn, out: ZoneMix) {
  const crowd = Math.max(0, z.crowd);
  const plaza = clamp01(z.plaza), park = clamp01(z.park), street = clamp01(z.street);
  const c = 1 - Math.exp(-crowd / 20);
  out.murmur = c * (0.55 + 0.45 * plaza);
  out.talk = Math.min(1, crowd / 6) * (0.6 + 0.4 * Math.max(plaza, park));
  out.birds = 0.03 + 0.3 * park + 0.06 * plaza;
  out.rumble = 0.06 + (1 - Math.exp(-Math.max(0, z.traffic) / 2.5)) * (0.45 + 0.55 * street);
  out.air = 0.25 + 0.2 * park + 0.1 * plaza;
  return out;
}

/** Distancia de (x, z) al polígono (0 dentro). */
function polyDist(x: number, z: number, ring: number[][]) {
  let inside = false, d2 = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = ring[j][0], az = ring[j][1], bx = ring[i][0], bz = ring[i][1];
    if ((bz > z) !== (az > z) && x < ((ax - bx) * (z - bz)) / (az - bz) + bx) inside = !inside;
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-9;
    const t = clamp01(((x - ax) * dx + (z - az) * dz) / L2);
    const ex = ax + t * dx - x, ez = az + t * dz - z;
    d2 = Math.min(d2, ex * ex + ez * ez);
  }
  return inside ? 0 : Math.sqrt(d2);
}

/**
 * Pesos de zona para CityScene a partir de los polígonos del mundo (world.json: plaza.ring, parks[].ring): 1 dentro,
 * bajando a 0 a `soft` m del borde (el sonido no cambia de golpe al cruzar la calle); street = 1 − max(plaza, park).
 */
export class ZoneMap {
  constructor(private plaza: number[][] | null, private parks: number[][][], private soft = 18) {}

  at(x: number, z: number, out: { plaza: number; park: number; street: number }) {
    out.plaza = this.plaza ? clamp01(1 - polyDist(x, z, this.plaza) / this.soft) : 0;
    let p = 0;
    for (const r of this.parks) p = Math.max(p, clamp01(1 - polyDist(x, z, r) / this.soft));
    out.park = p;
    out.street = 1 - Math.max(out.plaza, p);
    return out;
  }
}

/** Vocales del español (F1, F2 en Hz, voz adulta media) para el balbuceo de la multitud. */
export const VOWELS: [number, number][] = [[750, 1300], [480, 1900], [300, 2250], [520, 950], [330, 800]];
