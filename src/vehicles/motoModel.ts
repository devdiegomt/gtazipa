import * as THREE from 'three/webgpu';
import { uv, float, fract, step, abs, vec3, max } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import vcfg from '../data/vehicles.json';
import { envTexture } from '../world/env';

const C = vcfg.moto;
const S = vcfg.moto.spec;
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Mueve los hijos de `group` a `parent` conservando su transformación (el grupo debe ser estático). */
function flatten(group: THREE.Object3D, parent: THREE.Object3D) {
  group.updateMatrix();
  for (const c of [...group.children]) {
    c.applyMatrix4(group.matrix);
    parent.add(c);
  }
  parent.remove(group);
}

/** Une los hijos directos (mallas sin hijos) de un grupo que comparten material en una sola malla. */
function mergeByMaterial(group: THREE.Object3D) {
  const buckets = new Map<THREE.Material, THREE.Mesh[]>();
  for (const c of group.children) {
    const m = c as THREE.Mesh;
    if (!m.isMesh || m.children.length || Array.isArray(m.material)) continue;
    const mat = m.material as THREE.Material;
    if (!buckets.has(mat)) buckets.set(mat, []);
    buckets.get(mat)!.push(m);
  }
  for (const [mat, meshes] of buckets) {
    if (meshes.length < 2) continue;
    const geos = meshes.map((m) => {
      m.updateMatrix();
      let g = m.geometry.clone().applyMatrix4(m.matrix);
      if (g.index) g = g.toNonIndexed();
      for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
      if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
      return g;
    });
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    for (const m of meshes) group.remove(m);
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
}

/**
 * Moto de calle 125 cc (proporciones de una Honda CB125F: entre ejes 1,28 m, ruedas de 18", sillín a 0,79 m).
 * Ejes: adelante = -Z, arriba = +Y. Origen en el suelo, a mitad de la distancia entre ejes.
 */
export class MotoModel {
  readonly root = new THREE.Group();
  /** Gira alrededor de la línea de contacto con el suelo (inclinación). */
  readonly lean = new THREE.Group();
  /** Cuerpo suspendido: cabecea con la transferencia de carga. */
  private body = new THREE.Group();
  private steer = new THREE.Group();
  private frontWheel = new THREE.Group();
  private rearWheel = new THREE.Group();
  private sideStand = new THREE.Group();
  private dash: { canvas: HTMLCanvasElement; tex: THREE.CanvasTexture; last: string };
  /** Anclajes para el jinete (IK). */
  readonly anchors = {
    hips: new THREE.Object3D(), pegL: new THREE.Object3D(), pegR: new THREE.Object3D(),
    gripL: new THREE.Object3D(), gripR: new THREE.Object3D(), footDown: new THREE.Object3D(),
  };
  readonly R = S.wheelRadius;

  constructor() {
    const col = C.colors;
    const env = envTexture();
    // MeshStandard (con reflejos del entorno) para casi todo; MeshPhysical (barniz) sólo para la pintura.
    const std = (color: string, roughness: number, metalness = 0, extra: Partial<THREE.MeshPhysicalMaterial> = {}) =>
      'clearcoat' in extra
        ? new THREE.MeshPhysicalMaterial({ color, roughness, metalness, envMap: env, envMapIntensity: 1, ...extra })
        : new THREE.MeshStandardMaterial({ color, roughness, metalness, envMap: env, envMapIntensity: 1,
          ...(extra as Partial<THREE.MeshStandardMaterial>) });
    const M = {
      paint: std(col.paint, 0.32, 0.25, { clearcoat: 1, clearcoatRoughness: 0.06 }),
      paint2: std(col.paint2, 0.4, 0.2, { clearcoat: 1, clearcoatRoughness: 0.1 }),
      frame: std(col.frame, 0.5, 0.35),
      plastic: std('#18191b', 0.55, 0),
      chrome: std(col.chrome, 0.1, 1),
      alu: std(col.engine, 0.32, 0.85),
      engineDark: std(col.engineDark, 0.5, 0.6),
      seat: std(col.seat, 0.72, 0),
      rubber: std('#202020', 0.85, 0),
      tail: std('#7a0d0d', 0.2, 0, { emissive: new THREE.Color('#ff2a1f'), emissiveIntensity: 0.6 }),
      amber: std('#d98a17', 0.2, 0, { emissive: new THREE.Color('#ff9a1f'), emissiveIntensity: 0.15 }),
      lens: std('#f4f2ea', 0.05, 0, { emissive: new THREE.Color('#fff6dd'), emissiveIntensity: 0.9 }),
      glass: std('#9aa9b5', 0.05, 0.6),
    };
    const add = (parent: THREE.Object3D, geo: THREE.BufferGeometry, m: THREE.Material, p = V(0, 0, 0), r = V(0, 0, 0)) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.copy(p);
      mesh.rotation.set(r.x, r.y, r.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };
    const tube = (parent: THREE.Object3D, pts: THREE.Vector3[], r: number, m: THREE.Material, seg = 24, closed = false) =>
      add(parent, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, closed, 'centripetal'), seg, r, 8, closed), m);
    /** Viga de sección rectangular entre a y b. */
    const beam = (parent: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3, w: number, h: number, m: THREE.Material) => {
      const len = a.distanceTo(b);
      const mesh = add(parent, new THREE.BoxGeometry(w, h, len), m);
      mesh.position.copy(a).add(b).multiplyScalar(0.5);
      mesh.lookAt(mesh.position.clone().add(b.clone().sub(a)));
      parent.add(mesh);
      mesh.updateMatrix();
      return mesh;
    };
    /** Cilindro entre a y b. */
    const rod = (parent: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3, r: number, m: THREE.Material, r2 = r) => {
      const mesh = add(parent, new THREE.CylinderGeometry(r2, r, a.distanceTo(b), 14), m);
      mesh.position.copy(a).add(b).multiplyScalar(0.5);
      mesh.quaternion.setFromUnitVectors(V(0, 1, 0), b.clone().sub(a).normalize());
      return mesh;
    };
    /** Perfil 2D en el plano (z, y) extruido simétricamente en x. */
    const sideExtrude = (pts: [number, number][], width: number, bevel: number, m: THREE.Material, parent: THREE.Object3D,
      shapeX?: (x: number, y: number, z: number) => number) => {
      const shape = new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y)));
      const geo = new THREE.ExtrudeGeometry(shape, { depth: width - 2 * bevel, bevelEnabled: true, bevelThickness: bevel,
        bevelSize: bevel, bevelSegments: 4, curveSegments: 16 });
      geo.translate(0, 0, -(width - 2 * bevel) / 2);
      geo.rotateY(-Math.PI / 2);   // shape.x → z, profundidad → x
      const p = geo.getAttribute('position');
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        p.setXYZ(i, shapeX ? shapeX(x, y, z) : x, y, z);
      }
      geo.computeVertexNormals();
      return add(parent, geo, m);
    };

    this.root.rotation.order = 'YXZ';
    this.root.add(this.lean);
    this.lean.add(this.body);
    const R = this.R;
    const half = S.wheelbase / 2;

    // ------------------------------------------------ ruedas (llanta 18", neumático redondeado con labrado)
    const tireGeo = (w: number) => {  // perfil redondeado del neumático
      const prof: THREE.Vector2[] = [];
      const rim = 0.232;
      for (let i = 0; i <= 16; i++) {
        const a = -Math.PI / 2 + (Math.PI * i) / 16;
        const x = Math.sin(a) * w / 2;
        const r = rim + (R - rim) * (0.55 + 0.45 * Math.cos(a)) + 0.012 * Math.cos(a);
        prof.push(new THREE.Vector2(Math.min(r, R), x));
      }
      const g = new THREE.LatheGeometry(prof, 64);
      g.rotateZ(Math.PI / 2);
      return g;
    };
    const tireMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
    {
      const u = uv().x, v = uv().y;
      const groove = step(0.82, fract(u.mul(72).add(abs(v.sub(0.5)).mul(5))));
      const tread = step(0.22, v).mul(step(v, 0.78));
      const center = step(abs(v.sub(0.5)), 0.04);
      tireMat.colorNode = vec3(0.075).mul(float(1).sub(max(groove.mul(tread), center).mul(0.45)));
    }
    const wheel = (group: THREE.Group, front: boolean) => {
      add(group, tireGeo(front ? 0.085 : 0.095), tireMat);
      // llanta (canal) negra con borde mecanizado
      const rimProf = [[0.212, -0.04], [0.236, -0.042], [0.236, -0.03], [0.218, -0.026], [0.218, 0.026], [0.236, 0.03], [0.236, 0.042], [0.212, 0.04]]
        .map(([r, x]) => new THREE.Vector2(r, x));
      const rg = new THREE.LatheGeometry(rimProf, 48);
      rg.rotateZ(Math.PI / 2);
      add(group, rg, std('#1c1c1e', 0.35, 0.7));
      add(group, new THREE.CylinderGeometry(0.05, 0.05, 0.12, 16), M.alu, V(0, 0, 0), V(0, 0, Math.PI / 2));
      // 5 radios dobles (llanta de aleación)
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2;
        for (const da of [-0.13, 0.13]) {
          const b = add(group, new THREE.BoxGeometry(0.018, 0.17, 0.028), std('#1c1c1e', 0.35, 0.7));
          b.geometry.translate(0, 0.125, 0);
          b.rotation.set(a + da * 0.6, 0, 0);
          b.position.x = da * 0.1;
        }
      }
      if (front) {
        // disco perforado (lado izquierdo) + pinza
        const disc = add(group, new THREE.RingGeometry(0.06, 0.13, 40), std('#a7abb0', 0.3, 0.95, { side: THREE.DoubleSide }),
          V(-0.062, 0, 0), V(0, -Math.PI / 2, 0));
        disc.castShadow = false;
      } else {
        add(group, new THREE.CylinderGeometry(0.075, 0.075, 0.05, 24), M.alu, V(0.055, 0, 0), V(0, 0, Math.PI / 2)); // tambor
        // piñón de 40 dientes (lado izquierdo)
        const spr = new THREE.CylinderGeometry(0.11, 0.11, 0.008, 40);
        add(group, spr, std('#2a2a2c', 0.5, 0.8), V(-0.085, 0, 0), V(0, 0, Math.PI / 2));
      }
    };
    this.rearWheel.position.set(0, R, half);
    wheel(this.rearWheel, false);
    this.lean.add(this.rearWheel);

    // ------------------------------------------------ chasis (cuna de acero), basculante, amortiguadores
    const b = this.body;
    for (const sx of [-0.06, 0.06]) {
      tube(b, [V(sx * 0.5, 0.86, -0.36), V(sx, 0.84, -0.12), V(sx * 1.6, 0.72, 0.1), V(sx * 1.8, 0.44, 0.16)], 0.022, M.frame);
    }
    tube(b, [V(0, 0.8, -0.4), V(0, 0.58, -0.36), V(0, 0.36, -0.3)], 0.024, M.frame);
    for (const sx of [-0.1, 0.1]) {
      tube(b, [V(sx, 0.74, 0.06), V(sx, 0.77, 0.35), V(sx * 0.9, 0.8, 0.66)], 0.014, M.frame);
      tube(b, [V(sx, 0.46, 0.18), V(sx, 0.62, 0.3), V(sx * 0.95, 0.77, 0.4)], 0.013, M.frame);
    }
    rod(b, V(-0.12, 0.42, 0.16), V(0.12, 0.42, 0.16), 0.018, M.alu);          // eje del basculante
    for (const sx of [-0.105, 0.105]) beam(this.lean, V(sx, 0.42, 0.16), V(sx, R, half), 0.03, 0.055, M.frame);
    beam(this.lean, V(-0.105, 0.4, 0.3), V(0.105, 0.4, 0.3), 0.03, 0.04, M.frame);
    for (const sx of [-0.12, 0.12]) {
      const lo = V(sx, 0.36, 0.56), hi = V(sx, 0.77, 0.4);
      rod(this.lean, lo, hi, 0.016, M.chrome);
      rod(this.lean, lo.clone().lerp(hi, 0.55), hi, 0.026, M.plastic);
      // resorte helicoidal
      const axis = hi.clone().sub(lo);
      const len = axis.length();
      axis.normalize();
      const perp1 = V(1, 0, 0).cross(axis).normalize(), perp2 = axis.clone().cross(perp1);
      const coil: THREE.Vector3[] = [];
      for (let i = 0; i <= 120; i++) {
        const t = i / 120, a = t * Math.PI * 2 * 9;
        coil.push(lo.clone().addScaledVector(axis, 0.04 + t * (len * 0.6)).addScaledVector(perp1, Math.cos(a) * 0.03).addScaledVector(perp2, Math.sin(a) * 0.03));
      }
      add(this.lean, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(coil), 240, 0.006, 5), std('#1b1b1d', 0.4, 0.6));
    }
    // cadena (lado izquierdo): piñón de salida ↔ corona trasera
    {
      const x = -0.085, fc = V(x, 0.4, 0.12), rc = V(x, R, half), rf = 0.045, rr = 0.11;
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 12; i++) { const a = Math.PI / 2 + (Math.PI * i) / 12; pts.push(V(x, fc.y + Math.sin(a) * rf, fc.z - Math.cos(a) * rf * -1)); }
      for (let i = 0; i <= 16; i++) { const a = -Math.PI / 2 + (Math.PI * i) / 16; pts.push(V(x, rc.y + Math.sin(a) * rr, rc.z + Math.cos(a) * rr)); }
      add(this.lean, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 120, 0.007, 4, true), std('#2e2b28', 0.6, 0.7));
      beam(this.lean, V(x - 0.012, 0.47, 0.2), V(x - 0.012, R + 0.13, half - 0.05), 0.004, 0.05, M.plastic); // guardacadena
    }

    // ------------------------------------------------ motor monocilíndrico enfriado por aire
    const crank: [number, number][] = [[-0.3, 0.26], [-0.18, 0.2], [0.04, 0.2], [0.16, 0.28], [0.18, 0.42], [0.1, 0.52], [-0.12, 0.54], [-0.27, 0.46]];
    sideExtrude(crank, 0.26, 0.025, M.alu, b);
    add(b, new THREE.CylinderGeometry(0.105, 0.105, 0.03, 32), M.alu, V(0.14, 0.36, -0.08), V(0, 0, Math.PI / 2));       // tapa del embrague
    add(b, new THREE.CylinderGeometry(0.09, 0.09, 0.03, 28), M.engineDark, V(-0.14, 0.38, -0.14), V(0, 0, Math.PI / 2)); // volante magnético
    const cyl = new THREE.Group();
    cyl.position.set(0, 0.52, -0.2);
    cyl.rotation.x = -0.28;                                        // cilindro inclinado hacia adelante
    b.add(cyl);
    add(cyl, new THREE.CylinderGeometry(0.06, 0.06, 0.24, 20), M.engineDark, V(0, 0.12, 0));
    for (let i = 0; i < 9; i++) add(cyl, new THREE.BoxGeometry(0.2 - i * 0.004, 0.009, 0.16 - i * 0.003), M.alu, V(0, 0.02 + i * 0.022, 0));
    add(cyl, new THREE.BoxGeometry(0.2, 0.08, 0.17), M.alu, V(0, 0.24, 0.0));       // culata
    for (let i = 0; i < 3; i++) add(cyl, new THREE.BoxGeometry(0.21, 0.008, 0.18), M.alu, V(0, 0.21 + i * 0.025, 0));
    add(cyl, new THREE.CylinderGeometry(0.012, 0.016, 0.08, 10), std('#111', 0.5), V(0.05, 0.3, 0.04), V(0.3, 0, 0)); // capuchón de la bujía
    add(b, new THREE.CylinderGeometry(0.035, 0.035, 0.08, 14), M.alu, V(0, 0.62, -0.04), V(Math.PI / 2, 0, 0));      // carburador
    add(b, new THREE.BoxGeometry(0.18, 0.15, 0.2), M.plastic, V(0, 0.64, 0.14));                                      // caja del filtro

    // escape: múltiple cromado bajo el motor hasta el silenciador lateral derecho
    tube(b, [V(0, 0.66, -0.37), V(0.01, 0.42, -0.4), V(0.05, 0.2, -0.28), V(0.1, 0.18, -0.02), V(0.16, 0.26, 0.22), V(0.17, 0.32, 0.32)], 0.022, M.chrome, 48);
    {
      const a = V(0.17, 0.32, 0.3), e = V(0.185, 0.47, 0.7);
      rod(b, a, e, 0.056, M.plastic, 0.05);
      rod(b, a.clone().lerp(e, 0.15), a.clone().lerp(e, 0.75), 0.06, M.chrome, 0.058);   // protector térmico
      rod(b, e, e.clone().add(V(0.002, 0.012, 0.03)), 0.022, M.chrome);
    }
    // posapiés, pedal de freno, palanca de cambios, posapiés del pasajero
    for (const sx of [-1, 1]) {
      rod(b, V(sx * 0.11, 0.3, 0.02), V(sx * 0.22, 0.3, 0.02), 0.016, M.rubber);
      rod(b, V(sx * 0.1, 0.38, 0.38), V(sx * 0.19, 0.38, 0.4), 0.012, M.rubber);
      beam(b, V(sx * 0.1, 0.33, 0.06), V(sx * 0.1, 0.5, 0.28), 0.012, 0.04, M.alu);
    }
    rod(b, V(-0.15, 0.32, -0.04), V(-0.16, 0.36, -0.2), 0.009, M.alu);    // cambios
    rod(b, V(0.15, 0.3, -0.02), V(0.16, 0.33, -0.18), 0.009, M.alu);      // freno trasero

    // ------------------------------------------------ carrocería: tanque, aletas, sillín, colín, guardabarros
    const tank: [number, number][] = [];
    const tankCurve = new THREE.CatmullRomCurve3([V(-0.42, 0.8, 0), V(-0.4, 0.92, 0), V(-0.28, 0.99, 0), V(-0.1, 0.98, 0),
      V(0.06, 0.88, 0), V(0.08, 0.8, 0), V(-0.15, 0.76, 0)], true);
    for (const p of tankCurve.getPoints(40)) tank.push([p.x, p.y]);
    sideExtrude(tank, 0.34, 0.03, M.paint, b, (x, y, z) => {
      const ty = Math.min(1, Math.max(0, (y - 0.74) / 0.26));
      const round = 0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, ty * 1.15));
      const knee = 1 - 0.3 * Math.min(1, Math.max(0, (z + 0.05) / 0.13));
      return x * round * knee;
    });
    // aletas laterales del tanque (negras)
    for (const sx of [-1, 1]) {
      const fin = new THREE.Shape([new THREE.Vector2(-0.44, 0.74), new THREE.Vector2(-0.3, 0.92), new THREE.Vector2(-0.2, 0.82), new THREE.Vector2(-0.28, 0.72)]);
      const g = new THREE.ExtrudeGeometry(fin, { depth: 0.012, bevelEnabled: false });
      g.rotateY(-Math.PI / 2);
      const p = g.getAttribute('position');
      for (let i = 0; i < p.count; i++) p.setXYZ(i, sx * (0.16 - p.getX(i)), p.getY(i), p.getZ(i));
      g.computeVertexNormals();
      add(b, g, M.paint2);
    }
    // sillín escalonado (piloto a 0,79 m, pasajero más alto)
    const seat: [number, number][] = [[0.05, 0.8], [0.1, 0.81], [0.38, 0.79], [0.46, 0.85], [0.72, 0.86], [0.76, 0.83], [0.74, 0.76], [0.06, 0.74]];
    sideExtrude(seat, 0.27, 0.035, M.seat, b, (x, _y, z) => x * (z < 0.2 ? 0.75 + (z - 0.05) * 1.6 : 1));
    // tapas laterales y colín
    for (const sx of [-1, 1]) {
      const sc = new THREE.Shape([new THREE.Vector2(0.06, 0.56), new THREE.Vector2(0.4, 0.66), new THREE.Vector2(0.44, 0.76), new THREE.Vector2(0.08, 0.76)]);
      const g = new THREE.ExtrudeGeometry(sc, { depth: 0.015, bevelEnabled: false });
      g.rotateY(-Math.PI / 2);
      const p = g.getAttribute('position');
      for (let i = 0; i < p.count; i++) p.setXYZ(i, sx * (0.12 - p.getX(i)), p.getY(i), p.getZ(i));
      g.computeVertexNormals();
      add(b, g, M.plastic);
    }
    const tail: [number, number][] = [[0.42, 0.8], [0.8, 0.84], [0.84, 0.8], [0.78, 0.74], [0.44, 0.72]];
    sideExtrude(tail, 0.2, 0.02, M.paint, b, (x, _y, z) => x * (1 - 0.35 * Math.max(0, (z - 0.45) / 0.4)));
    add(b, new THREE.BoxGeometry(0.11, 0.035, 0.03), M.tail, V(0, 0.8, 0.85));                                    // stop LED
    // guardabarros trasero, porta-placa, placa, direccionales
    beam(b, V(0, 0.76, 0.8), V(0, 0.62, 0.95), 0.08, 0.012, M.plastic);
    const plateTex = this.plateTexture();
    add(b, new THREE.PlaneGeometry(0.17, 0.125), new THREE.MeshStandardMaterial({ map: plateTex, roughness: 0.5 }), V(0, 0.6, 0.962), V(0.2, 0, 0));
    for (const sx of [-1, 1]) {
      rod(b, V(sx * 0.04, 0.7, 0.88), V(sx * 0.14, 0.7, 0.9), 0.007, M.plastic);
      add(b, new THREE.SphereGeometry(0.022, 10, 8), M.amber, V(sx * 0.15, 0.7, 0.9)).scale.set(1, 0.9, 1.4);
    }
    // guardabarros trasero interior (sobre la llanta)
    const hugger = new THREE.CylinderGeometry(R + 0.035, R + 0.035, 0.11, 24, 1, true, Math.PI * 0.5, Math.PI * 0.42);
    hugger.rotateZ(Math.PI / 2);
    add(this.lean, hugger, M.plastic, V(0, R, half), V(0, 0, 0)).material = std('#18191b', 0.55, 0, { side: THREE.DoubleSide });

    // ------------------------------------------------ dirección (gira sobre el eje inclinado)
    const rake = (26 * Math.PI) / 180;
    const forkLen = 0.7;
    const top = V(0, R + forkLen * Math.cos(rake), -half + forkLen * Math.sin(rake));
    const pivot = new THREE.Group();
    pivot.position.copy(top);
    pivot.rotation.x = rake;
    this.lean.add(pivot);
    pivot.add(this.steer);
    const st = this.steer;
    for (const sx of [-0.075, 0.075]) {
      add(st, new THREE.CylinderGeometry(0.019, 0.019, 0.42, 14), M.chrome, V(sx, -0.25, 0));                  // barras
      add(st, new THREE.CylinderGeometry(0.027, 0.024, 0.3, 14), std('#2a2b2e', 0.4, 0.6), V(sx, -0.55, 0));    // botellas
    }
    add(st, new THREE.BoxGeometry(0.2, 0.03, 0.07), M.alu, V(0, 0.0, 0.0));        // tija superior
    add(st, new THREE.BoxGeometry(0.2, 0.035, 0.08), M.frame, V(0, -0.16, 0));     // tija inferior
    this.frontWheel.position.set(0, -forkLen, 0);
    wheel(this.frontWheel, true);
    st.add(this.frontWheel);
    add(st, new THREE.BoxGeometry(0.035, 0.06, 0.08), std('#8c1717', 0.4, 0.3), V(-0.078, -forkLen + 0.06, 0.09)); // pinza
    const fender = new THREE.CylinderGeometry(R + 0.03, R + 0.03, 0.1, 24, 1, true, Math.PI * 0.3, Math.PI * 0.55);
    fender.rotateZ(Math.PI / 2);
    add(st, fender, std(col.paint, 0.32, 0.25, { clearcoat: 1, side: THREE.DoubleSide, envMap: env }), V(0, -forkLen, 0), V(-rake, 0, 0));
    // grupo nivelado (anula el lanzamiento): manubrio, farola, tablero, espejos
    const lvl = new THREE.Group();
    lvl.rotation.x = -rake;
    st.add(lvl);
    tube(lvl, [V(-0.37, 0.15, 0.1), V(-0.18, 0.12, 0.04), V(0, 0.11, 0.02), V(0.18, 0.12, 0.04), V(0.37, 0.15, 0.1)], 0.011, M.frame);
    for (const sx of [-1, 1]) {
      add(lvl, new THREE.CylinderGeometry(0.017, 0.017, 0.12, 12), M.rubber, V(sx * 0.33, 0.145, 0.09), V(0, sx * 0.25, Math.PI / 2));
      rod(lvl, V(sx * 0.24, 0.15, 0.06), V(sx * 0.36, 0.13, 0.0), 0.006, M.alu);                                    // palancas
      rod(lvl, V(sx * 0.2, 0.14, 0.04), V(sx * 0.27, 0.42, 0.02), 0.006, M.frame);                                  // vástago del espejo
      const mir = add(lvl, new THREE.SphereGeometry(0.055, 14, 10), M.plastic, V(sx * 0.285, 0.45, 0.02));
      mir.scale.set(1.25, 0.8, 0.35);
      add(lvl, new THREE.CircleGeometry(0.05, 16), M.glass, V(sx * 0.285, 0.45, 0.042)).scale.set(1.2, 0.75, 1);
    }
    this.anchors.gripL.position.set(-0.33, 0.145, 0.09);
    this.anchors.gripR.position.set(0.33, 0.145, 0.09);
    lvl.add(this.anchors.gripL, this.anchors.gripR);
    // farola + carenado + direccionales delanteras
    add(lvl, new THREE.CylinderGeometry(0.085, 0.07, 0.11, 20), M.paint2, V(0, -0.09, -0.12), V(Math.PI / 2, 0, 0));
    add(lvl, new THREE.CircleGeometry(0.078, 24), M.lens, V(0, -0.09, -0.177), V(0, Math.PI, 0));
    add(lvl, new THREE.TorusGeometry(0.08, 0.008, 8, 28), M.chrome, V(0, -0.09, -0.176));   // aro de la farola
    for (const sx of [-1, 1]) {
      rod(lvl, V(sx * 0.07, -0.08, -0.08), V(sx * 0.17, -0.08, -0.09), 0.007, M.plastic);
      add(lvl, new THREE.SphereGeometry(0.022, 10, 8), M.amber, V(sx * 0.18, -0.08, -0.095)).scale.set(1, 0.9, 1.4);
    }
    // tablero digital (velocímetro, marcha) con textura dinámica
    const dc = document.createElement('canvas');
    dc.width = 128; dc.height = 64;
    const dtex = new THREE.CanvasTexture(dc);
    dtex.colorSpace = THREE.SRGBColorSpace;
    this.dash = { canvas: dc, tex: dtex, last: '' };
    add(lvl, new THREE.BoxGeometry(0.15, 0.08, 0.04), M.plastic, V(0, 0.17, -0.02), V(-0.5, 0, 0));
    add(lvl, new THREE.PlaneGeometry(0.13, 0.065), new THREE.MeshBasicMaterial({ map: dtex }), V(0, 0.18, -0.001), V(-0.5, 0, 0));
    this.updateDash(0, 1, 0);

    // ------------------------------------------------ pata lateral (izquierda)
    this.sideStand.position.set(-0.11, 0.3, 0.06);
    b.add(this.sideStand);
    add(this.sideStand, new THREE.CylinderGeometry(0.012, 0.012, 0.34, 8), M.frame, V(0, -0.17, 0));
    add(this.sideStand, new THREE.BoxGeometry(0.04, 0.012, 0.06), M.frame, V(0, -0.34, 0));

    // ------------------------------------------------ anclajes del jinete
    this.anchors.hips.position.set(0, 0.87, 0.24);
    this.anchors.pegL.position.set(-0.2, 0.32, 0.04);
    this.anchors.pegR.position.set(0.2, 0.32, 0.04);
    b.add(this.anchors.hips, this.anchors.pegL, this.anchors.pegR);
    this.anchors.footDown.position.set(-0.36, 0.0, 0.02);
    this.root.add(this.anchors.footDown);

    // Rendimiento: los grupos que no se mueven entre sí se aplanan en su padre y luego se fusionan las piezas que
    // comparten material dentro de cada grupo móvil (chasis, dirección, ruedas, pata): ≈175 → ≈35 draw calls.
    flatten(cyl, b);
    flatten(b, this.lean);
    flatten(lvl, this.steer);
    for (const g of [this.lean, this.steer, this.rearWheel, this.frontWheel, this.sideStand]) mergeByMaterial(g);
    // Sombras sólo de las piezas grandes (las pequeñas no se notan en el mapa de sombras y cuestan otra pasada)
    const bigCasters = new Set<THREE.Material>([M.paint, M.paint2, M.frame, M.seat, M.alu, M.engineDark, M.plastic, tireMat]);
    this.root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.castShadow = bigCasters.has(m.material as THREE.Material); });
  }

  private plateTexture() {
    const cv = document.createElement('canvas');
    cv.width = 128; cv.height = 96;
    const g = cv.getContext('2d')!;
    g.fillStyle = C.colors.plate; g.fillRect(0, 0, 128, 96);
    g.strokeStyle = '#111'; g.lineWidth = 5; g.strokeRect(3, 3, 122, 90);
    g.fillStyle = '#111'; g.font = 'bold 30px Arial'; g.textAlign = 'center';
    const [l1, l2] = C.plate.split(' ');
    g.fillText(l1, 64, 40); g.fillText(l2, 64, 76);
    g.font = 'bold 11px Arial'; g.fillText('ZIPAQUIRÁ', 64, 90);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /** Tablero LCD: velocidad, marcha y barra de rpm. */
  updateDash(kmh: number, gear: number, rpmFrac: number) {
    const key = `${Math.round(kmh)}|${gear}|${Math.round(rpmFrac * 20)}`;
    if (key === this.dash.last) return;
    this.dash.last = key;
    const g = this.dash.canvas.getContext('2d')!;
    g.fillStyle = '#9fb3a3'; g.fillRect(0, 0, 128, 64);
    g.fillStyle = '#1c2a22';
    g.font = 'bold 34px monospace'; g.textAlign = 'right';
    g.fillText(String(Math.round(kmh)), 92, 46);
    g.font = 'bold 12px monospace'; g.fillText('km/h', 124, 46);
    g.textAlign = 'left'; g.font = 'bold 22px monospace'; g.fillText(String(gear), 6, 46);
    for (let i = 0; i < 20; i++) if (i < rpmFrac * 20) g.fillRect(6 + i * 6, 6, 4, 8 + i * 0.3);
    this.dash.tex.needsUpdate = true;
  }

  /** Giro de ruedas, dirección, inclinación (+ = derecha), cabeceo del terreno y de la suspensión, pata. */
  pose(spin: number, steer: number, lean: number, terrainPitch: number, suspPitch: number, standDown: boolean) {
    this.rearWheel.rotation.x = spin;
    this.frontWheel.rotation.x = spin;
    this.steer.rotation.y = -steer;
    this.lean.rotation.z = -lean;
    this.root.rotation.x = terrainPitch + suspPitch;   // la suspensión cabecea toda la moto (sin huecos entre piezas)
    // pata lateral: abajo (hacia afuera y adelante) o recogida contra el basculante
    const [rx, rz] = standDown ? [0.3, -0.55] : [-1.4, -0.1];
    this.sideStand.rotation.x += (rx - this.sideStand.rotation.x) * 0.2;
    this.sideStand.rotation.z += (rz - this.sideStand.rotation.z) * 0.2;
  }
}

