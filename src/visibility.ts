import * as THREE from 'three/webgpu';
import type RAPIER from '@dimforge/rapier3d-compat';
import { WORLD_ONLY, type Physics } from './physics';

/** Muestras de oclusión alrededor del punto: [lateral (m, perpendicular a la visual), altura sobre el suelo (m)]. */
const SAMPLES: [number, number][] = [[0, 1.2], [0, 3], [-3, 1.2], [3, 1.2]];

/**
 * ¿Ve el jugador este punto del suelo? Para el tráfico (aparecer y reciclar sólo donde no se ve). Es visible si:
 * - cae en el frustum de la cámara con margen: `margin` m (el tráfico sólo prueba el centro del vehículo, que mide
 *   hasta 7,5 m) más `angle` rad (giros de cámara entre pasos); lo que queda detrás de la cámara no se ve;
 * - su profundidad de vista (a lo largo del eje de la cámara, como mide la niebla de three; no la distancia) es menor
 *   que `range` (final de la niebla): más allá la niebla lo oculta del todo, también a un lado de la pantalla;
 * - algún rayo desde la cámara hasta el punto (1,2 m sobre el suelo; también el techo de una buseta y ±3 m a los
 *   lados) llega sin chocar con el mundo. WORLD_ONLY: vehículos, jugador y muros invisibles no tapan.
 * update() toma la cámara una vez por paso de tráfico; test() es barato fuera del frustum y lanza ≤ 4 rayos dentro.
 */
export class ViewTest {
  /** Contadores para diagnóstico (llamadas y rayos lanzados desde el último reset). */
  calls = 0;
  rays = 0;
  private frustum = new THREE.Frustum();
  private m = new THREE.Matrix4();
  private sphere = new THREE.Sphere();
  private eye = new THREE.Vector3();
  private fwd = new THREE.Vector3();
  private ray: RAPIER.Ray;

  constructor(private camera: THREE.PerspectiveCamera, private phys: Physics, private heightAt: (x: number, z: number) => number,
    public range: number, readonly margin = 6, readonly angle = 0.18) {
    this.ray = new phys.R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  }

  /** Toma posición, orientación y proyección actuales de la cámara. */
  update() {
    const c = this.camera;
    c.updateMatrixWorld();
    this.m.multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.m, c.coordinateSystem, c.reversedDepth);
    this.eye.setFromMatrixPosition(c.matrixWorld);
    this.fwd.set(0, 0, -1).transformDirection(c.matrixWorld);
  }

  readonly test = (x: number, z: number): boolean => {
    this.calls++;
    const e = this.eye, y = this.heightAt(x, z);
    const dx = x - e.x, dy = y + 1.2 - e.y, dz = z - e.z;
    const d = Math.hypot(dx, dy, dz), f = this.fwd;
    if (dx * f.x + dy * f.y + dz * f.z - this.margin > this.range) return false;
    this.sphere.center.set(x, y + 1.2, z);
    this.sphere.radius = this.margin + d * this.angle;
    if (!this.frustum.intersectsSphere(this.sphere)) return false;
    if (d < this.margin) return true;
    const h = Math.hypot(dx, dz) || 1, lx = -dz / h, lz = dx / h;
    const r = this.ray;
    r.origin.x = e.x; r.origin.y = e.y; r.origin.z = e.z;
    for (const [side, up] of SAMPLES) {
      const tx = x + lx * side - e.x, ty = y + up - e.y, tz = z + lz * side - e.z;
      const L = Math.hypot(tx, ty, tz);
      r.dir.x = tx / L; r.dir.y = ty / L; r.dir.z = tz / L;
      this.rays++;
      // se detiene 0,5 m antes del punto para no contar el suelo o el andén bajo él
      if (!this.phys.world.castRay(r, L - 0.5, true, undefined, WORLD_ONLY)) return true;
    }
    return false;
  };
}
