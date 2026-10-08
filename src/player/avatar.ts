import * as THREE from 'three/webgpu';

/** Maniquí low-poly con animación procedural (caminar/correr/saltar). Pies en y = 0. */
export class Avatar {
  readonly root = new THREE.Group();
  private hips = new THREE.Group();
  private legL = new THREE.Group();
  private legR = new THREE.Group();
  private armL = new THREE.Group();
  private armR = new THREE.Group();
  private phase = 0;

  constructor() {
    const skin = new THREE.MeshStandardMaterial({ color: '#b98a68', roughness: 0.8 });
    const shirt = new THREE.MeshStandardMaterial({ color: '#8c2f2a', roughness: 0.9 });   // ruana roja
    const pants = new THREE.MeshStandardMaterial({ color: '#2c3b55', roughness: 0.9 });
    const shoes = new THREE.MeshStandardMaterial({ color: '#2a2420', roughness: 0.7 });
    const hat = new THREE.MeshStandardMaterial({ color: '#d9ccb0', roughness: 0.9 });     // sombrero
    const box = (w: number, h: number, d: number, m: THREE.Material, y: number) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      mesh.position.y = y;
      mesh.castShadow = true;
      return mesh;
    };
    this.hips.position.y = 0.92;
    this.root.add(this.hips);
    const torso = box(0.44, 0.6, 0.24, shirt, 0.32);
    this.hips.add(torso);
    const ruana = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.42, 0.42, 8), shirt);
    ruana.position.y = 0.42; ruana.castShadow = true;
    this.hips.add(ruana);
    const head = box(0.22, 0.25, 0.23, skin, 0.78);
    this.hips.add(head);
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.025, 14), hat);
    brim.position.y = 0.9; brim.castShadow = true;
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.13, 12), hat);
    crown.position.y = 0.97; crown.castShadow = true;
    this.hips.add(brim, crown);
    for (const [leg, x] of [[this.legL, -0.11], [this.legR, 0.11]] as const) {
      leg.position.set(x, 0, 0);
      leg.add(box(0.16, 0.82, 0.18, pants, -0.41));
      leg.add(box(0.17, 0.09, 0.28, shoes, -0.86).translateZ(-0.04));
      this.hips.add(leg);
    }
    for (const [arm, x] of [[this.armL, -0.29], [this.armR, 0.29]] as const) {
      arm.position.set(x, 0.58, 0);
      arm.add(box(0.12, 0.58, 0.13, shirt, -0.27));
      arm.add(box(0.1, 0.12, 0.11, skin, -0.62));
      this.hips.add(arm);
    }
  }

  /** Postura sentada en la moto: piernas hacia los posapiés, brazos al manubrio, torso inclinado. */
  ride(speed: number) {
    // +X en este marco = hacia adelante (-Z). Piernas abiertas para abrazar el tanque.
    this.legL.rotation.set(0.95, 0, -0.2);
    this.legR.rotation.set(0.95, 0, 0.2);
    this.armL.rotation.set(1.1, 0, 0.05);
    this.armR.rotation.set(1.1, 0, -0.05);
    this.hips.position.y = 0.92;
    this.hips.rotation.x = -0.15 - Math.min(speed / 20, 1) * 0.25;   // más agachado a mayor velocidad
  }

  /** speed en m/s, grounded, dt en s. */
  animate(speed: number, grounded: boolean, vy: number, dt: number) {
    const stride = speed > 4 ? 1.25 : 1.6; // m por medio ciclo
    this.phase += (speed / stride) * Math.PI * dt;
    const amp = Math.min(speed / 6, 1) * (speed > 4 ? 0.95 : 0.6);
    let swing = Math.sin(this.phase) * amp;
    let bob = Math.abs(Math.cos(this.phase)) * 0.05 * Math.min(speed / 2, 1);
    let armUp = 0;
    if (!grounded) {
      swing = 0.35;
      bob = 0;
      armUp = vy > 0 ? -0.6 : -0.3;
    }
    this.legL.rotation.set(swing, 0, 0);
    this.legR.rotation.set(grounded ? -swing : -0.25, 0, 0);
    this.armL.rotation.set(-swing * 0.9 + armUp, 0, 0);
    this.armR.rotation.set(swing * 0.9 + armUp, 0, 0);
    this.hips.position.y = 0.92 + bob;
    this.hips.rotation.x = speed > 4 && grounded ? -0.12 : 0;
  }
}
