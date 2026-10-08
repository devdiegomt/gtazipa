import type RAPIER from '@dimforge/rapier3d-compat';
import type { Physics } from '../physics';
import { MotoDynamics, type MotoEnv, type MotoSpec } from './motoDynamics';
import type { SurfaceMap } from './surface';
import vcfg from '../data/vehicles.json';

const C = vcfg.moto;
const DEG = Math.PI / 180;
const SURF = C.surfaces as Record<string, { mu: number; crr: number }>;

export interface MotoControls { throttle: number; brake: number; steer: number; reverse?: boolean }

/**
 * Moto: la dinámica (motor, caja, adherencia, inclinación) está en MotoDynamics; aquí se integra con Rapier
 * mediante un KinematicCharacterController con una cápsula acostada (colisiones, bordillos, pendientes).
 */
export class MotoController {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly dyn = new MotoDynamics(C.spec as unknown as MotoSpec);
  private kcc: RAPIER.KinematicCharacterController;
  readonly r = C.collider.radius;
  yaw: number;              // adelante = (-sin, -cos), como el avatar
  vy = 0;
  grounded = true;
  wheelSpin = 0;
  lean = -C.parkedLeanDeg * DEG;   // visual (+ = derecha)
  terrainPitch = 0;
  surface = 'asphalt';
  prev = { x: 0, y: 0, z: 0, yaw: 0 };
  curr = { x: 0, y: 0, z: 0, yaw: 0 };
  /** Último impacto: m/s perdidos y momento (ms), para sonido y sacudida de cámara. */
  impact = { dv: 0, at: 0 };
  private clock = 0;

  constructor(private phys: Physics, x: number, y: number, z: number, yaw: number,
    private surfaces: SurfaceMap, private atm: { airDensity: number; powerFactor: number }) {
    const R = phys.R;
    this.yaw = yaw;
    this.body = phys.world.createRigidBody(
      R.RigidBodyDesc.kinematicPositionBased().setTranslation(x, y + this.r, z).setRotation(this.yawQuat(yaw)),
    );
    const s = Math.SQRT1_2; // cápsula acostada a lo largo del eje Z local de la moto
    this.collider = phys.world.createCollider(
      R.ColliderDesc.capsule(C.collider.halfLength, this.r).setRotation({ x: s, y: 0, z: 0, w: s }), this.body,
    );
    this.kcc = phys.world.createCharacterController(0.03);
    this.kcc.setUp({ x: 0, y: 1, z: 0 });
    this.kcc.setMaxSlopeClimbAngle(C.maxSlopeDeg * DEG);
    this.kcc.setMinSlopeSlideAngle((C.maxSlopeDeg + 8) * DEG);
    this.kcc.enableAutostep(C.autostep.maxHeight, C.autostep.minWidth, false);
    this.kcc.enableSnapToGround(C.snapToGround);
    this.kcc.setSlideEnabled(true);
    this.curr = { x, y, z, yaw };
    this.prev = { ...this.curr };
  }

  get speed() { return this.dyn.v; }
  get steerAngle() { return this.dyn.steerAngle; }
  get suspPitch() { return this.dyn.pitch; }

  private yawQuat(yaw: number) {
    return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
  }

  /** Paso fijo. Sin jinete la moto está apagada, frenada y apoyada en la pata. */
  step(dt: number, ctl: MotoControls, riding: boolean) {
    this.clock += dt;
    const t0 = this.body.translation();
    this.surface = this.surfaces.at(t0.x, t0.z);
    const sf = SURF[this.surface] ?? SURF.lot;
    const env: MotoEnv = { mu: sf.mu, crr: sf.crr, ...this.atm, slopeSin: Math.sin(this.terrainPitch) };
    this.dyn.step(dt, riding ? ctl : { throttle: 0, brake: 1, steer: 0 }, env);
    if (!riding && this.dyn.v < 0) this.dyn.v = 0;   // estacionada: no se empuja sola
    this.yaw -= this.dyn.yawRate * dt;

    this.vy = this.grounded ? 0 : this.vy - 9.81 * dt;
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const v = this.dyn.v;
    this.kcc.computeColliderMovement(this.collider, { x: fx * v * dt, y: this.vy * dt, z: fz * v * dt });
    const mv = this.kcc.computedMovement();
    this.grounded = this.kcc.computedGrounded();
    // Choque: la velocidad real a lo largo del eje se ajusta a lo que permitió la colisión
    if (dt > 0 && Math.abs(v) > 0.8) {
      const real = (mv.x * fx + mv.z * fz) / dt;
      if (Math.abs(real) < Math.abs(v) * 0.7) {
        const dv = Math.abs(v - real);
        if (dv > 1.5) this.impact = { dv, at: this.clock };
        this.dyn.v = real * 0.5;
      }
    }
    const nx = t0.x + mv.x, ny = t0.y + mv.y, nz = t0.z + mv.z;
    this.body.setNextKinematicTranslation({ x: nx, y: ny, z: nz });
    this.body.setNextKinematicRotation(this.yawQuat(this.yaw));
    this.prev = this.curr;
    this.curr = { x: nx, y: ny - this.r, z: nz, yaw: this.yaw };

    this.wheelSpin -= (this.dyn.v / C.spec.wheelRadius) * dt;
    const leanTarget = riding ? this.dyn.lean : -C.parkedLeanDeg * DEG;
    this.lean += (leanTarget - this.lean) * Math.min(1, (riding ? 30 : 5) * dt);
    this.terrainPitch += (this.groundPitch(nx, ny, nz, fx, fz) - this.terrainPitch) * Math.min(1, 12 * dt);
  }

  /** Cabeceo del terreno a partir de rayos al suelo bajo cada rueda (incluye gradas y bordillos). */
  private groundPitch(x: number, y: number, z: number, fx: number, fz: number) {
    const R = this.phys.R;
    const h = C.spec.wheelbase / 2;
    const ray = (dx: number, dz: number) => {
      const hit = this.phys.world.castRay(new R.Ray({ x: x + dx, y: y + 0.8, z: z + dz }, { x: 0, y: -1, z: 0 }), 3, true,
        undefined, undefined, this.collider);
      return hit ? y + 0.8 - hit.timeOfImpact : null;
    };
    const front = ray(fx * h, fz * h), rear = ray(-fx * h, -fz * h);
    if (front === null || rear === null) return this.terrainPitch;
    return Math.atan2(front - rear, C.spec.wheelbase);
  }

  get impactAge() { return this.clock - this.impact.at; }

  teleport(x: number, y: number, z: number, yaw: number) {
    this.yaw = yaw;
    this.dyn.v = 0;
    this.dyn.gear = 0;
    this.vy = 0;
    this.body.setTranslation({ x, y: y + this.r, z }, true);
    this.body.setRotation(this.yawQuat(yaw), true);
    this.curr = { x, y, z, yaw };
    this.prev = { ...this.curr };
  }
}

/** Lugar de estacionamiento: en el andén derecho de la calzada vehicular más cercana a (x0, z0). */
export function parkingSpot(roads: { highway: string; width: number; area: boolean; pts: [number, number][] }[], x0: number, z0: number) {
  const vehicular = new Set(['primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street']);
  let best: { d: number; x: number; z: number; dx: number; dz: number; w: number } | null = null;
  for (const r of roads) {
    if (!vehicular.has(r.highway) || r.area) continue;
    for (let i = 0; i < r.pts.length - 1; i++) {
      const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1];
      const L2 = (bx - ax) ** 2 + (bz - az) ** 2;
      if (L2 < 1e-6) continue;
      const t = Math.max(0.15, Math.min(0.85, ((x0 - ax) * (bx - ax) + (z0 - az) * (bz - az)) / L2));
      const px = ax + t * (bx - ax), pz = az + t * (bz - az);
      const d = Math.hypot(px - x0, pz - z0);
      if (!best || d < best.d) {
        const L = Math.sqrt(L2);
        best = { d, x: px, z: pz, dx: (bx - ax) / L, dz: (bz - az) / L, w: r.width };
      }
    }
  }
  if (!best) return { x: x0 + 3, z: z0, yaw: 0 };
  const rx = -best.dz, rz = best.dx;              // derecha de la marcha
  const off = best.w / 2 + 0.8;                    // sobre el andén, junto al sardinel (no ocupa el carril)
  return { x: best.x + rx * off, z: best.z + rz * off, yaw: Math.atan2(-best.dx, -best.dz) };
}
