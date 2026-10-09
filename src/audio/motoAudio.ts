/**
 * Sonido de la moto sintetizado con WebAudio (sin archivos): monocilíndrico de 4 tiempos.
 * La frecuencia de encendido es rpm/120 (una explosión cada dos vueltas): a ralentí (1 500 rpm) son 12,5 Hz,
 * por eso el sonido "tuc-tuc" sale de los armónicos. Se suman viento y derrape (ruido filtrado) y golpes.
 * El AudioContext se crea con el primer gesto del usuario (requisito de los navegadores). M = silenciar.
 * En pausa el contexto se suspende (motor, viento y pitos callan y el tiempo de audio se detiene).
 * El contexto y la salida general (volumen de las opciones y silencio) se comparten con el audio de la ciudad
 * (`context`, `output`, `onReady`): todo el sonido del juego pasa por el mismo bus y el mismo compresor.
 */
export class MotoAudio {
  private ctx: AudioContext | null = null;
  /** Salida general: volumen de las opciones × silencio (M). */
  private out!: GainNode;
  private master!: GainNode;
  private engGain!: GainNode;
  private osc!: OscillatorNode;
  private sub!: OscillatorNode;
  private lp!: BiquadFilterNode;
  private intake!: GainNode;
  private wind!: GainNode;
  private skid!: GainNode;
  private noise!: AudioBuffer;
  muted = false;
  /** Volumen general de las opciones (0..1), multiplica el de vehicles.json. */
  private level = 1;
  private paused = false;
  private running = false;
  private startT = 0;
  private readyCbs: ((ctx: AudioContext, out: GainNode) => void)[] = [];

  constructor(private volume = 0.5) {
    const unlock = () => this.ensure();
    addEventListener('keydown', unlock);
    addEventListener('pointerdown', unlock);
    addEventListener('keydown', (e) => { if (e.code === 'KeyM' && !this.paused) this.toggleMute(); });
  }

  private get outGain() { return this.muted ? 0 : this.level; }

  /** Contexto compartido (null hasta el primer gesto del usuario). */
  get context(): AudioContext | null { return this.ctx; }
  /** Bus de salida general (volumen de las opciones, silencio, compresor); null hasta que exista el contexto. */
  get output(): GainNode | null { return this.ctx ? this.out : null; }
  /** Llama a cb cuando el contexto exista (en seguida si ya existe). */
  onReady(cb: (ctx: AudioContext, out: GainNode) => void) {
    if (this.ctx) cb(this.ctx, this.out); else this.readyCbs.push(cb);
  }

  private ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended' && !this.paused) void this.ctx.resume(); return; }
    let ctx: AudioContext;
    try { ctx = new AudioContext(); } catch { return; }
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = this.outGain;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(this.out).connect(comp).connect(ctx.destination);

    // Pulso de escape: espectro tipo diente de sierra con armónicos pares reforzados (golpe del monocilíndrico)
    const N = 40;
    const real = new Float32Array(N), imag = new Float32Array(N);
    for (let n = 1; n < N; n++) imag[n] = (1 / Math.pow(n, 0.85)) * (n % 2 === 0 ? 1.4 : 1) * (n < 4 ? 0.6 : 1);
    const wave = ctx.createPeriodicWave(real, imag);
    this.osc = ctx.createOscillator();
    this.osc.setPeriodicWave(wave);
    this.sub = ctx.createOscillator();
    this.sub.type = 'triangle';
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = (i / 1023) * 2 - 1; curve[i] = Math.tanh(2.2 * x); }
    shaper.curve = curve;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.Q.value = 0.9;
    const body = ctx.createBiquadFilter();
    body.type = 'peaking';
    body.frequency.value = 140;
    body.gain.value = 7;
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.35;
    this.osc.connect(shaper).connect(this.lp).connect(body).connect(this.engGain).connect(this.master);
    this.sub.connect(subGain).connect(this.lp);

    // Ruido blanco compartido: admisión, viento, derrape
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const noiseChain = (type: BiquadFilterType, f: number, q: number) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const flt = ctx.createBiquadFilter();
      flt.type = type; flt.frequency.value = f; flt.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(flt).connect(g).connect(this.master);
      src.start();
      return g;
    };
    this.intake = noiseChain('bandpass', 1600, 1.2);
    this.wind = noiseChain('lowpass', 650, 0.5);
    this.skid = noiseChain('bandpass', 1150, 6);
    this.osc.start();
    this.sub.start();
    if (this.paused) void ctx.suspend();
    for (const cb of this.readyCbs.splice(0)) cb(ctx, this.out);
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.ctx) this.out.gain.setTargetAtTime(this.outGain, this.ctx.currentTime, 0.05);
  }

  /** Volumen general (opciones), 0..1. */
  setLevel(v: number) {
    this.level = v;
    if (this.ctx) this.out.gain.setTargetAtTime(this.outGain, this.ctx.currentTime, 0.05);
  }

  /** Pausa: suspende el contexto (y no lo reanuda ningún gesto hasta quitarla). */
  setPaused(p: boolean) {
    this.paused = p;
    if (!this.ctx) return;
    if (p) void this.ctx.suspend(); else if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /** Arranque: motor de arranque y subida a ralentí. */
  start() {
    this.ensure();
    if (!this.ctx) return;
    this.running = true;
    this.startT = this.ctx.currentTime;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(95, t);
    o.frequency.linearRampToValueAtTime(130, t + 0.5);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0, t);
    g.gain.linearRampToValueAtTime(0.06, t + 0.05);
    g.gain.linearRampToValueAtTime(0.0, t + 0.6);
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 900;
    o.connect(f).connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.65);
  }

  stop() { this.running = false; }

  /** Pito de un vehículo (doble toque), con volumen según la distancia (0..1). */
  honk(gain: number) {
    if (!this.ctx || gain <= 0.02) return;
    const t = this.ctx.currentTime;
    for (const [start, dur] of [[0, 0.16], [0.22, 0.3]]) {
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t + start);
      g.gain.linearRampToValueAtTime(0.18 * gain, t + start + 0.02);
      g.gain.setValueAtTime(0.18 * gain, t + start + dur - 0.03);
      g.gain.linearRampToValueAtTime(0, t + start + dur);
      const f = this.ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 900; f.Q.value = 0.8;
      for (const hz of [415, 523]) {
        const o = this.ctx.createOscillator();
        o.type = 'square';
        o.frequency.value = hz;
        o.connect(f);
        o.start(t + start);
        o.stop(t + start + dur + 0.02);
      }
      f.connect(g).connect(this.master);
    }
  }

  /** Golpe contra un obstáculo (dv en m/s). */
  impact(dv: number) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 380;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(Math.min(1, dv / 8), t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + 0.5);
  }

  /** Llamar cada frame. rpm del motor, gas 0..1, velocidad m/s, deslizamiento 0..1. */
  update(rpm: number, throttle: number, speed: number, slip: number) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const on = this.running && t - this.startT > 0.45;
    const fire = rpm / 120;
    const jitter = 1 + (Math.random() - 0.5) * 0.03;          // irregularidad de combustión
    this.osc.frequency.setTargetAtTime(fire * jitter, t, 0.02);
    this.sub.frequency.setTargetAtTime(fire * 0.5, t, 0.02);
    const load = 0.25 + 0.75 * throttle;
    this.lp.frequency.setTargetAtTime(220 + 2400 * throttle * Math.min(1, rpm / 7000) + rpm * 0.05, t, 0.04);
    this.engGain.gain.setTargetAtTime(on ? 0.16 + 0.34 * load : 0, t, 0.05);
    this.intake.gain.setTargetAtTime(on ? 0.02 + 0.06 * throttle * (rpm / 9500) : 0, t, 0.05);
    const v = Math.min(1, Math.abs(speed) / 26);
    this.wind.gain.setTargetAtTime(0.35 * v * v, t, 0.1);
    this.skid.gain.setTargetAtTime(on ? Math.min(0.35, slip * 0.4) : 0, t, 0.03);
  }
}
