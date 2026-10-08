import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { GROUP, groups, Physics, WORLD_ONLY } from '../src/physics';
import { OrbitCamera } from '../src/camera';
import { Character } from '../src/player/character';
import { Avatar } from '../src/player/avatar';
import { MotoController } from '../src/vehicles/moto';
import { atmosphere } from '../src/vehicles/motoDynamics';
import { SurfaceMap } from '../src/vehicles/surface';
import cfg from '../src/data/player.json';

/**
 * Cámara orbital: el shape cast solo choca con la geometría del mundo (no con el tráfico, la moto, el jugador ni los
 * muros invisibles del borde). Los grupos de colisión no cambian ningún choque del personaje ni de la moto.
 */
const DT = 1 / 60;
const FEET = new THREE.Vector3(0, 0, 0);
const D = cfg.camera.distance;

/** Mundo con suelo plano (y = 0), el personaje en el origen y la cámara mirando al norte, detrás de él (+Z). */
async function escena() {
  const p = new Physics();
  await p.init();
  const R = p.R;
  p.world.createCollider(R.ColliderDesc.cuboid(80, 0.5, 80).setTranslation(0, -0.5, 0));
  const character = new Character(p, 0, 0.02, 0);
  const orbit = new OrbitCamera(new THREE.PerspectiveCamera(), p, character.collider);
  orbit.yaw = 0;
  orbit.pitch = 0;
  /** Muro entre el pivote y la cámara (z = 3 m); groups = undefined → grupos por defecto (WORLD). */
  const wall = (g?: number, z = 3) => {
    const d = R.ColliderDesc.cuboid(4, 4, 0.2).setTranslation(0, cfg.camera.pivotHeight, z);
    if (g !== undefined) d.setCollisionGroups(g);
    return p.world.createCollider(d);
  };
  /** Shape cast sin filtro desde el pivote hacia la cámara: ¿hay algo en el camino? */
  const blocked = () => p.world.castShape({ x: 0, y: cfg.camera.pivotHeight, z: 0 }, { x: 0, y: 0, z: 0, w: 1 },
    { x: 0, y: 0, z: 1 }, new R.Ball(0.2), 0, D, true, undefined, undefined, character.collider) !== null;
  /** Varios cuadros de cámara (alejarse es suave). */
  const settle = (n = 120) => { for (let i = 0; i < n; i++) orbit.update(FEET, DT); };
  return { p, R, character, orbit, wall, blocked, settle };
}

describe('grupos de colisión', () => {
  it('groups() arma InteractionGroups: 16 bits altos = pertenencia, 16 bajos = filtro', () => {
    expect(groups(GROUP.VEHICLE)).toBe(0x0004ffff);
    expect(groups(0xffff, GROUP.WORLD)).toBe(0xffff0001);
    expect(WORLD_ONLY).toBe(0xffff0001);
    expect(groups(GROUP.PLAYER, 0)).toBe(0x00080000);
  });

  it('el personaje es PLAYER, la moto VEHICLE y los muros del borde BOUNDS; el resto queda por defecto', async () => {
    const { p, character } = await escena();
    const moto = new MotoController(p, 10, 0.05, 0, 0, new SurfaceMap([], undefined), atmosphere(0));
    expect(character.collider.collisionGroups()).toBe(groups(GROUP.PLAYER));
    expect(moto.collider.collisionGroups()).toBe(groups(GROUP.VEHICLE));
    for (const w of p.addBounds(20, -5, 5)) expect(w.collisionGroups()).toBe(groups(GROUP.BOUNDS));
    expect(p.addCylinder(0, 0, 5, 0.5, 1).collisionGroups()).toBe(0xffffffff);
  });
});

describe('cámara orbital', () => {
  it('un muro del mundo entre el pivote y la cámara la acerca', async () => {
    const { p, orbit, wall, settle } = await escena();
    wall();
    p.world.step();
    settle();
    // el muro está a 3 m: 3 − 0.2 (medio espesor) − 0.2 (esfera) − margen
    expect(orbit.current).toBeLessThan(orbit.distance);
    expect(orbit.current).toBeCloseTo(2.6 - cfg.camera.collisionMargin, 2);
    expect(orbit.camera.position.z).toBeCloseTo(orbit.current, 5);
  });

  it('un vehículo (grupo VEHICLE) en el mismo lugar no la acerca', async () => {
    const { p, orbit, wall, blocked, settle } = await escena();
    wall(groups(GROUP.VEHICLE));
    p.world.step();
    expect(blocked()).toBe(true); // el vehículo sí está en el camino
    settle();
    expect(orbit.current).toBeCloseTo(D, 5);
  });

  it('el jugador (PLAYER) ajeno al `exclude` tampoco la acerca', async () => {
    const { p, orbit, settle } = await escena();
    const other = new Character(p, 0, 0.02, 3); // otro personaje detrás, en la línea de la cámara
    p.world.step();
    expect(other.collider.collisionGroups()).toBe(groups(GROUP.PLAYER));
    settle();
    expect(orbit.current).toBeCloseTo(D, 5);
  });

  it('los muros invisibles del borde (Physics.addBounds) no la acercan', async () => {
    const { p, orbit, blocked, settle } = await escena();
    p.addBounds(3, -10, 10); // muro norte-sur de z = 3 a z = 5, justo detrás del jugador
    p.world.step();
    expect(blocked()).toBe(true);
    settle();
    expect(orbit.current).toBeCloseTo(D, 5);
  });

  it('la lista `ignore` sigue funcionando', async () => {
    const { p, orbit, wall, settle } = await escena();
    const w = wall();
    p.world.step();
    orbit.ignore = [w];
    settle();
    expect(orbit.current).toBeCloseTo(D, 5);
    orbit.ignore = [];
    orbit.update(FEET, DT);
    expect(orbit.current).toBeLessThan(3);
  });

  it('nearFade: 1 a distancia normal, ~0 con la cámara pegada al personaje', async () => {
    const { p, orbit, wall, settle } = await escena();
    settle();
    expect(orbit.nearFade).toBe(1);
    orbit.current = cfg.camera.minDistance; // el zoom mínimo del jugador nunca desvanece
    expect(orbit.nearFade).toBe(1);
    wall(undefined, 0.5); // pared justo detrás de la cabeza
    p.world.step();
    orbit.update(FEET, DT);
    expect(orbit.current).toBeCloseTo(0.3, 5);
    expect(orbit.nearFade).toBeLessThan(0.01);
    // monótona entre ambos extremos
    let prev = -1;
    for (let d = 0.3; d <= 1.6; d += 0.05) {
      orbit.current = d;
      expect(orbit.nearFade).toBeGreaterThanOrEqual(prev);
      prev = orbit.nearFade;
    }
  });

  it('invertY invierte el cabeceo y sensitivity lo escala', async () => {
    const { orbit } = await escena();
    const s = cfg.camera.sensitivity;
    expect(orbit.sensitivity).toBe(s);
    expect(orbit.invertY).toBe(false);
    orbit.input(0, 40, 0);
    expect(orbit.pitch).toBeCloseTo(40 * s, 9);
    orbit.pitch = 0;
    orbit.invertY = true;
    orbit.input(0, 40, 0);
    expect(orbit.pitch).toBeCloseTo(-40 * s, 9);
    orbit.pitch = 0;
    orbit.invertY = false;
    orbit.sensitivity = 2 * s;
    orbit.input(10, 40, 0);
    expect(orbit.pitch).toBeCloseTo(80 * s, 9);
    expect(orbit.yaw).toBeCloseTo(-20 * s, 9);
  });
});

describe('los grupos no cambian los choques (el KCC consulta sin filtro)', () => {
  /** Camina hacia +X durante `seconds` y devuelve la x final de los pies. */
  const walk = (p: Physics, c: Character, seconds: number) => {
    for (let t = 0; t < seconds; t += DT) { c.step(DT, 1, 0, true, false); p.world.step(); }
    return c.curr.x;
  };

  it('el personaje se detiene contra un carro del tráfico (VEHICLE)', async () => {
    const { p, R, character } = await escena();
    p.world.createCollider(R.ColliderDesc.cuboid(0.9, 0.75, 2.2).setTranslation(3, 0.75, 0)
      .setCollisionGroups(groups(GROUP.VEHICLE)));
    const x = walk(p, character, 3); // a 6 m/s llegaría a x ≈ 17
    expect(x).toBeLessThan(3 - 0.9 - cfg.capsule.radius + 0.05);
    expect(x).toBeGreaterThan(1.5);
  });

  it('el personaje se detiene contra los muros invisibles (BOUNDS)', async () => {
    const { p, character } = await escena();
    p.addBounds(5, -10, 10);
    const x = walk(p, character, 3);
    expect(x).toBeLessThan(5 - cfg.capsule.radius + 0.05);
    expect(x).toBeGreaterThan(4);
  });

  it('la moto (VEHICLE) choca con un carro (VEHICLE) y con los muros (BOUNDS)', async () => {
    const { p, R } = await escena();
    const atm = atmosphere(0);
    // carro 12 m al norte de la moto (adelante = -Z)
    const moto = new MotoController(p, 0, 0.05, 20, 0, new SurfaceMap([], undefined), atm);
    p.world.createCollider(R.ColliderDesc.cuboid(0.9, 0.75, 2.2).setTranslation(0, 0.75, 8)
      .setCollisionGroups(groups(GROUP.VEHICLE)));
    p.world.step();
    for (let t = 0; t < 5; t += DT) { moto.step(DT, { throttle: 1, brake: 0, steer: 0 }, true); p.world.step(); }
    const front = moto.curr.z - 0.6 - moto.r; // la cápsula va a lo largo del eje de la moto
    expect(front).toBeGreaterThan(8 + 2.2 - 0.05);
    expect(front).toBeLessThan(8 + 2.2 + 0.5);
    expect(moto.impactAge).toBeLessThan(5);

    // y contra el muro del borde: borde a 30 m al sur del centro (z = +30), la moto mirando al sur (yaw = π)
    const { p: p2 } = await escena();
    p2.addBounds(30, -10, 10);
    const m2 = new MotoController(p2, 0, 0.05, 10, Math.PI, new SurfaceMap([], undefined), atm);
    p2.world.step();
    for (let t = 0; t < 6; t += DT) { m2.step(DT, { throttle: 1, brake: 0, steer: 0 }, true); p2.world.step(); }
    expect(m2.curr.z + 0.6 + m2.r).toBeLessThan(30 + 0.05);
    expect(m2.curr.z + 0.6 + m2.r).toBeGreaterThan(29);
  });
});

describe('avatar: setOpacity', () => {
  const mats = (a: Avatar) => {
    const s = new Set<THREE.Material>();
    a.root.traverse((o) => { if (o instanceof THREE.Mesh) s.add(o.material as THREE.Material); });
    return [...s];
  };

  it('opaco ↔ translúcido ↔ oculto sin tocar root.visible', () => {
    const a = new Avatar();
    const ms = mats(a);
    const hips = a.root.children[0];
    expect(ms.some((m) => m instanceof THREE.MeshPhysicalMaterial)).toBe(true); // incluye el casco
    a.setOpacity(0.5);
    for (const m of ms) { expect(m.transparent).toBe(true); expect(m.opacity).toBe(0.5); }
    const v = ms.map((m) => m.version);
    a.setOpacity(0.6); // solo cambia la opacidad: no recompila
    for (const [i, m] of ms.entries()) { expect(m.opacity).toBe(0.6); expect(m.version).toBe(v[i]); }
    a.setOpacity(0);
    expect(hips.visible).toBe(false);
    expect(a.root.visible).toBe(true);
    a.setOpacity(1);
    expect(hips.visible).toBe(true);
    for (const m of ms) {
      expect(m.transparent).toBe(false);
      expect(m.depthWrite).toBe(true);
      expect(m.opacity).toBe(1);
    }
  });
});
