/**
 * Dibujo de peatones (src/peds/render.ts) con peatones falsos: instancias, atributos, ocultos, aspecto determinista,
 * contrato de marcha sin patinar (gait.ts) y coste de CPU de update().
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { PedView, pedLook, buildPedGeometry } from '../src/peds/render';
import { pedFoot, pedPhasePerMetre, pedStride, pedRunBlend, ANKLE_Y } from '../src/peds/gait';
import type { Ped, PedPose } from '../src/peds/types';

const POSES: PedPose[] = ['walk', 'idle', 'wait', 'sit', 'run', 'fallen'];

function fakePeds(n: number, seed = 1): Ped[] {
  let s = seed;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: n }, (_, id) => {
    const pose = POSES[id % POSES.length];
    const x = (r() - 0.5) * 200, z = (r() - 0.5) * 200, h = r() * 6;
    const speed = pose === 'walk' ? 1 + r() * 0.6 : pose === 'run' ? 3.6 : 0;
    return {
      id, active: id % 7 !== 3, x, z, y: 2600 + r(), heading: h, px: x - 0.04, pz: z, py: 2600, pheading: h - 0.01,
      speed, phase: r() * 100, pose, poseTime: r() * 10, seatH: pose === 'sit' ? 0.46 : 0, look: Math.floor(r() * 1e9), height: 0.85 + r() * 0.25,
    };
  });
}

describe('PedView', () => {
  it('una InstancedMesh con atributos por instancia; inactivos ocultos (escala 0)', () => {
    const peds = fakePeds(160);
    const view = new PedView(peds, 170);
    view.update(1);
    const m = view.mesh;
    expect(m).toBeInstanceOf(THREE.InstancedMesh);
    expect(view.group.children).toEqual([m]);
    expect(m.castShadow && m.receiveShadow).toBe(true);
    const lastActive = peds.map((p) => p.active).lastIndexOf(true);
    expect(m.count).toBe(lastActive + 1);
    const g = m.geometry;
    for (const k of ['iRoot', 'iAnim', 'iPose', 'iLook', 'iColA', 'iColB']) {
      const a = g.getAttribute(k) as THREE.InterleavedBufferAttribute;
      expect(a.data).toBeInstanceOf(THREE.InstancedInterleavedBuffer);
      expect(a.count).toBe(170);
    }
    // WebGPU admite 8 búferes de vértices por pipeline: los intercalados cuentan una vez
    const buffers = new Set(Object.values(g.attributes).map((a) => ('data' in a && a.data ? a.data : a)));
    expect(buffers.size).toBeLessThanOrEqual(6);
    const root = g.getAttribute('iRoot'), look = g.getAttribute('iLook'), anim = g.getAttribute('iAnim'), pose = g.getAttribute('iPose');
    peds.forEach((p, i) => {
      if (!p.active) { expect(look.getX(i)).toBe(0); return; }
      expect(root.getX(i)).toBeCloseTo(p.x, 3);
      expect(root.getZ(i)).toBeCloseTo(p.z, 3);
      expect(root.getW(i)).toBeCloseTo(p.heading, 5);
      expect(look.getX(i)).toBeCloseTo(p.height, 5);
      expect(anim.getX(i)).toBeGreaterThanOrEqual(0);
      expect(anim.getX(i)).toBeLessThan(Math.PI * 2);
      expect(anim.getY(i)).toBeCloseTo(p.speed, 5);
      if (p.pose === 'sit') expect(pose.getZ(i)).toBeCloseTo(0.46 / p.height, 5);
    });
    // un peatón que se desactiva queda oculto; al volver, visible otra vez
    const i = peds.findIndex((p) => p.active);
    peds[i].active = false;
    view.update(0.5);
    expect(look.getX(i)).toBe(0);
    peds[i].active = true;
    view.update(0.5);
    expect(look.getX(i)).toBeCloseTo(peds[i].height, 5);
    // sin activos: nada que dibujar
    for (const p of peds) p.active = false;
    view.update(0);
    expect(m.count).toBe(0);
    expect(m.visible).toBe(false);
  });

  it('esfera de recorte que cubre a los activos; interpolación entre pasos', () => {
    const peds = fakePeds(40, 7);
    const view = new PedView(peds);
    view.update(0.25);
    const bs = view.mesh.boundingSphere!;
    const root = view.mesh.geometry.getAttribute('iRoot');
    peds.forEach((p, i) => {
      if (!p.active) return;
      expect(bs.distanceToPoint(new THREE.Vector3(p.x, p.y + 0.9, p.z))).toBeLessThan(-1.5);
      expect(root.getX(i)).toBeCloseTo(p.px + (p.x - p.px) * 0.25, 4);
      expect(root.getY(i)).toBeCloseTo(p.py + (p.y - p.py) * 0.25, 3);
    });
  });

  it('humano low-poly: 200–500 triángulos sin accesorios; ranuras y huesos válidos', () => {
    const g = buildPedGeometry();
    const bone = g.getAttribute('aBone'), idx = g.index!;
    let core = 0;
    for (let t = 0; t < idx.count; t += 3) if (bone.getZ(idx.getX(t)) < 4) core++;   // z = segmento + 4·accesorio
    expect(core).toBeGreaterThanOrEqual(200);
    expect(core).toBeLessThanOrEqual(500);
    expect(idx.count / 3).toBeLessThan(800);
    for (let i = 0; i < bone.count; i++) {
      expect([0, 1, 2, 3, 4]).toContain(bone.getX(i));
      expect([-1, 0, 1]).toContain(bone.getY(i));
      expect(bone.getW(i)).toBeGreaterThanOrEqual(0);
      expect(bone.getW(i)).toBeLessThanOrEqual(11);
    }
    g.computeBoundingBox();
    expect(g.boundingBox!.min.y).toBeCloseTo(0, 2);       // pies en el suelo
    expect(g.boundingBox!.max.y).toBeGreaterThan(1.69);  // 1,70 m (sombrero incluido, más)
  });

  it('aspecto determinista y variado', () => {
    expect(pedLook(12345, 1)).toEqual(pedLook(12345, 1));
    expect(pedLook(0.4321, 1)).toEqual(pedLook(0.4321, 1));
    const N = 2000, skins = new Set<number>(), tops = new Set<number>();
    const bits = new Array(8).fill(0);
    let kidsUniform = 0;
    for (let i = 0; i < N; i++) {
      const l = pedLook(i * 7919 + 13, 1);
      skins.add(l.colA[0]); tops.add(l.colA[2]);
      for (let b = 0; b < 8; b++) if (l.flags & (1 << b)) bits[b]++;
      for (const c of [...l.colA, ...l.colB]) { expect(Number.isInteger(c)).toBe(true); expect(c).toBeGreaterThanOrEqual(0); expect(c).toBeLessThan(1 << 24); }
      expect(l.girth).toBeGreaterThan(0.85);
      expect(l.gesture).toBeGreaterThanOrEqual(0);
      expect(l.gesture).toBeLessThanOrEqual(5);
      if (pedLook(i, 0.8).flags & (1 << 3)) kidsUniform++;
    }
    expect(skins.size).toBeGreaterThanOrEqual(8);
    expect(tops.size).toBeGreaterThanOrEqual(12);
    // sombrero, gorra, ruana, mochila, falda, pelo largo, chaleco: todos aparecen, ninguno domina
    for (let b = 0; b < 7; b++) { expect(bits[b] / N).toBeGreaterThan(0.02); expect(bits[b] / N).toBeLessThan(0.5); }
    expect(kidsUniform / N).toBeGreaterThan(0.5);   // escolares con morral
  });

  it('marcha: con phase += d · pedPhasePerMetre el pie de apoyo no patina', () => {
    for (const [speed, height] of [[0.8, 1], [1.3, 1], [1.6, 0.85], [3.6, 1.1]]) {
      const run = pedRunBlend(speed, speed > 3);
      const K = pedPhasePerMetre(speed, height), stride = pedStride(speed, 1);
      expect(2 * Math.PI / K).toBeCloseTo(pedStride(speed, height), 9);
      // el cuerpo avanza hacia -Z; punto de contacto del pie izquierdo = tobillo (mundo) sin la corrección del giro
      let contact: number | null = null, steps = 0;
      for (let d = 0; d < 6; d += 0.005) {
        const u = ((d * K) / (2 * Math.PI)) % 1;
        const f = pedFoot(u, stride, run);
        if (!f.stance) { contact = null; continue; }
        const beta = 0.6 + (0.38 - 0.6) * run, E = beta * stride, x = u / beta;
        const lin = -E / 2 + (0.05 + 0.05 * run) + E * x;   // tobillo con el pie plano
        const world = -d + lin * height;
        if (contact === null) contact = world;
        expect(Math.abs(world - contact)).toBeLessThan(1e-6);
        // y el tobillo real sólo se aparta por el giro del pie sobre talón o metatarso
        expect(Math.abs(f.z - lin)).toBeLessThan(0.13);
        expect(f.y).toBeGreaterThanOrEqual(ANKLE_Y - 0.005);
        steps++;
      }
      expect(steps).toBeGreaterThan(100);
    }
    // la trayectoria es continua (sin saltos del tobillo entre apoyo y vuelo)
    let prev = pedFoot(0, 1.4, 0);
    for (let u = 0.001; u < 1; u += 0.001) {
      const f = pedFoot(u, 1.4, 0);
      expect(Math.abs(f.z - prev.z)).toBeLessThan(0.02);
      expect(Math.abs(f.y - prev.y)).toBeLessThan(0.02);
      prev = { ...f };
    }
  });

  it('cambio de postura: la mezcla parte de la vigente (sin saltos)', () => {
    const peds = fakePeds(1);
    const p = peds[0];
    Object.assign(p, { active: true, pose: 'walk', speed: 1.3, poseTime: 5, seatH: 0 });
    const view = new PedView(peds);
    view.update(1);
    const P = view.mesh.geometry.getAttribute('iPose');
    const pose = { get 0() { return P.getX(0); }, get 1() { return P.getY(0); } };
    expect(pose[0]).toBe(0);
    Object.assign(p, { pose: 'sit', speed: 0, poseTime: 0, seatH: 0.46 });
    let last = 0;
    for (let k = 0; k <= 30; k++) {
      p.poseTime = k / 30;
      view.update(1);
      expect(pose[0]).toBeGreaterThanOrEqual(last);
      expect(pose[0] - last).toBeLessThan(0.12);
      last = pose[0];
    }
    expect(pose[0]).toBe(1);
    // se levanta a mitad de la mezcla hacia el suelo: continúa desde donde iba
    Object.assign(p, { pose: 'fallen', poseTime: 0.1 });
    view.update(1);
    const f1 = pose[1];
    Object.assign(p, { pose: 'idle', poseTime: 0 });
    view.update(1);
    expect(pose[1]).toBeCloseTo(f1, 5);
  });

  it('update() de 160 peatones cuesta < 0,3 ms', () => {
    const peds = fakePeds(160, 3);
    for (const p of peds) p.active = true;
    const view = new PedView(peds);
    for (let i = 0; i < 200; i++) view.update((i % 10) / 10);
    const N = 2000, t0 = performance.now();
    for (let i = 0; i < N; i++) {
      for (const p of peds) { p.poseTime += 1 / 60; p.phase += 0.05; }
      view.update((i % 10) / 10);
    }
    const ms = (performance.now() - t0) / N;
    console.log(`PedView.update(160): ${(ms * 1000).toFixed(1)} µs (incluye avanzar los peatones falsos)`);
    expect(ms).toBeLessThan(0.3);
  });
});
