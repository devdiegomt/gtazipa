/**
 * Datos reales del mundo para las pruebas de peatones (Node, sin three): triángulos 2D de la cara superior del andén
 * (primitiva 'sidewalk' de roads.glb, como la exporta loadRoads en el juego), alturas del terreno (terrain.bin con el
 * mismo muestreo que src/world/terrain.ts) y la red peatonal construida una sola vez.
 */
import { readFileSync } from 'node:fs';
import type { Road, WorldMeta } from '../src/world/types';
import type { RoadGraph } from '../src/traffic/graph';
import { PedNav, type NavInput } from '../src/peds/nav';

const W = 'public/world/';

/** Triángulos de la malla 'sidewalk' de un .glb (posiciones 3D en coordenadas del mundo) proyectados a (x, z). */
export function sidewalkTriangles(path = W + 'roads.glb'): Float32Array {
  const buf = readFileSync(path);
  const jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  const bin = 20 + jsonLen + 8;
  const read = (i: number) => {
    const a = gltf.accessors[i], bv = gltf.bufferViews[a.bufferView];
    const off = bin + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const n = a.count * ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 } as Record<string, number>)[a.type];
    const bytes = buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + n * (a.componentType === 5123 ? 2 : 4));
    return a.componentType === 5126 ? new Float32Array(bytes) : a.componentType === 5123 ? new Uint16Array(bytes) : new Uint32Array(bytes);
  };
  const out: number[] = [];
  for (const mesh of gltf.meshes) {
    for (const prim of mesh.primitives) {
      if (gltf.materials[prim.material]?.name !== 'sidewalk') continue;
      const P = read(prim.attributes.POSITION), I = read(prim.indices);
      for (let t = 0; t < I.length; t += 3) {
        for (let k = 0; k < 3; k++) out.push(P[I[t + k] * 3], P[I[t + k] * 3 + 2]);
      }
    }
  }
  return new Float32Array(out);
}

/** Alturas del terreno con el mismo muestreo que Heightfield.heightAt (src/world/terrain.ts). */
export function heightfield(meta: WorldMeta) {
  const raw = readFileSync(W + meta.terrain.file);
  const h = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  const { n, spacing, half } = meta.terrain;
  return (x: number, z: number) => {
    const fx = Math.min(Math.max((x + half) / spacing, 0), n - 1.0001);
    const fz = Math.min(Math.max((z + half) / spacing, 0), n - 1.0001);
    const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
    const a = h[iz * n + ix], b = h[iz * n + ix + 1], c = h[(iz + 1) * n + ix], d = h[(iz + 1) * n + ix + 1];
    return tx + tz <= 1 ? a + (b - a) * tx + (c - a) * tz : d + (c - d) * (1 - tx) + (b - d) * (1 - tz);
  };
}

export const world: WorldMeta = JSON.parse(readFileSync(W + 'world.json', 'utf8'));
export const roads: Road[] = JSON.parse(readFileSync(W + 'roads.json', 'utf8'));
export const graph: RoadGraph = JSON.parse(readFileSync(W + 'roadgraph.json', 'utf8'));

let cached: { input: NavInput; nav: PedNav; ms: number } | null = null;
/** Red peatonal del mundo real (construida una vez por archivo de prueba). */
export function realNav() {
  if (!cached) {
    const input: NavInput = { roads, graph, meta: world, walk: sidewalkTriangles(), heightAt: heightfield(world) };
    const t0 = performance.now();
    const nav = new PedNav(input);
    cached = { input, nav, ms: performance.now() - t0 };
  }
  return cached;
}
