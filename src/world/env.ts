import * as THREE from 'three/webgpu';

let cached: THREE.Texture | null = null;

/**
 * Mapa de entorno sencillo (cielo, horizonte con fachadas claras y tejados, suelo) para que los metales
 * (cromo, bronce, astas) reflejen algo. Se comparte entre todos los materiales que lo usan.
 */
export function envTexture(): THREE.Texture {
  if (cached) return cached;
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d')!;
  const sky = g.createLinearGradient(0, 0, 0, 128);
  sky.addColorStop(0, '#5d8fc4'); sky.addColorStop(1, '#c9d9e8');
  g.fillStyle = sky; g.fillRect(0, 0, 512, 128);
  const ground = g.createLinearGradient(0, 128, 0, 256);
  ground.addColorStop(0, '#8a7c6c'); ground.addColorStop(1, '#3b3530');
  g.fillStyle = ground; g.fillRect(0, 128, 512, 128);
  for (let x = 0; x < 512; x += 23) {
    const h = 10 + ((x * 7919) % 17);
    g.fillStyle = x % 3 ? '#efe9de' : '#d9cdb8';
    g.fillRect(x, 128 - h, 20, h);
    g.fillStyle = '#9c4e36';
    g.fillRect(x - 1, 128 - h - 3, 22, 3);
  }
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  cached = t;
  return t;
}
