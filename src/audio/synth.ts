/**
 * Piezas WebAudio del sonido de la ciudad, todas sintetizadas (el juego no trae archivos de audio). Reciben cualquier
 * BaseAudioContext, así que también se renderizan con OfflineAudioContext (campanas pre-renderizadas, verificación).
 * Las voces persistentes (motores, multitud, rumor) se crean una vez y se reutilizan; los sonidos de un solo uso
 * (campanadas, pasos, pitos, cantos) desconectan sus nodos al terminar.
 */
import {
  BELL_PARTIALS, BELLS, ENGINES, VOWELS, engineHarmonics, mulberry32,
  type BirdNote, type FootSpec, type HornSpec,
} from './mix';

/** Ruido blanco determinista, mono (congruencial en línea: generar segundos de ruido cuesta pocos ms). */
export function whiteNoise(ctx: BaseAudioContext, seconds: number, seed: number) {
  const b = ctx.createBuffer(1, Math.round(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = b.getChannelData(0);
  let s = seed | 0;
  for (let i = 0; i < d.length; i++) { s = (Math.imul(s, 1664525) + 1013904223) | 0; d[i] = s / 2147483648; }
  return b;
}

/** Ruido marrón (integrador con fuga: −6 dB/oct sobre ~8 Hz), normalizado a pico 1. Para rumor y viento. */
export function brownNoise(ctx: BaseAudioContext, seconds: number, seed: number) {
  const b = ctx.createBuffer(1, Math.round(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = b.getChannelData(0);
  const k = 1 - (2 * Math.PI * 8) / ctx.sampleRate;
  let s = seed | 0, y = 0, m = 1e-9;
  for (let i = 0; i < d.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    y = y * k + s * (0.05 / 2147483648);
    d[i] = y;
    if (y > m) m = y; else if (-y > m) m = -y;
  }
  const inv = 1 / m;
  for (let i = 0; i < d.length; i++) d[i] *= inv;
  return b;
}

/** Desconecta los nodos de un sonido de un solo uso cuando termina su última fuente. */
function release(last: AudioScheduledSourceNode, nodes: AudioNode[]) {
  last.onended = () => { for (const n of nodes) n.disconnect(); };
}

function biquad(ctx: BaseAudioContext, type: BiquadFilterType, hz: number, q: number) {
  const f = ctx.createBiquadFilter();
  f.type = type; f.frequency.value = hz; f.Q.value = q;
  return f;
}

function gainNode(ctx: BaseAudioContext, v: number) {
  const g = ctx.createGain();
  g.gain.value = v;
  return g;
}

/** Formas de onda de los motores por tipo (órdenes de encendido según los cilindros). */
export function engineWaves(ctx: BaseAudioContext) {
  const m = new Map<string, PeriodicWave>();
  for (const [type, spec] of Object.entries(ENGINES)) {
    const imag = engineHarmonics(spec);
    m.set(type, ctx.createPeriodicWave(new Float32Array(imag.length), imag));
  }
  return m;
}

/**
 * Voz de motor reutilizable: onda del motor (tono) + ruido de escape filtrado cuya amplitud late con la misma onda
 * (traqueteo del diésel, "putt" de la moto) y rodadura → paso bajo → ganancia → paneo → salida.
 */
export class EngineVoice {
  type = '';
  private osc: OscillatorNode;
  private bp: BiquadFilterNode;
  private nvca: GainNode;
  private mod: GainNode;
  private lp: BiquadFilterNode;
  private vca: GainNode;
  private pan: StereoPannerNode;

  constructor(ctx: BaseAudioContext, private waves: Map<string, PeriodicWave>, noise: AudioBuffer, out: AudioNode,
    offset: number) {
    this.osc = ctx.createOscillator();
    this.osc.frequency.value = 10;
    const src = ctx.createBufferSource();
    src.buffer = noise; src.loop = true;
    this.bp = biquad(ctx, 'bandpass', 1000, 1);
    this.nvca = gainNode(ctx, 0);
    this.mod = gainNode(ctx, 0);
    this.lp = biquad(ctx, 'lowpass', 1000, 0.7);
    this.vca = gainNode(ctx, 0);
    this.pan = ctx.createStereoPanner();
    this.osc.connect(this.lp);
    src.connect(this.bp).connect(this.nvca).connect(this.lp);
    this.osc.connect(this.mod).connect(this.nvca.gain);
    this.lp.connect(this.vca).connect(this.pan).connect(out);
    this.osc.start();
    src.start(0, offset % noise.duration);
  }

  /**
   * Nuevo vehículo en la voz. `quiet` = la voz está en silencio: frecuencia, onda y filtros cambian al instante; si no
   * (voz aún desvaneciéndose), la frecuencia se desliza.
   */
  assign(type: string, f: number, t: number, quiet: boolean) {
    const spec = ENGINES[type] ?? ENGINES.carro;
    if (type !== this.type) {
      this.type = type;
      this.osc.setPeriodicWave(this.waves.get(type) ?? this.waves.get('carro')!);
      this.bp.frequency.setValueAtTime(spec.noiseHz, t);
      this.bp.Q.setValueAtTime(spec.noiseQ, t);
    }
    if (quiet) this.osc.frequency.setValueAtTime(f, t);
    else this.osc.frequency.setTargetAtTime(f, t, 0.05);
  }

  /** Parámetros (con constante de tiempo tau): frecuencia del ciclo, ganancia, corte, paneo, rodadura y golpeteo. */
  set(t: number, f: number, gain: number, lp: number, pan: number, hiss: number, clatter: number, tau: number) {
    this.osc.frequency.setTargetAtTime(f, t, 0.04);
    this.vca.gain.setTargetAtTime(gain, t, tau);
    this.lp.frequency.setTargetAtTime(lp, t, 0.05);
    this.pan.pan.setTargetAtTime(pan, t, 0.05);
    this.nvca.gain.setTargetAtTime(hiss + clatter, t, 0.05);
    this.mod.gain.setTargetAtTime(clatter, t, 0.05);
  }

  /** Se desvanece (sin clic) y queda en silencio. */
  fadeOut(t: number, tau: number) {
    this.vca.gain.setTargetAtTime(0, t, tau);
  }
}

/**
 * Una campanada en vivo (osciladores senoidales por parcial con caída exponencial, dobletes que baten y el golpe
 * metálico del badajo). Se usa para pre-renderizar el banco de campanas y como respaldo mientras no está listo.
 */
export function bellStrike(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer, t: number, bell: number, vel: number) {
  const prime = BELLS[bell] ?? BELLS[0];
  const r = mulberry32(101 + bell * 7919);   // cada campana con su leve desafinación propia (determinista)
  const master = gainNode(ctx, 0.16 * vel);
  master.connect(out);
  const nodes: AudioNode[] = [master];
  let last: OscillatorNode | null = null, lastEnd = 0;
  for (const p of BELL_PARTIALS) {
    const f = prime * p.ratio * (1 + (r() - 0.5) * 0.004);
    if (f > ctx.sampleRate * 0.45) continue;
    const g = ctx.createGain();
    const a = p.amp * (p.ratio > 3 ? vel : 1);  // golpe más fuerte, más brillo
    const att = p.name === 'hum' ? 0.03 : 0.003;
    const end = t + att + p.tau * 5;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(a, t + att);
    g.gain.setTargetAtTime(0, t + att, p.tau);
    // al final (−43 dB) baja a cero en línea recta antes de parar: sin escalón
    g.gain.setValueAtTime(a * Math.exp(-(end - 0.25 - t - att) / p.tau), end - 0.25);
    g.gain.linearRampToValueAtTime(0, end);
    g.connect(master);
    nodes.push(g);
    for (const [df, amp] of p.beat ? [[0, 1], [p.beat, 0.6]] : [[0, 1]]) {
      const o = ctx.createOscillator();
      o.frequency.value = f + df;
      let src: AudioNode = o;
      if (amp !== 1) { const ga = gainNode(ctx, amp); o.connect(ga); src = ga; nodes.push(ga); }
      src.connect(g);
      o.start(t);
      o.stop(end);
      nodes.push(o);
      if (end > lastEnd) { lastEnd = end; last = o; }
    }
  }
  // badajo: chasquido metálico corto
  const s = ctx.createBufferSource();
  s.buffer = noise;
  const hp = biquad(ctx, 'bandpass', 3200, 0.9);
  const gs = ctx.createGain();
  gs.gain.setValueAtTime(0.5 * vel, t);
  gs.gain.setTargetAtTime(0, t, 0.008);
  s.connect(hp).connect(gs).connect(master);
  s.start(t, r() * (noise.duration - 0.2));
  s.stop(t + 0.15);
  nodes.push(s, hp, gs);
  if (last) release(last, nodes);
}

/** Banco de campanas pre-renderizado (una vez, fuera del hilo principal): un búfer por campana, golpe a intensidad 1. */
export async function renderBells(sampleRate: number, seconds = 20): Promise<AudioBuffer[]> {
  const out: AudioBuffer[] = [];
  for (let b = 0; b < BELLS.length; b++) {
    const oc = new OfflineAudioContext(1, Math.round(sampleRate * seconds), sampleRate);
    const fade = gainNode(oc, 1);   // la cola del hum se recorta con un fundido, sin clic
    fade.gain.setValueAtTime(1, seconds - 4);
    fade.gain.linearRampToValueAtTime(0, seconds);
    fade.connect(oc.destination);
    bellStrike(oc, fade, whiteNoise(oc, 0.5, 31 + b), 0, b, 1);
    out.push(await oc.startRendering());
  }
  return out;
}

/** Reproduce una campanada del banco (fuente de un solo uso). */
export function playBuffer(ctx: BaseAudioContext, out: AudioNode, buf: AudioBuffer, t: number, gain: number) {
  const s = ctx.createBufferSource();
  s.buffer = buf;
  const g = gainNode(ctx, gain);
  s.connect(g).connect(out);
  s.start(t);
  release(s, [s, g]);
}

/**
 * Una pisada: ruido filtrado según la superficie con envolvente rápida (dos golpes en el empedrado: talón y punta)
 * y un golpe grave del talón; variación aleatoria de tono y fuerza. Corriendo: más fuerte, más corto y más agudo.
 */
export function footstepSound(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer, t: number, spec: FootSpec,
  run: boolean, land: boolean, r: () => number) {
  const k = (0.85 + 0.3 * r()) * (run ? 1.15 : 1);
  const gain = spec.gain * (run ? 1.35 : 1) * (land ? 1.6 : 1) * (0.8 + 0.4 * r());
  const decay = spec.decay * (run ? 0.8 : 1) * (land ? 1.4 : 1);
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const f = biquad(ctx, spec.type, spec.hz * k, spec.q);
  const lp = biquad(ctx, 'lowpass', spec.lp * k, 0.7);
  const env = ctx.createGain();
  env.gain.value = 0;
  const hit = (t0: number, a: number) => {
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(a, t0 + spec.attack);
    env.gain.setTargetAtTime(0, t0 + spec.attack, decay / 3);
  };
  hit(t, gain);
  if (spec.gap) hit(t + spec.gap * (0.8 + 0.4 * r()), gain * 0.6);
  src.connect(f).connect(lp).connect(env).connect(out);
  const end = t + spec.gap + decay * 3 + 0.05;
  src.start(t, r() * (noise.duration - 0.5));
  src.stop(end);
  const nodes: AudioNode[] = [src, f, lp, env];
  if (spec.thud > 0) {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(spec.thudHz * k * 1.4, t);
    o.frequency.exponentialRampToValueAtTime(spec.thudHz * k, t + 0.03);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(spec.thud * gain, t + 0.004);
    g.gain.setTargetAtTime(0, t + 0.004, 0.018);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(end - 0.01);
    nodes.push(o, g);
  }
  release(src, nodes);
}

/** Pito de un vehículo ya espacializado (ganancia, paneo y corte por distancia). */
export function hornSound(ctx: BaseAudioContext, out: AudioNode, t: number, spec: HornSpec, gain: number, pan: number,
  lp: number) {
  const bp = biquad(ctx, 'bandpass', spec.bp, 0.8);
  const lpf = biquad(ctx, 'lowpass', lp, 0.7);
  const env = ctx.createGain();
  env.gain.value = 0;
  const p = ctx.createStereoPanner();
  p.pan.value = pan;
  let end = t;
  for (const [s, dur] of spec.taps) {
    env.gain.setValueAtTime(0, t + s);
    env.gain.linearRampToValueAtTime(spec.gain * gain, t + s + 0.015);
    env.gain.setValueAtTime(spec.gain * gain, t + s + dur - 0.025);
    env.gain.linearRampToValueAtTime(0, t + s + dur);
    end = Math.max(end, t + s + dur);
  }
  const nodes: AudioNode[] = [bp, lpf, env, p];
  let last: OscillatorNode | null = null;
  for (const hz of spec.hz) {
    const o = ctx.createOscillator();
    o.type = spec.wave;
    o.frequency.value = hz;
    o.connect(bp);
    o.start(t);
    o.stop(end + 0.02);
    nodes.push(o);
    last = o;
  }
  bp.connect(lpf).connect(env).connect(p).connect(out);
  if (last) release(last, nodes);
}

/** Canto de pájaro (notas de birdSong): silbido senoidal con barridos de frecuencia y envolvente por nota. */
export function birdSound(ctx: BaseAudioContext, out: AudioNode, t: number, notes: BirdNote[], n: number, gain: number,
  pan: number, lp: number) {
  if (!n) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  g.gain.value = 0;
  const lpf = biquad(ctx, 'lowpass', lp, 0.7);
  const p = ctx.createStereoPanner();
  p.pan.value = pan;
  o.frequency.setValueAtTime(notes[0].f0, t);
  for (let i = 0; i < n; i++) {
    const b = notes[i], t0 = t + b.t, t1 = t0 + b.dur;
    o.frequency.setValueAtTime(b.f0, t0);
    o.frequency.exponentialRampToValueAtTime(b.f1, t1);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(b.a * gain, t0 + Math.min(0.012, b.dur * 0.25));
    g.gain.setValueAtTime(b.a * gain, t1 - Math.min(0.015, b.dur * 0.3));
    g.gain.linearRampToValueAtTime(0, t1);
  }
  o.connect(g).connect(lpf).connect(p).connect(out);
  const end = t + notes[n - 1].t + notes[n - 1].dur + 0.05;
  o.start(t);
  o.stop(end);
  release(o, [o, g, lpf, p]);
}

/** Hablante del balbuceo: sílabas con vocales (formantes F1/F2) sobre un pulso glotal, frases y pausas. */
interface Talker {
  osc: OscillatorNode; f1: BiquadFilterNode; f2: BiquadFilterNode; g: GainNode; pan: StereoPannerNode;
  /** s hasta la próxima sílaba, s que le quedan a la frase, tono base (Hz), nivel de la frase, progreso. */
  syl: number; phrase: number; f0: number; level: number; len: number;
}

/**
 * Ambiente continuo de la ciudad: murmullo de multitud (ruido por dos bandas de formantes que se mueven al azar al
 * ritmo de las sílabas) más hablantes sueltos, rumor del tráfico (ruido marrón grave) y aire de fondo. Se crea una vez;
 * update() (≤ 30 Hz) sólo programa valores con setTargetAtTime.
 */
export class Ambience {
  private bp1: BiquadFilterNode;
  private bp2: BiquadFilterNode;
  private g1: GainNode;
  private g2: GainNode;
  private murmur: GainNode;
  private talk: GainNode;
  private talkers: Talker[] = [];
  private rumble: GainNode;
  private hiss: GainNode;
  private air: GainNode;
  private airLp: BiquadFilterNode;
  private gust = 0;

  constructor(ctx: BaseAudioContext, white: AudioBuffer, brown: AudioBuffer, out: AudioNode, private r: () => number) {
    const loop = (b: AudioBuffer, off: number) => {
      const s = ctx.createBufferSource();
      s.buffer = b; s.loop = true;
      s.start(0, off * b.duration);
      return s;
    };
    // murmullo
    const crowdLp = biquad(ctx, 'lowpass', 2600, 0.6);
    crowdLp.connect(out);
    this.murmur = gainNode(ctx, 0);
    this.murmur.connect(crowdLp);
    this.bp1 = biquad(ctx, 'bandpass', 550, 1.4);
    this.bp2 = biquad(ctx, 'bandpass', 1700, 2);
    this.g1 = gainNode(ctx, 0.7);
    this.g2 = gainNode(ctx, 0.4);
    const w1 = loop(white, 0.1), w2 = loop(white, 0.55);
    w1.connect(this.bp1).connect(this.g1).connect(this.murmur);
    w2.connect(this.bp2).connect(this.g2).connect(this.murmur);
    // hablantes
    this.talk = gainNode(ctx, 0);
    this.talk.connect(crowdLp);
    const N = 40, imag = new Float32Array(N);
    for (let k = 1; k < N; k++) imag[k] = Math.pow(k, -1.4);
    const glottal = ctx.createPeriodicWave(new Float32Array(N), imag);
    for (let i = 0; i < 4; i++) {
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(glottal);
      osc.frequency.value = 120;
      const f1 = biquad(ctx, 'bandpass', 600, 5), f2 = biquad(ctx, 'bandpass', 1500, 7);
      const g2 = gainNode(ctx, 0.55), g = gainNode(ctx, 0), pan = ctx.createStereoPanner();
      osc.connect(f1).connect(g);
      osc.connect(f2).connect(g2).connect(g);
      g.connect(pan).connect(this.talk);
      osc.start();
      this.talkers.push({ osc, f1, f2, g, pan, syl: r() * 2, phrase: 0, f0: 120, level: 0, len: 1 });
    }
    // rumor del tráfico y aire
    this.rumble = gainNode(ctx, 0);
    loop(brown, 0.3).connect(biquad(ctx, 'lowpass', 150, 0.8)).connect(this.rumble).connect(out);
    this.hiss = gainNode(ctx, 0);
    loop(white, 0.8).connect(biquad(ctx, 'bandpass', 500, 0.6)).connect(this.hiss).connect(out);
    this.air = gainNode(ctx, 0);
    this.airLp = biquad(ctx, 'lowpass', 380, 0.5);
    loop(brown, 0.7).connect(this.airLp).connect(this.air).connect(out);
  }

  /** t = reloj del audio; dt = s desde la última llamada; niveles 0..1 (zoneMix). */
  update(t: number, dt: number, murmur: number, talk: number, rumble: number, air: number) {
    const r = this.r;
    // multitud: niveles con fundido lento; formantes del ruido al azar (balbuceo)
    this.murmur.gain.setTargetAtTime(0.2 * murmur, t, 0.8);
    if (murmur > 0.01) {
      this.bp1.frequency.setTargetAtTime(380 + 420 * r(), t, 0.07);
      this.bp2.frequency.setTargetAtTime(1100 + 1100 * r(), t, 0.07);
      this.g1.gain.setTargetAtTime(0.45 + 0.55 * r(), t, 0.06);
      this.g2.gain.setTargetAtTime(0.2 + 0.4 * r(), t, 0.06);
    }
    this.talk.gain.setTargetAtTime(0.14 * talk, t, 0.8);
    if (talk > 0.01) for (const k of this.talkers) this.talker(k, t, dt);
    this.rumble.gain.setTargetAtTime(0.25 * rumble, t, 0.6);
    this.hiss.gain.setTargetAtTime(0.035 * rumble, t, 0.6);
    // aire: ráfagas lentas
    this.gust -= dt;
    if (this.gust <= 0) {
      this.gust = 0.8 + 2 * r();
      this.air.gain.setTargetAtTime(0.05 * air * (0.4 + 0.8 * r()), t, 0.9);
      this.airLp.frequency.setTargetAtTime(260 + 300 * r(), t, 1.2);
    }
  }

  private talker(k: Talker, t: number, dt: number) {
    const r = this.r;
    k.syl -= dt;
    if (k.syl > 0) return;
    if (k.phrase <= 0) {
      // pausa entre frases y luego otra persona (tono, lado y distancia nuevos)
      if (k.level > 0) { k.level = 0; k.g.gain.setTargetAtTime(0, t, 0.04); k.syl = 0.4 + 2.2 * r(); return; }
      k.len = k.phrase = 0.9 + 2.4 * r();
      k.f0 = r() < 0.5 ? 100 + 45 * r() : 175 + 70 * r();
      k.level = 0.3 + 0.7 * r();
      k.pan.pan.setTargetAtTime((r() - 0.5) * 1.4, t, 0.02);
    }
    const dur = 0.11 + 0.14 * r();
    k.syl = dur; k.phrase -= dur;
    const [F1, F2] = VOWELS[Math.floor(r() * VOWELS.length)];
    const sp = k.f0 > 160 ? 1.12 : 1;     // formantes más altos en voces agudas
    const decl = 1 - 0.12 * (1 - k.phrase / k.len);   // la entonación baja hacia el final de la frase
    k.osc.frequency.setTargetAtTime(k.f0 * decl * (0.93 + 0.14 * r()), t, 0.03);
    k.f1.frequency.setTargetAtTime(F1 * sp, t, 0.025);
    k.f2.frequency.setTargetAtTime(F2 * sp, t, 0.025);
    k.g.gain.setTargetAtTime(k.level, t, 0.015);
    k.g.gain.setTargetAtTime(k.level * 0.12, t + dur * 0.65, 0.025);   // consonante entre sílabas
  }
}
