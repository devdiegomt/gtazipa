/**
 * Prueba de visibilidad que usa el tráfico para aparecer y reciclar fuera de la vista: frustum con margen, niebla y
 * oclusión sólo por la geometría del mundo (vehículos, jugador y muros invisibles no tapan).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { GROUP, groups, Physics } from '../src/physics';
import { ViewTest } from '../src/visibility';

const FOG = 650;

/** Suelo plano (y = 0) y cámara a 3 m de altura en z = 10 mirando al norte (-Z), 60° de FOV vertical, 16:9. */
async function escena() {
  const p = new Physics();
  await p.init();
  const R = p.R;
  p.world.createCollider(R.ColliderDesc.cuboid(1000, 0.5, 1000).setTranslation(0, -0.5, 0));
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 2000);
  camera.position.set(0, 3, 10);
  camera.lookAt(0, 3, -100);
  const view = new ViewTest(camera, p, () => 0, FOG);
  /** Muro centrado en (x, z) de ancho 2·hx y alto h; g = grupos (undefined = por defecto, cuenta como WORLD). */
  const wall = (x: number, z: number, hx: number, h: number, g?: number) => {
    const d = R.ColliderDesc.cuboid(hx, h / 2, 0.5).setTranslation(x, h / 2, z);
    if (g !== undefined) d.setCollisionGroups(g);
    const c = p.world.createCollider(d);
    p.world.step();   // actualiza la estructura de consultas
    return c;
  };
  p.world.step();
  view.update();
  return { p, camera, view, wall };
}

describe('visibilidad para el tráfico', () => {
  it('delante se ve; detrás de la cámara y muy a un lado, no', async () => {
    const { view } = await escena();
    expect(view.test(0, -100)).toBe(true);
    expect(view.test(0, 120)).toBe(false);              // detrás
    expect(view.test(0, 30)).toBe(false);               // 20 m detrás
    const at = (deg: number, d = 100) => view.test(Math.sin((deg * Math.PI) / 180) * d, 10 - Math.cos((deg * Math.PI) / 180) * d);
    expect(at(40)).toBe(true);                          // dentro (mitad del FOV horizontal ≈ 45,7°)
    expect(at(52)).toBe(true);                          // fuera por poco: cuenta el margen (el vehículo mide hasta 7,5 m)
    expect(at(75)).toBe(false);
    expect(at(-75)).toBe(false);
  });

  it('más allá del final de la niebla no se ve (por profundidad de vista, como la niebla de three)', async () => {
    const { view } = await escena();
    expect(view.test(0, 10 - 600)).toBe(true);
    expect(view.test(0, 10 - FOG - 20)).toBe(false);
    // a 40° del eje la niebla termina a FOG / cos 40° ≈ 850 m: a 800 m aún se ve (profundidad 613 m), a 900 m no (689 m)
    const at = (deg: number, d: number) => view.test(Math.sin((deg * Math.PI) / 180) * d, 10 - Math.cos((deg * Math.PI) / 180) * d);
    expect(at(40, 800)).toBe(true);
    expect(at(-40, 800)).toBe(true);
    expect(at(40, 900)).toBe(false);
  });

  it('un edificio (WORLD) tapa; un vehículo, el jugador o un muro invisible del borde, no', async () => {
    const { p, view, wall } = await escena();
    const target = () => view.test(0, -100);
    for (const g of [GROUP.VEHICLE, GROUP.PLAYER, GROUP.BOUNDS]) wall(0, -50, 30, 12, groups(g));
    expect(target()).toBe(true);
    wall(0, -60, 30, 12).setEnabled(false);             // apagado (como un vehículo inactivo): no cuenta
    p.world.step();
    expect(target()).toBe(true);
    wall(0, -60, 30, 12);                               // grupos por defecto = mundo
    view.rays = 0;
    expect(target()).toBe(false);
    expect(view.rays).toBe(4);                          // centro, techo y ±3 m: todos tapados
    expect(view.test(0, -40)).toBe(true);               // delante del edificio
  });

  it('se ve lo que asoma: sobre un muro bajo o al lado de un poste', async () => {
    const { view, wall } = await escena();
    wall(0, -50, 30, 2.5);                              // 2,5 m: tapa el centro (1,2 m) pero el techo de una buseta (3 m) asoma
    expect(view.test(0, -100)).toBe(true);
    wall(40, -50, 0.4, 20);                             // poste delgado delante de otro punto: los laterales pasan
    expect(view.test(80, -110)).toBe(true);
  });

  it('fuera del frustum no lanza rayos; update() toma la cámara nueva', async () => {
    const { view, camera } = await escena();
    view.rays = 0;
    expect(view.test(0, 200)).toBe(false);
    expect(view.rays).toBe(0);
    camera.lookAt(0, 3, 200);                           // da media vuelta
    expect(view.test(0, 200)).toBe(false);              // aún no se tomó la cámara
    view.update();
    expect(view.test(0, 200)).toBe(true);
    expect(view.test(0, -100)).toBe(false);
  });
});
