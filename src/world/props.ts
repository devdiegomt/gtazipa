import * as THREE from 'three/webgpu';
import type { Prop } from './types';

/** Árboles y postes de OSM (natural=tree, highway=street_lamp) dibujados con InstancedMesh. */
export function buildProps(props: Prop[]): THREE.Group {
  const group = new THREE.Group();
  group.name = 'props';
  const trees = props.filter((p) => p.kind === 'tree');
  const lamps = props.filter((p) => p.kind === 'lamp');
  const m4 = new THREE.Matrix4();

  if (trees.length) {
    const trunkGeo = new THREE.CylinderGeometry(0.15, 0.22, 3, 6).translate(0, 1.5, 0);
    const crownGeo = new THREE.IcosahedronGeometry(2.2, 1).translate(0, 4.4, 0);
    const trunk = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: '#5b4632', roughness: 1 }), trees.length);
    const crown = new THREE.InstancedMesh(crownGeo, new THREE.MeshStandardMaterial({ color: '#4f6f34', roughness: 1, flatShading: true }), trees.length);
    trees.forEach((t, i) => {
      const s = 0.85 + ((t.x * 13.7 + t.z * 7.1) % 1 + 1) % 1 * 0.4;
      m4.makeScale(s, s, s).setPosition(t.x, t.y - 0.1, t.z);
      trunk.setMatrixAt(i, m4);
      crown.setMatrixAt(i, m4);
    });
    for (const m of [trunk, crown]) { m.castShadow = true; m.receiveShadow = true; group.add(m); }
  }
  if (lamps.length) {
    const poleGeo = new THREE.CylinderGeometry(0.06, 0.09, 4.5, 6).translate(0, 2.25, 0);
    const pole = new THREE.InstancedMesh(poleGeo, new THREE.MeshStandardMaterial({ color: '#2d2f31', roughness: 0.6 }), lamps.length);
    lamps.forEach((l, i) => { m4.makeTranslation(l.x, l.y, l.z); pole.setMatrixAt(i, m4); });
    pole.castShadow = true;
    group.add(pole);
  }
  return group;
}
