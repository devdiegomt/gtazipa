import * as THREE from 'three/webgpu';
import {
  Fn, attribute, positionGeometry, normalGeometry, normalLocal, varying, float, vec2, vec3, vec4, sin, cos, atan, acos,
  sqrt, clamp, mix, smoothstep, step, select, fract, floor, mod, min, max, exp2, pow, normalize, length,
} from 'three/tsl';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Ped, PedPose } from './types';
import { pedPhasePerMetre, pedRunBlend, ANKLE_Y, HEEL, BALL } from './gait';

export { pedStride, pedPhasePerMetre } from './gait';

/**
 * Peatones instanciados: UNA InstancedMesh (una llamada de dibujo + su pasada de sombra) con un humano low-poly
 * procedural (~470 triángulos sin accesorios) animado en el vertex shader (TSL positionNode). Cada vértice lleva su hueso
 * (aBone: cadena, lado, segmento + 4·accesorio opcional, ranura de color); cada instancia, su estado (iRoot, iAnim, iPose:
 * un búfer intercalado que se sube en cada frame) y su aspecto (iLook, iColA, iColB: otro, que sólo cambia al aparecer un
 * peatón). Cinco búferes de vértices en total (WebGPU admite 8). Toda la animación sale de atributos de la simulación
 * (fase, rapidez, tiempo en la postura), nunca del reloj `time` de TSL: en pausa queda congelada.
 *
 * Lo que el dibujo espera de la simulación (types.ts):
 * - Marcha: la fase avanza con la DISTANCIA (gait.ts): phase += d · pedPhasePerMetre(speed, height). Los tobillos siguen
 *   pedFoot() y las piernas se resuelven con IK analítica de dos huesos: el pie de apoyo no patina.
 * - poseTime: segundos de simulación en la postura actual, 0 al cambiarla; las posturas se mezclan con él (≈0,5 s; sentarse
 *   0,8 s; caer 0,35 s; levantarse 1 s). Al aparecer un peatón (active false → true) no hay mezcla.
 * - Al aparecer o teletransportarlo, px/pz/py/pheading = x/z/y/heading (si no, se dibuja deslizándose desde el sitio viejo).
 * - 'sit': (x, z) es la cadera sobre el asiento, heading hacia donde mira; cadera a seatH + 9 cm sobre y; los pies quedan
 *   ~0,4 m delante en el suelo (si el asiento es alto, cuelgan; con seatH = 0 se sienta en el suelo).
 * - 'fallen': tendido boca arriba (30 % boca abajo) girando sobre la cadera en (x, z): la cabeza ~0,8 m detrás según
 *   heading, los pies ~0,9 m delante.
 * - 'wait': de pie mirando a un lado y al otro (el tráfico); 'idle': gesto propio del peatón (brazos cruzados, conversa,
 *   celular, manos atrás o en la cintura…); 'run': correr (carrera según la rapidez, o trote si va lento).
 * - look: semilla entera o fraccionaria (aspecto determinista, pedLook()); height < 0,9 se viste como escolar casi siempre.
 *
 * Atributos por instancia (Float32; en cada frame se reescriben sólo los peatones activos):
 *   iRoot = (x, y, z, rumbo)  ·  iAnim = (fase, rapidez m/s, carrera 0–1, reloj s)
 *   iPose = (sentado 0–1, caído 0–1, asiento en unidades del cuerpo, gesto + 8·espera + peso del gesto en la fracción)
 *   iLook = (escala de estatura (0 = oculto), complexión, banderas, semilla)  ·  iColA/iColB = 8 colores sRGB 0xRRGGBB
 */

// ---------------------------------------------------------------- esqueleto del cuerpo de referencia (1,70 m)

const HIP_X = 0.095, HIP_Y = 0.9, KNEE_Y = 0.475;
const SHO_X = 0.205, SHO_Y = 1.405, ELB_Y = 1.12;
const WAIST_Y = 1.0, NECK_Y = 1.49;
const THIGH = HIP_Y - KNEE_Y, SHIN = KNEE_Y - ANKLE_Y;

/** Cadenas (aBone.x), en orden: las de < 2 se ensanchan con la complexión. */
const PELVIS = 0, TORSO = 1, HEAD = 2, ARM = 3, LEG = 4;
/**
 * Ranuras de color (aBone.w): 0–7 por instancia; 8 oscuro (ojos, cinta); 9 reflectivo; 10/11 pierna (pantorrilla / muslo):
 * el pantalón, o con falda la media (piel, medias blancas o azules hasta la rodilla, o pantimedias oscuras).
 */
const SKIN = 0, HAIR = 1, TOP = 2, BOTTOM = 3, SHOES = 4, HAT = 5, RUANA = 6, PACK = 7, DARK = 8, REFLECT = 9, LEG_SHIN = 10, LEG_THIGH = 11;
/** Accesorios opcionales (aBone.z = segmento + 4·opt; visibles si el bit opt-1 de las banderas está puesto). */
const SOMBRERO = 1, GORRA = 2, O_RUANA = 3, MOCHILA = 4, FALDA = 5, PELO_LARGO = 6, CHALECO = 7;

type V3 = [number, number, number];
interface PartTag { chain: number; side: number; seg: number; slot: number; opt?: number }
/** Etiqueta fija o por vértice (p. ej. la falda: cintura en la pelvis, ruedo en cada muslo). */
type Tagger = PartTag | ((v: V3) => PartTag);
/** Anillo de un loft: [y, radio x, radio z, centro z]. */
type Ring = [number, number, number, number?];

class BodyBuilder {
  pos: number[] = []; nor: number[] = []; bone: number[] = [];

  /** Triángulo con normal de cara; si `hint` se da, se orienta para que la normal se aleje de ese punto. */
  tri(a: V3, b: V3, c: V3, tagger: Tagger, hint?: V3) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) return;
    nx /= l; ny /= l; nz /= l;
    if (hint) {
      const cx = (a[0] + b[0] + c[0]) / 3 - hint[0], cy = (a[1] + b[1] + c[1]) / 3 - hint[1], cz = (a[2] + b[2] + c[2]) / 3 - hint[2];
      if (nx * cx + ny * cy + nz * cz < 0) { [b, c] = [c, b]; nx = -nx; ny = -ny; nz = -nz; }
    }
    for (const v of [a, b, c]) {
      const tag = typeof tagger === 'function' ? tagger(v) : tagger;
      this.pos.push(v[0], v[1], v[2]);
      this.nor.push(nx, ny, nz);
      this.bone.push(tag.chain, tag.side, tag.seg + 4 * (tag.opt ?? 0), tag.slot);
    }
  }

  /** Geometría de three (ya orientada). */
  geo(g: THREE.BufferGeometry, tag: PartTag) {
    const ng = g.index ? g.toNonIndexed() : g;
    const p = ng.getAttribute('position');
    for (let i = 0; i < p.count; i += 3) {
      const v = (k: number): V3 => [p.getX(i + k), p.getY(i + k), p.getZ(i + k)];
      this.tri(v(0), v(1), v(2), tag);
    }
  }

  box(w: number, h: number, d: number, x: number, y: number, z: number, tag: PartTag, edit?: (v: THREE.Vector3) => void, rx = 0) {
    const g = new THREE.BoxGeometry(w, h, d);
    if (edit) {
      const p = g.getAttribute('position'), v = new THREE.Vector3();
      for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i); edit(v); p.setXYZ(i, v.x, v.y, v.z); }
    }
    if (rx) g.rotateX(rx);
    this.geo(g.translate(x, y, z), tag);
  }

  /** Cuadro plano mirando a -Z (ojos, cejas, boca). */
  quad(w: number, h: number, x: number, y: number, z: number, tag: PartTag) {
    const a: V3 = [x - w / 2, y - h / 2, z], b: V3 = [x + w / 2, y - h / 2, z], c: V3 = [x + w / 2, y + h / 2, z], d: V3 = [x - w / 2, y + h / 2, z];
    const hint: V3 = [x, y, z + 1];
    this.tri(a, b, c, tag, hint);
    this.tri(a, c, d, tag, hint);
  }

  /**
   * Loft de anillos elípticos alrededor de un eje vertical en x = cx. θ = 0 mira a +Z (espalda); `rot` gira los
   * vértices (π/sides deja una cara plana al frente). `arc` = [θ0, θ1] para una tira abierta.
   */
  loft(rings: Ring[], sides: number, tag: Tagger, o: { cx?: number; top?: boolean; bottom?: boolean; rot?: number; arc?: [number, number] } = {}) {
    const cx = o.cx ?? 0, rot = o.rot ?? Math.PI / sides;
    const n = o.arc ? sides + 1 : sides;
    const ang = (k: number) => o.arc ? o.arc[0] + ((o.arc[1] - o.arc[0]) * k) / sides : rot + (2 * Math.PI * k) / sides;
    const pts = rings.map(([y, rx, rz, cz = 0]) => Array.from({ length: n }, (_, k): V3 => [cx + rx * Math.sin(ang(k)), y, cz + rz * Math.cos(ang(k))]));
    for (let i = 0; i + 1 < rings.length; i++) {
      const hint: V3 = [cx, (rings[i][0] + rings[i + 1][0]) / 2, ((rings[i][3] ?? 0) + (rings[i + 1][3] ?? 0)) / 2];
      for (let k = 0; k < sides; k++) {
        const k1 = o.arc ? k + 1 : (k + 1) % n;
        const a = pts[i][k], b = pts[i][k1], c = pts[i + 1][k1], d = pts[i + 1][k];
        this.tri(a, b, c, tag, hint);
        this.tri(a, c, d, tag, hint);
      }
    }
    const cap = (i: number, up: number) => {
      const [y, , , cz = 0] = rings[i];
      const c: V3 = [cx, y, cz], hint: V3 = [cx, y - up, cz];
      for (let k = 0; k < sides; k++) this.tri(c, pts[i][k], pts[i][(k + 1) % n], tag, hint);
    };
    if (o.bottom && !o.arc) cap(0, -1);
    if (o.top && !o.arc) cap(rings.length - 1, 1);
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('aBone', new THREE.Float32BufferAttribute(this.bone, 4));
    return mergeVertices(g);
  }
}

/** Torso (anillos compartidos con el chaleco, que va 5 % por fuera). */
const TORSO_RINGS: Ring[] = [[0.98, 0.142, 0.1], [1.22, 0.165, 0.118], [1.38, 0.2, 0.112], [1.45, 0.168, 0.095], [1.5, 0.07, 0.06]];
function torsoAt(y: number, k = 1.05): Ring {
  const R = TORSO_RINGS;
  let i = 0;
  while (i < R.length - 2 && y > R[i + 1][0]) i++;
  const t = (y - R[i][0]) / (R[i + 1][0] - R[i][0]);
  return [y, (R[i][1] + (R[i + 1][1] - R[i][1]) * t) * k, (R[i][2] + (R[i + 1][2] - R[i][2]) * t) * k];
}

/** Humano low-poly: pies en y = 0, mirando a -Z, 1,70 m. */
export function buildPedGeometry() {
  const B = new BodyBuilder();
  const T = (chain: number, slot: number, side = 0, seg = 0, opt = 0): PartTag => ({ chain, side, seg, slot, opt });
  // pelvis y torso
  B.loft([[0.84, 0.14, 0.098], [1.02, 0.152, 0.104]], 8, T(PELVIS, BOTTOM), { bottom: true });
  B.loft(TORSO_RINGS, 8, T(TORSO, TOP), { top: true });
  B.loft([[1.46, 0.045, 0.045], [1.53, 0.042, 0.042, 0.004]], 6, T(TORSO, SKIN));
  // cabeza (cara plana al frente), pelo, rasgos
  const HY = 1.585;
  B.loft([[HY - 0.11, 0.04, 0.04, -0.035], [HY - 0.075, 0.075, 0.085, -0.012], [HY - 0.01, 0.09, 0.105], [HY + 0.06, 0.085, 0.1, 0.005],
    [HY + 0.105, 0.055, 0.065, 0.008]], 8, T(HEAD, SKIN), { top: true, bottom: true });
  B.loft([[HY + 0.04, 0.094, 0.109, 0.004], [HY + 0.085, 0.088, 0.1, 0.006], [HY + 0.123, 0.05, 0.06, 0.01]], 8, T(HEAD, HAIR), { top: true });
  B.loft([[HY - 0.06, 0.082, 0.098, 0.012], [HY + 0.045, 0.096, 0.111, 0.004]], 5, T(HEAD, HAIR), { arc: [-Math.PI * 0.62, Math.PI * 0.62] });
  const fz = -(0.1036 * Math.cos(Math.PI / 8)) + 0.0014 - 0.0015;   // cara frontal del octágono a la altura de los ojos
  for (const s of [-1, 1]) {
    B.quad(0.024, 0.016, s * 0.034, HY + 0.012, fz, T(HEAD, DARK));
    B.quad(0.032, 0.008, s * 0.034, HY + 0.034, fz - 0.001, T(HEAD, HAIR));
  }
  B.quad(0.036, 0.007, 0, HY - 0.05, fz + 0.004, T(HEAD, DARK));
  B.box(0.022, 0.034, 0.024, 0, HY - 0.012, fz - 0.008, T(HEAD, SKIN), (v) => { if (v.y < 0 && v.z < 0) v.z += 0.006; });
  // brazos: hombro → codo (manga), codo → muñeca (manga) y mano
  for (const s of [-1, 1]) {
    const cx = s * (SHO_X + 0.01);
    B.loft([[ELB_Y - 0.01, 0.046, 0.046], [SHO_Y + 0.035, 0.055, 0.058]], 6, T(ARM, TOP, s, 0), { cx, top: true });
    B.loft([[0.89, 0.036, 0.036], [ELB_Y + 0.03, 0.046, 0.046]], 6, T(ARM, TOP, s, 1), { cx });
    B.box(0.036, 0.1, 0.075, cx, 0.84, -0.005, T(ARM, SKIN, s, 1), (v) => { if (v.y < 0) { v.z *= 0.8; v.x *= 0.8; } });
  }
  // piernas: muslo (pantalón), pantorrilla (pantalón o media), zapato
  for (const s of [-1, 1]) {
    const cx = s * HIP_X;
    B.loft([[KNEE_Y - 0.01, 0.057, 0.06], [0.72, 0.07, 0.076, 0.004], [0.96, 0.073, 0.08]], 6, T(LEG, LEG_THIGH, s, 0), { cx });
    B.loft([[0.085, 0.04, 0.042], [0.33, 0.052, 0.06, 0.01], [KNEE_Y + 0.025, 0.056, 0.058]], 6, T(LEG, LEG_SHIN, s, 1), { cx });
    B.box(0.092, 0.085, 0.25, cx, 0.0425, (HEEL - BALL - 0.06) / 2, T(LEG, SHOES, s, 2), (v) => {   // talón 6 cm atrás, punta 19 cm adelante
      if (v.y > 0 && v.z < 0) v.y -= 0.035;   // punta más baja
      if (v.z < 0) v.x *= 0.85;
    });
  }
  // accesorios opcionales
  B.loft([[1.665, 0.2, 0.21], [1.677, 0.2, 0.21]], 8, T(HEAD, HAT, 0, 0, SOMBRERO), { top: true, bottom: true });
  B.loft([[1.66, 0.105, 0.115], [1.785, 0.09, 0.1]], 8, T(HEAD, HAT, 0, 0, SOMBRERO), { top: true });
  B.loft([[1.676, 0.108, 0.118], [1.70, 0.106, 0.116]], 8, T(HEAD, DARK, 0, 0, SOMBRERO));
  B.loft([[HY + 0.035, 0.1, 0.116, 0.004], [HY + 0.09, 0.093, 0.105, 0.006], [HY + 0.132, 0.055, 0.065, 0.01]], 8, T(HEAD, HAT, 0, 0, GORRA), { top: true });
  B.box(0.15, 0.012, 0.09, 0, HY + 0.042, -0.135, T(HEAD, HAT, 0, 0, GORRA), (v) => { if (v.z < 0) v.x *= 0.85; }, 0.12);
  B.loft([[0.84, 0.31, 0.195], [1.41, 0.31, 0.18], [1.48, 0.255, 0.152], [1.53, 0.085, 0.07]], 8, T(TORSO, RUANA, 0, 0, O_RUANA));
  B.box(0.27, 0.36, 0.13, 0, 1.2, 0.17, T(TORSO, PACK, 0, 0, MOCHILA));
  for (const s of [-1, 1]) B.box(0.035, 0.3, 0.012, s * 0.095, 1.27, -0.111, T(TORSO, PACK, 0, 0, MOCHILA), undefined, -0.08);
  B.loft([[0.55, 0.235, 0.19], [1.0, 0.166, 0.118]], 8, (v) => v[1] > 0.9 ? T(PELVIS, BOTTOM, 0, 0, FALDA) : T(LEG, BOTTOM, Math.sign(v[0]), 0, FALDA));
  B.box(0.18, 0.24, 0.06, 0, 1.5, 0.075, T(HEAD, HAIR, 0, 0, PELO_LARGO), (v) => { if (v.y < 0) v.x *= 1.15; });
  for (const y of [1.08, 1.28]) B.loft([torsoAt(y), torsoAt(y + 0.04)], 8, T(TORSO, REFLECT, 0, 0, CHALECO));
  return B.build();
}

// ---------------------------------------------------------------- aspecto (determinista por `look`)

const PIEL = ['#f0c9a8', '#e0b393', '#d6a27c', '#d6a27c', '#c98f68', '#c98f68', '#b97c56', '#b97c56', '#a86d48', '#94603f', '#7d4f33', '#5f3b27'];
const PELO = ['#141110', '#141110', '#1d1612', '#2a1c14', '#2a1c14', '#3e2a1c', '#5a2a1a'];
const CANAS = ['#8d8a86', '#b5b2ac', '#6f6b66'];
const CHAQUETA = ['#1f2a44', '#1c1c1e', '#55585e', '#4a5233', '#4a3226', '#6b1f2a', '#a3262a', '#c08a2a', '#1f5f66', '#3c5a80',
  '#e8e6e0', '#c9b79a', '#c66b84', '#7fa6c9', '#2f3a2c', '#7a7f87'];
const PANTALON = ['#2c3b55', '#34466a', '#1f2738', '#2c3b55', '#1a1a1c', '#a08c68', '#5c5f66', '#4d3b2c', '#3a3d44'];
const FALDA_C = ['#1a1a1c', '#1f2a44', '#5c5f66', '#6b1f2a', '#c9b79a', '#4a3226'];
const RUANA_C = ['#7a7570', '#5e4636', '#d8cdb5', '#3e3b3a', '#7a2525', '#2a3550', '#8a7a62', '#4b4f3c'];
const SOMBRERO_C = ['#d9ccb0', '#d9ccb0', '#2a2522', '#4b3b2e', '#e8e0cc'];
const GORRA_C = ['#a3262a', '#1f2a44', '#1c1c1e', '#e8e6e0', '#e8c21a', '#2e6b3a'];
const MOCHILA_C = ['#1c1c1e', '#1f2a44', '#55585e', '#a3262a', '#a08c68', '#1f5f66'];
const ZAPATO = ['#1b1a19', '#1b1a19', '#4a3324', '#e6e4df', '#6b6d70', '#2b2b33'];
const UNIFORME = ['#1d2a4d', '#5e1b24', '#1f4a33', '#1d2a4d'];
const CHALECO_C = ['#ff6a13', '#c8e62a', '#ff8c1a'];
/** Gestos de pie / sentado: 0 brazos sueltos, 1 cruzados, 2 atrás, 3 conversa, 4 celular, 5 manos en la cintura. */
const GESTO_P = [0.22, 0.14, 0.1, 0.3, 0.15, 0.09];

let rs = 0;
function rnd() {   // mulberry32 sin cierres (sin asignaciones)
  rs = (rs + 0x6d2b79f5) | 0;
  let t = Math.imul(rs ^ (rs >>> 15), 1 | rs);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (a: string[]) => parseInt(a[Math.floor(rnd() * a.length)].slice(1), 16);

export interface PedLook { colA: number[]; colB: number[]; girth: number; flags: number; seed: number; gesture: number }

/** Aspecto de un peatón (colores 0xRRGGBB sRGB, banderas de accesorios, complexión, gesto). Determinista. */
export function pedLook(look: number, height = 1, out: PedLook = { colA: [0, 0, 0, 0], colB: [0, 0, 0, 0], girth: 1, flags: 0, seed: 0, gesture: 0 }) {
  const a = Math.abs(look);
  rs = (Number.isInteger(a) ? a : Math.floor(a * 4294967296)) | 0;
  rs = Math.imul(rs ^ 0x9e3779b9, 0x85ebca6b);
  rnd(); rnd();
  const kid = height < 0.9;
  const old = !kid && rnd() < 0.16;
  const uniforme = kid ? rnd() < 0.7 : rnd() < 0.04;
  const obrero = !uniforme && rnd() < 0.06;
  const campesino = !uniforme && !obrero && rnd() < (old ? 0.3 : 0.08);
  let flags = 0;
  const skin = pick(PIEL), hair = old ? pick(CANAS) : pick(PELO);
  const falda = uniforme ? rnd() < 0.5 : !obrero && !campesino && rnd() < 0.15;
  if (falda) flags |= 1 << (FALDA - 1);
  if (falda ? rnd() < 0.85 : rnd() < 0.1) flags |= 1 << (PELO_LARGO - 1);
  let top = pick(CHAQUETA), bottom = falda ? pick(FALDA_C) : pick(PANTALON);
  if (uniforme) { top = pick(UNIFORME); bottom = falda ? parseInt('3a3f4f', 16) + Math.floor(rnd() * 3) * 0x050505 : parseInt('4a4d55', 16); }
  if (obrero) { top = pick(CHALECO_C); flags |= 1 << (CHALECO - 1); }
  if (campesino || (!uniforme && !obrero && rnd() < 0.07)) flags |= 1 << (O_RUANA - 1);
  if (campesino ? rnd() < 0.75 : !uniforme && rnd() < 0.04) flags |= 1 << (SOMBRERO - 1);
  else if (!falda && rnd() < (obrero ? 0.5 : 0.13)) flags |= 1 << (GORRA - 1);
  if (uniforme ? rnd() < 0.85 : rnd() < 0.18) flags |= 1 << (MOCHILA - 1);
  // medias con falda: 0 piel, 1 blancas hasta la rodilla, 2 pantimedias oscuras, 3 azules hasta la rodilla (uniformes)
  const media = uniforme ? (rnd() < 0.6 ? 1 : 3) : rnd() < 0.5 ? 0 : 2;
  flags |= media << 8;
  const sombrero = flags & (1 << (SOMBRERO - 1)) ? pick(SOMBRERO_C) : pick(GORRA_C);
  out.colA[0] = skin; out.colA[1] = hair; out.colA[2] = top; out.colA[3] = bottom;
  out.colB[0] = pick(ZAPATO); out.colB[1] = sombrero; out.colB[2] = pick(RUANA_C); out.colB[3] = pick(MOCHILA_C);
  out.girth = kid ? 0.9 + rnd() * 0.08 : 0.92 + rnd() * 0.24;
  out.flags = flags;
  out.seed = rnd();
  let r = rnd(), g = 0;
  while (g < GESTO_P.length - 1 && r > GESTO_P[g]) r -= GESTO_P[g++];
  out.gesture = g;
  return out;
}

// ---------------------------------------------------------------- shader (TSL)

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any;   // nodos TSL (los tipos de @types/three no siguen bien las mezclas float/vec)

const rotX = (v: N, a: N) => { const c = cos(a), s = sin(a); return vec3(v.x, v.y.mul(c).sub(v.z.mul(s)), v.y.mul(s).add(v.z.mul(c))); };
const rotY = (v: N, a: N) => { const c = cos(a), s = sin(a); return vec3(v.x.mul(c).add(v.z.mul(s)), v.y, v.z.mul(c).sub(v.x.mul(s))); };
const rotZ = (v: N, a: N) => { const c = cos(a), s = sin(a); return vec3(v.x.mul(c).sub(v.y.mul(s)), v.x.mul(s).add(v.y.mul(c)), v.z); };

/** pedFoot() de gait.ts en TSL: vec4(z, y, inclinación, apoyo 0/1). */
function footNode(u: N, beta: N, E: N, run: N) {
  const d = run.mul(0.05).add(0.05);
  const ps = float(1).sub(run).mul(0.2), pe = run.mul(0.25).add(0.7).negate();
  const tilt = (p: N) => {
    const k = select(p.greaterThanEqual(0), float(-HEEL), float(BALL));
    return vec2(cos(p).sub(1).mul(ANKLE_Y).sub(k.mul(sin(p))), sin(p).mul(ANKLE_Y).add(k.mul(cos(p).sub(1))));
  };
  // apoyo
  const xs = u.div(beta);
  const pS = ps.mul(float(1).sub(smoothstep(0, 0.15, xs))).add(pe.mul(smoothstep(0.5, 1, xs))).toVar();
  const tS = tilt(pS).toVar();
  const zS = E.mul(xs.sub(0.5)).add(d).add(tS.y);
  const yS = tS.x.add(ANKLE_Y);
  // vuelo
  const xw = u.sub(beta).div(float(1).sub(beta)).toVar();
  const te = tilt(pe).toVar(), ts = tilt(ps).toVar();
  const ze = E.mul(0.5).add(d).add(te.y), ye = te.x.add(ANKLE_Y);
  const zs = E.mul(-0.5).add(d).add(ts.y), ys = ts.x.add(ANKLE_Y);
  const m = float(1).sub(beta).div(beta).negate();
  const x2 = xw.mul(xw), x3 = x2.mul(xw);
  const h = m.mul(x3.mul(2).sub(x2.mul(3)).add(xw)).add(x2.mul(3)).sub(x3.mul(2));
  const sw = sin(xw.mul(Math.PI));
  const zW = ze.add(zs.sub(ze).mul(h));
  const yW = ye.add(ys.sub(ye).mul(smoothstep(0, 1, xw))).add(run.mul(0.21).add(0.07).mul(sw));
  const pW = pe.add(ps.sub(pe).mul(smoothstep(0, 0.7, xw))).add(float(1).sub(run).mul(0.12).mul(sw));
  const st = u.lessThan(beta);
  return vec4(select(st, zS, zW), select(st, yS, yW), select(st, pS, pW), select(st, float(1), float(0)));
}

/**
 * Brazos por gesto (flexión, abducción, rotación interna, codo; brazo derecho, el izquierdo en espejo); `sit` elige la
 * variante sentada. Valores ajustados con cinemática directa para que codo y mano lleguen a su sitio (sin atravesar el
 * cuerpo): 0 sueltos / manos en los muslos, 1 cruzados, 2 atrás / codos en las rodillas, 3 conversa (mano derecha
 * gesticula a ratos), 4 celular, 5 manos en la cintura o en los bolsillos / apoyadas en la banca.
 */
function gestureArm(g: N, side: N, c: N, seed: N, sit: boolean) {
  const right = step(0, side);                          // 1 brazo derecho
  const speak = smoothstep(0.3, 0.7, sin(c.mul(0.27).add(seed.mul(31))).mul(0.5).add(0.5));
  const relaxed = sit ? vec4(0.2, 0, 0.45, 0.9)
    : vec4(sin(c.mul(0.45).add(side.mul(1.3)).add(seed.mul(6))).mul(0.03).add(0.02), 0.08, 0.1, 0.18);
  const crossed = mix(vec4(0.25, -0.05, 1.4, 1.5), vec4(0.3, -0.1, 1.35, 1.55), right);
  const behind = sit ? vec4(0.8, -0.08, 0.3, 1.9) : vec4(-0.45, 0.1, 1.45, 0.95);
  const lift = speak.mul(sin(c.mul(1.9)).mul(0.35).add(0.65));
  const talkR = mix(vec4(0.15, 0.05, 0.3, 1.35), vec4(0.3, 0.1, 0.3, 1.95), lift).add(vec4(0, 0, sin(c.mul(2.7).add(1.3)).mul(0.25).mul(speak), 0));
  const talk = mix(relaxed, talkR, right);
  const oneHand = step(0.5, seed);
  const phone = mix(sit ? vec4(0.3, -0.1, 0.5, 1.2) : vec4(0.2, -0.1, 0.5, 1.6), relaxed, oneHand.mul(float(1).sub(right)));
  const hips = sit ? vec4(-0.15, 0.25, 1.0, 0.15) : mix(vec4(-0.25, 0.6, 1.2, 1.35), vec4(-0.2, 0.15, 0.7, 0.8), step(0.5, fract(seed.mul(7))));
  return select(g.lessThan(0.5), relaxed, select(g.lessThan(1.5), crossed, select(g.lessThan(2.5), behind,
    select(g.lessThan(3.5), talk, select(g.lessThan(4.5), phone, hips)))));
}

const srgb = (hex: string) => { const c = new THREE.Color(hex); return vec3(c.r, c.g, c.b); };

function pedMaterial() {
  const bone = attribute('aBone', 'vec4') as N, opt: N = floor(bone.z.div(4));
  const R = attribute('iRoot', 'vec4') as N, A = attribute('iAnim', 'vec4') as N, Q = attribute('iPose', 'vec4') as N;
  const L = attribute('iLook', 'vec4') as N, CA = attribute('iColA', 'vec4') as N, CB = attribute('iColB', 'vec4') as N;
  // banderas enteras: +0,5 antes de dividir para que un exp2/división inexacta en la GPU no cambie el bit
  const bit = (k: number) => mod(floor(L.z.add(0.5).div(2 ** k)), 2);

  const position = Fn(() => {
    const chain = bone.x, side = bone.y, seg = mod(bone.z, 4);
    const isLeg = step(3.5, chain), isArm = step(2.5, chain).sub(isLeg), isHead = step(1.5, chain).sub(step(2.5, chain));
    const isUpper = step(0.5, chain).sub(isLeg), isBody = float(1).sub(step(1.5, chain));
    const seg1 = step(0.5, seg), seg2 = step(1.5, seg);
    const s = L.x, g = L.y, seed = L.w;
    // accesorio ausente: sus vértices se colapsan en un punto (después de los huesos: la falda usa pelvis y muslos)
    const vis = max(float(1).sub(step(0.5, opt)), mod(floor(L.z.add(0.5).div(exp2(max(opt.sub(1), 0)))), 2));
    const gx = mix(float(1), g, isBody);
    const shift = side.mul(g.sub(1)).mul(isArm.mul(SHO_X).add(isLeg.mul(HIP_X)));
    // ruedo de la falda (va con los muslos): sentado se ciñe para no atravesar la banca
    const hem: N = step(4.5, opt).mul(step(opt, 5.5)).mul(isLeg).mul(Q.x).mul(0.5);
    const rest = vec3(positionGeometry.x.mul(gx).add(shift), positionGeometry.y, positionGeometry.z.mul(gx).mul(float(1).sub(hem)));
    // los niños (estatura baja) tienen la cabeza proporcionalmente más grande
    const headK = clamp(float(1).div(L.x.max(0.5)).sub(1).mul(0.7).add(1), 0.97, 1.25);
    const neck0 = vec3(0, NECK_Y, 0);
    const p0 = mix(rest, rest.sub(neck0).mul(headK).add(neck0), isHead).toVar();

    // estado
    const phase = A.x, speed = A.y, run = A.z, c = A.w;
    const sit = Q.x, fall = Q.y, seat = Q.z;
    const code = floor(Q.w), gw = fract(Q.w).div(0.999), wait = step(7.5, code), gid = code.sub(wait.mul(8));
    const ruana = bit(O_RUANA - 1);
    const w = smoothstep(0.05, 0.45, speed).mul(float(1).sub(sit)).mul(float(1).sub(fall)).toVar();

    // marcha: tobillos de las dos piernas (la altura de la cadera depende de ambas)
    const stride = min(speed.mul(0.58).add(0.62), speed.mul(0.45).add(0.9));
    const beta = mix(float(0.6), float(0.38), run), E = beta.mul(stride).toVar();
    const uL = fract(phase.div(Math.PI * 2)).toVar(), uR = fract(uL.add(0.5)).toVar();
    const fL = footNode(uL, beta, E, run).toVar(), fR = footNode(uR, beta, E, run).toVar();
    const Lr = mix(float(0.805), float(0.75), run), Hmid = Lr.add(ANKLE_Y);
    const reach = (f: N) => f.y.add(sqrt(max(Lr.mul(Lr).sub(f.x.mul(f.x)), 0.0001)));
    const hs = min(select(fL.w.greaterThan(0.5), reach(fL), float(9)), select(fR.w.greaterThan(0.5), reach(fR), float(9)));
    const Hwalk = select(hs.greaterThan(8), Hmid.add(run.mul(0.03)), clamp(hs, Hmid.sub(mix(float(0.05), float(0.06), run)), Hmid));
    const f = select(side.greaterThan(0), fR, fL);
    const half = E.mul(0.5).add(0.001);
    const eL: N = clamp(fL.x.div(half), -1.2, 1.2), eR: N = clamp(fR.x.div(half), -1.2, 1.2), e: N = select(side.greaterThan(0), eR, eL);

    // pelvis (desplazamiento en el marco del suelo) y objetivos de los tobillos
    const hipX = side.mul(HIP_X).mul(g);
    const sway = cos(uL.sub(beta.mul(0.5)).mul(Math.PI * 2)).mul(mix(float(-0.02), float(-0.01), run));
    const shiftI = sin(c.mul(0.31).add(seed.mul(40))).mul(0.022).mul(gw);
    const Ow = vec3(sway, Hwalk.sub(HIP_Y), 0), Os = vec3(shiftI, -0.007, 0), Ot = vec3(0, seat.add(0.09 - HIP_Y), 0.03);
    const O = mix(mix(Os, Ow, w), Ot, sit).toVar();
    const Tw = vec3(hipX.add(side.mul(0.01)), f.y, f.x);
    const Ts = vec3(hipX.add(side.mul(0.025)), ANKLE_Y, side.mul(seed.sub(0.5)).mul(0.12));
    const low = float(1).sub(clamp(seat.div(0.46), 0, 1));
    const Tt = vec3(hipX.add(side.mul(seed.mul(0.05).add(0.04))), ANKLE_Y, low.mul(0.25).add(0.4).add(side.mul(seed.sub(0.5)).mul(0.08)).negate());
    // en el suelo (marco del cuerpo): una rodilla doblada (boca arriba), la otra estirada
    const dir = select(seed.lessThan(0.3), float(-1), float(1));
    const bent = select(side.mul(seed.sub(0.5)).greaterThan(0), float(1), float(0)).mul(step(0, dir));
    const Tf = mix(vec3(hipX.add(side.mul(0.13)), 0.09, 0.0), vec3(hipX.add(side.mul(0.05)), 0.42, -0.1), bent);
    const Tg = mix(mix(Ts, Tw, w), Tt, sit);
    const Tl = mix(Tg.sub(O), Tf, fall).toVar();
    O.assign(O.mul(float(1).sub(fall)));
    const pitch = mix(f.z.mul(w), float(0), sit);

    // IK de dos huesos (plano de la pierna girado por la abducción rho)
    const hip = vec3(hipX, HIP_Y, 0);
    const dv = Tl.sub(hip).toVar();
    const rho = atan(dv.x, dv.y.negate());
    const thT = atan(dv.z.negate(), sqrt(dv.x.mul(dv.x).add(dv.y.mul(dv.y))));
    const D = clamp(length(dv), 0.1, THIGH + SHIN - 0.002);
    const alpha = acos(clamp(D.mul(D).add(THIGH * THIGH - SHIN * SHIN).div(D.mul(2 * THIGH)), -1, 1));
    const knee = acos(clamp(float(THIGH * THIGH + SHIN * SHIN).sub(D.mul(D)).div(2 * THIGH * SHIN), -1, 1)).sub(Math.PI);
    const th1 = thT.add(alpha).toVar();
    const footRel = mix(pitch.sub(th1.add(knee)), float(-0.45), fall);

    // brazos (del lado del vértice)
    // con ruana los brazos van por dentro, casi sin balanceo (asoman las manos bajo el borde)
    const armAmp = run.mul(0.3).add(0.42).mul(seed.mul(0.3).add(0.85));
    const armW = mix(vec4(e.mul(armAmp).add(run.mul(0.12)).add(0.04), run.mul(0.05).add(0.07), run.mul(0.25),
      max(e, 0).mul(0.2).add(0.15).add(run.mul(1.35))), vec4(e.mul(0.05).add(0.04), 0.03, 0.3, run.mul(0.5).add(0.4)), ruana);
    const armS = gestureArm(gid, side, c, seed, false), armT = gestureArm(gid, side, c, seed, true);
    const armF = vec4(side.mul(seed.sub(0.5)).mul(0.6).add(0.25), 1.15, 0, 0.45);
    const arm = mix(mix(mix(vec4(0.02, 0.08, 0.1, 0.18), armW, w), armS, gw.mul(float(1).sub(w))), armT, sit).toVar();
    arm.assign(mix(arm, armF, fall));

    // tronco y cabeza
    const leanT = select(gid.lessThan(1.5), float(0.08), select(gid.lessThan(2.5), float(0.5), select(gid.lessThan(3.5), float(0.1),
      select(gid.lessThan(4.5), float(0.22), float(-0.08)))));
    const lean = mix(mix(sin(c.mul(1.4)).mul(0.012), run.mul(0.2).add(0.04), w), leanT, sit).mul(float(1).sub(fall)).toVar();
    const twist = eR.sub(eL).mul(0.045).mul(run.add(1)).mul(w);
    const look = sin(c.mul(0.17).add(seed.mul(9))).mul(0.4).add(sin(c.mul(0.53).add(seed.mul(4))).mul(0.15));
    const glance = smoothstep(0.7, 0.95, sin(c.mul(0.29).add(seed.mul(17)))).sub(smoothstep(0.7, 0.95, sin(c.mul(0.23).add(seed.mul(29))))).mul(0.35);
    const yawS = mix(look, sin(c.mul(0.45).add(seed.mul(5))).mul(0.8), wait);
    const isPhone = step(3.5, gid).mul(step(gid, 4.5));
    const nod = step(2.5, gid).mul(step(gid, 3.5)).mul(sin(c.mul(2.2)).mul(0.04));
    const hYaw = mix(mix(glance, yawS, gw), dir.mul(seed.sub(0.5)).mul(0.8), fall).mul(float(1).sub(isPhone.mul(0.7).mul(gw)));
    const hPitch = mix(lean.mul(-0.6).add(0.04), isPhone.mul(0.5).add(nod).add(0.03), gw.add(sit).min(1)).mul(float(1).sub(fall));

    // cadena: pie → rodilla → cadera; codo → hombro; cabeza → tronco; pelvis; caída; escala, rumbo, mundo
    const ank = vec3(hipX, ANKLE_Y, 0), kne = vec3(hipX, KNEE_Y, 0);
    const sho = vec3(side.mul(SHO_X).mul(g), SHO_Y, 0), elb = vec3(side.mul(SHO_X).mul(g), ELB_Y, 0);
    const neck = vec3(0, NECK_Y, 0), waist = vec3(0, WAIST_Y, 0);
    const p = p0.toVar(), n = normalGeometry.toVar();
    const step3 = (mask: N, pivot: N, fn: (v: N) => N) => {
      p.assign(mix(p, fn(p.sub(pivot)).add(pivot), mask));
      n.assign(mix(n, fn(n), mask));
    };
    step3(isLeg.mul(seg2), ank, (v) => rotX(v, footRel));
    step3(isLeg.mul(seg1), kne, (v) => rotX(v, knee));
    step3(isLeg, hip, (v) => rotZ(rotX(v, th1), rho));
    step3(isArm.mul(seg1), elb, (v) => rotX(v, arm.w));
    step3(isArm, sho, (v) => rotZ(rotX(rotY(v, side.mul(arm.z)), arm.x), side.mul(arm.y)));
    step3(isHead, neck, (v) => rotX(rotY(v, hYaw), hPitch.negate()));
    step3(isUpper, waist, (v) => rotY(rotX(v, lean.negate()), twist));
    p.assign(mix(vec3(0, 1.2, 0), p, vis).add(O));
    const a = dir.mul(fall).mul(Math.PI / 2);
    step3(float(1), vec3(0, HIP_Y, 0), (v) => rotX(v, a));
    p.assign(p.sub(vec3(0, fall.mul(HIP_Y - 0.12), 0)));
    normalLocal.assign(normalize(rotY(n, R.w)));
    return rotY(p.mul(s), R.w).add(R.xyz);
  })();

  // color: ranura del vértice → color empaquetado de la instancia (sRGB 8 bits) → lineal
  const slot = bone.w;
  const packed = select(slot.lessThan(0.5), CA.x, select(slot.lessThan(1.5), CA.y, select(slot.lessThan(2.5), CA.z,
    select(slot.lessThan(3.5), CA.w, select(slot.lessThan(4.5), CB.x, select(slot.lessThan(5.5), CB.y,
      select(slot.lessThan(6.5), CB.z, CB.w)))))));
  const unpack = (v: N) => pow(vec3(floor(v.div(65536)), mod(floor(v.div(256)), 256), mod(v, 256)).div(255), vec3(2.2));
  const media = mod(floor(L.z.add(0.5).div(256)), 4), tights = srgb('#25222a');
  const shin = select(media.lessThan(0.5), unpack(CA.x), select(media.lessThan(1.5), srgb('#e9e6df'), select(media.lessThan(2.5), tights, srgb('#1e2740'))));
  const thigh = select(media.greaterThan(1.5).and(media.lessThan(2.5)), tights, unpack(CA.x));
  const leg = select(bit(FALDA - 1).lessThan(0.5), unpack(CA.w), select(slot.lessThan(10.5), shin, thigh));
  const color = select(slot.lessThan(7.5), unpack(packed), select(slot.lessThan(8.5), srgb('#191311'),
    select(slot.lessThan(9.5), srgb('#d9dcd8'), leg)));

  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
  mat.positionNode = position;
  mat.colorNode = varying(color);
  return mat;
}

// ---------------------------------------------------------------- vista

const POSES: PedPose[] = ['walk', 'idle', 'wait', 'sit', 'run', 'fallen'];
const P_SIT = 3, P_FALLEN = 5;
const TAU = Math.PI * 2;
const smooth01 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

export interface PedViewOptions {
  /** Proyecta sombra (por defecto sí). */
  castShadow?: boolean;
  /** Recibe sombra (por defecto sí). */
  receiveShadow?: boolean;
}

/**
 * Dibujo de los peatones de la simulación. `peds` es el arreglo vivo de la simulación (se lee en cada update);
 * `maxCount` = capacidad (por defecto peds.length): el peatón i usa la instancia i, los de índice ≥ maxCount no se dibujan.
 */
export class PedView {
  readonly group = new THREE.Group();
  readonly mesh: THREE.InstancedMesh;
  /** Triángulos del modelo (con todos los accesorios; los ausentes se colapsan en el shader). */
  readonly triangles: number;
  private readonly cap: number;
  /** Estado por instancia (iRoot, iAnim, iPose) y aspecto (iLook, iColA, iColB): 12 floats por peatón cada uno. */
  private readonly state: THREE.InstancedInterleavedBuffer;
  private readonly lookBuf: THREE.InstancedInterleavedBuffer;
  // por instancia: aspecto vigente, postura y mezcla de posturas (sentado, caído, gesto), reloj interpolado
  private readonly lookKey: Float64Array; private readonly heightKey: Float64Array; private readonly shown: Uint8Array;
  private readonly gesture: Uint8Array; private readonly poseCode: Int8Array;
  private readonly wFrom: Float32Array; private readonly wCur: Float32Array;
  private readonly ptLast: Float64Array; private readonly ptPrev: Float64Array;
  private readonly tmpLook: PedLook = { colA: [0, 0, 0, 0], colB: [0, 0, 0, 0], girth: 1, flags: 0, seed: 0, gesture: 0 };

  constructor(private readonly peds: Ped[], maxCount = peds.length, opts: PedViewOptions = {}) {
    this.group.name = 'peatones';
    const cap = this.cap = Math.max(1, maxCount);
    const geo = buildPedGeometry();
    this.triangles = geo.index!.count / 3;
    const interleaved = (names: string[], usage: THREE.Usage) => {
      const buf = new THREE.InstancedInterleavedBuffer(new Float32Array(cap * 12), 12, 1).setUsage(usage);
      names.forEach((n, k) => geo.setAttribute(n, new THREE.InterleavedBufferAttribute(buf, 4, k * 4)));
      return buf;
    };
    this.state = interleaved(['iRoot', 'iAnim', 'iPose'], THREE.DynamicDrawUsage);
    this.lookBuf = interleaved(['iLook', 'iColA', 'iColB'], THREE.StaticDrawUsage);
    this.mesh = new THREE.InstancedMesh(geo, pedMaterial(), cap);
    this.mesh.name = 'peatones';
    this.mesh.castShadow = opts.castShadow ?? true;
    this.mesh.receiveShadow = opts.receiveShadow ?? true;
    // la matriz de instancia queda en identidad (la posición va en iRoot). Esfera de recorte: la fija update() con los
    // activos; hasta entonces lo cubre todo (así el precompilado de main.ts, compileAsync, no lo descarta)
    this.mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.mesh.count = 0;
    this.group.add(this.mesh);
    this.lookKey = new Float64Array(cap).fill(NaN); this.heightKey = new Float64Array(cap);
    this.shown = new Uint8Array(cap); this.gesture = new Uint8Array(cap); this.poseCode = new Int8Array(cap).fill(-1);
    this.wFrom = new Float32Array(cap * 3); this.wCur = new Float32Array(cap * 3);
    this.ptLast = new Float64Array(cap); this.ptPrev = new Float64Array(cap);
  }

  private writeLook(i: number, p: Ped) {
    const lk = pedLook(p.look, p.height, this.tmpLook);
    const L = this.lookBuf.array as Float32Array, j = i * 12;
    L[j] = p.height; L[j + 1] = lk.girth; L[j + 2] = lk.flags; L[j + 3] = lk.seed;
    for (let k = 0; k < 4; k++) { L[j + 4 + k] = lk.colA[k]; L[j + 8 + k] = lk.colB[k]; }
    this.gesture[i] = lk.gesture;
    this.lookKey[i] = p.look; this.heightKey[i] = p.height;
    // reaparece: sin mezcla desde la postura anterior
    const code = POSES.indexOf(p.pose);
    this.poseCode[i] = code;
    const w = this.wCur, i3 = i * 3;
    w[i3] = code === P_SIT ? 1 : 0; w[i3 + 1] = code === P_FALLEN ? 1 : 0; w[i3 + 2] = code === 1 || code === 2 || code === P_SIT ? 1 : 0;
    this.wFrom[i3] = w[i3]; this.wFrom[i3 + 1] = w[i3 + 1]; this.wFrom[i3 + 2] = w[i3 + 2];
    this.ptLast[i] = this.ptPrev[i] = p.poseTime;
  }

  /** t ∈ [0, 1]: interpolación entre el paso anterior y el actual de la simulación (como TrafficView.update). */
  update(t: number) {
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const P = this.peds, n = Math.min(P.length, this.cap);
    const S = this.state.array as Float32Array, Lk = this.lookBuf.array as Float32Array, Wf = this.wFrom, Wc = this.wCur;
    let last = -1, lookDirty = false;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const p = P[i], j = i * 12, i3 = i * 3;
      if (!p.active) {
        if (this.shown[i]) { this.shown[i] = 0; Lk[j] = 0; lookDirty = true; }
        continue;
      }
      if (!this.shown[i] || p.look !== this.lookKey[i] || p.height !== this.heightKey[i]) {
        this.writeLook(i, p);
        this.shown[i] = 1;
        lookDirty = true;
      }
      // reloj de la postura interpolado (poseTime avanza por pasos de la simulación)
      const pt = p.poseTime;
      if (pt !== this.ptLast[i]) { this.ptPrev[i] = pt > this.ptLast[i] && pt - this.ptLast[i] < 1 ? this.ptLast[i] : pt; this.ptLast[i] = pt; }
      const clock = this.ptPrev[i] + (pt - this.ptPrev[i]) * t;
      // mezcla de posturas: desde la mezcla vigente al cambiar, hacia la nueva, con el tiempo en la postura
      let code = 0;
      while (code < 5 && POSES[code] !== p.pose) code++;
      if (code !== this.poseCode[i]) { this.poseCode[i] = code; Wf[i3] = Wc[i3]; Wf[i3 + 1] = Wc[i3 + 1]; Wf[i3 + 2] = Wc[i3 + 2]; }
      const dur = code === P_FALLEN ? 0.35 : Wf[i3 + 1] > 0.5 ? 1.0 : code === P_SIT || Wf[i3] > 0.5 ? 0.8 : 0.5;
      const k = smooth01(clock / dur);
      const sitT = code === P_SIT ? 1 : 0, fallT = code === P_FALLEN ? 1 : 0, gestT = code === 1 || code === 2 || code === P_SIT ? 1 : 0;
      const sit = (Wc[i3] = Wf[i3] + (sitT - Wf[i3]) * k);
      const fall = (Wc[i3 + 1] = Wf[i3 + 1] + (fallT - Wf[i3 + 1]) * k);
      const gest = (Wc[i3 + 2] = Wf[i3 + 2] + (gestT - Wf[i3 + 2]) * k);
      // posición, rumbo y fase interpolados (la fase retrocede lo que avanzó en el paso: d · rad/m)
      const x = p.px + (p.x - p.px) * t, y = p.py + (p.y - p.py) * t, z = p.pz + (p.z - p.pz) * t;
      let dh = p.heading - p.pheading;
      dh -= TAU * Math.round(dh / TAU);
      const dx = p.x - p.px, dz = p.z - p.pz, dist = Math.sqrt(dx * dx + dz * dz);
      let ph = p.phase - (dist < 2.5 ? (1 - t) * dist * pedPhasePerMetre(p.speed, p.height) : 0);
      ph -= TAU * Math.floor(ph / TAU);
      S[j] = x; S[j + 1] = y; S[j + 2] = z; S[j + 3] = p.pheading + dh * t;
      S[j + 4] = ph; S[j + 5] = p.speed; S[j + 6] = pedRunBlend(p.speed, code === 4); S[j + 7] = clock;
      let g = this.gesture[i];
      if (code === 2 && g === 3) g = 0;   // esperando el cruce no conversa solo
      S[j + 8] = sit; S[j + 9] = fall; S[j + 10] = p.seatH / (p.height || 1);
      S[j + 11] = g + (code === 2 ? 8 : 0) + Math.min(gest, 1) * 0.999;
      last = i;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    this.mesh.count = last + 1;
    this.mesh.visible = last >= 0;
    if (last >= 0) {
      const bs = this.mesh.boundingSphere!;
      bs.center.set((x0 + x1) / 2, (y0 + y1) / 2 + 0.9, (z0 + z1) / 2);
      bs.radius = Math.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2 + (z1 - z0) ** 2) / 2 + 2.5;
      this.state.needsUpdate = true;
    }
    if (lookDirty) this.lookBuf.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
