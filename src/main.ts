import * as THREE from 'three/webgpu';
import { Physics } from './physics';
import { Heightfield, buildTerrainMesh } from './world/terrain';
import { loadBuildings } from './world/buildings';
import { buildProps } from './world/props';
import { Character } from './player/character';
import { Avatar } from './player/avatar';
import { OrbitCamera } from './camera';
import { Input } from './input';
import { Minimap } from './ui/minimap';
import { buildSky } from './world/sky';
import { loadCatedral } from './world/catedral';
import { buildPlaza } from './world/plaza';
import { MotoController, MotoModel, parkingSpot } from './vehicles/moto';
import vehiclesCfg from './data/vehicles.json';
import type { BuildingMeta, Prop, Road, WorldMeta } from './world/types';
import worldCfg from './data/world.json';
import playerCfg from './data/player.json';

const WORLD = `${import.meta.env.BASE_URL}world/`;
const params = new URLSearchParams(location.search);
const CAPTURE = params.get('capture'); // N | E | S | W: vista fija desde la plaza para capturas

declare global {
  interface Window { __zipa?: Record<string, unknown> }
}

async function fetchJSON<T>(name: string): Promise<T> {
  const r = await fetch(WORLD + name);
  if (!r.ok) throw new Error(`No se pudo cargar ${name} (${r.status}). ¿Ejecutaste el pipeline?`);
  return r.json() as Promise<T>;
}

async function main() {
  const loading = document.getElementById('loading')!;
  if (CAPTURE) document.body.classList.add('capture');

  // ---------------- render (WebGPU con fallback automático a WebGL2)
  const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: params.has('webgl') });
  await renderer.init();
  const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.85;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.getElementById('app')!.appendChild(renderer.domElement);

  const r = worldCfg.render;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(r.sky);
  scene.fog = new THREE.Fog(r.sky, r.fogNear, r.fogFar);
  const sky = buildSky(r.sky);
  scene.add(sky);
  const camera = new THREE.PerspectiveCamera(playerCfg.camera.fov, innerWidth / innerHeight, 0.1, 2000);

  const hemi = new THREE.HemisphereLight('#d6e4f2', '#5e5444', 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight('#fff1dc', 2.2);
  const sunDir = new THREE.Vector3(...(r.sunDirection as [number, number, number])).normalize();
  sun.castShadow = true;
  sun.shadow.mapSize.set(r.shadowMapSize, r.shadowMapSize);
  const ext = r.shadowExtent;
  Object.assign(sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 1, far: 400 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);

  // ---------------- datos del mundo
  const meta = await fetchJSON<WorldMeta>('world.json');
  const [heightsBuf, groundTex, roads, bmeta, props, buildings, phys] = await Promise.all([
    fetch(WORLD + meta.terrain.file).then((x) => x.arrayBuffer()),
    new THREE.TextureLoader().loadAsync(WORLD + meta.ground.file),
    fetchJSON<Road[]>(meta.files.roads),
    fetchJSON<BuildingMeta[]>(meta.files.buildingsMeta),
    fetchJSON<Prop[]>(meta.files.props),
    loadBuildings(WORLD + meta.files.buildings),
    (async () => { const p = new Physics(); await p.init(); return p; })(),
  ]);
  document.getElementById('attribution')!.textContent = meta.attribution.join(' · ');

  const hf = new Heightfield(new Float32Array(heightsBuf), meta.terrain);
  const terrainMesh = buildTerrainMesh(hf, groundTex);
  const cat = meta.landmarks.find((l) => l.model);
  const catedral = cat?.model ? await loadCatedral(WORLD + cat.model.file, cat) : null;
  const axisU: [number, number] = cat?.model?.axisU ?? [1, 0];
  const plaza = buildPlaza(meta, hf, axisU);
  const plazaTrees = new Set((meta.plaza.planters ?? []).map((p) => p.osm));
  scene.add(terrainMesh, buildings.group, buildProps(props.filter((p) => !plazaTrees.has(p.osm))), plaza.group);
  if (catedral) scene.add(catedral.group);

  // ---------------- física: terreno + manzanas + límites
  const tArr = hf.buildArrays();
  phys.addTrimesh(tArr.pos, tArr.idx);
  for (const c of buildings.colliders) phys.addTrimesh(c.vertices, c.indices);
  if (catedral) phys.addTrimesh(catedral.vertices, catedral.indices);
  for (const p of plaza.planters) phys.addCylinder(p.x, p.y, p.z, p.r, p.h);
  phys.addBounds(meta.area.half, meta.terrain.minY, meta.terrain.maxY);

  // ---------------- jugador
  const spawn = { x: 0, z: 0 };
  const character = new Character(phys, spawn.x, hf.heightAt(spawn.x, spawn.z) + 0.05, spawn.z);
  // Moto estacionada junto a la calzada más cercana al inicio
  const MC = vehiclesCfg.moto;
  const spot = parkingSpot(roads, spawn.x, spawn.z);
  const moto = new MotoController(phys, spot.x, hf.heightAt(spot.x, spot.z) + 0.05, spot.z, spot.yaw);
  const motoModel = new MotoModel();
  scene.add(motoModel.root);
  let riding = false;
  let lastMouseMs = 0;
  let notice = '';
  let noticeUntil = 0;
  phys.world.step(); // inicializa la estructura de consultas
  const avatar = new Avatar();
  scene.add(avatar.root);
  const input = new Input(renderer.domElement);
  const orbit = new OrbitCamera(camera, phys, character.collider);
  let heading = 0;

  if (CAPTURE) {
    if (CAPTURE === 'AERIAL') {
      scene.fog = null;
      Object.assign(sun.shadow.camera, { left: -420, right: 420, top: 420, bottom: -420, far: 900 });
      sun.shadow.mapSize.set(4096, 4096);
    }
    const yawFor: Record<string, number> = { N: 0, E: -Math.PI / 2, S: Math.PI, W: Math.PI / 2 };
    orbit.yaw = yawFor[CAPTURE.toUpperCase()] ?? 0;
    orbit.pitch = 12 * (Math.PI / 180);
    orbit.distance = 7;
    heading = orbit.yaw;
  }

  // Vistas fijas para comparar con las fotos de referencia (docs/referencias/).
  let fixedView: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
  if (cat?.model && (CAPTURE === 'CATEDRAL' || CAPTURE === 'PLAZA' || CAPTURE === 'TORRES')) {
    const { origin: [mx, mz], axisU: [ux, uz], axisV: [vx, vz], floorY } = cat.model;
    const at = (u: number, v: number, y: number) => new THREE.Vector3(mx + u * ux + v * vx, y, mz + u * uz + v * vz);
    if (CAPTURE === 'CATEDRAL') {
      // Como la foto: desde el lado poniente de la plaza, a ~45 m de la fachada, bajo un alero.
      const p = at(-11, -50, 0);
      p.y = hf.heightAt(p.x, p.z) + 3.0;
      fixedView = { pos: p, target: at(-1, 0, floorY + 15.5) };
    } else if (CAPTURE === 'TORRES') {
      const p = at(-6, -26, 0);
      p.y = hf.heightAt(p.x, p.z) + 1.7;
      fixedView = { pos: p, target: at(0, 0, floorY + 17) };
    } else {
      // Como la foto de la plaza: elevada, desde el atrio mirando a través de la plaza.
      const p = at(6, -6, floorY + 10);
      fixedView = { pos: p, target: at(-2, -70, floorY - 3) };
    }
    avatar.root.visible = false;
    camera.fov = 62;
    camera.updateProjectionMatrix();
  }

  const minimap = new Minimap(
    document.getElementById('minimap') as HTMLCanvasElement, roads, meta,
    bmeta.map((b) => [b.c[0], b.c[1], b.area] as [number, number, number]),
  );

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  // ---------------- bucle
  const statsEl = document.getElementById('stats')!;
  const speedoEl = document.getElementById('speedo')!;
  const promptEl = document.getElementById('prompt')!;
  const helpEl = document.getElementById('help')!;
  const helpWalk = helpEl.innerHTML;
  const helpRide = 'Clic para controlar la cámara · <b>W</b> acelerar · <b>S</b> frenar / reversa · <b>A D</b> girar · ' +
    '<b>Espacio</b> freno · <b>E</b> bajarse · <b>Rueda</b> distancia';
  let helpRiding = false;

  /** Busca dónde bajarse: a la izquierda, a la derecha, detrás o delante de la moto, sin chocar con nada. */
  function dismountSpot() {
    const R = phys.R;
    const fx = -Math.sin(moto.yaw), fz = -Math.cos(moto.yaw);
    const rx = -fz, rz = fx;
    const capsule = new R.Capsule(playerCfg.capsule.halfHeight, playerCfg.capsule.radius);
    const centerUp = playerCfg.capsule.halfHeight + playerCfg.capsule.radius;
    for (const [ox, oz] of [[-rx * 1.1, -rz * 1.1], [rx * 1.1, rz * 1.1], [-fx * 2.0, -fz * 2.0], [fx * 2.0, fz * 2.0]]) {
      const x = moto.curr.x + ox, z = moto.curr.z + oz;
      const y = Math.max(hf.heightAt(x, z), moto.curr.y) + 0.05;
      const hit = phys.world.intersectionWithShape({ x, y: y + centerUp, z }, { x: 0, y: 0, z: 0, w: 1 }, capsule,
        undefined, undefined, moto.collider);
      if (!hit) return { x, y, z };
    }
    return null;
  }
  const FIXED = 1 / 60;
  let acc = 0;
  let last = performance.now();
  let fpsFrames = 0, fpsTime = 0, fps = 0;
  const feet = new THREE.Vector3();
  let frames = 0;

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    const m = input.consumeMouse();
    if (!CAPTURE) orbit.input(m.dx, m.dy, m.wheel);
    if (m.dx || m.dy) lastMouseMs = now;

    // Subir / bajar de la moto (E o F)
    const nearMoto = Math.hypot(moto.curr.x - feet.x, moto.curr.z - feet.z) < MC.mountDistance
      && Math.abs(moto.curr.y - feet.y) < 1.5;
    if (input.consumeInteract() && !CAPTURE) {
      if (!riding && nearMoto) {
        riding = true;
        character.collider.setEnabled(false);
        orbit.ignore = [moto.collider];
        orbit.distance = MC.camera.distance;
        orbit.yaw = moto.yaw;
        motoModel.lean.add(avatar.root);
        avatar.root.position.set(motoModel.seat.x, motoModel.seat.y - 0.88, motoModel.seat.z);
        avatar.root.rotation.set(0, 0, 0);
      } else if (riding && Math.abs(moto.speed) > 3) {
        notice = 'Frena para bajarte (S o Espacio)';
        noticeUntil = now + 1500;
      } else if (riding) {
        const free = dismountSpot();
        if (free) {
          riding = false;
          scene.add(avatar.root);
          character.teleport(free.x, free.y, free.z);
          character.collider.setEnabled(true);
          orbit.ignore = [];
          orbit.distance = playerCfg.camera.distance;
          heading = moto.yaw;
        } else {
          notice = 'No hay espacio para bajarse aquí';
          noticeUntil = now + 1500;
        }
      }
    }

    acc += dt;
    while (acc >= FIXED) {
      // El salto se consume sólo cuando corre un paso fijo (a >60 FPS hay frames sin paso).
      const jump = CAPTURE ? false : input.consumeJump();
      const { x: ax, y: ay } = CAPTURE ? { x: 0, y: 0 } : input.axes();
      if (riding) {
        moto.step(FIXED, ay, ax, input.down('Space'), true);
      } else {
        const b = orbit.basis();
        let wx = b.rx * ax + b.fx * ay, wz = b.rz * ax + b.fz * ay;
        const len = Math.hypot(wx, wz);
        if (len > 1) { wx /= len; wz /= len; }
        character.step(FIXED, wx, wz, input.run, jump);
        moto.step(FIXED, 0, 0, false, false);
      }
      phys.world.step();
      acc -= FIXED;
    }

    const t = acc / FIXED;
    const mp = moto.prev, mc = moto.curr;
    let dyaw = mc.yaw - mp.yaw;
    dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
    motoModel.root.position.set(mp.x + (mc.x - mp.x) * t, mp.y + (mc.y - mp.y) * t, mp.z + (mc.z - mp.z) * t);
    motoModel.root.rotation.y = mp.yaw + dyaw * t;
    motoModel.pose(moto.wheelSpin, moto.steer, moto.lean, moto.pitch);
    if (riding) {
      feet.copy(motoModel.root.position);
    } else {
      feet.set(
        character.prev.x + (character.curr.x - character.prev.x) * t,
        character.prev.y + (character.curr.y - character.prev.y) * t,
        character.prev.z + (character.curr.z - character.prev.z) * t,
      );
    }
    const speed = riding ? Math.abs(moto.speed) : character.horizontalSpeed();
    if (!riding && speed > 0.3) {
      const target = Math.atan2(-character.vel.x, -character.vel.z);
      let d = target - heading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      heading += d * Math.min(1, dt * playerCfg.turnSpeed);
    }
    if (riding) {
      avatar.ride(speed);
      // La cámara se coloca sola detrás de la moto si el ratón está quieto
      if (now - lastMouseMs > MC.camera.followDelay * 1000 && Math.abs(moto.speed) > 2) {
        let dy = moto.yaw - orbit.yaw;
        dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        orbit.yaw += dy * Math.min(1, MC.camera.followRate * dt);
      }
    } else {
      avatar.root.position.copy(feet);
      avatar.root.rotation.y = heading;
      avatar.animate(speed, character.grounded, character.vel.y, dt);
    }
    if (CAPTURE === 'AERIAL') {
      camera.position.set(-260, 330, 330);
      camera.lookAt(20, 0, -20);
    } else if (fixedView) {
      camera.position.copy(fixedView.pos);
      camera.lookAt(fixedView.target);
    } else {
      orbit.update(feet, dt, riding ? MC.camera.pivotHeight : undefined);
    }
    sky.position.copy(camera.position);

    // La sombra sigue al jugador (cascada única de ±shadowExtent m).
    const shadowCenter = CAPTURE === 'AERIAL' ? new THREE.Vector3() : fixedView ? fixedView.target.clone().setY(feet.y) : feet;
    sun.target.position.copy(shadowCenter);
    sun.position.copy(shadowCenter).addScaledVector(sunDir, 150);

    renderer.render(scene, camera);
    minimap.draw(feet.x, feet.z, riding ? moto.yaw : heading, orbit.yaw,
      riding ? [] : [{ x: moto.curr.x, z: moto.curr.z, color: '#ff9f1a', label: 'moto' }]);
    // HUD de la moto
    speedoEl.style.display = riding && !CAPTURE ? 'block' : 'none';
    if (riding) speedoEl.innerHTML = `${(Math.abs(moto.speed) * 3.6).toFixed(0)}<span>km/h</span>`;
    const msg = now < noticeUntil ? notice : !riding && nearMoto ? 'E — subirse a la moto' : riding && speed < 3 ? 'E — bajarse' : '';
    if (promptEl.textContent !== msg) promptEl.textContent = msg;
    promptEl.style.display = msg && !CAPTURE ? 'block' : 'none';
    if (helpRiding !== riding) { helpRiding = riding; helpEl.innerHTML = riding ? helpRide : helpWalk; }

    fpsFrames++; fpsTime += dt; frames++;
    if (fpsTime >= 0.5) {
      fps = fpsFrames / fpsTime;
      fpsFrames = 0; fpsTime = 0;
      const info = renderer.info.render as unknown as { drawCalls?: number; calls?: number; triangles: number };
      statsEl.textContent =
        `${fps.toFixed(0)} FPS · ${backend}\n` +
        `x ${feet.x.toFixed(1)}  z ${feet.z.toFixed(1)}  y ${feet.y.toFixed(1)} m (${(meta.origin.elevation + feet.y).toFixed(0)} m s.n.m.)\n` +
        `${speed.toFixed(1)} m/s ${character.grounded ? '' : '· en el aire'}\n` +
        `draw calls ${info.drawCalls ?? info.calls ?? '?'} · tris ${(info.triangles / 1000).toFixed(0)}k`;
    }
    if (frames === 3) loading.classList.add('hidden');
    window.__zipa = {
      ready: frames > 30, backend, fps, x: feet.x, y: feet.y, z: feet.z, grounded: character.grounded,
      speed, camDistance: orbit.current, camDesired: orbit.distance, cam: camera.position.toArray(),
      riding, motoSpeed: moto.speed, moto: [moto.curr.x, moto.curr.y, moto.curr.z], motoYaw: moto.yaw, motoLean: moto.lean,
      buildings: bmeta.length, drawCalls: buildings.drawCalls, buildingTriangles: buildings.triangles,
      teleport: (x: number, z: number) => character.teleport(x, hf.heightAt(x, z) + 0.05, z),
      setView: (yaw: number, pitch: number, dist: number) => { orbit.yaw = yaw; orbit.pitch = pitch; orbit.distance = dist; },
      debug: () => ({ phys, buildings, character, moto }),
      placeMoto: (x: number, z: number, yaw: number) => moto.teleport(x, hf.heightAt(x, z) + 0.05, z, yaw),
    };
  });
}

main().catch((e) => {
  console.error(e);
  const el = document.getElementById('loading')!;
  el.textContent = `Error: ${e.message ?? e}`;
});
