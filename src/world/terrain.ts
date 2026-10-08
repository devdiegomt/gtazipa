import * as THREE from 'three/webgpu';
import { texture, uv, positionWorld, mx_noise_float, float, vec2 } from 'three/tsl';
import type { WorldMeta } from './types';

/** Alturas del terreno (rejilla regular, fila = z, columna = x) con muestreo bilineal. */
export class Heightfield {
  readonly n: number;
  readonly spacing: number;
  readonly half: number;
  constructor(readonly heights: Float32Array, meta: WorldMeta['terrain']) {
    this.n = meta.n;
    this.spacing = meta.spacing;
    this.half = meta.half;
  }

  /** Altura interpolada igual que los triángulos de la malla (diagonal a→d). */
  heightAt(x: number, z: number): number {
    const fx = Math.min(Math.max((x + this.half) / this.spacing, 0), this.n - 1.0001);
    const fz = Math.min(Math.max((z + this.half) / this.spacing, 0), this.n - 1.0001);
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const h = this.heights, n = this.n;
    const a = h[iz * n + ix], b = h[iz * n + ix + 1], c = h[(iz + 1) * n + ix], d = h[(iz + 1) * n + ix + 1];
    // Triángulos (a, c, b) y (b, c, d): la diagonal va de b a c.
    return tx + tz <= 1 ? a + (b - a) * tx + (c - a) * tz : d + (c - d) * (1 - tx) + (b - d) * (1 - tz);
  }

  /** Vértices e índices compartidos por la malla visible y el collider de Rapier. */
  buildArrays() {
    const { n, spacing, half, heights } = this;
    const pos = new Float32Array(n * n * 3);
    const uvs = new Float32Array(n * n * 2);
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const i = iz * n + ix;
        pos[i * 3] = -half + ix * spacing;
        pos[i * 3 + 1] = heights[i];
        pos[i * 3 + 2] = -half + iz * spacing;
        uvs[i * 2] = ix / (n - 1);
        uvs[i * 2 + 1] = 1 - iz / (n - 1);
      }
    }
    const idx = new Uint32Array((n - 1) * (n - 1) * 6);
    let k = 0;
    for (let iz = 0; iz < n - 1; iz++) {
      for (let ix = 0; ix < n - 1; ix++) {
        const a = iz * n + ix, b = a + 1, c = a + n, d = c + 1;
        idx[k++] = a; idx[k++] = c; idx[k++] = b;
        idx[k++] = b; idx[k++] = c; idx[k++] = d;
      }
    }
    return { pos, uvs, idx };
  }
}

export function buildTerrainMesh(hf: Heightfield, groundTex: THREE.Texture): THREE.Mesh {
  const { pos, uvs, idx } = hf.buildArrays();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  groundTex.colorSpace = THREE.SRGBColorSpace;
  groundTex.anisotropy = 8;
  groundTex.generateMipmaps = true;
  groundTex.minFilter = THREE.LinearMipmapLinearFilter;

  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  // Textura de suelo (dato: calles/aceras/plazas rasterizadas) × ruido de detalle (procedural, sólo visual).
  const p = vec2(positionWorld.x, positionWorld.z);
  const fine = mx_noise_float(p.mul(1.7)).mul(0.06);
  const coarse = mx_noise_float(p.mul(0.08)).mul(0.07);
  mat.colorNode = texture(groundTex, uv()).mul(float(1).add(fine).add(coarse));

  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  return mesh;
}
