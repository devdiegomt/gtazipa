import * as THREE from 'three/webgpu';

const DOWN = new THREE.Vector3(0, -1, 0);

/** Cadena de dos huesos (muslo-pierna o brazo-antebrazo). La raíz y la articulación cuelgan hacia -Y en reposo. */
interface Limb { root: THREE.Group; joint: THREE.Group; a: number; b: number; pole: THREE.Vector3 }

/**
 * Maniquí low-poly con rodillas y codos. Camina con animación procedural; en moto, los pies y las manos se colocan
 * con IK analítica de dos huesos sobre los posapiés y los puños del manubrio. Pies en y = 0.
 */
export class Avatar {
  readonly root = new THREE.Group();
  private hips = new THREE.Group();
  private head = new THREE.Group();
  private hat = new THREE.Group();
  private helmet = new THREE.Group();
  private face: THREE.Mesh;
  private legL: Limb;
  private legR: Limb;
  private armL: Limb;
  private armR: Limb;
  private phase = 0;
  /** Todos los materiales del maniquí (incluido el casco), para desvanecerlo. */
  private mats: THREE.Material[] = [];
  private opacity = 1;

  constructor() {
    const mat = (color: string, roughness = 0.85, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
    const skin = mat('#b98a68', 0.8);
    const shirt = mat('#8c2f2a', 0.9);    // ruana roja
    const pants = mat('#2c3b55', 0.9);    // jean
    const shoes = mat('#2a2420', 0.7);
    const box = (parent: THREE.Object3D, w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z = 0) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };
    this.hips.position.y = 0.92;
    this.root.add(this.hips);
    box(this.hips, 0.4, 0.14, 0.22, pants, 0, 0.02);          // pelvis
    box(this.hips, 0.42, 0.5, 0.23, shirt, 0, 0.36);          // torso
    const ruana = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.42, 0.42, 8), shirt);
    ruana.position.y = 0.42;
    ruana.castShadow = true;
    this.hips.add(ruana);
    this.head.position.y = 0.66;
    this.hips.add(this.head);
    box(this.head, 0.08, 0.07, 0.08, skin, 0, 0.03);          // cuello
    this.face = box(this.head, 0.22, 0.25, 0.23, skin, 0, 0.17);
    // sombrero
    const hatM = mat('#d9ccb0', 0.9);
    this.hat.position.y = 0.3;
    this.head.add(this.hat);
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.025, 16), hatM);
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.13, 14), hatM);
    crown.position.y = 0.07;
    brim.castShadow = crown.castShadow = true;
    this.hat.add(brim, crown);
    // casco integral (obligatorio en moto)
    const shell = new THREE.Mesh(new THREE.SphereGeometry(0.165, 24, 18), new THREE.MeshPhysicalMaterial({
      color: '#e8e6e1', roughness: 0.25, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.05 }));
    shell.scale.set(0.95, 1.0, 1.08);
    shell.position.y = 0.18;
    shell.castShadow = true;
    const visor = new THREE.Mesh(new THREE.SphereGeometry(0.168, 24, 12, Math.PI * 1.22, Math.PI * 0.56, Math.PI * 0.36, Math.PI * 0.22),
      new THREE.MeshPhysicalMaterial({ color: '#15181c', roughness: 0.05, metalness: 0.4, clearcoat: 1 }));
    visor.scale.copy(shell.scale);
    visor.position.copy(shell.position);
    const stripe = new THREE.Mesh(new THREE.TorusGeometry(0.163, 0.012, 6, 32, Math.PI), mat('#b0161b', 0.4));
    stripe.position.y = 0.18;
    stripe.rotation.set(0, Math.PI / 2, 0);
    stripe.scale.set(1.08, 1, 0.95);
    this.helmet.add(shell, visor, stripe);
    this.helmet.visible = false;
    this.head.add(this.helmet);

    const limb = (parent: THREE.Object3D, x: number, y: number, a: number, b: number, w: number, m1: THREE.Material,
      m2: THREE.Material, end: (j: THREE.Group) => void, pole: THREE.Vector3): Limb => {
      const root = new THREE.Group();
      root.position.set(x, y, 0);
      parent.add(root);
      box(root, w, a, w * 1.1, m1, 0, -a / 2);
      const joint = new THREE.Group();
      joint.position.y = -a;
      root.add(joint);
      box(joint, w * 0.9, b, w, m2, 0, -b / 2);
      end(joint);
      return { root, joint, a, b, pole };
    };
    const foot = (j: THREE.Group) => box(j, 0.15, 0.08, 0.27, shoes, 0, -0.46, -0.05);
    const hand = (j: THREE.Group) => box(j, 0.09, 0.11, 0.1, skin, 0, -0.32);
    this.legL = limb(this.hips, -0.11, 0, 0.44, 0.42, 0.16, pants, pants, foot, new THREE.Vector3(-0.15, 0, -1));
    this.legR = limb(this.hips, 0.11, 0, 0.44, 0.42, 0.16, pants, pants, foot, new THREE.Vector3(0.15, 0, -1));
    this.armL = limb(this.hips, -0.29, 0.56, 0.29, 0.27, 0.11, shirt, shirt, hand, new THREE.Vector3(-0.8, -0.5, 0.5));
    this.armR = limb(this.hips, 0.29, 0.56, 0.29, 0.27, 0.11, shirt, shirt, hand, new THREE.Vector3(0.8, -0.5, 0.5));
    const mats = new Set<THREE.Material>();
    this.root.traverse((o) => { if (o instanceof THREE.Mesh) mats.add(o.material as THREE.Material); });
    this.mats = [...mats];
  }

  /**
   * Opacidad del cuerpo (cámara pegada al personaje). 1 = opaco (sin coste de ordenar transparencias);
   * ~0 = oculto sin tocar root.visible (main.ts lo usa en las vistas fijas). depthWrite queda siempre activo.
   * Solo recompila (needsUpdate) cuando cambia `transparent`; la opacidad es un uniforme.
   */
  setOpacity(alpha: number) {
    const a = alpha >= 0.999 ? 1 : alpha <= 0.02 ? 0 : alpha;
    if (a === this.opacity) return;
    this.opacity = a;
    this.hips.visible = a > 0;
    if (a === 0) return; // oculto: los materiales quedan como estaban
    const transparent = a < 1;
    for (const m of this.mats) {
      if (m.transparent !== transparent) { m.transparent = transparent; m.needsUpdate = true; }
      m.opacity = a;
    }
  }

  setHelmet(on: boolean) {
    this.helmet.visible = on;
    this.hat.visible = !on;
    this.face.visible = !on;
  }

  /** IK analítica de dos huesos: lleva el extremo de la cadena (tobillo/muñeca) al punto `target` (mundo). */
  private solve(l: Limb, target: THREE.Vector3) {
    const parent = l.root.parent!;
    parent.updateWorldMatrix(true, false);
    const T = parent.worldToLocal(target.clone());
    const P = l.root.position;
    const D = T.clone().sub(P);
    const d = THREE.MathUtils.clamp(D.length(), Math.abs(l.a - l.b) + 1e-3, l.a + l.b - 1e-3);
    const dir = D.normalize();
    const alpha = Math.acos(THREE.MathUtils.clamp((l.a * l.a + d * d - l.b * l.b) / (2 * l.a * d), -1, 1));
    const pole = l.pole.clone().sub(dir.clone().multiplyScalar(l.pole.dot(dir))).normalize();
    const u1 = dir.clone().multiplyScalar(Math.cos(alpha)).add(pole.multiplyScalar(Math.sin(alpha)));
    l.root.quaternion.setFromUnitVectors(DOWN, u1);
    const knee = P.clone().addScaledVector(u1, l.a);
    const end = P.clone().addScaledVector(dir, d);
    const u2 = end.sub(knee).normalize().applyQuaternion(l.root.quaternion.clone().invert());
    l.joint.quaternion.setFromUnitVectors(DOWN, u2);
  }

  /**
   * Postura en moto. Objetivos en coordenadas de mundo: posapiés, puños y punto de apoyo del pie en el suelo.
   * crouch ∈ [0, 1]: se agacha a mayor velocidad.
   */
  ride(t: { pegL: THREE.Vector3; pegR: THREE.Vector3; gripL: THREE.Vector3; gripR: THREE.Vector3; footDown: THREE.Vector3 },
    footDown: boolean, crouch: number) {
    this.hips.position.y = 0.92;
    this.hips.rotation.set(-0.32 - crouch * 0.22, 0, 0);
    this.head.rotation.set(0.3 + crouch * 0.2, 0, 0);
    this.root.updateWorldMatrix(true, true);
    const up = new THREE.Vector3(0, 0.06, 0);
    this.solve(this.legL, (footDown ? t.footDown : t.pegL).clone().add(up));
    this.solve(this.legR, t.pegR.clone().add(up));
    this.solve(this.armL, t.gripL);
    this.solve(this.armR, t.gripR);
  }

  /** speed en m/s, grounded, dt en s. */
  animate(speed: number, grounded: boolean, vy: number, dt: number) {
    const stride = speed > 4 ? 1.25 : 1.6; // m por medio ciclo
    this.phase += (speed / stride) * Math.PI * dt;
    const amp = Math.min(speed / 6, 1) * (speed > 4 ? 0.95 : 0.6);
    let swing = Math.sin(this.phase) * amp;
    let bob = Math.abs(Math.cos(this.phase)) * 0.05 * Math.min(speed / 2, 1);
    let armUp = 0;
    let kneeL = Math.max(0, -Math.sin(this.phase + 0.6)) * amp * 1.3 + 0.05 * amp;
    let kneeR = Math.max(0, Math.sin(this.phase + 0.6)) * amp * 1.3 + 0.05 * amp;
    if (!grounded) {
      swing = 0.35;
      bob = 0;
      armUp = vy > 0 ? -0.6 : -0.3;
      kneeL = 0.5;
      kneeR = 0.9;
    }
    this.legL.root.rotation.set(swing, 0, 0);
    this.legR.root.rotation.set(grounded ? -swing : -0.25, 0, 0);
    this.legL.joint.rotation.set(-kneeL, 0, 0);
    this.legR.joint.rotation.set(-kneeR, 0, 0);
    this.armL.root.rotation.set(-swing * 0.9 + armUp, 0, 0.04);
    this.armR.root.rotation.set(swing * 0.9 + armUp, 0, -0.04);
    this.armL.joint.rotation.set(0.25 + Math.max(0, swing) * 0.5, 0, 0);
    this.armR.joint.rotation.set(0.25 + Math.max(0, -swing) * 0.5, 0, 0);
    this.hips.position.y = 0.92 + bob;
    this.hips.rotation.set(speed > 4 && grounded ? -0.12 : 0, 0, 0);
    this.head.rotation.set(speed > 4 && grounded ? 0.1 : 0, 0, 0);
  }
}
