/**
 * Tráfico con el jugador en los bordes del mapa y viajes rápidos (regresión del cuelgue de la Fase 0: un vehículo
 * cuyo reciclaje fallaba quedaba con el camino vacío y el siguiente paso lanzaba TypeError; el respaldo apilaba
 * decenas de vehículos en lanes[0]).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { TrafficSim, type TrafficCfg, type Vehicle } from '../src/traffic/sim';
import type { RoadGraph } from '../src/traffic/graph';
import trafico from '../src/data/trafico.json';

const graph: RoadGraph = JSON.parse(readFileSync('public/world/roadgraph.json', 'utf8'));
const cfg = trafico.traffic as unknown as TrafficCfg;
const DT = 1 / 30;
const HALF = 400;              // meta.area.half (main.ts)
const SPEED = 25;              // moto a fondo (m/s)
const R = cfg.bubbleRadius!;

type P = { x: number; z: number };
const on = (v: Vehicle) => v.active !== false;   // (el código anterior no tenía `active`)
const near = (sim: TrafficSim, p: P) => sim.vehicles.filter((v) => on(v) && Math.hypot(v.x - p.x, v.z - p.z) <= R).length;
/** Capacidad de referencia: cuántos caben en la burbuja si el juego arrancara con el jugador en ese punto. */
const capacity = (p: P) => near(new TrafficSim(graph, cfg, trafico.signals, 11, HALF, p), p);

interface Stats { steps: number; badId: number; empty: number; stacked: number; far: number; minDist: number }
const stats = (): Stats => ({ steps: 0, badId: 0, empty: 0, stacked: 0, far: 0, minDist: Infinity });

/** Avanza un paso y revisa invariantes: id === índice, ningún activo sin camino, ninguno encima de otro. */
function step(sim: TrafficSim, p: P, st: Stats) {
  sim.step(DT, [], p);
  st.steps++;
  const V = sim.vehicles;
  for (let i = 0; i < V.length; i++) {
    const a = V[i];
    if (a.id !== i) st.badId++;
    if (!on(a)) continue;
    if (!a.path.length) st.empty++;
    // sin callback de visibilidad nada se ve: ningún activo puede seguir más allá de despawnDistance
    if (Math.hypot(a.x - p.x, a.z - p.z) > cfg.despawnDistance!) st.far++;
    for (let j = i + 1; j < V.length; j++) {
      const b = V[j];
      if (!on(b)) continue;
      const d2 = (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
      if (d2 < 2.25) st.stacked++;
      if (d2 < st.minDist) st.minDist = d2;
    }
  }
}

function expectClean(st: Stats) {
  expect(st.badId).toBe(0);
  expect(st.empty).toBe(0);
  expect(st.stacked).toBe(0);
  expect(st.far).toBe(0);
}

/** Del centro al destino a 25 m/s y quieto allí `stay` s; devuelve el promedio de vehículos en la burbuja al final. */
function trip(target: P, stay: number) {
  const sim = new TrafficSim(graph, cfg, trafico.signals, 11, HALF, { x: 0, z: 0 });
  const L = Math.hypot(target.x, target.z), total = L / SPEED + stay;
  const st = stats();
  let sum = 0, n = 0;
  for (let t = 0; t < total; t += DT) {
    const d = Math.min(L, t * SPEED);
    const p = { x: (target.x / L) * d, z: (target.z / L) * d };
    step(sim, p, st);
    if (t > total - 30) { sum += near(sim, p); n++; }
  }
  return { st, avg: sum / n, cap: capacity(target) };
}

const EDGES: [string, P][] = [['E', { x: 395, z: 0 }], ['O', { x: -395, z: 0 }], ['N', { x: 0, z: -395 }], ['S', { x: 0, z: 395 }]];
const CORNERS: [string, P][] = [['SE', { x: 390, z: 390 }], ['NO', { x: -390, z: -390 }], ['NE', { x: 390, z: -390 }], ['SO', { x: -390, z: 390 }]];

describe('tráfico en los bordes del mapa', () => {
  for (const [name, target] of [...EDGES, ...CORNERS]) {
    it(`en moto del centro al borde ${name} y quieto 2 min: sin errores, sin apilados y la burbuja se repuebla`, () => {
      const { st, avg, cap } = trip(target, 120);
      console.log(`${name}: ${avg.toFixed(0)} vehículos en la burbuja (referencia ${cap}), distancia mínima ${Math.sqrt(st.minDist).toFixed(2)} m`);
      expectClean(st);
      expect(avg).toBeGreaterThanOrEqual(0.7 * cap);
    }, 60_000);
  }

  it('viajes instantáneos entre puntos lejanos (fast travel): mismas invariantes y repoblación rápida', () => {
    const sim = new TrafficSim(graph, cfg, trafico.signals, 4, HALF, { x: 0, z: 0 });
    const st = stats();
    const hops: P[] = [{ x: 0, z: 0 }, { x: 390, z: -390 }, { x: -395, z: 10 }, { x: 0, z: 395 }, { x: -385, z: -385 },
      { x: 250, z: 120 }, { x: 392, z: 392 }, { x: -60, z: 40 }];
    for (const p of hops) {
      for (let t = 0; t < 20; t += DT) step(sim, p, st);
      const n = near(sim, p), cap = capacity(p);
      console.log(`salto a (${p.x}, ${p.z}): ${n} vehículos en la burbuja tras 20 s (referencia ${cap})`);
      expect(n).toBeGreaterThanOrEqual(0.7 * cap);
    }
    expectClean(st);
  }, 60_000);
});
