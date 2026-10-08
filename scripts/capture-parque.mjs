// Primeros planos del Parque de la Independencia (fuente y estatua). Uso: npm run capture-parque
import { readFileSync } from 'node:fs';
import { startGame } from './harness.mjs';
const world = JSON.parse(readFileSync('public/world/world.json', 'utf8'));
const pk = world.parks[0];
const f = pk.fountains[0], m = pk.monuments[0];
const g = await startGame({ width: 1200, height: 800 });
try {
  await g.open('');
  // fuente: jugador a 5 m, cámara mirándola
  await g.page.evaluate(([x, z]) => window.__zipa.teleport(x, z), [f.x + 5, f.z + 3]);
  await g.page.evaluate(([y]) => window.__zipa.setView(y, 0.35, 4.5), [Math.atan2(5, 3)]);
  await g.page.waitForTimeout(1800);
  await g.page.screenshot({ path: 'docs/captures/parque_independencia_fuente.png' });
  // estatua: frente del pedestal
  const sx = m.x + m.front[0] * 6, sz = m.z + m.front[1] * 6;
  await g.page.evaluate(([x, z]) => window.__zipa.teleport(x, z), [sx, sz]);
  await g.page.evaluate(([y]) => window.__zipa.setView(y, 0.05, 2.6), [Math.atan2(m.front[0], m.front[1])]);
  await g.page.waitForTimeout(1800);
  await g.page.screenshot({ path: 'docs/captures/parque_independencia_estatua.png' });
  console.log('ok', g.errors);
} finally { await g.close(); }
