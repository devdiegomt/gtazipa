// Capturas de la moto: estacionada (3/4 delantero), detenida con el pie en el suelo (lado izquierdo)
// y en curva con inclinación. Uso: npm run capture-moto  (salida en docs/captures/moto_*.png)
import { startGame } from './harness.mjs';

const g = await startGame({ width: 1200, height: 800 });
const { page } = g;
const wait = (ms) => page.waitForTimeout(ms);
try {
  await g.open('');
  let s = await g.state();
  const [mx, , mz] = s.moto;
  const yaw = s.motoYaw;
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);   // adelante de la moto
  const rx = -fz, rz = fx;                            // derecha de la moto
  const view = (dirX, dirZ, pitch, dist) => page.evaluate(([y, p, d]) => window.__zipa.setView(y, p, d), [Math.atan2(dirX, dirZ), pitch, dist]);

  // 1) estacionada, 3/4 delantero derecho (el jugador queda al otro lado)
  await page.evaluate(([x, z]) => window.__zipa.teleport(x, z), [mx - rx * 2.2 - fx * 1.0, mz - rz * 2.2 - fz * 1.0]);
  await view(rx * 0.8 + fx * 0.6, rz * 0.8 + fz * 0.6, 0.25, 6.5);
  await wait(1500);
  await page.screenshot({ path: 'docs/captures/moto_estacionada.png' });

  // 2) montado y detenido, lado izquierdo: pie izquierdo en el suelo
  await page.evaluate(([x, z]) => window.__zipa.teleport(x, z), [mx - rx * 1.3, mz - rz * 1.3]);
  await wait(300);
  await page.keyboard.press('e');
  await wait(600);
  await view(-rx, -rz, 0.1, 3.8);
  await wait(1200);
  await page.screenshot({ path: 'docs/captures/moto_montada.png' });

  // 3) en curva: acelera y gira a la derecha; cámara detrás
  await page.keyboard.down('w');
  await wait(3500);
  await page.keyboard.down('d');
  await wait(700);
  s = await g.state();
  await view(-Math.sin(s.motoYaw) * -1, -Math.cos(s.motoYaw) * -1, 0.18, 5.5);
  await wait(250);
  await page.screenshot({ path: 'docs/captures/moto_curva.png' });
  s = await g.state();
  console.log(`curva: ${(s.motoSpeed * 3.6).toFixed(0)} km/h, ${s.motoGear}ª, ${Math.round(s.motoRpm)} rpm, inclinación ${(s.motoLean * 180 / Math.PI).toFixed(0)}°, superficie ${s.motoSurface}`);
  await page.keyboard.up('d');
  await page.keyboard.up('w');
  console.log('ok', g.errors);
} finally {
  await g.close();
}
