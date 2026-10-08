import * as THREE from 'three/webgpu';
import { uv, float, vec2, fract, floor, step, max, hash, mix, mx_noise_float, positionWorld, vec3 } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { TrafficSim, VehicleType } from './sim';
import type { Lane } from './graph';
import { envTexture } from '../world/env';
import trafico from '../data/trafico.json';

const rgb = (hex: string) => { const c = new THREE.Color(hex); return vec3(c.r, c.g, c.b); };

// ---------------------------------------------------------------- modelos de vehículos (low-poly)

type Part = { geo: THREE.BufferGeometry; color?: string };   // sin color = pintura (toma el color de la instancia)

function box(w: number, h: number, l: number, x: number, y: number, z: number, color?: string, rx = 0): Part {
  const g = new THREE.BoxGeometry(w, h, l);
  if (rx) g.rotateX(rx);
  g.translate(x, y, z);
  return { geo: g, color };
}
function wheel(x: number, z: number, r: number, w: number): Part {
  const g = new THREE.CylinderGeometry(r, r, w, 14).rotateZ(Math.PI / 2).translate(x, r, z);
  return { geo: g, color: '#141414' };
}
const GLASS = '#1d2730', LIGHT = '#f2efd8', TAIL = '#a1141a', TRIM = '#202224';

const MODELS: Record<VehicleType, { parts: Part[]; height: number }> = {
  carro: { height: 1.45, parts: [
    box(1.75, 0.62, 4.3, 0, 0.6, 0), box(1.6, 0.52, 2.15, 0, 1.15, 0.25),
    box(1.62, 0.4, 2.0, 0, 1.17, 0.25, GLASS), box(1.4, 0.36, 0.05, 0, 1.12, -0.82, GLASS, -0.55),
    box(1.78, 0.18, 0.12, 0, 0.42, -2.15, TRIM), box(1.78, 0.18, 0.12, 0, 0.42, 2.15, TRIM),
    box(0.35, 0.12, 0.04, -0.6, 0.72, -2.16, LIGHT), box(0.35, 0.12, 0.04, 0.6, 0.72, -2.16, LIGHT),
    box(0.35, 0.12, 0.04, -0.6, 0.74, 2.16, TAIL), box(0.35, 0.12, 0.04, 0.6, 0.74, 2.16, TAIL),
    wheel(-0.78, -1.35, 0.31, 0.2), wheel(0.78, -1.35, 0.31, 0.2), wheel(-0.78, 1.35, 0.31, 0.2), wheel(0.78, 1.35, 0.31, 0.2)] },
  taxi: { height: 1.55, parts: [
    box(1.6, 0.66, 3.6, 0, 0.62, 0), box(1.5, 0.58, 2.1, 0, 1.22, 0.3),
    box(1.52, 0.44, 1.95, 0, 1.24, 0.3, GLASS), box(1.3, 0.4, 0.05, 0, 1.2, -0.72, GLASS, -0.6),
    box(0.62, 0.14, 0.24, 0, 1.6, 0.3, '#f4f2e8'),                       // aviso de techo
    box(1.62, 0.1, 3.0, 0, 0.78, 0, '#1b1b1b'),                          // franja de cuadros (simplificada)
    box(0.3, 0.12, 0.04, -0.52, 0.76, -1.81, LIGHT), box(0.3, 0.12, 0.04, 0.52, 0.76, -1.81, LIGHT),
    box(0.25, 0.14, 0.04, -0.58, 0.8, 1.81, TAIL), box(0.25, 0.14, 0.04, 0.58, 0.8, 1.81, TAIL),
    wheel(-0.72, -1.1, 0.29, 0.19), wheel(0.72, -1.1, 0.29, 0.19), wheel(-0.72, 1.1, 0.29, 0.19), wheel(0.72, 1.1, 0.29, 0.19)] },
  buseta: { height: 2.85, parts: [
    box(2.3, 2.1, 7.5, 0, 1.45, 0), box(2.32, 0.75, 6.9, 0, 1.95, 0.2, GLASS), box(2.0, 0.8, 0.05, 0, 1.9, -3.76, GLASS),
    box(2.33, 0.28, 7.52, 0, 0.95, 0, '#1f7a3e'), box(2.33, 0.1, 7.52, 0, 2.48, 0, '#1f7a3e'),     // franjas verdes
    box(2.26, 0.16, 7.4, 0, 2.58, 0),
    box(0.35, 0.15, 0.04, -0.85, 0.75, -3.77, LIGHT), box(0.35, 0.15, 0.04, 0.85, 0.75, -3.77, LIGHT),
    box(0.25, 0.3, 0.04, -0.95, 0.9, 3.77, TAIL), box(0.25, 0.3, 0.04, 0.95, 0.9, 3.77, TAIL),
    wheel(-1.0, -2.5, 0.45, 0.28), wheel(1.0, -2.5, 0.45, 0.28), wheel(-1.0, 2.3, 0.45, 0.28), wheel(1.0, 2.3, 0.45, 0.28)] },
  camioneta: { height: 1.85, parts: [
    box(1.9, 0.75, 5.2, 0, 0.75, 0), box(1.8, 0.65, 2.0, 0, 1.45, -0.7), box(1.82, 0.5, 1.85, 0, 1.47, -0.7, GLASS),
    box(1.9, 0.45, 2.0, 0, 1.33, 1.55), box(1.6, 0.05, 1.9, 0, 1.12, 1.55, TRIM),                     // platón
    box(1.92, 0.2, 0.14, 0, 0.48, -2.6, TRIM), box(0.32, 0.14, 0.04, -0.65, 0.92, -2.61, LIGHT), box(0.32, 0.14, 0.04, 0.65, 0.92, -2.61, LIGHT),
    box(0.2, 0.3, 0.04, -0.82, 1.1, 2.61, TAIL), box(0.2, 0.3, 0.04, 0.82, 1.1, 2.61, TAIL),
    wheel(-0.85, -1.65, 0.38, 0.26), wheel(0.85, -1.65, 0.38, 0.26), wheel(-0.85, 1.6, 0.38, 0.26), wheel(0.85, 1.6, 0.38, 0.26)] },
  moto: { height: 1.4, parts: [
    wheel(0, -0.65, 0.3, 0.1), wheel(0, 0.65, 0.3, 0.1), box(0.22, 0.28, 1.0, 0, 0.62, 0.05),
    box(0.3, 0.22, 0.5, 0, 0.88, -0.2), box(0.26, 0.08, 0.55, 0, 0.88, 0.32, '#151515'),
    box(0.4, 0.55, 0.28, 0, 1.25, 0.2, '#2b3542'), { geo: new THREE.SphereGeometry(0.15, 10, 8).translate(0, 1.66, 0.12), color: '#e8e4dc' },
    box(0.5, 0.05, 0.05, 0, 1.05, -0.45, '#222'), box(0.12, 0.1, 0.05, 0, 0.92, -0.62, LIGHT)] },
};

function buildModel(type: VehicleType) {
  const { parts } = MODELS[type];
  const prep = (p: Part) => {
    let g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
    g = g.clone();
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal'].includes(k)) g.deleteAttribute(k);
    const c = new THREE.Color(p.color ?? '#ffffff');
    const n = g.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
  };
  const paint = mergeGeometries(parts.filter((p) => !p.color).map(prep))!;
  const fixed = mergeGeometries(parts.filter((p) => p.color).map(prep))!;
  return { paint, fixed };
}

const PALETTES: Record<VehicleType, string[]> = {
  carro: ['#e9e9e6', '#b9bcc0', '#6d7176', '#1d1f22', '#8c1d1d', '#1f3d73', '#e9e9e6', '#b9bcc0'],
  taxi: ['#f5c400'],
  buseta: ['#f1f0ea'],
  camioneta: ['#e9e9e6', '#2b2d30', '#7b2020', '#9aa0a6'],
  moto: ['#b3241e', '#1d1f22', '#1f3d73', '#e9e9e6', '#2e6b3a'],
};

// ---------------------------------------------------------------- vehículos instanciados

export class TrafficView {
  readonly group = new THREE.Group();
  private meshes = new Map<VehicleType, { paint: THREE.InstancedMesh; fixed: THREE.InstancedMesh; ids: number[] }>();
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler(0, 0, 0, 'YXZ');
  // reutilizados en cada frame (sin asignaciones por vehículo)
  private pos = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  private p = { x: 0, z: 0, y: 0, yaw: 0, pitch: 0 };

  constructor(private sim: TrafficSim, private heightAt: (x: number, z: number) => number) {
    this.group.name = 'trafico';
    const env = envTexture();
    const byType = new Map<VehicleType, number[]>();
    for (const v of sim.vehicles) { if (!byType.has(v.type)) byType.set(v.type, []); byType.get(v.type)!.push(v.id); }
    for (const [type, ids] of byType) {
      const { paint, fixed } = buildModel(type);
      const pm = new THREE.InstancedMesh(paint, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.45, envMap: env }), ids.length);
      const fm = new THREE.InstancedMesh(fixed, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.2, envMap: env }), ids.length);
      const col = new THREE.Color();
      ids.forEach((id, i) => {
        const pal = PALETTES[type];
        col.set(pal[(id * 7919) % pal.length]);
        pm.setColorAt(i, col);
      });
      // sólo la carrocería proyecta sombra (luces, vidrios y molduras no se notan en el mapa de sombras)
      pm.castShadow = true;
      for (const m of [pm, fm]) { m.receiveShadow = true; m.frustumCulled = false; this.group.add(m); }
      this.meshes.set(type, { paint: pm, fixed: fm, ids });
    }
  }

  /** Pose de un vehículo interpolada entre el paso anterior y el actual. */
  pose(id: number, t: number, out = { x: 0, z: 0, y: 0, yaw: 0, pitch: 0 }) {
    const v = this.sim.vehicles[id];
    const x = v.px + (v.x - v.px) * t, z = v.pz + (v.z - v.pz) * t;
    const tx = v.ptx + (v.tx - v.ptx) * t, tz = v.ptz + (v.tz - v.ptz) * t;
    const h = v.length * 0.4;
    const yf = this.heightAt(x + tx * h, z + tz * h), yb = this.heightAt(x - tx * h, z - tz * h);
    out.x = x; out.z = z; out.y = (yf + yb) / 2; out.yaw = Math.atan2(-tx, -tz); out.pitch = Math.atan2(yf - yb, 2 * h);
    return out;
  }

  update(t: number) {
    const V = this.sim.vehicles;
    for (const { paint, fixed, ids } of this.meshes.values()) {
      for (let i = 0; i < ids.length; i++) {
        // inactivo (esperando reaparecer fuera de la vista): escala cero
        if (!V[ids[i]].active) { paint.setMatrixAt(i, this.hidden); fixed.setMatrixAt(i, this.hidden); continue; }
        const p = this.pose(ids[i], t, this.p);
        this.e.set(p.pitch, p.yaw, 0);
        this.q.setFromEuler(this.e);
        this.m4.compose(this.pos.set(p.x, p.y, p.z), this.q, this.one);
        paint.setMatrixAt(i, this.m4);
        fixed.setMatrixAt(i, this.m4);
      }
      paint.instanceMatrix.needsUpdate = true;
      fixed.instanceMatrix.needsUpdate = true;
    }
  }

  static height(type: VehicleType) { return MODELS[type].height; }
}

// ---------------------------------------------------------------- semáforos (estilo colombiano)

export class SignalsView {
  readonly group = new THREE.Group();
  private heads: { lane: Lane; controller: number; phase: 0 | 1 }[] = [];
  private lenses: THREE.InstancedMesh[] = [];
  private on = [new THREE.Color('#ff2a1a').multiplyScalar(2.2), new THREE.Color('#ffb000').multiplyScalar(2.2), new THREE.Color('#19e05a').multiplyScalar(2.0)];
  private off = [new THREE.Color('#3a0b08'), new THREE.Color('#3a2a06'), new THREE.Color('#06301a')];

  constructor(private sim: TrafficSim, heightAt: (x: number, z: number) => number) {
    this.group.name = 'semaforos';
    for (const [ci, c] of sim.controllers.entries()) for (const a of c.lanes) this.heads.push({ lane: a.lane, controller: ci, phase: a.phase });
    const n = this.heads.length;
    const env = envTexture();
    const metal = new THREE.MeshStandardMaterial({ color: '#8d9196', metalness: 0.7, roughness: 0.45, envMap: env });
    const black = new THREE.MeshStandardMaterial({ color: '#141516', roughness: 0.6 });
    const yellow = new THREE.MeshStandardMaterial({ color: '#f2c200', roughness: 0.5 });
    const poleG = new THREE.CylinderGeometry(0.09, 0.12, 6.0, 10).translate(0, 3.0, 0);
    const armG = new THREE.CylinderGeometry(0.06, 0.06, 1, 8).rotateZ(Math.PI / 2).translate(0.5, 0, 0);
    const housingG = new THREE.BoxGeometry(0.34, 1.0, 0.3);
    const backG = new THREE.BoxGeometry(0.62, 1.28, 0.03).translate(0, 0, 0.17);
    const visorG = new THREE.CylinderGeometry(0.15, 0.15, 0.16, 12, 1, true, Math.PI * 0.5, Math.PI).rotateX(Math.PI / 2);
    const poles = new THREE.InstancedMesh(poleG, metal, n), arms = new THREE.InstancedMesh(armG, metal, n);
    const housings = new THREE.InstancedMesh(housingG, black, n), backs = new THREE.InstancedMesh(backG, yellow, n);
    const visors = new THREE.InstancedMesh(visorG, black, n * 3);
    const lensG = new THREE.CircleGeometry(0.12, 16);
    for (let k = 0; k < 3; k++) {
      const m = new THREE.InstancedMesh(lensG, new THREE.MeshBasicMaterial({ color: '#ffffff' }), n);
      this.lenses.push(m);
    }
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    this.heads.forEach((h, i) => {
      const L = h.lane;
      const end = L.poly.at(L.poly.length);
      const rx = -end.tz, rz = end.tx;                       // derecha de la marcha
      const toCurb = L.edge.width / 2 - L.offset + 0.7;
      const px = end.x + rx * toCurb, pz = end.z + rz * toCurb;
      const py = heightAt(px, pz);
      m4.makeTranslation(px, py, pz);
      poles.setMatrixAt(i, m4);
      // brazo desde el poste hasta encima del carril
      const armLen = toCurb + 0.2;
      const armYaw = Math.atan2(rz, -rx);                    // eje +X del brazo apunta hacia el carril (-derecha)
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), armYaw);
      m4.compose(new THREE.Vector3(px, py + 5.6, pz), q, new THREE.Vector3(armLen, 1, 1));
      arms.setMatrixAt(i, m4);
      // cabeza colgada sobre el carril, mirando a quien llega
      const hx = end.x + rx * 0.0, hz = end.z + rz * 0.0;
      const yaw = Math.atan2(end.tx, end.tz);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      const hp = new THREE.Vector3(hx, py + 4.95, hz);
      m4.compose(hp, q, one);
      housings.setMatrixAt(i, m4);
      backs.setMatrixAt(i, m4);
      for (let k = 0; k < 3; k++) {
        const local = new THREE.Vector3(0, 0.3 - k * 0.3, -0.155).applyQuaternion(q);
        m4.compose(hp.clone().add(local), q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)), one);
        this.lenses[k].setMatrixAt(i, m4);
        const vl = new THREE.Vector3(0, 0.36 - k * 0.3, -0.22).applyQuaternion(q);
        m4.compose(hp.clone().add(vl), q, one);
        visors.setMatrixAt(i * 3 + k, m4);
      }
    });
    for (const m of [poles, arms, housings, backs, visors]) { m.castShadow = true; this.group.add(m); }
    for (const m of this.lenses) this.group.add(m);
    this.update();
  }

  update() {
    this.heads.forEach((h, i) => {
      const st = this.sim.light(this.sim.controllers[h.controller], h.phase);
      const k = st === 'R' ? 0 : st === 'Y' ? 1 : 2;
      for (let j = 0; j < 3; j++) this.lenses[j].setColorAt(i, j === k ? this.on[j] : this.off[j]);
    });
    for (const m of this.lenses) if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- andenes, sardineles y señalización (roads.glb)

export async function loadRoads(url: string) {
  const gltf = await new GLTFLoader().loadAsync(url);
  const S = trafico.sidewalks;
  const p = uv();
  // tableta de concreto de 0,6 m con juntas y variación por losa
  const cell = floor(p.div(0.6));
  const f = fract(p.div(0.6));
  const joint = max(max(step(f.x, 0.025), step(0.975, f.x)), max(step(f.y, 0.025), step(0.975, f.y)));
  const swMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
  swMat.colorNode = mix(rgb(S.color).mul(float(0.92).add(hash(cell.x.add(cell.y.mul(31.7))).mul(0.12))), rgb('#8a857c'), joint.mul(0.6))
    .mul(float(1).add(mx_noise_float(vec2(positionWorld.x, positionWorld.z).mul(0.3)).mul(0.06)));
  const curbMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.85 });
  curbMat.colorNode = rgb(S.curb).mul(float(1).add(mx_noise_float(positionWorld.mul(2)).mul(0.06)));
  const mark = (hex: string) => {
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.65 });
    m.colorNode = rgb(hex).mul(float(0.9).add(mx_noise_float(vec2(positionWorld.x, positionWorld.z).mul(3)).mul(0.08)));
    m.polygonOffset = true;
    m.polygonOffsetFactor = -4;
    m.polygonOffsetUnits = -4;
    return m;
  };
  const mats: Record<string, THREE.Material> = { sidewalk: swMat, curb: curbMat, mark_white: mark('#ecebe4'), mark_yellow: mark('#e2b419') };
  const verts: number[] = [], inds: number[] = [];
  gltf.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const name = (m.material as THREE.Material).name;
    m.material = mats[name] ?? swMat;
    m.receiveShadow = true;
    m.castShadow = false;   // sardinel de 15 cm: su sombra no se aprecia y cuesta una pasada
    if (name === 'sidewalk' || name === 'curb') {
      const g = m.geometry as THREE.BufferGeometry;
      const pos = g.getAttribute('position'), idx = g.getIndex()!;
      const base = verts.length / 3;
      for (let i = 0; i < pos.count; i++) verts.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      for (let i = 0; i < idx.count; i++) inds.push(base + idx.getX(i));
    }
  });
  return { group: gltf.scene, collider: { vertices: new Float32Array(verts), indices: new Uint32Array(inds) } };
}
