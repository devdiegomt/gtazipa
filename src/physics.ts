import RAPIER from '@dimforge/rapier3d-compat';

export type Rapier = typeof RAPIER;

/**
 * Bits de pertenencia de los grupos de colisión. Los colliders creados sin grupos (terreno, manzanas, catedral,
 * plaza, parques, andenes) pertenecen a todos los grupos (0xffff) y por tanto cuentan como WORLD.
 */
export const GROUP = { WORLD: 1, BOUNDS: 2, VEHICLE: 4, PLAYER: 8 } as const;

/**
 * InteractionGroups de Rapier: 16 bits altos = pertenencia, 16 bajos = filtro. Dos colliders (o una consulta y un
 * collider) interactúan si la pertenencia de cada uno comparte algún bit con el filtro del otro.
 * Con el filtro por defecto (0xffff) cambiar la pertenencia no altera ningún choque: el KCC consulta sin filtro.
 */
export function groups(membership: number, filter = 0xffff): number {
  return (((membership & 0xffff) << 16) | (filter & 0xffff)) >>> 0;
}

/** Filtro de consultas (cámara, oclusión) que solo ve la geometría del mundo: ignora vehículos, jugador y muros invisibles. */
export const WORLD_ONLY = groups(0xffff, GROUP.WORLD);

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

  /** Muros invisibles en el borde del área jugable (grupo BOUNDS: la cámara no choca con ellos). */
  addBounds(half: number, minY: number, maxY: number) {
    const h = (maxY - minY) / 2 + 60;
    const cy = (maxY + minY) / 2;
    const t = 1;
    const walls: [number, number, number, number][] = [
      [0, -half - t, half + t, t], [0, half + t, half + t, t],
      [-half - t, 0, t, half + t], [half + t, 0, t, half + t],
    ];
    return walls.map(([x, z, hx, hz]) => this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, h, hz).setTranslation(x, cy, z).setCollisionGroups(groups(GROUP.BOUNDS))));
  }
}
