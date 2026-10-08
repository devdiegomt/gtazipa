import * as THREE from 'three/webgpu';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Physics } from '../physics';
import vcfg from '../data/vehicles.json';

const C = vcfg.moto;
const DEG = Math.PI / 180;

/**
 * Modelo visual low-poly de una moto de calle (tipo 125 cc, muy común en Cundinamarca).
 * Ejes: adelante = -Z, arriba = +Y. El origen está en el suelo, entre las dos ruedas.
 */
export class MotoModel {
  readonly root = new THREE.Group();
  /** Grupo que se inclina en curvas (gira alrededor del eje de contacto con el suelo). */
  readonly lean = new THREE.Group();
  readonly fork = new THREE.Group();
  private wheels: THREE.Object3D[] = [];
  /** Punto (en coords de `lean`) donde se sienta el jinete. */
  readonly seat = new THREE.Vector3(0, C.seatHeight, 0.12);

  constructor() {
    const col = C.colors;
    const mat = (c: string, rough = 0.6, metal = 0) => new THREE.MeshStandardMaterial({ color: c, roughness: rough, metalness: metal });
    const paint = mat(col.tank, 0.35, 0.3);
    const frame = mat(col.frame, 0.5, 0.4);
    const metal = mat(col.metal, 0.3, 0.9);
    const black = mat(col.seat, 0.8);
    const tire = mat(col.tire, 0.9);
    const add = (parent: THREE.Object3D, geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x, y, z);
      mesh.rotation.set(rx, ry, rz);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };
    const R = C.wheelRadius;
    const half = C.wheelbase / 2;
    this.root.rotation.order = 'YXZ';
    this.root.add(this.lean);

    const wheel = (z: number, parent: THREE.Object3D) => {
      const w = new THREE.Group();
      w.position.set(0, R, z);
      add(w, new THREE.TorusGeometry(R - 0.055, 0.058, 8, 22), tire, 0, 0, 0, 0, Math.PI / 2, 0);
      add(w, new THREE.TorusGeometry(R - 0.11, 0.014, 6, 22), metal, 0, 0, 0, 0, Math.PI / 2, 0);
      add(w, new THREE.CylinderGeometry(0.05, 0.05, 0.14, 10), metal, 0, 0, 0, 0, 0, Math.PI / 2);
      for (let k = 0; k < 5; k++) {   // rin de 5 radios
        const s = add(w, new THREE.BoxGeometry(0.025, R - 0.12, 0.03), metal, 0, 0, 0, (k / 5) * Math.PI * 2, 0, 0);
        s.geometry.translate(0, (R - 0.12) / 2, 0);
      }
      add(w, new THREE.CylinderGeometry(0.1, 0.1, 0.02, 14), metal, 0.05, 0, 0, 0, 0, Math.PI / 2); // disco de freno
      parent.add(w);
      this.wheels.push(w);
      return w;
    };
    wheel(half, this.lean);

    // Chasis, motor, tanque, sillín, colín
    const tube = (a: THREE.Vector3, b: THREE.Vector3, r: number, m: THREE.Material, parent: THREE.Object3D = this.lean) => {
      const len = a.distanceTo(b);
      const mesh = add(parent, new THREE.CylinderGeometry(r, r, len, 8), m, 0, 0, 0);
      mesh.position.copy(a).add(b).multiplyScalar(0.5);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      return mesh;
    };
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    tube(V(0, 0.93, -0.4), V(0, 0.46, 0.22), 0.035, frame);           // tubo principal
    tube(V(0, 0.9, -0.38), V(0, 0.34, -0.2), 0.03, frame);            // cuna
    for (const sx of [-0.11, 0.11]) tube(V(sx, 0.44, 0.2), V(sx, R, half), 0.025, frame); // basculante
    tube(V(0.12, 0.8, 0.28), V(0.11, R + 0.04, half - 0.02), 0.022, metal);   // amortiguador
    tube(V(-0.12, 0.8, 0.28), V(-0.11, R + 0.04, half - 0.02), 0.022, metal);
    add(this.lean, new THREE.BoxGeometry(0.26, 0.28, 0.38), mat('#55595e', 0.5, 0.6), 0, 0.42, -0.06);   // motor
    add(this.lean, new THREE.CylinderGeometry(0.06, 0.07, 0.24, 8), mat('#6b7076', 0.4, 0.7), 0, 0.58, -0.2, 0.5); // cilindro
    const tank = add(this.lean, new THREE.SphereGeometry(0.2, 14, 10), paint, 0, 0.9, -0.24);
    tank.scale.set(0.85, 0.65, 1.45);
    add(this.lean, new THREE.BoxGeometry(0.26, 0.08, 0.52), black, 0, 0.86, 0.2, 0.06);                  // sillín
    add(this.lean, new THREE.BoxGeometry(0.2, 0.1, 0.36), paint, 0, 0.86, 0.56, -0.18);                  // colín
    add(this.lean, new THREE.BoxGeometry(0.14, 0.04, 0.3), black, 0, 0.72, half - 0.06, -0.55);          // guardabarros trasero
    add(this.lean, new THREE.BoxGeometry(0.16, 0.06, 0.03), mat('#c41f1f', 0.4), 0, 0.82, 0.72);          // stop
    // Placa amarilla (formato colombiano de moto: 3 letras, 2 números, 1 letra)
    const cv = document.createElement('canvas');
    cv.width = 128; cv.height = 96;
    const g = cv.getContext('2d')!;
    g.fillStyle = col.plate; g.fillRect(0, 0, 128, 96);
    g.strokeStyle = '#111'; g.lineWidth = 5; g.strokeRect(3, 3, 122, 90);
    g.fillStyle = '#111'; g.font = 'bold 30px Arial'; g.textAlign = 'center';
    const [l1, l2] = C.plate.split(' ');
    g.fillText(l1, 64, 40); g.fillText(l2, 64, 76);
    g.font = 'bold 11px Arial'; g.fillText('ZIPAQUIRÁ', 64, 90);
    const plateTex = new THREE.CanvasTexture(cv);
    plateTex.colorSpace = THREE.SRGBColorSpace;
    add(this.lean, new THREE.PlaneGeometry(0.16, 0.12), new THREE.MeshStandardMaterial({ map: plateTex, roughness: 0.5 }),
      0, 0.66, half + 0.05, 0.25, 0, 0);
    // Exosto cromado
    tube(V(0.1, 0.32, -0.1), V(0.17, 0.38, 0.62), 0.04, metal);

    // Dirección: horquilla, rueda delantera, manubrio, farola, guardabarros.
    // Cabeza de dirección a y = headY con lanzamiento `rake`; la horquilla mide lo justo para que el eje
    // delantero quede en (0, R, -half). El giro del manubrio es alrededor del eje inclinado (como en la realidad).
    const rake = 0.42, headY = 0.95;
    const forkLen = (headY - R) / Math.cos(rake);
    this.fork.position.set(0, headY, -half + forkLen * Math.sin(rake));
    this.fork.rotation.x = rake;
    this.lean.add(this.fork);
    const steer = new THREE.Group();
    this.fork.add(steer);
    this.steerGroup = steer;
    for (const sx of [-0.08, 0.08]) add(steer, new THREE.CylinderGeometry(0.022, 0.022, forkLen, 8), metal, sx, -forkLen / 2, 0);
    const fw = wheel(0, steer);
    fw.position.set(0, -forkLen, 0);
    add(steer, new THREE.CylinderGeometry(0.014, 0.014, 0.66, 8), frame, 0, 0.06, 0.05, 0, 0, Math.PI / 2);   // manubrio
    for (const sx of [-0.31, 0.31]) add(steer, new THREE.CylinderGeometry(0.02, 0.02, 0.1, 8), black, sx, 0.06, 0.05, 0, 0, Math.PI / 2);
    for (const sx of [-0.25, 0.25]) add(steer, new THREE.CylinderGeometry(0.035, 0.035, 0.01, 10), metal, sx, 0.22, 0.07, Math.PI / 2 - 0.3);
    const lamp = add(steer, new THREE.CylinderGeometry(0.08, 0.07, 0.08, 14), new THREE.MeshStandardMaterial({
      color: '#fffbe8', emissive: '#fff3c4', emissiveIntensity: 0.6, roughness: 0.2,
    }), 0, -0.1, -0.11, Math.PI / 2 - rake);
    lamp.castShadow = false;
    add(steer, new THREE.BoxGeometry(0.12, 0.03, 0.42), paint, 0, -forkLen + R + 0.09, -0.02, -rake + 0.1); // guardabarros
    this.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.receiveShadow = true; });
  }

  private steerGroup: THREE.Group;

  /** Giro de ruedas, ángulo de dirección, inclinación (+ = a la derecha) y cabeceo (+ = nariz arriba). */
  pose(wheelSpin: number, steerRad: number, leanRad: number, pitchRad: number) {
    this.wheels[0].rotation.x = wheelSpin;
    this.wheels[1].rotation.x = wheelSpin;
    this.steerGroup.rotation.y = -steerRad;
    this.lean.rotation.z = -leanRad;
    this.root.rotation.x = pitchRad;
  }
}

/** Física arcade de la moto: KinematicCharacterController con una cápsula acostada. */
export class MotoController {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  private kcc: RAPIER.KinematicCharacterController;
  readonly r = C.collider.radius;
  yaw: number;        // misma convención que el avatar: adelante = (-sin, -cos)
  /** Inclinación visual (+ = a la derecha). */
  speed = 0;          // m/s a lo largo del eje de la moto (negativo = reversa)
  steer = 0;          // rad
  vy = 0;
  grounded = true;
  wheelSpin = 0;
  lean = -C.parkedLeanDeg * DEG;
  pitch = 0;
  prev = { x: 0, y: 0, z: 0, yaw: 0 };
  curr = { x: 0, y: 0, z: 0, yaw: 0 };
  /** Último impacto (m/s perdidos contra un obstáculo), para el HUD. */
  lastImpact = 0;

  constructor(private phys: Physics, x: number, y: number, z: number, yaw: number) {
    const R = phys.R;
    this.yaw = yaw;
    const q = this.yawQuat(yaw);
    this.body = phys.world.createRigidBody(
      R.RigidBodyDesc.kinematicPositionBased().setTranslation(x, y + this.r, z).setRotation(q),
    );
    // Cápsula acostada a lo largo del eje Z local de la moto
    const s = Math.SQRT1_2;
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

  private yawQuat(yaw: number) {
    return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
  }

  /** Paso fijo. throttle ∈ [-1, 1] (W/S), steerIn ∈ [-1, 1] (A/D, + = derecha), brake = freno de mano. */
  step(dt: number, throttle: number, steerIn: number, brake: boolean, riding: boolean) {
    const v = this.speed;
    let a = 0;
    if (!riding) {
      a = -Math.sign(v) * C.handBrake;
    } else if (brake) {
      a = -Math.sign(v) * C.handBrake;
    } else if (throttle > 0) {
      a = v >= 0 ? C.acceleration * throttle * (1 - (v / C.maxSpeed) ** 2) : C.brake;
    } else if (throttle < 0) {
      a = v > 0.3 ? -C.brake : -C.acceleration * 0.5;
    } else {
      a = -Math.sign(v) * C.coast;
    }
    let nv = v + a * dt;
    if ((throttle === 0 || brake || !riding) && Math.sign(nv) !== Math.sign(v)) nv = 0; // no invertir al frenar
    this.speed = THREE.MathUtils.clamp(nv, -C.maxReverse, C.maxSpeed);

    // Dirección limitada por la aceleración lateral máxima: a más velocidad, radio de giro mayor
    const v2 = Math.max(this.speed * this.speed, 1e-3);
    const maxSteer = Math.min(C.maxSteerDeg * DEG, Math.atan((C.maxLateralAcc * C.wheelbase) / v2));
    const target = (riding ? steerIn : 0) * maxSteer;
    this.steer += (target - this.steer) * Math.min(1, C.steerRate * dt);
    const yawRate = (this.speed * Math.tan(this.steer)) / C.wheelbase;
    this.yaw -= yawRate * dt;

    // Gravedad / suelo
    this.vy = this.grounded ? 0 : this.vy - C.gravity * dt;
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const desired = { x: fx * this.speed * dt, y: this.vy * dt, z: fz * this.speed * dt };
    this.kcc.computeColliderMovement(this.collider, desired);
    const mv = this.kcc.computedMovement();
    this.grounded = this.kcc.computedGrounded();
    // Choque: la velocidad real a lo largo del eje se ajusta a lo que permitió la colisión
    if (dt > 0 && Math.abs(this.speed) > 0.5) {
      const real = (mv.x * fx + mv.z * fz) / dt;
      if (Math.abs(real) < Math.abs(this.speed) * 0.7) {
        this.lastImpact = Math.abs(this.speed - real);
        this.speed = real * 0.85;
      }
    }
    const t = this.body.translation();
    const nx = t.x + mv.x, ny = t.y + mv.y, nz = t.z + mv.z;
    this.body.setNextKinematicTranslation({ x: nx, y: ny, z: nz });
    this.body.setNextKinematicRotation(this.yawQuat(this.yaw));
    this.prev = this.curr;
    this.curr = { x: nx, y: ny - this.r, z: nz, yaw: this.yaw };

    // Visual: ruedas, inclinación por aceleración centrípeta, cabeceo según el suelo
    this.wheelSpin -= (this.speed / C.wheelRadius) * dt;
    const latAcc = this.speed * yawRate;
    const leanTarget = riding
      ? THREE.MathUtils.clamp(Math.atan2(latAcc, C.gravity), -C.maxLeanDeg * DEG, C.maxLeanDeg * DEG)
      : (Math.abs(this.speed) < 0.2 ? -C.parkedLeanDeg * DEG : 0);   // parada: apoyada en la pata (izquierda)
    this.lean += (leanTarget - this.lean) * Math.min(1, 6 * dt);
    this.pitch += (this.groundPitch(nx, ny, nz, fx, fz) - this.pitch) * Math.min(1, 10 * dt);
  }

  /** Cabeceo a partir de rayos al suelo bajo cada rueda. */
  private groundPitch(x: number, y: number, z: number, fx: number, fz: number) {
    const R = this.phys.R;
    const h = C.wheelbase / 2;
    const ray = (dx: number, dz: number) => {
      const hit = this.phys.world.castRay(new R.Ray({ x: x + dx, y: y + 0.8, z: z + dz }, { x: 0, y: -1, z: 0 }), 3, true,
        undefined, undefined, this.collider);
      return hit ? y + 0.8 - hit.timeOfImpact : null;
    };
    const front = ray(fx * h, fz * h), rear = ray(-fx * h, -fz * h);
    if (front === null || rear === null) return this.pitch;
    return Math.atan2(front - rear, C.wheelbase);
  }

  setEnabled(on: boolean) { this.collider.setEnabled(on); }

  teleport(x: number, y: number, z: number, yaw: number) {
    this.yaw = yaw;
    this.speed = 0;
    this.vy = 0;
    this.steer = 0;
    this.body.setTranslation({ x, y: y + this.r, z }, true);
    this.body.setRotation(this.yawQuat(yaw), true);
    this.curr = { x, y, z, yaw };
    this.prev = { ...this.curr };
  }
}

/** Lugar de estacionamiento: junto al borde derecho de la calzada vehicular más cercana a (x0, z0). */
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
  const off = Math.max(0, best.w / 2 - 0.9);
  return { x: best.x + rx * off, z: best.z + rz * off, yaw: Math.atan2(-best.dx, -best.dz) };
}
