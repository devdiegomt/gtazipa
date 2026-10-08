import * as THREE from 'three/webgpu';
import {
  uv, float, vec2, vec3, fract, floor, step, mix, hash, max, min, smoothstep, sin, atan, length,
  mx_noise_float, positionWorld,
} from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import cfg from '../data/catedral.json';
import type { Landmark } from './types';

type N = ReturnType<typeof float>;
const C = cfg.colors as Record<string, string>;
const rgb = (hex: string) => { const c = new THREE.Color(hex); return vec3(c.r, c.g, c.b); };

/** Ruido suave en coordenadas de mundo (manchas de intemperie). */
const weather = (scale: number, amount: number) =>
  mx_noise_float(positionWorld.mul(scale)).mul(amount) as unknown as N;

/**
 * Sillería (bloques de piedra con aparejo trabado). UV en metros desde el pipeline.
 * bw/bh = tamaño del sillar, vari = variación de tono entre sillares.
 */
function ashlar(base: string, bw: number, bh: number, vari: number, mortarHex: string) {
  const p = uv();
  const row = floor(p.y.div(bh));
  const off = fract(row.mul(0.5)).mul(bw);
  const bx = p.x.add(off).div(bw);
  const cell = floor(bx);
  const fx = fract(bx);
  const fy = fract(p.y.div(bh));
  const mw = 0.018;
  const jx = max(step(fx, mw / bw), step(1 - mw / bw, fx));
  const jy = max(step(fy, mw / bh), step(1 - mw / bh, fy));
  const joint = max(jx, jy);
  const id = hash(cell.add(row.mul(57.31)));
  const id2 = hash(cell.mul(3.1).add(row.mul(11.7)));
  const tone = float(1).add(id.sub(0.5).mul(vari)).add(weather(0.35, 0.06));
  const warm = vec3(1, float(1).sub(id2.mul(0.05)), float(1).sub(id2.mul(0.1)));
  const stone = rgb(base).mul(tone).mul(warm);
  // Erosión leve en los bordes del sillar
  const edge = smoothstep(0.0, 0.06, min(min(fx, float(1).sub(fx)), min(fy, float(1).sub(fy)).mul(bh / bw)));
  return mix(rgb(mortarHex), stone.mul(float(0.9).add(edge.mul(0.1))), float(1).sub(joint));
}

function std(colorNode: unknown, rough = 0.85, metal = 0, side: THREE.Side = THREE.FrontSide) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: rough, metalness: metal, side });
  m.colorNode = colorNode as never;
  return m;
}

function materials(clockCenter: [number, number], clockR: number): Record<string, THREE.Material> {
  const p = uv();
  // Teja de barro (canal y cobija): uv.x a lo largo de la cumbrera, uv.y pendiente abajo.
  const tx = fract(p.x.div(0.24));
  const ty = fract(p.y.div(0.42));
  const tileId = hash(floor(p.x.div(0.24)).add(floor(p.y.div(0.42)).mul(91.7)));
  const barrel = float(0.72).add(sin(tx.mul(Math.PI)).mul(0.32));
  const overlap = float(1).sub(smoothstep(0.82, 1.0, ty).mul(0.35));
  const teja = rgb(C.teja).mul(barrel).mul(overlap).mul(float(0.85).add(tileId.mul(0.3))).mul(float(1).add(weather(0.5, 0.12)));

  // Cúpula vidriada verde con nervios blancos (uv.x ∈ [0,1] por gajo, uv.y longitud de perfil).
  const rib = max(step(p.x, 0.045), step(0.955, p.x));
  const scales = float(0.9).add(step(0.5, fract(p.y.div(0.22).add(step(0.5, fract(p.x.mul(9))).mul(0.5)))).mul(0.12));
  const cupula = mix(rgb(C.cupula).mul(scales).mul(float(1).add(weather(1.5, 0.1))), rgb(C.blanco), rib);

  // Reloj: esfera blanca con marcas horarias.
  const d = p.sub(vec2(clockCenter[0], clockCenter[1]));
  const r = length(d).div(clockR);
  const ang = atan(d.y, d.x).div(Math.PI * 2).mul(12);
  const tick = step(fract(ang.add(0.5)), 0.12).mul(step(0.74, r)).mul(step(r, 0.92));
  const ring = step(0.95, r);
  const reloj = mix(rgb(C.reloj), rgb(C.hierro), max(tick, ring));

  // Madera de las puertas: tablones verticales y peinazos.
  const plank = fract(p.x.div(0.17));
  const rail = step(fract(p.y.div(1.25)), 0.08);
  const grain = mx_noise_float(vec2(p.x.mul(40), p.y.mul(2))).mul(0.08);
  const madera = rgb(C.madera).mul(float(0.85).add(smoothstep(0.0, 0.08, plank).mul(0.15)).sub(rail.mul(0.25)).add(grain));

  return {
    cat_piedra: std(ashlar(C.piedra, 0.78, 0.39, 0.16, '#bba78c'), 0.92),
    cat_sillar: std(ashlar(C.sillar, 0.62, 0.31, 0.22, '#b88a68'), 0.9),
    cat_muro: std(ashlar(C.muro, 0.7, 0.36, 0.12, '#b39c80'), 0.92),
    cat_zocalo: std(ashlar(C.zocalo, 1.1, 0.42, 0.1, '#8e877b'), 0.9),
    cat_moldura: std(rgb(C.moldura).mul(float(1).add(weather(0.6, 0.08))), 0.8),
    cat_madera: std(madera, 0.7),
    cat_vano: std(rgb(C.vano), 0.35, 0.1),
    cat_teja: std(teja, 0.85, 0, THREE.DoubleSide),
    cat_cupula: std(cupula, 0.38, 0.05),
    cat_blanco: std(rgb(C.blanco).mul(float(1).add(weather(0.8, 0.05))), 0.7),
    cat_hierro: std(rgb(C.hierro), 0.5, 0.6),
    cat_bronce: std(rgb(C.bronce), 0.4, 0.85),
    cat_reloj: std(reloj, 0.5),
  };
}

export interface CatedralResult { group: THREE.Group; vertices: Float32Array; indices: Uint32Array; triangles: number }

export async function loadCatedral(url: string, lm: Landmark): Promise<CatedralResult> {
  const gltf = await new GLTFLoader().loadAsync(url);
  const half = (lm.model?.facadeWidth ?? 36) / 2;
  const tw = cfg.towers.width;
  const clockX = (cfg.towers.clock.tower === 'east' ? 1 : -1) * (half - tw / 2);
  const mats = materials([clockX, cfg.towers.clock.y], cfg.towers.clock.r);
  const verts: number[] = [];
  const inds: number[] = [];
  let triangles = 0;
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const name = (m.material as THREE.Material).name;
    m.material = mats[name] ?? mats.cat_piedra;
    m.castShadow = true;
    m.receiveShadow = true;
    const g = m.geometry as THREE.BufferGeometry;
    const pos = g.getAttribute('position');
    const idx = g.getIndex()!;
    const base = verts.length / 3;
    for (let i = 0; i < pos.count; i++) verts.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    for (let i = 0; i < idx.count; i++) inds.push(base + idx.getX(i));
    triangles += idx.count / 3;
  });
  const group = new THREE.Group();
  group.name = 'catedral';
  group.add(gltf.scene);
  return { group, vertices: new Float32Array(verts), indices: new Uint32Array(inds), triangles };
}
