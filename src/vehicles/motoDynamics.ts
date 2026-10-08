/**
 * Dinámica de la moto (pura, sin three ni Rapier: se prueba con vitest).
 *
 * Longitudinal: motor con curva de par + caja automática de 5 marchas + embrague de arranque,
 * límite de tracción (rueda trasera), arrastre aerodinámico, rodadura, pendiente, freno motor y frenos
 * limitados por la adherencia de la superficie.
 * Lateral: se gira inclinando (como una moto real): el mando fija la inclinación objetivo, la inclinación sigue
 * una dinámica de segundo orden y la guiñada sale del equilibrio en curva ω = g·tan(φ)/v. A baja velocidad la
 * moto va casi vertical y gira con el manubrio (modelo cinemático). Círculo de fricción: si freno + curva
 * piden más que μ·g, la moto se abre (derrapa) y se reporta deslizamiento.
 */

export interface MotoSpec {
  massBike: number; massRider: number; wheelbase: number; wheelRadius: number; cgHeight: number; rearLoad: number;
  cdA: number; drivetrainEff: number; idleRpm: number; clutchRpm: number; redlineRpm: number;
  torqueCurve: [number, number][]; primary: number; final: number; gears: number[];
  shiftUpRpm: number; shiftUpRpmPartial: number; shiftDownRpm: number; shiftTime: number; engineBrakeNm: number;
  brakeMaxG: number; brakeRampTime: number; maxLeanDeg: number; minTurnRadius: number; lowSpeedSteerDeg: number;
  rollStiffness: number; pushSpeed: number; footDownLeanDeg: number; pitchPerAccel: number;
}

export interface MotoEnv {
  mu: number;            // adherencia de la superficie
  crr: number;           // resistencia a la rodadura
  airDensity: number;    // kg/m³
  powerFactor: number;   // pérdida de potencia por altitud (motor atmosférico)
  slopeSin: number;      // seno de la pendiente en la dirección de marcha (+ = subida)
}

export interface MotoInput { throttle: number; brake: number; steer: number; /** S sostenida detenida: empujar hacia atrás */ reverse?: boolean }

const G = 9.81;
const DEG = Math.PI / 180;

/** Atmósfera estándar internacional: densidad del aire y factor de potencia a una altitud h (m). */
export function atmosphere(h: number) {
  const ratio = Math.pow(1 - 2.25577e-5 * h, 4.2559);
  return { airDensity: 1.225 * ratio, powerFactor: ratio };
}

function interp(curve: [number, number][], x: number) {
  if (x <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    if (x <= curve[i][0]) {
      const [x0, y0] = curve[i - 1], [x1, y1] = curve[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return curve[curve.length - 1][1];
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class MotoDynamics {
  v = 0;            // m/s a lo largo del eje (negativo sólo al empujarla hacia atrás)
  rpm: number;
  gear = 0;         // índice 0..4
  shiftTimer = 0;
  lean = 0;         // rad, + = derecha
  leanVel = 0;
  yawRate = 0;      // rad/s, + = gira a la derecha
  steerAngle = 0;   // ángulo del manubrio (visual), rad
  aLong = 0;        // m/s²
  slip = 0;         // 0..1 (derrape)
  pitch = 0;        // cabeceo por transferencia de carga (rad, + = nariz arriba)
  private pitchVel = 0;
  private brakeLevel = 0;
  private stoppedBrakeTime = 0;
  throttle = 0;
  readonly mass: number;

  constructor(readonly s: MotoSpec) {
    this.rpm = s.idleRpm;
    this.mass = s.massBike + s.massRider;
  }

  ratio(g = this.gear) { return this.s.primary * this.s.final * this.s.gears[g]; }

  step(dt: number, inp: MotoInput, env: MotoEnv) {
    const s = this.s, m = this.mass;
    const throttle = Math.max(0, Math.min(1, inp.throttle));
    this.throttle = throttle;
    // Presión de freno progresiva (las teclas son digitales)
    const bTarget = Math.max(0, Math.min(1, inp.brake));
    this.brakeLevel += Math.sign(bTarget - this.brakeLevel) * Math.min(Math.abs(bTarget - this.brakeLevel), dt / s.brakeRampTime);

    // ---------------- motor y caja
    const wheelRpm = (Math.abs(this.v) / (2 * Math.PI * s.wheelRadius)) * 60;
    let rpmWheel = wheelRpm * this.ratio();
    if (this.shiftTimer > 0) this.shiftTimer -= dt;
    else if (this.v > 0.5) {
      const up = throttle > 0.9 ? s.shiftUpRpm : s.shiftUpRpmPartial;
      if (rpmWheel > up && this.gear < s.gears.length - 1) { this.gear++; this.shiftTimer = s.shiftTime; }
      else if (rpmWheel < s.shiftDownRpm && this.gear > 0) { this.gear--; this.shiftTimer = s.shiftTime * 0.6; }
      rpmWheel = wheelRpm * this.ratio();
    }
    if (this.v < 1.0 && this.gear !== 0) this.gear = 0;
    // Embrague: por debajo de clutchRpm patina (arranque) y el motor sube hasta clutchRpm con gas
    const slipping = rpmWheel < s.clutchRpm && throttle > 0;
    let rpmTarget = slipping ? Math.max(rpmWheel, s.idleRpm + (s.clutchRpm - s.idleRpm) * throttle) : Math.max(rpmWheel, s.idleRpm);
    if (this.shiftTimer > 0) rpmTarget = Math.max(s.idleRpm, rpmWheel * (throttle > 0 ? 0.92 : 1));
    this.rpm += (rpmTarget - this.rpm) * Math.min(1, dt * (slipping ? 6 : 18));
    this.rpm = Math.min(this.rpm, s.redlineRpm);
    const limiter = this.rpm >= s.redlineRpm - 50 ? 0 : 1;
    const torque = interp(s.torqueCurve, this.rpm) * throttle * env.powerFactor * limiter * (this.shiftTimer > 0 ? 0 : 1);
    let fDrive = (torque * this.ratio() * s.drivetrainEff) / s.wheelRadius;
    // Límite de tracción de la rueda trasera (con transferencia de carga)
    const rearN = m * G * (s.rearLoad + Math.max(0, this.aLong) * s.cgHeight / (s.wheelbase * G));
    fDrive = Math.min(fDrive, env.mu * rearN);
    // Freno motor (con gas cerrado y embragado)
    const fEngBrake = throttle === 0 && this.v > 1 ? (s.engineBrakeNm * this.ratio() * (this.rpm / s.redlineRpm)) / s.wheelRadius : 0;

    // ---------------- fuerzas longitudinales
    const v = this.v;
    const fAero = 0.5 * env.airDensity * s.cdA * v * Math.abs(v);
    const fRoll = env.crr * m * G * Math.sign(v);
    const fGrade = m * G * env.slopeSin;
    let a = (fDrive - fAero - fRoll - fGrade - fEngBrake) / m;
    const brakeDecel = this.brakeLevel * Math.min(s.brakeMaxG, env.mu * 0.95) * G;
    if (v > 0) a -= brakeDecel;
    let nv = v + a * dt;
    if (v >= 0 && nv < 0) nv = 0;                     // los frenos no hacen ir hacia atrás
    // Detenida con freno sostenido: se empuja hacia atrás con los pies (las motos no tienen reversa)
    if (Math.abs(v) < 0.3 && inp.reverse && throttle === 0) this.stoppedBrakeTime += dt; else this.stoppedBrakeTime = 0;
    if (this.stoppedBrakeTime > 0.5) nv = -s.pushSpeed;
    else if (v < 0) nv = Math.min(0, v + 3 * dt);    // deja de empujar
    this.aLong = (nv - v) / Math.max(dt, 1e-6);
    this.v = nv;

    // ---------------- lateral: inclinación → guiñada
    const sp = Math.abs(this.v);
    const muLat = env.mu * 0.95;
    const tanGrip = muLat;
    const tanRadius = (sp * sp) / (G * s.minTurnRadius);
    const leanMax = Math.min(s.maxLeanDeg * DEG, Math.atan(Math.min(tanGrip, tanRadius)));
    let target = Math.max(-1, Math.min(1, inp.steer)) * leanMax;
    if (sp < 0.6) target = -s.footDownLeanDeg * DEG;   // parada: pie izquierdo en el suelo
    const wn = s.rollStiffness * (0.45 + 0.55 * smooth(0, 8, sp));
    const leanAcc = wn * wn * (target - this.lean) - 2 * wn * this.leanVel;
    this.leanVel += leanAcc * dt;
    this.lean += this.leanVel * dt;

    const yawHigh = (G * Math.tan(this.lean)) / Math.max(sp, 0.1);
    const steerLow = Math.max(-1, Math.min(1, inp.steer)) * s.lowSpeedSteerDeg * DEG;
    const yawLow = (this.v * Math.tan(steerLow)) / s.wheelbase;
    const b = smooth(1.5, 4.5, sp);
    let yaw = yawLow * (1 - b) + yawHigh * b;
    // Círculo de fricción: la aceleración total no puede superar μ·g
    const aMax = env.mu * G;
    const aLat = sp * yaw;
    const aTot = Math.hypot(aLat, this.aLong);
    this.slip = 0;
    if (aTot > aMax && sp > 2) {
      const latAllowed = Math.sqrt(Math.max(0, aMax * aMax - this.aLong * this.aLong));
      this.slip = Math.min(1, (aTot - aMax) / aMax + 0.25);
      yaw = (Math.sign(aLat) * Math.min(Math.abs(aLat), latAllowed)) / sp;
    }
    if (this.brakeLevel > 0.95 && sp > 3 && env.mu < 0.7) this.slip = Math.max(this.slip, 0.35);
    this.yawRate = yaw;
    this.steerAngle = Math.atan((yaw * s.wheelbase) / Math.max(Math.abs(this.v), 0.6)) * Math.sign(this.v || 1);

    // ---------------- cabeceo por transferencia de carga (suspensión, resorte-amortiguador)
    const pTarget = this.aLong * s.pitchPerAccel;
    this.pitchVel += (60 * (pTarget - this.pitch) - 9 * this.pitchVel) * dt;
    this.pitch += this.pitchVel * dt;
    return this;
  }

  get speedKmh() { return Math.abs(this.v) * 3.6; }
}
