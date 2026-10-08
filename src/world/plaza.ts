import * as THREE from 'three/webgpu';
import {
  uv, float, vec2, vec3, fract, floor, step, mix, hash, min, abs, smoothstep, max,
  mx_noise_float, positionWorld, instanceIndex, cameraPosition, length,
} from 'three/tsl';
import cfg from '../data/plaza.json';
import type { Heightfield } from './terrain';
import type { WorldMeta } from './types';

const rgb = (hex: string) => { const c = new THREE.Color(hex); return vec3(c.r, c.g, c.b); };

/** Generador pseudoaleatorio determinista (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Adoquín de arcilla en espina de pez simplificada (petatillo) con fajas de piedra gris.
 * Coordenadas alineadas con el eje de la catedral (la retícula de la plaza).
 */
function pavingMaterial(axisU: [number, number]): THREE.MeshStandardNodeMaterial {
  const P = cfg.paving;
  const wx = positionWorld.x, wz = positionWorld.z;
  const a = wx.mul(axisU[0]).add(wz.mul(axisU[1]));
  const b = wx.mul(-axisU[1]).add(wz.mul(axisU[0]));
  const W = P.brickWidth;
  const q = vec2(a, b).div(W * 2);
  const cell = floor(q);
  const f = fract(q).mul(2);
  const o = fract(cell.x.add(cell.y).mul(0.5)).mul(2); // 0 = ladrillos horizontales, 1 = verticales
  const dxH = min(f.x, float(2).sub(f.x));
  const dyH = min(min(f.y, abs(f.y.sub(1))), float(2).sub(f.y));
  const dxV = min(min(f.x, abs(f.x.sub(1))), float(2).sub(f.x));
  const dyV = min(f.y, float(2).sub(f.y));
  const dEdge = mix(min(dxH, dyH), min(dxV, dyV), o);
  const joint = float(1).sub(smoothstep(0.035, 0.09, dEdge));
  const sub = mix(step(1, f.y), step(1, f.x), o);
  const id = hash(cell.x.mul(31.7).add(cell.y.mul(17.3)).add(sub.mul(5.1)));
  const brick = mix(rgb(P.brick), rgb(P.brickAlt), id).mul(float(0.9).add(hash(id.mul(7.7)).mul(0.2)));
  const grime = mx_noise_float(vec2(wx, wz).mul(0.15)).mul(0.08);
  // Lejos de la cámara el ladrillo (patrón sin mipmaps) se funde en su color medio para evitar moiré.
  const fade = smoothstep(9.0, 30.0, length(positionWorld.sub(cameraPosition)));
  const brickNear = mix(brick, rgb('#6b5a4c'), joint.mul(0.85));
  const brickFar = mix(rgb(P.brick), rgb(P.brickAlt), 0.5).mul(0.92);
  let c = mix(brickNear, brickFar, fade).mul(float(1).add(grime));
  // Fajas de piedra en retícula
  const s = P.bandSpacing, bw = P.bandWidth;
  const ba = step(fract(a.div(s)).mul(s), bw);
  const bb = step(fract(b.div(s)).mul(s), bw);
  const band = max(ba, bb);
  const slab = hash(floor(a.div(0.6)).add(floor(b.div(0.6)).mul(13.1)));
  c = mix(c, rgb(P.band).mul(float(0.92).add(slab.mul(0.12).mul(float(1).sub(fade)))), band);
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
  m.colorNode = c;
  m.polygonOffset = true;
  m.polygonOffsetFactor = -2;
  m.polygonOffsetUnits = -2;
  return m;
}

function pavingMesh(meta: WorldMeta, hf: Heightfield, axisU: [number, number]): THREE.Mesh {
  const ring = (meta.plaza.paved ?? meta.plaza.ring).slice(0, -1).map(([x, z]) => new THREE.Vector2(x, z));
  const tris = THREE.ShapeUtils.triangulateShape(ring, []);
  const pos = new Float32Array(ring.length * 3);
  ring.forEach((p, i) => { pos.set([p.x, hf.heightAt(p.x, p.y) + 0.025, p.y], i * 3); });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(tris.flat());
  geo.computeVertexNormals();
  if (geo.getAttribute('normal').getY(0) < 0) geo.setIndex(tris.map(([a, b, c]) => [a, c, b]).flat());
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, pavingMaterial(axisU));
  mesh.receiveShadow = true;
  mesh.name = 'plaza-paving';
  return mesh;
}

// ---------------------------------------------------------------- materas con banca circular

function lathe(profile: [number, number][], segments = 64) {
  return new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), segments);
}

function benchMaterial(R: number) {
  const pc = cfg.planter.colors;
  const n = Math.round((2 * Math.PI * R) / 0.11); // listones de ~11 cm
  const f = fract(uv().x.mul(n));
  const gap = step(0.84, f);
  const grain = mx_noise_float(positionWorld.mul(vec3(6, 1.2, 6))).mul(0.07);
  const id = hash(floor(uv().x.mul(n)).add(float(instanceIndex).mul(977)));
  const wood = rgb(pc.bench).mul(float(0.9).add(id.mul(0.18)).add(grain));
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.75, metalness: 0 });
  m.colorNode = mix(wood, rgb(pc.benchGap), gap);
  return m;
}

function frondGeometry(L: number) {
  const segs = 18;
  const g = new THREE.PlaneGeometry(1, 1, segs, 2);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const t = p.getX(i) + 0.5;             // 0..1 a lo largo
    const w = p.getY(i);                   // -0.5..0.5 a lo ancho
    const x = t * L;
    const env = Math.sin(Math.PI * Math.min(1, t * 1.05)) * (1 - 0.35 * t);
    const y = -0.42 * x * x / L + Math.abs(w) * 0.35 * env;   // caída + pliegue en V
    const z = w * 2.0 * env;
    p.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  return g;
}

function frondMaterial() {
  const P = cfg.palm;
  const p = uv();
  const across = abs(p.y.sub(0.5)).mul(2);           // 0 en el raquis
  const leaflets = step(0.42, fract(p.x.mul(46).add(across.mul(3.2))));
  const rachis = step(across, 0.06);
  const alpha = max(leaflets.mul(step(across, 0.98)), rachis);
  const dry = smoothstep(0.75, 1.0, p.x).mul(0.6);
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.75, metalness: 0, side: THREE.DoubleSide });
  const tint = hash(float(instanceIndex).mul(3.3)).mul(0.25);
  m.colorNode = mix(rgb(P.leaf).mul(float(0.85).add(tint)), rgb(P.leafDry), dry);
  m.opacityNode = alpha;
  m.alphaTest = 0.5;
  return m;
}

function trunkMaterial() {
  const rings = fract(positionWorld.y.mul(3.2));
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  m.colorNode = rgb(cfg.palm.trunk).mul(float(0.82).add(smoothstep(0.0, 0.25, rings).mul(0.18)))
    .mul(float(1).add(mx_noise_float(positionWorld.mul(2.5)).mul(0.08)));
  return m;
}

export interface PlazaResult { group: THREE.Group; planters: { x: number; y: number; z: number; r: number; h: number; trunkH: number }[] }

export function buildPlaza(meta: WorldMeta, hf: Heightfield, axisU: [number, number]): PlazaResult {
  const group = new THREE.Group();
  group.name = 'plaza';
  group.add(pavingMesh(meta, hf, axisU));

  const P = cfg.planter;
  const R = P.outerRadius;
  const rIn = R - P.benchDepth;
  const spots = (meta.plaza.planters ?? []).map((t) => ({ ...t, y: hf.heightAt(t.x, t.z) }));
  const n = spots.length;
  if (!n) return { group, planters: [] };
  const m4 = new THREE.Matrix4();
  const place = (mesh: THREE.InstancedMesh, yOff = 0) => {
    spots.forEach((s, i) => { m4.makeTranslation(s.x, s.y + yOff, s.z); mesh.setMatrixAt(i, m4); });
    mesh.castShadow = true; mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  const pc = P.colors;
  // Banca circular: cara exterior de listones + asiento
  place(new THREE.InstancedMesh(lathe([[R, -0.05], [R, P.seatHeight], [rIn, P.seatHeight]], 96), benchMaterial(R), n));
  // Muro de la matera (por dentro de la banca) y su remate
  const wallMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.85 });
  wallMat.colorNode = rgb(pc.wall).mul(float(1).add(mx_noise_float(positionWorld.mul(1.5)).mul(0.08)));
  place(new THREE.InstancedMesh(lathe([[rIn, P.seatHeight - 0.01], [rIn, P.wallHeight], [rIn - 0.16, P.wallHeight], [rIn - 0.16, P.wallHeight - 0.1]], 64), wallMat, n));
  // Tierra
  const soil = new THREE.CircleGeometry(rIn - 0.16, 48).rotateX(-Math.PI / 2);
  place(new THREE.InstancedMesh(soil, new THREE.MeshStandardMaterial({ color: pc.soil, roughness: 1 }), n), P.wallHeight - 0.1);
  // Anillo blanco alrededor de la palma
  const ir = P.innerRing;
  const soilY = P.wallHeight - 0.1;
  place(new THREE.InstancedMesh(lathe([[ir.r1, soilY], [ir.r1, ir.height], [ir.r0, ir.height], [ir.r0, soilY]], 48),
    new THREE.MeshStandardMaterial({ color: pc.ring, roughness: 0.8 }), n));

  // Flores y arbustos (instanciados con color por instancia)
  const clump = new THREE.IcosahedronGeometry(0.24, 1).scale(1, 0.7, 1);
  const total = n * P.flowerClumps;
  const flowers = new THREE.InstancedMesh(clump, new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }), total);
  const col = new THREE.Color();
  let k = 0;
  spots.forEach((s, si) => {
    const rand = rng(1000 + si * 7919);
    for (let j = 0; j < P.flowerClumps; j++) {
      const ang = rand() * Math.PI * 2;
      const rr = ir.r1 + 0.25 + rand() * (rIn - 0.45 - ir.r1 - 0.25);
      const sc = 0.7 + rand() * 0.8;
      const isShrub = rand() < 0.35;
      m4.compose(
        new THREE.Vector3(s.x + Math.cos(ang) * rr, s.y + soilY + 0.08 * sc, s.z + Math.sin(ang) * rr),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rand() * 6.28, 0)),
        new THREE.Vector3(sc * (isShrub ? 1.4 : 1), sc * (isShrub ? 1.5 : 1), sc * (isShrub ? 1.4 : 1)),
      );
      flowers.setMatrixAt(k, m4);
      col.set(isShrub ? cfg.planter.shrub : P.flowers[Math.floor(rand() * P.flowers.length)]);
      flowers.setColorAt(k, col);
      k++;
    }
  });
  flowers.castShadow = true;
  flowers.receiveShadow = true;
  group.add(flowers);

  // Palmas: tronco (instanciado y escalado) + hojas (una geometría instanciada para todas)
  const PL = cfg.palm;
  const trunkH = spots.map((s) => {
    const h = (Math.abs(Math.sin(Number(s.osm.split('/')[1]) * 12.9898)) * 43758.5453) % 1;
    return PL.trunkMin + h * (PL.trunkMax - PL.trunkMin);
  });
  const trunkGeo = new THREE.CylinderGeometry(PL.trunkRadius * 0.75, PL.trunkRadius, 1, 10, 8).translate(0, 0.5, 0);
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMaterial(), n);
  spots.forEach((s, i) => {
    m4.compose(new THREE.Vector3(s.x, s.y + soilY, s.z), new THREE.Quaternion(), new THREE.Vector3(1, trunkH[i], 1));
    trunks.setMatrixAt(i, m4);
  });
  trunks.castShadow = true;
  group.add(trunks);
  const crownGeo = new THREE.SphereGeometry(0.55, 10, 8);
  const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshStandardMaterial({ color: '#5c5a3a', roughness: 1 }), n);
  spots.forEach((s, i) => { m4.makeTranslation(s.x, s.y + soilY + trunkH[i], s.z); crowns.setMatrixAt(i, m4); });
  group.add(crowns);
  const fronds = new THREE.InstancedMesh(frondGeometry(PL.frondLength), frondMaterial(), n * PL.fronds);
  k = 0;
  spots.forEach((s, i) => {
    const rand = rng(31 + i * 104729);
    for (let j = 0; j < PL.fronds; j++) {
      const yaw = (j / PL.fronds) * Math.PI * 2 + rand() * 0.25;
      const ring = j % 3;
      const pitch = [0.55, 0.15, -0.35][ring] + (rand() - 0.5) * 0.25;   // hojas altas, medias y caídas
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, pitch, 'YXZ'));
      const sc = 0.85 + rand() * 0.3 - ring * 0.05;
      m4.compose(new THREE.Vector3(s.x, s.y + soilY + trunkH[i] + 0.15, s.z), q, new THREE.Vector3(sc, sc, sc));
      fronds.setMatrixAt(k++, m4);
    }
  });
  fronds.castShadow = true;
  fronds.receiveShadow = true;
  group.add(fronds);

  return {
    group,
    planters: spots.map((s, i) => ({ x: s.x, y: s.y, z: s.z, r: R, h: P.wallHeight, trunkH: trunkH[i] })),
  };
}
