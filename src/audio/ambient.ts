/**
 * Sonido de la ciudad (todo sintetizado con WebAudio): ambiente por zona (murmullo y voces en la plaza, pájaros en el
 * parque, rumor del tráfico en la calle, aire), motores del tráfico espacializados (6 voces para los vehículos más
 * cercanos, con fundido cruzado al reasignarlas), pasos del jugador según la superficie, pitos espacializados y las
 * campanas de la Catedral (repique al empezar y cada pocos minutos de tiempo de JUEGO).
 *
 * Comparte el AudioContext y el bus de salida de MotoAudio (volumen de las opciones, silencio con M, compresor); en
 * pausa MotoAudio suspende el contexto y update() no avanza nada. El oyente es la cámara. update() trabaja a ≤ 30 Hz
 * y sólo programa parámetros con setTargetAtTime; nada reserva memoria por frame salvo los sonidos de un solo uso.
 *
 * Uso (main.ts; todo con objetos reutilizados, sin reservar por frame):
 *   const city = new CityAudio(motoAudio, { bell: belfryPosition(catedral.model, catedralCfg.towers) });
 *   const zones = new ZoneMap(world.plaza.ring, world.parks.map((p) => p.ring));
 *   // cada frame, con la cámara como oyente (fx, fz = camera.getWorldDirection(v) en el plano):
 *   zones.at(camera.position.x, camera.position.z, scene);                 // scene.plaza / park / street
 *   scene.crowd = countNear(peds.peds, camera.position.x, camera.position.z, 35);
 *   city.update(gdt, listener, scene, paused);                              // scene.vehicles = traffic.vehicles
 *   if (!riding) { const st = city.stepEvent(avatar.walkPhase, speed, character.grounded, gdt);
 *     if (st) city.footstep(surfaces.at(feet.x, feet.z), input.run, st === 2); }   // o 'sidewalk' / 'grass'
 *   for (const hv of traffic.drainHonks()) city.honk(hv.x, hv.z, hv.type);  // en lugar de motoAudio.honk
 */
import {
  BellSchedule, FOOT, StepDetector, VOICE_OPTS, VoicePool, birdSong, engineSpec, engineState, footClass, hornSpec,
  mulberry32, newEngineState, newSpatial, newZoneMix, pealPattern, spatialize, trafficDensity, zoneMix,
  type AudioVehicle, type BirdKind, type BirdNote, type Listener, type PealStrike, type VoicePoolOpts,
} from './mix';
import {
  Ambience, EngineVoice, bellStrike, birdSound, brownNoise, engineWaves, footstepSound, hornSound, playBuffer,
  renderBells, whiteNoise,
} from './synth';

export { ZoneMap, belfryPosition, countNear, type Listener } from './mix';

/** Quien provee el contexto y el bus de salida (MotoAudio, o uno de prueba con OfflineAudioContext). */
export interface AudioHost { readonly context: BaseAudioContext | null; readonly output: AudioNode | null }

/** Lo que el audio necesita de la escena en cada update(). */
export interface CityScene {
  /** Vehículos del tráfico (traffic.vehicles: el índice identifica al vehículo entre llamadas). */
  vehicles: ArrayLike<AudioVehicle>;
  /** Peatones activos cerca del oyente (mix.countNear(peds, x, z, 35)). */
  crowd: number;
  /** Pesos de zona 0..1 donde está el oyente: plaza, parque, calle (pueden ser suaves en los bordes). */
  plaza: number; park: number; street: number;
}

export interface CityAudioOpts {
  /** Semilla de todo lo aleatorio (ruidos, variaciones, cantos, balbuceo). */ seed?: number;
  /**
   * Campanario (m, mundo): mix.belfryPosition(landmark.model, catedral.towers). Por defecto, ese mismo cálculo con los
   * datos actuales (torre oriental, vano a ~25 m sobre el atrio).
   */
  bell?: { x: number; y: number; z: number };
  /** Primer repique y periodo (s de juego desde que el audio arranca). */ firstBell?: number; bellPeriod?: number;
  voices?: Partial<VoicePoolOpts>;
}

/** Niveles de los buses (ganancia antes del bus general de MotoAudio, cuya ganancia de la moto es 0,5). */
const MIX = { engines: 0.4, ambience: 1, steps: 0.35, horns: 0.8, bells: 0.9, birds: 0.16 };
/** Periodo de actualización (s): ≤ 30 Hz. */
const TICK = 1 / 30;

interface Graph {
  ctx: BaseAudioContext;
  white: AudioBuffer;
  voices: EngineVoice[];
  engines: GainNode;
  amb: Ambience;
  steps: GainNode;
  horns: GainNode;
  birds: GainNode;
  /** Bus de las campanas: paso bajo y paneo según el campanario visto desde la cámara. */
  bellIn: GainNode; bellLp: BiquadFilterNode; bellGain: GainNode; bellPan: StereoPannerNode;
  bank: AudioBuffer[] | null;
}

export class CityAudio {
  private g: Graph | null = null;
  private acc = 0;
  private r: () => number;
  private L: Listener = { x: 0, y: 0, z: 0, fx: 0, fz: -1 };
  private bellPos: { x: number; y: number; z: number };
  private pool: VoicePool;
  /** Estado por voz: velocidad y distancia de la actualización anterior, aceleración suavizada y Doppler. */
  private vPrev: Float64Array;
  private aSm: Float64Array;
  private dPrev: Float64Array;
  private dop: Float64Array;
  private eng = newEngineState();
  private sp = newSpatial();
  private zone = newZoneMix();
  private zoneIn = { crowd: 0, plaza: 0, park: 0, street: 0, traffic: 0 };
  private schedule: BellSchedule;
  private strikes: PealStrike[] = [];
  private steps = new StepDetector();
  private notes: BirdNote[] = [];
  private hornT = 0;
  private hornN = 0;

  constructor(private host: AudioHost, o: CityAudioOpts = {}) {
    this.r = mulberry32(o.seed ?? 20260);
    this.bellPos = { ...(o.bell ?? { x: 42.88, y: 27.38, z: -31.53 }) };
    this.pool = new VoicePool({ ...VOICE_OPTS, ...o.voices });
    const V = this.pool.o.voices;
    this.vPrev = new Float64Array(V);
    this.aSm = new Float64Array(V);
    this.dPrev = new Float64Array(V);
    this.dop = new Float64Array(V).fill(1);
    this.schedule = new BellSchedule(pealPattern(o.seed ?? 7), o.firstBell ?? 3, o.bellPeriod ?? 300);
  }

  /** ¿Ya existe el grafo (el contexto se crea con el primer gesto del usuario)? */
  get ready() { return this.g !== null; }

  setBellPosition(x: number, y: number, z: number) { this.bellPos.x = x; this.bellPos.y = y; this.bellPos.z = z; }

  /** Datos de depuración (reserva memoria: no llamar cada frame). */
  debug() {
    return {
      ready: this.ready, bank: !!this.g?.bank, gameTime: this.schedule.t, ringing: this.schedule.ringing,
      voices: Array.from(this.pool.veh), zone: { ...this.zone }, traffic: this.zoneIn.traffic,
    };
  }

  private init(ctx: BaseAudioContext, out: AudioNode): Graph {
    const seed = Math.floor(this.r() * 1e9);
    const white = whiteNoise(ctx, 4.3, seed), brown = brownNoise(ctx, 5.9, seed + 1);
    const bus = (v: number) => { const g = ctx.createGain(); g.gain.value = v; g.connect(out); return g; };
    const engines = bus(MIX.engines);
    const waves = engineWaves(ctx);
    const voices: EngineVoice[] = [];
    for (let k = 0; k < this.pool.o.voices; k++) voices.push(new EngineVoice(ctx, waves, white, engines, this.r() * 5));
    const amb = new Ambience(ctx, white, brown, bus(MIX.ambience), this.r);
    const bellIn = ctx.createGain(), bellGain = ctx.createGain(), bellPan = ctx.createStereoPanner();
    const bellLp = ctx.createBiquadFilter();
    bellLp.type = 'lowpass'; bellLp.frequency.value = 8000; bellLp.Q.value = 0.6;
    bellGain.gain.value = 0;
    bellIn.connect(bellLp).connect(bellPan).connect(bellGain).connect(out);
    const g: Graph = {
      ctx, white, voices, engines, amb, steps: bus(MIX.steps), horns: bus(MIX.horns), birds: bus(MIX.birds),
      bellIn, bellLp, bellGain, bellPan, bank: null,
    };
    // banco de campanas pre-renderizado (asíncrono); mientras tanto, campanadas en vivo
    if (typeof OfflineAudioContext !== 'undefined') {
      renderBells(Math.min(24000, ctx.sampleRate)).then((b) => { g.bank = b; }, () => { /* sigue en vivo */ });
    }
    return g;
  }

  /**
   * Cada frame. dt = s de juego (0 o paused = true en pausa: nada avanza); listener = cámara (posición y dirección de
   * vista en el plano). Trabaja a ≤ 30 Hz. Hasta que exista el contexto no hace nada (tampoco cuenta el tiempo de las
   * campanas: el primer repique suena a los `firstBell` s de oírse el juego).
   */
  update(dt: number, listener: Listener, scene: CityScene, paused: boolean) {
    if (paused) return;
    const ctx = this.host.context, out = this.host.output;
    if (!ctx || !out) return;
    if (!this.g) this.g = this.init(ctx, out);
    const L = this.L;
    L.x = listener.x; L.y = listener.y; L.z = listener.z; L.fx = listener.fx; L.fz = listener.fz;
    this.acc += dt;
    if (this.acc < TICK) return;
    const step = Math.min(this.acc, 0.25);
    this.acc = 0;
    const g = this.g, t = ctx.currentTime;

    // campanas: golpes que tocan y el bus siguiendo al campanario
    const n = this.schedule.advance(step, this.strikes);
    for (let i = 0; i < n; i++) this.strike(this.strikes[i]);
    const B = this.bellPos;
    const sb = spatialize(L, B.x, B.y, B.z, 45, Infinity, this.sp);
    g.bellGain.gain.setTargetAtTime(MIX.bells * sb.gain, t, 0.2);
    g.bellPan.pan.setTargetAtTime(sb.pan, t, 0.2);
    g.bellLp.frequency.setTargetAtTime(Math.min(9000, sb.lp * 1.4), t, 0.2);

    this.engines(scene.vehicles, t, step);

    // ambiente por zona
    const zi = this.zoneIn;
    zi.crowd = scene.crowd; zi.plaza = scene.plaza; zi.park = scene.park; zi.street = scene.street;
    zi.traffic = trafficDensity(scene.vehicles, L.x, L.z);
    const z = zoneMix(zi, this.zone);
    g.amb.update(t, step, z.murmur, z.talk, z.rumble, z.air);
    if (this.r() < z.birds * step) this.bird(t);
  }

  private engines(vehicles: ArrayLike<AudioVehicle>, t: number, step: number) {
    const g = this.g!, pool = this.pool, L = this.L;
    pool.assign(vehicles, L.x, L.z, t);
    for (let k = 0; k < g.voices.length; k++) {
      const voice = g.voices[k], ch = pool.changed[k], i = pool.veh[k];
      if (ch === 2) voice.fadeOut(t, 0.07);
      if (i < 0) continue;
      const v = vehicles[i];
      const spec = engineSpec(v.type);
      const sp = spatialize(L, v.x, L.y - 1.6, v.z, 5, pool.o.maxDist * spec.loud, this.sp);
      if (ch === 1) {
        // desde silencio si la voz llevaba libre más que el fundido; si no, la frecuencia se desliza
        const quiet = pool.freeFor[k] > 0.3 || !voice.type;
        this.vPrev[k] = v.v; this.dPrev[k] = sp.d; this.dop[k] = 1; this.aSm[k] = 0;
        engineState(spec, v.v, 0, this.eng);
        voice.assign(v.type, this.eng.f, t, quiet);
      }
      // aceleración suavizada (el tráfico avanza a 30 Hz, desfasado de este reloj: sin suavizar, la carga temblaría)
      this.aSm[k] += ((v.v - this.vPrev[k]) / step - this.aSm[k]) * 0.25;
      // Doppler: c / (c + velocidad radial), suavizado
      const vr = Math.max(-25, Math.min(25, (sp.d - this.dPrev[k]) / step));
      this.dop[k] += (343 / (343 + vr) - this.dop[k]) * 0.3;
      this.vPrev[k] = v.v; this.dPrev[k] = sp.d;
      const e = engineState(spec, v.v, this.aSm[k], this.eng);
      const rpmN = e.rpm / spec.shift;
      const gain = spec.gain * (0.45 + 0.55 * e.load) * (0.55 + 0.45 * rpmN) * sp.gain;
      const lp = Math.min(sp.lp, spec.lp * (0.6 + 0.8 * e.load) * (0.7 + 0.6 * rpmN));
      const sv = Math.min(1, Math.abs(v.v) / 15);
      voice.set(t, e.f * this.dop[k], gain, lp, sp.pan, spec.hiss * sv * sv, spec.clatter * (0.4 + 0.6 * e.load),
        ch === 1 ? 0.08 : 0.06);
    }
  }

  private strike(s: PealStrike) {
    const g = this.g!, t = g.ctx.currentTime + 0.02;
    if (g.bank) playBuffer(g.ctx, g.bellIn, g.bank[s.bell], t, s.vel);
    else bellStrike(g.ctx, g.bellIn, g.white, t, s.bell, s.vel);
  }

  private bird(t: number) {
    const g = this.g!, r = this.r;
    const x = r();
    const kind: BirdKind = x < 0.5 ? 'copeton' : x < 0.8 ? 'chip' : 'mirla';
    const n = birdSong(kind, r, this.notes);
    const d = 8 + 40 * r();   // en los árboles alrededor
    birdSound(g.ctx, g.birds, t + 0.02, this.notes, n, 8 / Math.max(8, d) * (0.6 + 0.4 * r()), (r() - 0.5) * 1.5,
      14000 / (1 + d / 35));
  }

  /** Repique ya (si no hay uno sonando). */
  bell() {
    this.schedule.ring();
  }

  /**
   * Detector de pisadas para el avatar del jugador: llamar cada frame a pie con Avatar.walkPhase, la rapidez (m/s),
   * si está en el suelo y el dt de juego. 0 = nada, 1 = pisada, 2 = aterrizaje (pasar a footstep(…, land)).
   */
  stepEvent(phase: number, speed: number, grounded: boolean, dt: number) {
    return this.steps.update(phase, speed, grounded, dt);
  }

  /**
   * Una pisada del jugador. surface: las de SurfaceMap ('asphalt', 'paved', 'concrete', 'paving_stones', 'sett',
   * 'plaza', 'unpaved', 'lot'), 'sidewalk' (sobre el andén) o 'grass'; ver mix.footClass. No espacializada (el
   * jugador está en el centro de la imagen).
   */
  footstep(surface: string, run: boolean, land = false) {
    const g = this.g;
    if (!g) return;
    footstepSound(g.ctx, g.steps, g.white, g.ctx.currentTime + 0.005, FOOT[footClass(surface)], run, land, this.r);
  }

  /** Pito espacializado de un vehículo en (x, z) (tipo del tráfico: timbre propio). Como mucho 4 por medio segundo. */
  honk(x: number, z: number, type = 'carro') {
    const g = this.g;
    if (!g) return;
    const t = g.ctx.currentTime;
    if (t - this.hornT > 0.5) { this.hornT = t; this.hornN = 0; }
    if (++this.hornN > 4) return;
    const sp = spatialize(this.L, x, this.L.y - 1.2, z, 6, 160, this.sp);
    if (sp.gain < 0.01) return;
    hornSound(g.ctx, g.horns, t + 0.01 + this.r() * 0.03, hornSpec(type), sp.gain, sp.pan, sp.lp);
  }
}
