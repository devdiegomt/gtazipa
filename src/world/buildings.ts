import * as THREE from 'three/webgpu';
import {
  uv, float, vec3, fract, floor, step, mix, vertexColor, normalWorld, hash, mx_noise_float, sin, smoothstep, max,
  positionWorld, vec2,
} from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import buildingCfg from '../data/buildings.json';

/** Color hex (sRGB) → vec3 en espacio lineal. */
const rgb = (hex: string) => { const c = new THREE.Color(hex); return vec3(c.r, c.g, c.b); };

type Style = { wall: string; base: string; trim: string; roof: string };

/**
 * Fachadas procedurales por arquetipo. Las UV de las paredes vienen del pipeline en metros:
 * u = distancia a lo largo del perímetro, v = altura sobre el suelo medio del edificio.
 * Ventanas, puertas y zócalos son patrón procedural (no dato).
 */
interface FacadeSpec {
  bay: number;            // ancho de vano (m)
  baseH: number;          // altura del zócalo (m)
  win: [number, number, number, number]; // ventana en fracción del vano/piso: u0,u1,v0,v1
  ground: 'door' | 'shop' | 'window' | 'none';
  ribbon?: boolean;       // ventanas corridas (moderno)
  glass: string;
}

const SPECS: Record<string, FacadeSpec> = {
  colonial: { bay: 3.6, baseH: 0.95, win: [0.34, 0.66, 0.28, 0.78], ground: 'door', glass: '#5a6570' },
  casa_tradicional: { bay: 3.2, baseH: 0.6, win: [0.3, 0.7, 0.32, 0.76], ground: 'door', glass: '#5b6168' },
  comercial: { bay: 4.0, baseH: 0.3, win: [0.14, 0.86, 0.3, 0.8], ground: 'shop', glass: '#46525c' },
  moderno: { bay: 1.6, baseH: 0.4, win: [0.06, 0.94, 0.3, 0.86], ground: 'window', ribbon: true, glass: '#5d7487' },
  hito: { bay: 1, baseH: 1.2, win: [0, 0, 0, 0], ground: 'none', glass: '#000000' },
};

function facadeMaterial(arch: string): THREE.MeshStandardNodeMaterial {
  const style = (buildingCfg.style as Record<string, Style>)[arch];
  const spec = SPECS[arch];
  const fh = float((buildingCfg.floorHeight as unknown as Record<string, number>)[arch]);
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.88, metalness: 0 });

  const p = uv();
  const u = p.x.div(spec.bay);
  const fu = fract(u);
  const bayId = floor(u);
  const level = floor(p.y.div(fh));
  const fv = fract(p.y.div(fh));
  const tintC = vertexColor();
  const wallC = rgb(style.wall).mul(vec3(tintC.x, tintC.y, tintC.z));
  const baseC = rgb(style.base);
  const trimC = rgb(style.trim);
  const glassC = rgb(spec.glass);
  const roofC = rgb(style.roof);

  // Suciedad suave para que los planos no se vean de plástico.
  const grime = mx_noise_float(vec2(positionWorld.x.add(positionWorld.z), positionWorld.y).mul(0.6)).mul(0.05);
  let c = wallC.mul(float(1).add(grime).sub(step(p.y, float(0.6)).mul(0.04)));

  if (arch !== 'hito') {
    const inRect = (u0: number, u1: number, v0: number, v1: number) =>
      step(u0, fu).mul(step(fu, u1)).mul(step(v0, fv)).mul(step(fv, v1));
    const frame = (u0: number, u1: number, v0: number, v1: number, t: number) =>
      inRect(u0 - t, u1 + t, v0 - t * 0.6, v1 + t * 0.6).sub(inRect(u0, u1, v0, v1));
    const belowEave = step(p.y, tintC.w.mul(25).sub(0.25));
    const upper = step(0.5, level).mul(belowEave);
    const groundFloor = step(level, 0.5).mul(step(0, p.y));
    const [u0, u1, v0, v1] = spec.win;
    let winMask = inRect(u0, u1, v0, v1).mul(upper);
    if (spec.ribbon) winMask = step(v0, fv).mul(step(fv, v1)).mul(step(0.04, fu)).mul(step(fu, 0.96)).mul(step(0.5, level));
    const frameMask = frame(u0, u1, v0, v1, 0.05).mul(upper).mul(spec.ribbon ? 0 : 1);
    c = mix(c, trimC, frameMask);
    c = mix(c, glassC, winMask);
    if (spec.ground === 'door') {
      // Alterna puerta (madera) y ventana baja por vano, de forma determinista.
      const isDoor = step(0.55, hash(bayId.add(17.0)));
      const door = inRect(0.36, 0.64, 0.0, 0.78).mul(isDoor);
      const lowWin = inRect(0.3, 0.7, 0.3, 0.72).mul(float(1).sub(isDoor));
      c = mix(c, trimC.mul(0.85), door.mul(groundFloor));
      c = mix(c, glassC, lowWin.mul(groundFloor));
      c = mix(c, trimC, frame(0.3, 0.7, 0.3, 0.72, 0.05).mul(float(1).sub(isDoor)).mul(groundFloor));
    } else if (spec.ground === 'shop') {
      // Local comercial: vitrina o cortina metálica, con franja de aviso.
      const shutter = step(0.6, hash(bayId.add(5.0)));
      const opening = inRect(0.06, 0.94, 0.0, 0.74).mul(groundFloor);
      const shutterC = mix(glassC, rgb('#8d9196'), shutter);
      c = mix(c, shutterC, opening);
      const sign = inRect(0.0, 1.0, 0.8, 0.94).mul(groundFloor);
      const signC = mix(rgb('#b8402e'), rgb('#2f5d8a'), step(0.5, hash(bayId.add(9.0))));
      c = mix(c, signC, sign.mul(step(0.35, hash(bayId.add(3.0)))));
    } else if (spec.ground === 'window') {
      c = mix(c, glassC, step(0.05, fv).mul(step(fv, 0.85)).mul(step(0.04, fu)).mul(step(fu, 0.96)).mul(groundFloor));
    }
  }
  // Zócalo (base pintada) y cimiento bajo el suelo.
  c = mix(c, baseC, step(p.y, float(spec.baseH)));
  // Cubiertas planas: la cara superior (normal hacia arriba) usa el color de cubierta.
  const isRoof = step(0.7, normalWorld.y);
  c = mix(c, roofC.mul(float(1).add(grime.mul(2))), isRoof);

  mat.colorNode = c;
  return mat;
}

function roofTileMaterial(): THREE.MeshStandardNodeMaterial {
  // Teja de barro (canal y cobija). UV del pipeline en metros: x a lo largo de la cumbrera, y hacia el alero.
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.82, metalness: 0, side: THREE.DoubleSide });
  const tintC = vertexColor();
  const base = rgb((buildingCfg.style as Record<string, Style>).colonial.roof);
  const p = uv();
  const tx = fract(p.x.div(0.24));
  const ty = fract(p.y.div(0.4));
  const id = hash(floor(p.x.div(0.24)).add(floor(p.y.div(0.4)).mul(71.3)));
  const barrel = float(0.74).add(sin(tx.mul(Math.PI)).mul(0.3));
  const overlap = float(1).sub(smoothstep(0.8, 1.0, ty).mul(0.3));
  const n = mx_noise_float(vec2(positionWorld.x, positionWorld.z).mul(0.35)).mul(0.12);
  mat.colorNode = base.mul(vec3(tintC.x, tintC.y, tintC.z)).mul(barrel).mul(overlap)
    .mul(float(0.86).add(id.mul(0.26)).add(n));
  return mat;
}

function balconyMaterial(): THREE.MeshStandardNodeMaterial {
  // Madera rojiza. Caras con alfa de vértice 0 = baranda con balaustres (recortes por alphaTest).
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.7, metalness: 0, side: THREE.DoubleSide });
  const c = vertexColor();
  const p = uv();
  const isRail = float(1).sub(step(0.5, c.w));
  const bar = step(fract(p.x.div(0.16)), 0.42);
  const rails = max(step(p.y, 0.1), step(0.86, p.y));
  const solid = max(bar, rails);
  mat.opacityNode = mix(float(1), solid, isRail);
  mat.alphaTest = 0.5;
  const grain = mx_noise_float(vec2(p.x.mul(30), p.y.mul(3))).mul(0.08);
  mat.colorNode = rgb(buildingCfg.balconies.color).mul(vec3(c.x, c.y, c.z)).mul(float(1).add(grain));
  return mat;
}

export interface BuildingsResult {
  group: THREE.Group;
  /** Geometría por manzana en coordenadas de mundo (para colliders trimesh). */
  colliders: { name: string; vertices: Float32Array; indices: Uint32Array }[];
  triangles: number;
  drawCalls: number;
}

export async function loadBuildings(url: string): Promise<BuildingsResult> {
  const gltf = await new GLTFLoader().loadAsync(url);
  const materials: Record<string, THREE.Material> = {
    wall_colonial: facadeMaterial('colonial'),
    wall_casa_tradicional: facadeMaterial('casa_tradicional'),
    wall_comercial: facadeMaterial('comercial'),
    wall_moderno: facadeMaterial('moderno'),
    wall_hito: facadeMaterial('hito'),
    roof_tile: roofTileMaterial(),
    balcony_wood: balconyMaterial(),
  };
  const group = new THREE.Group();
  group.name = 'buildings';
  const colliders: BuildingsResult['colliders'] = [];
  let triangles = 0, drawCalls = 0;
  gltf.scene.updateMatrixWorld(true);
  // Cada nodo del glb es una manzana: se conserva como Object3D (culling por manzana).
  for (const node of [...gltf.scene.children]) {
    const verts: number[] = [];
    const inds: number[] = [];
    node.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const srcName = (m.material as THREE.Material).name;
      m.material = materials[srcName] ?? materials.wall_casa_tradicional;
      m.castShadow = true;
      m.receiveShadow = true;
      const g = m.geometry as THREE.BufferGeometry;
      const pos = g.getAttribute('position');
      const idx = g.getIndex()!;
      const base = verts.length / 3;
      for (let i = 0; i < pos.count; i++) verts.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      for (let i = 0; i < idx.count; i++) inds.push(base + idx.getX(i));
      triangles += idx.count / 3;
      drawCalls++;
    });
    colliders.push({ name: node.name, vertices: new Float32Array(verts), indices: new Uint32Array(inds) });
    group.add(node);
  }
  return { group, colliders, triangles, drawCalls };
}
