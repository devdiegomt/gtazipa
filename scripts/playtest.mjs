// Pruebas jugables automáticas en navegador real: caminar, correr, saltar, colisión con edificios,
// cámara sin atravesar paredes y FPS. Uso: node scripts/playtest.mjs
import { readFileSync } from 'node:fs';
import { startGame } from './harness.mjs';

const world = JSON.parse(readFileSync('public/world/world.json', 'utf8'));
const g = await startGame();
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'OK ' : 'FALLA'}  ${name}  ${detail}`); };
const { page } = g;
const wait = (ms) => page.waitForTimeout(ms);
const hold = async (key, ms) => { await page.keyboard.down(key); await wait(ms); await page.keyboard.up(key); };

function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

try {
  await g.open('');
  await page.mouse.click(800, 450); // foco
  await wait(500);

  // FPS en reposo (vista por defecto desde la plaza)
  await wait(4000);
  let s = await g.state();
  check('FPS >= 55', s.fps >= 55, `${Number(s.fps).toFixed(1)} FPS (${s.backend}), ${s.drawCalls} draw calls de edificios`);

  // Caminar 3 s hacia el norte (cámara mira al norte por defecto)
  const s0 = await g.state();
  await hold('w', 3000);
  s = await g.state();
  const walked = Math.hypot(s.x - s0.x, s.z - s0.z);
  check('caminar', walked > 4 && walked < 8 && s.z < s0.z, `${walked.toFixed(2)} m en 3 s hacia z ${s0.z.toFixed(1)}→${s.z.toFixed(1)}`);

  // Correr
  const s1 = await g.state();
  await page.keyboard.down('Shift');
  await hold('w', 2000);
  await page.keyboard.up('Shift');
  s = await g.state();
  const ran = Math.hypot(s.x - s1.x, s.z - s1.z);
  check('correr', ran > 9, `${ran.toFixed(2)} m en 2 s`);

  // Saltar
  await wait(800);
  const s2 = await g.state();
  await page.keyboard.press('Space');
  let maxY = s2.y;
  for (let i = 0; i < 12; i++) { await wait(40); maxY = Math.max(maxY, (await g.state()).y); }
  await wait(1200);
  s = await g.state();
  check('saltar', maxY - s2.y > 0.6 && s.grounded, `altura máx +${(maxY - s2.y).toFixed(2)} m, vuelve al suelo: ${s.grounded}`);

  // Colisión: aparecer 8 m fuera de la fachada de la catedral más cercana a la plaza y caminar hacia ella
  const cat = world.landmarks[0];
  let best = null;
  for (let i = 0; i < cat.ring.length - 1; i++) {
    const [ax, az] = cat.ring[i], [bx, bz] = cat.ring[i + 1];
    const L2 = (bx - ax) ** 2 + (bz - az) ** 2;
    const t = Math.max(0, Math.min(1, -(ax * (bx - ax) + az * (bz - az)) / L2));
    const px = ax + t * (bx - ax), pz = az + t * (bz - az);
    const dd = Math.hypot(px, pz);
    if (!best || dd < best.d) best = { x: px, z: pz, d: dd };
  }
  const ux = -best.x / best.d, uz = -best.z / best.d; // de la fachada hacia la plaza
  const startX = best.x + ux * 8, startZ = best.z + uz * 8;
  const yawToWall = Math.atan2(ux, uz); // forward = (-sin, -cos) = -u
  await page.evaluate(([x, z, yaw]) => { window.__zipa.teleport(x, z); window.__zipa.setView(yaw, 0.3, 5); },
    [startX, startZ, yawToWall]);
  await wait(500);
  await hold('w', 7000);
  s = await g.state();
  const inside = pointInRing(s.x, s.z, cat.ring);
  const gap = Math.hypot(s.x - best.x, s.z - best.z);
  check('colisión con la catedral', !inside && gap < 1.0,
    `pos final (${s.x.toFixed(1)}, ${s.z.toFixed(1)}), a ${gap.toFixed(2)} m del muro, dentro de la huella: ${inside}`);

  // Cámara: ponerla del lado del muro (detrás de él) → debe acercarse y quedar fuera del edificio
  await page.evaluate(([yaw]) => window.__zipa.setView(yaw, 0.2, 10), [yawToWall + Math.PI]);
  await wait(800);
  s = await g.state();
  const camInside = pointInRing(s.cam[0], s.cam[2], cat.ring);
  check('cámara no atraviesa paredes', s.camDistance < s.camDesired - 0.5 && !camInside,
    `distancia ${Number(s.camDistance).toFixed(2)} m de ${s.camDesired} deseados; cámara dentro: ${camInside}`);

  // Materas de la plaza: no se atraviesan
  const pl = world.plaza.planters?.[0];
  if (pl) {
    await page.evaluate(([x, z, yaw]) => { window.__zipa.teleport(x, z); window.__zipa.setView(yaw, 0.3, 6); },
      [pl.x + 9, pl.z, Math.PI / 2]); // al este de la matera, mirando al oeste
    await wait(400);
    await hold('w', 4000);
    s = await g.state();
    const dc = Math.hypot(s.x - pl.x, s.z - pl.z);
    check('colisión con matera/banca', dc > 4.0, `distancia al centro ${dc.toFixed(2)} m (radio 4.0 m)`);
  }

  // ---------------- Moto
  await page.evaluate(() => window.__zipa.teleport(0, 0));
  await wait(300);
  s = await g.state();
  const dMoto = Math.hypot(s.moto[0], s.moto[2]);
  check('moto estacionada cerca del inicio', dMoto < 40, `a ${dMoto.toFixed(1)} m del centro de la plaza`);
  // acercarse y montar
  const my = s.motoYaw;
  const mrx = Math.cos(my), mrz = -Math.sin(my);   // derecha de la moto
  await page.evaluate(([x, z]) => window.__zipa.teleport(x, z), [s.moto[0] - mrx * 1.4, s.moto[2] - mrz * 1.4]);
  await wait(400);
  await page.keyboard.press('e');
  await wait(400);
  s = await g.state();
  check('subirse a la moto (E)', s.riding === true, `riding=${s.riding}`);
  // acelerar
  const m0 = s.moto;
  await hold('w', 3000);
  s = await g.state();
  const dm = Math.hypot(s.moto[0] - m0[0], s.moto[2] - m0[2]);
  check('acelerar', s.motoSpeed > 10 && dm > 15, `${(s.motoSpeed * 3.6).toFixed(0)} km/h, ${dm.toFixed(1)} m en 3 s`);
  // girar a la derecha con inclinación
  const y0 = s.motoYaw;
  await page.keyboard.down('w');
  await page.keyboard.down('d');
  let maxLean = 0;
  for (let i = 0; i < 12; i++) { await wait(100); maxLean = Math.max(maxLean, (await g.state()).motoLean); }
  await page.keyboard.up('d');
  await page.keyboard.up('w');
  s = await g.state();
  let dyaw = s.motoYaw - y0;
  dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
  check('girar a la derecha e inclinarse', dyaw < -0.3 && maxLean > 0.1,
    `giro ${(dyaw * 180 / Math.PI).toFixed(0)}°, inclinación máx ${(maxLean * 180 / Math.PI).toFixed(0)}°`);
  // frenar
  await hold(' ', 2500);
  s = await g.state();
  check('frenar', Math.abs(s.motoSpeed) < 0.5, `${(s.motoSpeed * 3.6).toFixed(1)} km/h`);
  // chocar contra la catedral a toda velocidad: no la atraviesa
  await page.evaluate(([x, z, yaw]) => window.__zipa.placeMoto(x, z, yaw), [best.x + ux * 25, best.z + uz * 25, yawToWall]);
  await page.evaluate(([yaw]) => window.__zipa.setView(yaw, 0.3, 7), [yawToWall]);
  await wait(300);
  await hold('w', 4500);
  s = await g.state();
  const motoInside = pointInRing(s.moto[0], s.moto[2], cat.ring);
  check('la moto choca con la catedral', !motoInside, `pos (${s.moto[0].toFixed(1)}, ${s.moto[2].toFixed(1)}), dentro: ${motoInside}, ${(s.motoSpeed * 3.6).toFixed(0)} km/h`);
  // captura conduciendo por la plaza hacia la catedral
  await page.evaluate(([x, z, yaw]) => window.__zipa.placeMoto(x, z, yaw), [best.x + ux * 60, best.z + uz * 60, yawToWall]);
  await page.evaluate(([yaw]) => window.__zipa.setView(yaw, 0.22, 7), [yawToWall]);
  await page.keyboard.down('w');
  await wait(1800);
  await page.keyboard.down('a');
  await wait(450);
  await page.screenshot({ path: 'docs/captures/moto.png' });
  await page.keyboard.up('a');
  await page.keyboard.up('w');
  await hold(' ', 2500);
  // bajarse
  await page.keyboard.press('e');
  await wait(500);
  s = await g.state();
  const dPl = Math.hypot(s.x - s.moto[0], s.z - s.moto[2]);
  check('bajarse de la moto (E)', s.riding === false && dPl < 2.5, `riding=${s.riding}, a ${dPl.toFixed(2)} m de la moto`);

  // FPS corriendo por la ciudad
  await page.evaluate(() => { window.__zipa.teleport(0, 0); window.__zipa.setView(Math.PI / 4, 0.3, 6); });
  await page.keyboard.down('Shift');
  await page.keyboard.down('w');
  await wait(5000);
  s = await g.state();
  await page.keyboard.up('w');
  await page.keyboard.up('Shift');
  check('FPS corriendo >= 55', s.fps >= 55, `${Number(s.fps).toFixed(1)} FPS`);

  check('sin errores de consola', g.errors.length === 0, g.errors.slice(0, 3).join(' | '));
} finally {
  await g.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} pruebas OK`);
process.exit(failed ? 1 : 0);
