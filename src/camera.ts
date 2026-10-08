import * as THREE from 'three/webgpu';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Physics } from './physics';
import cfg from './data/player.json';

const DEG = Math.PI / 180;

/** Cámara orbital en tercera persona con colisión (shape cast de una esfera contra el mundo). */
export class OrbitCamera {
  yaw = 0;    // 0 = mirando al norte (-Z)
  pitch = 18 * DEG; // elevación de la cámara sobre el pivote
  distance = cfg.camera.distance;
  /** Distancia real tras resolver colisiones. */
  current = cfg.camera.distance;
  private ball: RAPIER.Ball;

  constructor(readonly camera: THREE.PerspectiveCamera, private phys: Physics, private exclude: RAPIER.Collider) {
    this.ball = new phys.R.Ball(0.2);
  }

  input(dx: number, dy: number, wheel: number) {
    const s = cfg.camera.sensitivity;
    this.yaw -= dx * s;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy * s, cfg.camera.minPitchDeg * DEG, cfg.camera.maxPitchDeg * DEG);
    if (wheel) {
      this.distance = THREE.MathUtils.clamp(this.distance * Math.exp(wheel * 0.0012), cfg.camera.minDistance, cfg.camera.maxDistance);
    }
  }

  /** Vectores de movimiento relativos a la cámara (plano XZ). */
  basis() {
    return {
      fx: -Math.sin(this.yaw), fz: -Math.cos(this.yaw),
      rx: Math.cos(this.yaw), rz: -Math.sin(this.yaw),
    };
  }

  /** Colliders adicionales que la cámara ignora (p. ej. la moto en la que se va montado). */
  ignore: RAPIER.Collider[] = [];

  update(feet: THREE.Vector3, dt: number, pivotHeight = cfg.camera.pivotHeight) {
    const pivot = new THREE.Vector3(feet.x, feet.y + pivotHeight, feet.z);
    const cp = Math.cos(this.pitch);
    const dir = new THREE.Vector3(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    let allowed = this.distance;
    const hit = this.phys.world.castShape(
      pivot, { x: 0, y: 0, z: 0, w: 1 }, dir, this.ball, 0, this.distance, true,
      undefined, undefined, this.exclude, undefined, (c) => !this.ignore.includes(c),
    );
    if (hit) allowed = Math.max(0.3, hit.time_of_impact - cfg.camera.collisionMargin);
    // Acercarse al instante (no atravesar paredes); alejarse suavemente.
    this.current = allowed < this.current ? allowed : this.current + (allowed - this.current) * Math.min(1, dt * 4);
    this.camera.position.copy(pivot).addScaledVector(dir, this.current);
    this.camera.lookAt(pivot);
  }
}
