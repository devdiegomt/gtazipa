/**
 * Superposición entre vehículos para las pruebas del tráfico. Con las motos que filtran (Fase 1) dos vehículos pueden ir
 * lado a lado en el mismo carril (desplazamiento lateral `lat`) y sus centros quedar a poco más de un metro: lo que
 * cuenta es si las carrocerías (rectángulos orientados, ya con el desplazamiento en x, z) se tocan.
 */
import type { Vehicle } from '../src/traffic/sim';

/** ¿Se tocan las carrocerías? (ejes separadores; `shrink` m de tolerancia por lado). */
export function bodiesOverlap(a: Vehicle, b: Vehicle, shrink = 0.1) {
  const ax = [a.tx, a.tz], ay = [-a.tz, a.tx], bx = [b.tx, b.tz], by = [-b.tz, b.tx];
  const ha = [a.length / 2 - shrink, a.width / 2 - shrink], hb = [b.length / 2 - shrink, b.width / 2 - shrink];
  const dx = b.x - a.x, dz = b.z - a.z;
  for (const [ux, uz] of [ax, ay, bx, by]) {
    const ra = ha[0] * Math.abs(ax[0] * ux + ax[1] * uz) + ha[1] * Math.abs(ay[0] * ux + ay[1] * uz);
    const rb = hb[0] * Math.abs(bx[0] * ux + bx[1] * uz) + hb[1] * Math.abs(by[0] * ux + by[1] * uz);
    if (Math.abs(dx * ux + dz * uz) > ra + rb) return false;
  }
  return true;
}

/** Apilados: centros casi en el mismo punto y carrocerías encima (el respaldo a lanes[0] de antes de la Fase 0). */
export function stacked(a: Vehicle, b: Vehicle) {
  return (a.x - b.x) ** 2 + (a.z - b.z) ** 2 < 2.25 && bodiesOverlap(a, b);
}

/** Mismo carril o conector y franjas laterales que se cruzan (no una moto que filtra al lado). */
export function sameStrip(a: Vehicle, b: Vehicle) {
  return a.path[0] === b.path[0] && Math.abs(a.lat - b.lat) < (a.width + b.width) / 2 - 0.05;
}

/** En la misma franja de la misma pieza, ¿se montan uno sobre otro a lo largo? (tolerancia `tol` m) */
export function stripOverlap(a: Vehicle, b: Vehicle, tol = 0.3) {
  return sameStrip(a, b) && Math.abs(a.s - b.s) < (a.length + b.length) / 2 - tol;
}
