/**
 * Interbloqueos en cruces: junctionWaitTimeout (turno para quien más lleva esperando y prelación para romper ciclos
 * de espera) en el mapa real y en un circuito sintético donde dos vehículos se bloquean mutuamente la salida.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { TrafficSim, type TrafficCfg, type Vehicle } from '../src/traffic/sim';
import type { Lane, Piece, RoadGraph, REdge, RNode } from '../src/traffic/graph';
import trafico from '../src/data/trafico.json';

const graph: RoadGraph = JSON.parse(readFileSync('public/world/roadgraph.json', 'utf8'));
const cfg = trafico.traffic as unknown as TrafficCfg;
const DT = 1 / 30;
const on = (v: Vehicle) => v.active !== false;   // (el código anterior no tenía `active`)

describe('interbloqueos', () => {
  it('sin el jugador estorbando, nadie espera más de dos ciclos de semáforo (10 minutos)', () => {
    const sim = new TrafficSim(graph, cfg, trafico.signals, 1);
    let worst = 0, who = '';
    for (let t = 0; t < 600; t += DT) {
      sim.step(DT);
      for (const v of sim.vehicles) {
        if (on(v) && v.wait > worst) { worst = v.wait; who = `v${v.id} (${v.why}) en (${v.x.toFixed(0)}, ${v.z.toFixed(0)})`; }
      }
    }
    console.log(`espera máxima ${worst.toFixed(1)} s: ${who}; ciclo de semáforo ${sim.cycle} s`);
    expect(worst).toBeLessThan(2 * sim.cycle);
  }, 60_000);

  it('dos vehículos que se bloquean la salida mutuamente (circuito de carriles cortos) se destraban tras el timeout', () => {
    // P —(arco norte)→ Q —(arco sur)→ P, con una entrada a P y una salida de Q (ambos cruces de grado 3)
    const node = (id: number, x: number, z: number, edges: number[]): RNode =>
      ({ id, x, z, y: 0, edges, exit: false, degree: edges.length, radius: edges.length >= 3 ? 4 : 0 });
    const edge = (id: number, from: number, to: number, pts: [number, number][]): REdge => ({ id, way: id, name: null,
      highway: 'residential', from, to, pts, width: 6, surface: 'asphalt', fw: 1, bw: 0, oneway: 1, speed: 30,
      length: pts.slice(1).reduce((a, p, i) => a + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0) });
    const g: RoadGraph = {
      nodes: [node(1, -60, 0, [0]), node(2, 0, 0, [0, 1, 2]), node(3, 14, 0, [1, 2, 3]), node(4, 74, 0, [3])],
      edges: [edge(0, 1, 2, [[-60, 0], [0, 0]]), edge(1, 2, 3, [[0, 0], [7, 5], [14, 0]]), edge(2, 3, 2, [[14, 0], [7, -5], [0, 0]]),
        edge(3, 3, 4, [[14, 0], [74, 0]])],
      signals: [], crossings: [],
    };
    const sim = new TrafficSim(g, { ...cfg, vehicles: 2, mix: { carro: 1 } }, trafico.signals, 1);
    const lane = (e: number) => sim.lg.lanes.find((l) => l.edge.id === e)!;
    const conn = (a: Lane, b: Lane) => a.outs.find((c) => c.to === b)!;
    const north = lane(1), south = lane(2);
    const lap: Piece[] = [north, conn(north, south), south, conn(south, north)];
    // cada uno en un arco, dando vueltas: al llegar a la línea de pare la salida está ocupada por el otro
    sim.vehicles.forEach((v, i) => {
      const loop = i === 0 ? lap : [...lap.slice(2), ...lap.slice(0, 2)];
      v.path = Array.from({ length: 30 }, () => loop).flat();
      v.active = true; v.s = 4; v.v = 0; v.res = null;
      const p = v.path[0].poly.at(v.s);
      v.x = v.px = p.x; v.z = v.pz = p.z; v.tx = v.ptx = p.tx; v.tz = v.ptz = p.tz;
    });
    expect(north.poly.length).toBeLessThan(12);   // la cola de quien espera en la línea deja sin espacio la salida del otro
    let worst = 0, minDist = Infinity, crossings = 0;
    const prev = sim.vehicles.map((v) => v.path[0]);
    for (let t = 0; t < 60; t += DT) {
      sim.step(DT);
      const [a, b] = sim.vehicles;
      expect(on(a) && on(b)).toBe(true);
      minDist = Math.min(minDist, Math.hypot(a.x - b.x, a.z - b.z));
      for (const v of sim.vehicles) {
        worst = Math.max(worst, v.wait);
        if (v.path[0] !== prev[v.id] && v.path[0].kind === 'conn') crossings++;
        prev[v.id] = v.path[0];
      }
    }
    console.log(`circuito: ${crossings} cruces en 60 s, espera máxima ${worst.toFixed(1)} s, distancia mínima ${minDist.toFixed(2)} m`);
    expect(crossings).toBeGreaterThanOrEqual(8);
    expect(worst).toBeLessThan(cfg.junctionWaitTimeout + 5);
    expect(minDist).toBeGreaterThan(sim.vehicles[0].length);
  }, 30_000);

  it('último recurso: detenido tras un obstáculo (la moto estacionada) se recicla sólo si no se ve; ante el jugador nunca', () => {
    const cases: [string, boolean, boolean, boolean][] = [
      ['moto a la vista', false, true, false], ['moto fuera de la vista', false, false, true], ['jugador fuera de la vista', true, false, false]];
    for (const [name, isPlayer, seen, recycled] of cases) {
      const sim = new TrafficSim(graph, { ...cfg, vehicles: 1 }, trafico.signals, 4);
      const v = sim.vehicles[0];
      sim.step(DT);
      const lane = v.path[0];
      const q = lane.poly.at(Math.min(lane.poly.length - 1, v.s + 18));
      const obs = [{ x: q.x, z: q.z, r: 0.6, isPlayer }];
      let at = -1, px = v.x, pz = v.z;
      for (let t = 0; t < cfg.stuckRecycle! + 15; t += DT) {
        sim.step(DT, obs, null, () => seen);
        if (at < 0 && (!on(v) || Math.hypot(v.x - px, v.z - pz) > 15)) at = sim.time;
        px = v.x; pz = v.z;
      }
      console.log(`${name}: ${at < 0 ? 'sigue esperando' : `reciclado a los ${at.toFixed(1)} s`}`);
      if (recycled) {
        expect(at).toBeGreaterThan(cfg.stuckRecycle!);
        expect(at).toBeLessThan(cfg.stuckRecycle! + 10);
      } else {
        expect(at).toBe(-1);
        expect(v.v).toBeLessThan(0.3);
      }
    }
  }, 30_000);
});
