// Pruebas jugables automáticas en navegador real: caminar, correr, saltar, colisión con edificios,
// cámara sin atravesar paredes, HUD, pausa y FPS. Uso: node scripts/playtest.mjs
// (Linux sin Chrome ni GPU: ZIPA_CHROME_PATH=/ruta/a/chromium WEBGL=1; ahí, a 1–10 FPS, fallan como es de esperar las
// 11 pruebas con esperas fijas en tiempo real: FPS, movimiento, catedral y casi todas las de la moto. Ver harness.mjs.)
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
  check('FPS >= 55', s.fps >= 55, `${Number(s.fps).toFixed(1)} FPS (${s.backend}, resolución ${(s.pixelRatio * 100).toFixed(0)} %), ${s.drawCalls} draw calls de edificios`);

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

  // ---------------- Parque de la Independencia: subir la grada de la plataforma y chocar con el pedestal
  const pk = world.parks?.[0];
  if (pk?.monuments?.length) {
    const mon = pk.monuments[0];
    const stx = mon.x + mon.front[0] * 0.6, stz = mon.z + mon.front[1] * 0.6;
    const yawToStatue = Math.atan2(mon.front[0], mon.front[1]);   // forward = -front → hacia la estatua
    await page.evaluate(([x, z, yaw]) => { window.__zipa.teleport(x, z); window.__zipa.setView(yaw, 0.3, 5); },
      [stx + mon.front[0] * 9, stz + mon.front[1] * 9, yawToStatue]);
    await wait(500);
    const p0 = await g.state();
    await hold('w', 5000);
    s = await g.state();
    const dStatue = Math.hypot(s.x - stx, s.z - stz);
    check('subir a la plataforma del monumento', s.y - p0.y > 0.25, `subió ${(s.y - p0.y).toFixed(2)} m`);
    check('colisión con el pedestal de Nariño', dStatue > 0.95, `a ${dStatue.toFixed(2)} m del centro del pedestal`);
  }

  // ---------------- Tráfico
  {
    s = await g.state();
    check('tráfico circulando', s.vehicles >= 80 && s.trafficAvgSpeed > 2,
      `${s.vehicles} vehículos, velocidad media ${(s.trafficAvgSpeed * 3.6).toFixed(0)} km/h, ${s.trafficStopped} detenidos, ${s.signals} semáforos`);
    // pararse en la calzada delante de un vehículo en marcha: debe frenar y no atropellar
    const list = await page.evaluate(() => window.__zipa.vehicleList());
    // un vehículo en marcha cuyo punto 14 m adelante esté libre (sin otro vehículo a menos de 6 m)
    const free = (x, z) => list.every((o) => Math.hypot(o.x - x, o.z - z) > 6);
    const veh = list.filter((v) => v.v > 3 && v.type !== 'moto' && free(v.x + v.tx * 14, v.z + v.tz * 14))
      .sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))[0];
    if (veh) {
      await page.evaluate(([x, z]) => window.__zipa.teleport(x, z), [veh.x + veh.tx * 14, veh.z + veh.tz * 14]);
      let inside = false, minD = Infinity;
      for (let i = 0; i < 40; i++) {
        await wait(100);
        const st = await g.state();
        const vs = await page.evaluate(() => window.__zipa.vehicleList());
        for (const v of vs) {
          // ¿el jugador quedó dentro de la huella de algún vehículo?
          const dx = st.x - v.x, dz = st.z - v.z;
          const along = dx * v.tx + dz * v.tz, across = dx * -v.tz + dz * v.tx;
          const dims = { carro: [4.3, 1.75], taxi: [3.6, 1.6], moto: [2, 0.75], buseta: [7.5, 2.3], camioneta: [5.2, 1.9] }[v.type];
          if (Math.abs(along) < dims[0] / 2 && Math.abs(across) < dims[1] / 2) inside = true;
          if (v.id === veh.id) minD = Math.min(minD, Math.hypot(dx, dz));
        }
      }
      check('los vehículos frenan ante el peatón', !inside, `distancia mínima al vehículo ${minD.toFixed(2)} m, atropellado: ${inside}`);
    }
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
  await hold('w', 4500);
  s = await g.state();
  const dm = Math.hypot(s.moto[0] - m0[0], s.moto[2] - m0[2]);
  check('acelerar (125 cc: 0–50 km/h en ~6 s)', s.motoSpeed > 8.5 && s.motoSpeed < 16 && dm > 15,
    `${(s.motoSpeed * 3.6).toFixed(0)} km/h, ${dm.toFixed(1)} m en 4,5 s`);
  check('caja automática', s.motoGear >= 2 && s.motoRpm > 2500, `${s.motoGear}ª a ${Math.round(s.motoRpm)} rpm, superficie ${s.motoSurface}`);
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
  check('girar a la derecha e inclinarse', dyaw < -0.25 && maxLean > 0.3,
    `giro ${(dyaw * 180 / Math.PI).toFixed(0)}°, inclinación máx ${(maxLean * 180 / Math.PI).toFixed(0)}°`);
  // frenar
  await hold(' ', 2500);
  s = await g.state();
  check('frenar', Math.abs(s.motoSpeed) < 0.5, `${(s.motoSpeed * 3.6).toFixed(1)} km/h`);
  // chocar contra la catedral a toda velocidad: no la atraviesa
  await page.evaluate(([x, z, yaw]) => window.__zipa.placeMoto(x, z, yaw), [best.x + ux * 14, best.z + uz * 14, yawToWall]);
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
  // la moto choca con los vehículos (colliders cinemáticos)
  {
    const vs = await page.evaluate(() => window.__zipa.vehicleList());
    const st0 = await g.state();
    const target = vs.filter((v) => v.type === 'buseta' || v.type === 'camioneta' || v.type === 'carro')
      .sort((a, b) => Math.hypot(a.x - st0.moto[0], a.z - st0.moto[2]) - Math.hypot(b.x - st0.moto[0], b.z - st0.moto[2]))[0];
    if (target) {
      // de frente contra el costado del vehículo, desde 10 m
      const px = -target.tz, pz = target.tx;
      await page.evaluate(([x, z, yaw]) => window.__zipa.placeMoto(x, z, yaw), [target.x + px * 10, target.z + pz * 10, Math.atan2(px, pz)]);
      await page.evaluate(() => { const t = window.__zipa.debug().traffic; for (const v of t.vehicles) v.v0f = v.v0f; });
      await hold('w', 2200);
      const st = await g.state();
      const vs2 = await page.evaluate(() => window.__zipa.vehicleList());
      let inside = false;
      for (const v of vs2) {
        const dx = st.moto[0] - v.x, dz = st.moto[2] - v.z;
        const dims = { carro: [4.3, 1.75], taxi: [3.6, 1.6], moto: [2, 0.75], buseta: [7.5, 2.3], camioneta: [5.2, 1.9] }[v.type];
        if (Math.abs(dx * v.tx + dz * v.tz) < dims[0] / 2 - 0.2 && Math.abs(dx * -v.tz + dz * v.tx) < dims[1] / 2 - 0.2) inside = true;
      }
      check('la moto no atraviesa los vehículos', !inside, `moto dentro de un vehículo: ${inside}`);
      await hold(' ', 2000);
    }
  }
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

  // ---------------- HUD de depuración (F3) y menú de pausa (P)
  {
    const statsShown = () => page.evaluate(() => getComputedStyle(document.getElementById('stats')).display !== 'none');
    // window.__zipa se actualiza una vez por frame: esperar el estado en vez de un tiempo fijo
    const until = (fn) => page.waitForFunction(fn, null, { timeout: 15_000 }).catch(() => {});
    check('datos de depuración ocultos por defecto', !(await statsShown()), '');
    await page.keyboard.press('F3');
    await wait(300);
    const shown = await statsShown();
    await page.keyboard.press('F3');
    await wait(300);
    check('F3 muestra y oculta los datos de depuración', shown && !(await statsShown()), `visibles tras F3: ${shown}`);
    const snap = () => page.evaluate(() => ({ t: window.__zipa.debug().traffic.time, v: window.__zipa.vehicleList().map((v) => `${v.id}:${v.x},${v.z}`).join() }));
    await page.keyboard.press('p');
    await until(() => window.__zipa.paused === true);
    const a = await snap();
    await wait(1500);
    const b = await snap();
    s = await g.state();
    const menu = await page.evaluate(() => !document.getElementById('pause').hidden);
    check('P pausa y congela el tráfico', s.paused === true && menu && a.t === b.t && a.v === b.v,
      `paused=${s.paused}, menú visible: ${menu}, tiempo del tráfico ${a.t.toFixed(2)} → ${b.t.toFixed(2)}`);
    await page.click('#pause button[data-act="resume"]');
    await until(() => window.__zipa.paused === false);
    await wait(1500);
    const c = await snap();
    s = await g.state();
    check('Reanudar continúa el juego', s.paused === false && c.t > b.t, `paused=${s.paused}, tiempo del tráfico ${b.t.toFixed(2)} → ${c.t.toFixed(2)}`);
    const sep = await page.evaluate(() => {
      const h = document.getElementById('help').getBoundingClientRect(), at = document.getElementById('attribution').getBoundingClientRect();
      return h.bottom <= at.top || at.bottom <= h.top || h.right <= at.left || at.right <= h.left;
    });
    check('barra de ayuda y créditos sin solaparse', sep, '');
  }

  check('sin errores de consola', g.errors.length === 0, g.errors.slice(0, 3).join(' | '));
} finally {
  await g.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} pruebas OK`);
process.exit(failed ? 1 : 0);
