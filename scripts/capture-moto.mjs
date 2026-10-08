// Captura de primer plano de la moto estacionada y montada (revisión visual).
import { startGame } from './harness.mjs';

const g = await startGame({ width: 1200, height: 800 });
try {
  await g.open('');
  const s = await g.state();
  const [mx, , mz] = s.moto;
  const yaw = s.motoYaw;
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);
  // de lado: el jugador queda al otro lado de la moto y la cámara (detrás de él) la encuadra de perfil
  await g.page.evaluate(([x, z]) => window.__zipa.teleport(x, z), [mx - rx * 1.5, mz - rz * 1.5]);
  await g.page.evaluate(([y]) => window.__zipa.setView(y, 0.2, 5.5), [Math.atan2(rx, rz)]);
  await g.page.waitForTimeout(1500);
  await g.page.screenshot({ path: 'docs/captures/moto_estacionada.png' });
  // montado, vista lateral
  await g.page.evaluate(([x, z]) => window.__zipa.teleport(x, z), [mx + rx * 1.3, mz + rz * 1.3]);
  await g.page.waitForTimeout(300);
  await g.page.keyboard.press('e');
  await g.page.waitForTimeout(400);
  await g.page.evaluate(([y]) => window.__zipa.setView(y, 0.12, 4.2), [Math.atan2(rx, rz)]);
  await g.page.waitForTimeout(1200);
  await g.page.screenshot({ path: 'docs/captures/moto_montada.png' });
  console.log('ok', g.errors);
} finally {
  await g.close();
}
