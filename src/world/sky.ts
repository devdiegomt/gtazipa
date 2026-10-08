import * as THREE from 'three/webgpu';
import { positionLocal, normalize, mix, smoothstep, vec3 } from 'three/tsl';

/** Cielo degradado (horizonte = color de niebla) en una esfera que sigue a la cámara. */
export function buildSky(horizonHex: string): THREE.Mesh {
  const h = new THREE.Color(horizonHex);
  const z = new THREE.Color('#5d8fc4');
  const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
  const t = smoothstep(0.0, 0.45, normalize(positionLocal).y);
  mat.colorNode = mix(vec3(h.r, h.g, h.b), vec3(z.r, z.g, z.b), t);
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1500, 32, 16), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  mesh.name = 'sky';
  return mesh;
}
