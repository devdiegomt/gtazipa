import RAPIER from '@dimforge/rapier3d-compat';

export type Rapier = typeof RAPIER;

export class Physics {
  world!: RAPIER.World;
  R: Rapier = RAPIER;

  async init() {
    await RAPIER.init();
    this.world = new RAPIER.World({ x: 0, y: 0, z: 0 }); // la gravedad del personaje se integra a mano
    this.world.timestep = 1 / 60;
  }

  addTrimesh(vertices: Float32Array, indices: Uint32Array) {
    const desc = RAPIER.ColliderDesc.trimesh(vertices, indices);
    return this.world.createCollider(desc);
  }

  addCylinder(x: number, y: number, z: number, radius: number, height: number) {
    return this.world.createCollider(RAPIER.ColliderDesc.cylinder(height / 2, radius).setTranslation(x, y + height / 2, z));
  }

  /** Muros invisibles en el borde del área jugable. */
  addBounds(half: number, minY: number, maxY: number) {
    const h = (maxY - minY) / 2 + 60;
    const cy = (maxY + minY) / 2;
    const t = 1;
    const walls: [number, number, number, number][] = [
      [0, -half - t, half + t, t], [0, half + t, half + t, t],
      [-half - t, 0, t, half + t], [half + t, 0, t, half + t],
    ];
    for (const [x, z, hx, hz] of walls) {
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(hx, h, hz).setTranslation(x, cy, z));
    }
  }
}
