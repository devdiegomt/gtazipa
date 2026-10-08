import * as THREE from 'three/webgpu';
import {
  float, vec2, vec3, fract, floor, step, mix, hash, max, smoothstep, sin, cos, length, time, texture, uv,
  positionLocal, positionWorld, cameraPosition, mx_noise_float, normalWorld,
} from 'three/tsl';
import parksCfg from '../data/parques.json';
import type { Heightfield } from './terrain';
import type { ParkMeta } from './types';
import { envTexture } from './env';

type Cfg = typeof parksCfg.independencia;
const rgb = (hex: string) => { const c = new THREE.Color(hex); return vec3(c.r, c.g, c.b); };

export interface ParkResult {
  group: THREE.Group;
  colliders: { vertices: Float32Array; indices: Uint32Array }[];
  cylinders: { x: number; y: number; z: number; r: number; h: number }[];
  /** Punto de la estatua (para cámaras y pruebas). */
  statue?: { x: number; y: number; z: number; front: [number, number] };
}

/** Adoquín de concreto en hilada trabada con fajas, alineado con el eje del parque. Se funde con la distancia. */
function paverMaterial(P: Cfg['paving'], axis: [number, number]) {
  const wx = positionWorld.x, wz = positionWorld.z;
  const a = wx.mul(axis[0]).add(wz.mul(axis[1]));
  const b = wx.mul(-axis[1]).add(wz.mul(axis[0]));
  const row = floor(b.div(P.paverWidth));
  const off = fract(row.mul(0.5)).mul(P.paverLength);
  const ca = a.add(off).div(P.paverLength);
  const fa = fract(ca), fb = fract(b.div(P.paverWidth));
  const j = max(max(step(fa, 0.05), step(0.95, fa)), max(step(fb, 0.08), step(0.92, fb)));
  const id = hash(floor(ca).add(row.mul(37.1)));
  const fade = smoothstep(8.0, 28.0, length(positionWorld.sub(cameraPosition)));
  const paver = mix(rgb(P.base), rgb(P.alt), id.mul(0.8)).mul(float(0.92).add(hash(id.mul(3.3)).mul(0.14)));
  const near = mix(paver, rgb('#5d5a55'), j.mul(0.7));
  const far = mix(rgb(P.base), rgb(P.alt), 0.4).mul(0.95);
  let c = mix(near, far, fade).mul(float(1).add(mx_noise_float(vec2(wx, wz).mul(0.12)).mul(0.07)));
  const s = P.bandSpacing, bw = P.bandWidth;
  const band = max(step(fract(a.div(s)).mul(s), bw), step(fract(b.div(s)).mul(s), bw));
  c = mix(c, rgb(P.band).mul(float(0.95).add(hash(floor(a.div(0.4)).add(floor(b.div(0.4)).mul(9.7))).mul(0.1))), band);
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
  m.colorNode = c;
  m.polygonOffset = true;
  m.polygonOffsetFactor = -2;
  m.polygonOffsetUnits = -2;
  return m;
}

/** Piedra con despiece (losas) para la plataforma y el pedestal. */
function stoneMaterial(hex: string, slab = 0.6) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.8, metalness: 0 });
  const p = positionWorld;
  const k = vec2(p.x.add(p.z), p.y).div(slab);
  const id = hash(floor(k.x).add(floor(k.y).mul(17.3)));
  const f = fract(k);
  const joint = max(max(step(f.x, 0.02), step(0.98, f.x)), max(step(f.y, 0.03), step(0.97, f.y)));
  m.colorNode = rgb(hex).mul(float(0.9).add(id.mul(0.18))).mul(float(1).sub(joint.mul(0.35)))
    .mul(float(1).add(mx_noise_float(p.mul(2.5)).mul(0.05)));
  return m;
}

/** Bronce con pátina verdosa en las zonas expuestas (arriba) y brillo en relieves. */
function bronzeMaterial(S: Cfg['statue']) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.42, metalness: 0.8, envMap: envTexture(), envMapIntensity: 1.2 });
  const up = smoothstep(0.2, 0.9, normalWorld.y);
  const n = mx_noise_float(positionWorld.mul(9)).mul(0.5).add(0.5);
  m.colorNode = mix(rgb(S.bronze), rgb(S.patina), up.mul(0.6).add(n.mul(0.25)));
  m.roughnessNode = mix(float(0.38), float(0.75), up.mul(0.7));
  return m;
}

/** Bandera (canvas) de una nación bolivariana. Diseño simplificado: franjas oficiales; escudos simplificados. */
function flagTexture(code: string) {
  const c = document.createElement('canvas');
  c.width = 300; c.height = 200;
  const g = c.getContext('2d')!;
  const hStripes = (cols: string[], ratios: number[]) => {
    let y = 0;
    cols.forEach((col, i) => { g.fillStyle = col; const h = ratios[i] * 200; g.fillRect(0, y, 300, h + 1); y += h; });
  };
  const emblem = (x: number, y: number, r: number) => {
    g.fillStyle = '#c9a227'; g.beginPath(); g.ellipse(x, y, r * 0.8, r, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#2d6b3c'; g.beginPath(); g.ellipse(x, y + r * 0.15, r * 0.5, r * 0.6, 0, 0, Math.PI * 2); g.fill();
  };
  switch (code) {
    case 'CO': hStripes(['#fcd116', '#003893', '#ce1126'], [0.5, 0.25, 0.25]); break;
    case 'EC': hStripes(['#ffdd00', '#034ea2', '#ed1c24'], [0.5, 0.25, 0.25]); emblem(150, 100, 30); break;
    case 'VE':
      hStripes(['#ffcc00', '#00247d', '#cf142b'], [1 / 3, 1 / 3, 1 / 3]);
      g.fillStyle = '#fff';
      for (let i = 0; i < 8; i++) {
        const a = Math.PI * (0.15 + (0.7 * i) / 7);
        g.beginPath(); g.arc(150 - Math.cos(a) * 45, 118 - Math.sin(a) * 38, 6, 0, Math.PI * 2); g.fill();
      }
      break;
    case 'PE': g.fillStyle = '#d91023'; g.fillRect(0, 0, 300, 200); g.fillStyle = '#fff'; g.fillRect(100, 0, 100, 200); break;
    case 'BO': hStripes(['#d52b1e', '#f9e300', '#007934'], [1 / 3, 1 / 3, 1 / 3]); break;
    default: g.fillStyle = '#ddd'; g.fillRect(0, 0, 300, 200);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/**
 * Figura de bronce de pie (estilo de estatuaria conmemorativa del siglo XIX): levita abierta con faldones, chaleco,
 * corbatín, coleta dieciochesca; sostiene un libro contra el pecho con la mano izquierda y hace un gesto de orador
 * con la derecha. Cada miembro es una cápsula entre articulaciones explícitas, así las piezas quedan unidas.
 * Pies en y = 0, mira a -Z. Diseño ESTIMADO (no hay foto de referencia).
 */
function statueFigure(mat: THREE.Material, height: number) {
  const g = new THREE.Group();
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const mesh = (geo: THREE.BufferGeometry) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };
  /** Cápsula (o tronco de cono) entre dos articulaciones. */
  const seg = (a: THREE.Vector3, b: THREE.Vector3, ra: number, rb = ra) => {
    const len = a.distanceTo(b);
    const m = mesh(new THREE.CylinderGeometry(rb, ra, len, 14));
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(V(0, 1, 0), b.clone().sub(a).normalize());
    mesh(new THREE.SphereGeometry(ra, 12, 10)).position.copy(a);
    mesh(new THREE.SphereGeometry(rb, 12, 10)).position.copy(b);
  };
  // piernas (contrapposto: la derecha adelantada) y botas
  const hipL = V(-0.1, 0.95, 0), hipR = V(0.1, 0.95, 0);
  const kneeL = V(-0.11, 0.5, 0.02), kneeR = V(0.11, 0.51, -0.08);
  const ankL = V(-0.11, 0.08, 0.03), ankR = V(0.12, 0.08, -0.12);
  seg(hipL, kneeL, 0.092, 0.075); seg(kneeL, ankL, 0.075, 0.06);
  seg(hipR, kneeR, 0.092, 0.075); seg(kneeR, ankR, 0.075, 0.06);
  for (const [a, dz] of [[ankL, 0], [ankR, -0.04]] as const) {
    const boot = mesh(new THREE.CapsuleGeometry(0.06, 0.18, 4, 10));
    boot.rotation.x = Math.PI / 2;
    boot.position.set(a.x, 0.06, a.z - 0.07 + dz);
  }
  // pelvis, chaleco y pecho
  mesh(new THREE.CylinderGeometry(0.19, 0.2, 0.22, 18)).position.set(0, 1.0, 0);
  const chest = mesh(new THREE.CylinderGeometry(0.205, 0.18, 0.5, 18));
  chest.position.set(0, 1.3, 0);
  chest.scale.set(1, 1, 0.82);
  // levita: torno abierto por delante (faldones hasta la rodilla) + cuello vuelto
  const coatProfile = [V(0.215, 1.5, 0), V(0.225, 1.3, 0), V(0.205, 1.08, 0), V(0.235, 0.86, 0), V(0.275, 0.55, 0)]
    .map((p) => new THREE.Vector2(p.x, p.y));
  const coat = mesh(new THREE.LatheGeometry(coatProfile, 28, Math.PI * 0.62, Math.PI * 1.76));
  coat.scale.set(1, 1, 0.88);
  (coat.material as THREE.Material).side = THREE.DoubleSide;
  const collar = mesh(new THREE.TorusGeometry(0.15, 0.035, 8, 20, Math.PI * 1.4));
  collar.position.set(0, 1.53, 0.01);
  collar.rotation.set(Math.PI / 2, 0, Math.PI * 0.8);
  mesh(new THREE.CylinderGeometry(0.06, 0.068, 0.1, 12)).position.set(0, 1.58, 0);
  const cravat = mesh(new THREE.SphereGeometry(0.06, 10, 8));
  cravat.position.set(0, 1.53, -0.12);
  cravat.scale.set(1.2, 0.8, 0.6);
  // cabeza, cabello con coleta y rasgos
  const head = mesh(new THREE.SphereGeometry(0.105, 20, 16));
  head.position.set(0, 1.71, -0.01);
  head.scale.set(0.9, 1.1, 1.0);
  const hair = mesh(new THREE.SphereGeometry(0.11, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.58));
  hair.position.set(0, 1.725, 0.015);
  hair.scale.set(0.95, 1.05, 1.05);
  seg(V(0, 1.68, 0.1), V(0, 1.55, 0.14), 0.025, 0.018);                     // coleta
  mesh(new THREE.BoxGeometry(0.03, 0.045, 0.035)).position.set(0, 1.7, -0.115);   // nariz
  // brazo izquierdo: sostiene el libro contra el pecho
  const shL = V(-0.24, 1.47, 0.01), elL = V(-0.29, 1.19, -0.04), wrL = V(-0.13, 1.21, -0.2);
  seg(shL, elL, 0.072, 0.062); seg(elL, wrL, 0.062, 0.05);
  const book = mesh(new THREE.BoxGeometry(0.2, 0.27, 0.05));
  book.position.set(-0.06, 1.22, -0.22);
  book.rotation.set(-0.2, 0.3, 0.1);
  mesh(new THREE.SphereGeometry(0.048, 10, 8)).position.copy(wrL).add(V(0.02, -0.02, -0.03));
  // brazo derecho: gesto de orador, palma hacia adelante
  const shR = V(0.24, 1.47, 0.01), elR = V(0.33, 1.2, -0.1), wrR = V(0.4, 1.22, -0.36);
  seg(shR, elR, 0.072, 0.062); seg(elR, wrR, 0.062, 0.05);
  const hand = mesh(new THREE.BoxGeometry(0.08, 0.1, 0.035));
  hand.position.copy(wrR).add(V(0.01, 0.03, -0.05));
  hand.rotation.set(-0.5, 0.2, 0);
  g.scale.setScalar(height / 1.82);
  return g;
}

export function buildPark(p: ParkMeta, hf: Heightfield, cfg: Cfg): ParkResult {
  const group = new THREE.Group();
  group.name = `parque-${p.id}`;
  const colliders: ParkResult['colliders'] = [];
  const cylinders: ParkResult['cylinders'] = [];
  const mon = p.monuments[0];
  const axis: [number, number] = mon ? mon.axis : [1, 0];

  // ---------------- pavimento (polígono OSM) + sardinel perimetral
  const ring = p.ring.slice(0, -1).map(([x, z]) => new THREE.Vector2(x, z));
  const tris = THREE.ShapeUtils.triangulateShape(ring, []);
  const pos = new Float32Array(ring.length * 3);
  ring.forEach((q, i) => pos.set([q.x, hf.heightAt(q.x, q.y) + 0.03, q.y], i * 3));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(tris.flat());
  geo.computeVertexNormals();
  if (geo.getAttribute('normal').getY(0) < 0) { geo.setIndex(tris.map(([a, b, c]) => [a, c, b]).flat()); geo.computeVertexNormals(); }
  const paving = new THREE.Mesh(geo, paverMaterial(cfg.paving, axis));
  paving.receiveShadow = true;
  group.add(paving);
  const curbMat = stoneMaterial('#b4afa6', 0.9);
  for (let i = 0; i < p.ring.length - 1; i++) {
    const [ax, az] = p.ring[i], [bx, bz] = p.ring[i + 1];
    const L = Math.hypot(bx - ax, bz - az);
    const y = (hf.heightAt(ax, az) + hf.heightAt(bx, bz)) / 2;
    const curb = new THREE.Mesh(new THREE.BoxGeometry(L + 0.15, cfg.paving.curbHeight + 0.2, 0.15), curbMat);
    curb.position.set((ax + bx) / 2, y + cfg.paving.curbHeight / 2 - 0.1, (az + bz) / 2);
    curb.rotation.y = -Math.atan2(bz - az, bx - ax);
    curb.castShadow = curb.receiveShadow = true;
    group.add(curb);
  }

  // ---------------- plataforma del Homenaje a la Independencia (huella OSM, nivelada, con grada)
  let statue: ParkResult['statue'];
  if (mon) {
    const g0 = mon.ring.map(([x, z]) => hf.heightAt(x, z));
    const yMean = g0.reduce((a, b) => a + b, 0) / g0.length;
    const yMin = Math.min(...g0);
    const P = cfg.platform;
    const top = yMean + P.height;
    const prism = (rg: [number, number][], y0: number, y1: number, mat: THREE.Material) => {
      const shape = new THREE.Shape(rg.slice(0, -1).map(([x, z]) => new THREE.Vector2(x, -z)));
      const eg = new THREE.ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: false });
      eg.rotateX(-Math.PI / 2);
      eg.translate(0, y0, 0);
      const mesh = new THREE.Mesh(eg, mat);
      mesh.castShadow = mesh.receiveShadow = true;
      group.add(mesh);
      const ng = eg.index ? eg.toNonIndexed() : eg;
      const v = ng.getAttribute('position').array as Float32Array;
      colliders.push({ vertices: new Float32Array(v), indices: new Uint32Array([...Array(v.length / 3).keys()]) });
      return mesh;
    };
    // grada perimetral (contorno ampliado) y cuerpo de la plataforma
    const [ux, uz] = mon.axis, [fx, fz] = mon.front;
    const rect = (hl: number, hw: number): [number, number][] => {
      const c = [[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw], [-hl, -hw]];
      return c.map(([a, b]) => [mon.x + a * ux + b * fx, mon.z + a * uz + b * fz]);
    };
    // Plataforma nivelada sobre una plaza en pendiente: escalinata perimetral con contrahuellas de P.rise
    // y huellas de P.tread, tantas como pide el lado más bajo (del lado alto quedan enterradas).
    const hl = mon.length / 2, hw = mon.width / 2;
    const around = rect(hl + 2.5, hw + 2.5).map(([x, z]) => hf.heightAt(x, z));
    const nSteps = Math.max(1, Math.ceil((top - Math.min(...around, yMin)) / P.rise) - 1);
    const clad = stoneMaterial(P.cladding);
    for (let k = nSteps; k >= 1; k--) {
      prism(rect(hl + k * P.tread, hw + k * P.tread), yMin - 0.6, top - k * P.rise, clad);
    }
    prism(mon.ring as [number, number][], yMin - 0.6, top, stoneMaterial(P.top, 0.75));

    // ---------------- pedestal + estatua de Antonio Nariño (centro de la plataforma, mirando al centro del parque)
    const S = cfg.statue;
    const sx = mon.x + fx * 0.6, sz = mon.z + fz * 0.6;
    const yaw = Math.atan2(-fx, -fz);     // la figura mira a -Z local → hacia `front`
    const ped = new THREE.Group();
    ped.position.set(sx, top, sz);
    ped.rotation.y = yaw;
    group.add(ped);
    const stone = stoneMaterial(S.stone, 0.5);
    const blk = (w: number, h: number, d: number, y: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), stone);
      m.position.y = y + h / 2;
      m.castShadow = m.receiveShadow = true;
      ped.add(m);
    };
    const W = S.pedestalWidth, H = S.pedestalHeight;
    blk(W + 0.5, 0.3, W + 0.5, 0);
    blk(W + 0.2, 0.2, W + 0.2, 0.3);
    blk(W, H - 0.8, W, 0.5);
    blk(W + 0.2, 0.15, W + 0.2, H - 0.3);
    blk(W + 0.3, 0.15, W + 0.3, H - 0.15);
    // placa de bronce con el nombre
    const pc = document.createElement('canvas');
    pc.width = 256; pc.height = 128;
    const pg = pc.getContext('2d')!;
    pg.fillStyle = '#6b5434'; pg.fillRect(0, 0, 256, 128);
    pg.strokeStyle = '#a8895a'; pg.lineWidth = 6; pg.strokeRect(6, 6, 244, 116);
    pg.fillStyle = '#d8c08a'; pg.font = 'bold 26px Georgia'; pg.textAlign = 'center';
    pg.fillText('ANTONIO', 128, 52); pg.fillText('NARIÑO', 128, 86);
    pg.font = '14px Georgia'; pg.fillText('1765 – 1823', 128, 110);
    const ptex = new THREE.CanvasTexture(pc);
    ptex.colorSpace = THREE.SRGBColorSpace;
    const plaque = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.4),
      new THREE.MeshStandardMaterial({ map: ptex, metalness: 0.6, roughness: 0.4, envMap: envTexture() }));
    plaque.position.set(0, 1.25, -W / 2 - 0.005);
    plaque.rotation.y = Math.PI;
    ped.add(plaque);
    const fig = statueFigure(bronzeMaterial(S), S.figureHeight);
    fig.position.y = H;
    ped.add(fig);
    statue = { x: sx, y: top + H, z: sz, front: [fx, fz] };
    cylinders.push({ x: sx, y: top, z: sz, r: (W + 0.5) * 0.62, h: H + 1.6 });

    // ---------------- banderas de las naciones bolivarianas (fila al fondo de la plataforma)
    const F = cfg.flags;
    const n = F.countries.length;
    const poleMat = new THREE.MeshStandardMaterial({ color: '#d9dcdf', metalness: 0.8, roughness: 0.3, envMap: envTexture() });
    const gold = new THREE.MeshStandardMaterial({ color: '#c9a227', metalness: 0.9, roughness: 0.3, envMap: envTexture() });
    const windA = (F.windFromDeg * Math.PI) / 180;
    // dirección hacia donde ondea la bandera (viento desde windFromDeg, medido desde el norte hacia el este)
    const wdx = -Math.sin(windA), wdz = Math.cos(windA);
    const flagYaw = Math.atan2(-wdz, wdx);
    F.countries.forEach((code, i) => {
      const u = (i - (n - 1) / 2) * ((mon.length - 3) / Math.max(1, n - 1));
      const px = mon.x + u * ux - fx * (mon.width / 2 - 0.7), pz = mon.z + u * uz - fz * (mon.width / 2 - 0.7);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.07, F.poleHeight, 10), poleMat);
      pole.position.set(px, top + F.poleHeight / 2, pz);
      pole.castShadow = true;
      group.add(pole);
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 8), gold);
      ball.position.set(px, top + F.poleHeight + 0.08, pz);
      group.add(ball);
      cylinders.push({ x: px, y: top, z: pz, r: 0.12, h: F.poleHeight });
      // tela con ondeo (vertex shader): desplazamiento creciente desde el asta
      const fg = new THREE.PlaneGeometry(F.flagWidth, F.flagHeight, 24, 10);
      fg.translate(F.flagWidth / 2, 0, 0);
      const fm = new THREE.MeshStandardNodeMaterial({ roughness: 0.75, metalness: 0, side: THREE.DoubleSide });
      const x = positionLocal.x;
      const k = x.div(F.flagWidth);
      const phase = float(i * 1.7);
      const wave = sin(x.mul(2.6).sub(time.mul(5.2)).add(phase)).mul(0.16).add(sin(x.mul(5.1).sub(time.mul(8.3)).add(phase)).mul(0.05));
      fm.positionNode = positionLocal.add(vec3(0, cos(x.mul(1.7).sub(time.mul(3.0))).mul(0.04).mul(k), wave.mul(k)));
      fm.colorNode = texture(flagTexture(code), uv()).mul(float(0.85).add(sin(x.mul(2.6).sub(time.mul(5.2)).add(phase)).mul(0.15)));
      const flag = new THREE.Mesh(fg, fm);
      flag.position.set(px, top + F.poleHeight - F.flagHeight / 2 - 0.15, pz);
      flag.rotation.y = flagYaw;
      flag.castShadow = true;
      group.add(flag);
    });
  }

  // ---------------- fuente (huella OSM): pila de piedra, agua animada y surtidor
  const FT = cfg.fountain;
  for (const f of p.fountains) {
    const y0 = hf.heightAt(f.x, f.z);
    const R = Math.max(1.2, f.radius);
    const fs = stoneMaterial(FT.stone, 0.45);
    fs.side = THREE.DoubleSide;
    const rim = new THREE.Mesh(new THREE.LatheGeometry([new THREE.Vector2(R - FT.rimWidth, 0), new THREE.Vector2(R - FT.rimWidth, FT.rimHeight),
      new THREE.Vector2(R + 0.05, FT.rimHeight), new THREE.Vector2(R + 0.05, FT.rimHeight - 0.08), new THREE.Vector2(R, FT.rimHeight - 0.1),
      new THREE.Vector2(R, -0.2)], 48), fs);
    rim.position.set(f.x, y0, f.z);
    rim.castShadow = rim.receiveShadow = true;
    group.add(rim);
    const wm = new THREE.MeshStandardNodeMaterial({ roughness: 0.08, metalness: 0.3, transparent: true, opacity: 0.88 });
    const wp = vec2(positionWorld.x, positionWorld.z);
    const rad = length(wp.sub(vec2(f.x, f.z)));
    const ripple = sin(rad.mul(9).sub(time.mul(4))).mul(0.5).add(0.5).mul(smoothstep(R, 0.2, rad));
    wm.colorNode = mix(rgb(FT.water), rgb('#9cc3cf'), ripple.mul(0.35).add(mx_noise_float(vec3(wp.mul(2), time.mul(0.4))).mul(0.1)));
    const water = new THREE.Mesh(new THREE.CircleGeometry(R - FT.rimWidth, 40).rotateX(-Math.PI / 2), wm);
    water.position.set(f.x, y0 + FT.rimHeight - 0.12, f.z);
    group.add(water);
    const spout = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.2, 0.55, 16), fs);
    spout.position.set(f.x, y0 + 0.28, f.z);
    group.add(spout);
    // surtidor: columna translúcida con brillo que sube
    const jm = new THREE.MeshStandardNodeMaterial({ roughness: 0.1, metalness: 0, transparent: true, depthWrite: false });
    const jy = positionLocal.y.div(FT.jetHeight).add(0.5);
    jm.colorNode = vec3(0.85, 0.93, 0.97);
    jm.opacityNode = float(0.55).mul(float(1).sub(jy)).mul(fract(jy.mul(6).sub(time.mul(3))).mul(0.4).add(0.6));
    const jet = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.06, FT.jetHeight, 10, 1, true), jm);
    jet.position.set(f.x, y0 + 0.55 + FT.jetHeight / 2, f.z);
    group.add(jet);
    cylinders.push({ x: f.x, y: y0, z: f.z, r: R + 0.05, h: FT.rimHeight });
  }
  return { group, colliders, cylinders, statue };
}
