// Capturas desde el centro de la Plaza de los Comuneros hacia los 4 puntos cardinales.
// Uso: npm run capture   (salida en docs/captures/)
import { mkdirSync } from 'node:fs';
import { startGame } from './harness.mjs';

const OUT = 'docs/captures';
mkdirSync(OUT, { recursive: true });
const g = await startGame();
const PORTRAIT = { CATEDRAL: { width: 800, height: 1000 }, NARINO: { width: 800, height: 1000 } };
const names = { N: 'norte', E: 'este', S: 'sur', W: 'oeste', AERIAL: 'vista_aerea', CATEDRAL: 'catedral', TORRES: 'torres', PLAZA: 'plaza_elevada',
  INDEPENDENCIA: 'parque_independencia', INDEPENDENCIA_AEREA: 'parque_independencia_aerea', NARINO: 'parque_independencia_narino',
  TRAFICO: 'trafico_semaforo', CALLE: 'trafico_calle' };
const only = process.argv.slice(2);
try {
  for (const dir of only.length ? only : ['N', 'E', 'S', 'W', 'AERIAL', 'CATEDRAL', 'TORRES', 'PLAZA', 'INDEPENDENCIA', 'INDEPENDENCIA_AEREA', 'NARINO', 'TRAFICO', 'CALLE']) {
    await g.page.setViewportSize(PORTRAIT[dir] ?? { width: 1600, height: 900 });
    await g.open(`?capture=${dir}`);
    await g.page.waitForTimeout(2500); // sombras y mipmaps asentados
    const s = await g.state();
    const file = dir.length > 1 ? `${OUT}/${names[dir]}.png` : `${OUT}/plaza_${dir}_${names[dir]}.png`;
    await g.page.screenshot({ path: file });
    console.log(`${file}  backend=${s.backend} fps=${Number(s.fps).toFixed(0)} pos=(${Number(s.x).toFixed(1)}, ${Number(s.z).toFixed(1)})`);
  }
  if (g.errors.length) console.warn('Errores en consola:\n' + g.errors.join('\n'));
} finally {
  await g.close();
}
