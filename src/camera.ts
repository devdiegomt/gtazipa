import * as THREE from 'three/webgpu';
import type RAPIER from '@dimforge/rapier3d-compat';
import { WORLD_ONLY, type Physics } from './physics';
import cfg from './data/player.json';

const DEG = Math.PI / 180;
const NO_ROT = { x: 0, y: 0, z: 0, w: 1 };
const MIN_DIST = 0.3;
/** Tramo de distancia (m) en el que el personaje se desvanece cuando la cámara queda pegada a él. */
const FADE_NEAR = 0.4, FADE_FAR = 1.2;

/**
 * Cámara orbital en tercera persona con colisión (shape cast de una esfera). Solo choca con la geometría del mundo:
 * ignora vehículos, la moto, al jugador y los muros invisibles del borde.
 */
export class OrbitCamera {
  yaw = 0;    // 0 = mirando al norte (-Z)
  pitch = 18 * DEG; // elevación de la cámara sobre el pivote
  distance = cfg.camera.distance;
  /** Distancia real tras resolver colisiones. */
  current = cfg.camera.distance;
  /** Radianes por píxel de ratón. */
  sensitivity = cfg.camera.sensitivity;
  /** Invierte el eje vertical del ratón. */
  invertY = false;
  /** Colliders adicionales que la cámara ignora (p. ej. la moto en la que se va montado). */
  ignore: RAPIER.Collider[] = [];
  private ball: RAPIER.Ball;
  private pivot = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private keep = (c: RAPIER.Collider) => !this.ignore.includes(c);

  constructor(readonly camera: THREE.PerspectiveCamera, private phys: Physics, private exclude: RAPIER.Collider) {
    this.ball = new phys.R.Ball(0.2);
  }

  input(dx: number, dy: number, wheel: number) {
    const s = this.sensitivity;
    this.yaw -= dx * s;
    this.pitch = THREE.MathUtils.clamp(this.pitch + (this.invertY ? -dy : dy) * s,
      cfg.camera.minPitchDeg * DEG, cfg.camera.maxPitchDeg * DEG);
    if (wheel) {
      this.distance = THREE.MathUtils.clamp(this.distance * Math.exp(wheel * 0.0012), cfg.camera.minDistance, cfg.camera.maxDistance);
    }
  }

  /** 1 = personaje visible; baja a 0 cuando la cámara queda pegada a él (para desvanecerlo en vez de ver por dentro). */
  get nearFade() { return THREE.MathUtils.smoothstep(this.current, FADE_NEAR, FADE_FAR); }

  /** Vectores de movimiento relativos a la cámara (plano XZ). */
  basis() {
    return {
      fx: -Math.sin(this.yaw), fz: -Math.cos(this.yaw),
      rx: Math.cos(this.yaw), rz: -Math.sin(this.yaw),
    };
  }

  update(feet: THREE.Vector3, dt: number, pivotHeight = cfg.camera.pivotHeight) {
    const pivot = this.pivot.set(feet.x, feet.y + pivotHeight, feet.z);
    const cp = Math.cos(this.pitch);
    const dir = this.dir.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    let allowed = this.distance;
    const hit = this.phys.world.castShape(
      pivot, NO_ROT, dir, this.ball, 0, this.distance, true,
      undefined, WORLD_ONLY, this.exclude, undefined, this.ignore.length ? this.keep : undefined,
    );
    if (hit) allowed = Math.max(MIN_DIST, hit.time_of_impact - cfg.camera.collisionMargin);
    // Acercarse al instante (no atravesar paredes); alejarse suavemente.
    this.current = allowed < this.current ? allowed : this.current + (allowed - this.current) * Math.min(1, dt * 4);
    this.camera.position.copy(pivot).addScaledVector(dir, this.current);
    this.camera.lookAt(pivot);
  }
}
