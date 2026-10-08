import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { TrafficSim, type TrafficCfg } from '../src/traffic/sim';
import type { RoadGraph } from '../src/traffic/graph';
import trafico from '../src/data/trafico.json';

const graph: RoadGraph = JSON.parse(readFileSync('public/world/roadgraph.json', 'utf8'));
const cfg = trafico.traffic as unknown as TrafficCfg;
const DT = 1 / 30;

function run(sim: TrafficSim, seconds: number, each?: (sim: TrafficSim) => void) {
  for (let t = 0; t < seconds; t += DT) { sim.step(DT); each?.(sim); }
}

describe('tráfico', () => {
  it('el grafo de carriles respeta los sentidos de OSM (tránsito por la derecha)', () => {
    const sim = new TrafficSim(graph, cfg, trafico.signals, 1);
    for (const l of sim.lg.lanes) {
      if (l.edge.oneway === 1) expect(l.dir).toBe(1);
      if (l.edge.oneway === -1) expect(l.dir).toBe(-1);
    }
    // en una vía de doble sentido, cada carril queda a la derecha de su sentido de marcha
    const two = sim.lg.lanes.find((l) => l.edge.fw && l.edge.bw && l.poly.length > 20)!;
    const e = two.edge;
    const mid = two.poly.at(two.poly.length / 2);
    // vector desde el eje de la vía hacia el carril, comparado con la derecha de la marcha (-tz, tx)
    const pts = two.dir === 1 ? e.pts : [...e.pts].reverse();
    let best = Infinity, cx = 0, cz = 0;
    for (const [x, z] of pts) { const d = Math.hypot(x - mid.x, z - mid.z); if (d < best) { best = d; cx = x; cz = z; } }
    expect((mid.x - cx) * -mid.tz + (mid.z - cz) * mid.tx).toBeGreaterThan(0);
    console.log(`${sim.lg.lanes.length} carriles, ${sim.lg.connectors.length} conectores, ${sim.controllers.length} controladores de semáforo`);
  });

  it('los vehículos circulan sin atravesarse (2 minutos simulados)', () => {
    const sim = new TrafficSim(graph, cfg, trafico.signals, 2);
    let minGap = Infinity, moving = 0, samples = 0;
    run(sim, 120, (s) => {
      for (let i = 0; i < s.vehicles.length; i++) {
        const a = s.vehicles[i];
        for (let j = i + 1; j < s.vehicles.length; j++) {
          const b = s.vehicles[j];
          // mismo carril/pieza y sentido: separación entre extremos
          if (a.path[0] === b.path[0]) {
            const g = Math.abs(a.s - b.s) - (a.length + b.length) / 2;
            minGap = Math.min(minGap, g);
          }
        }
        if (a.v > 1) moving++;
        samples++;
      }
    });
    console.log(`${sim.vehicles.length} vehículos; separación mínima en el mismo carril ${minGap.toFixed(2)} m; en movimiento ${(100 * moving / samples).toFixed(0)} % del tiempo`);
    expect(sim.vehicles.length).toBeGreaterThan(cfg.vehicles * 0.8);
    expect(minGap).toBeGreaterThan(0.3);
    expect(moving / samples).toBeGreaterThan(0.4);
  }, 60_000);

  it('ningún par de vehículos se superpone, tampoco dentro de los cruces (3 minutos)', () => {
    const sim = new TrafficSim(graph, cfg, trafico.signals, 5);
    let overlaps = 0;
    run(sim, 180, (s) => {
      const V = s.vehicles;
      for (let i = 0; i < V.length; i++) {
        for (let j = i + 1; j < V.length; j++) {
          const a = V[i], b = V[j];
          const d = Math.hypot(a.x - b.x, a.z - b.z);
          if (d < Math.min(a.length, b.length) * 0.45 + 0.3 && d < (a.width + b.width) / 2) overlaps++;
        }
      }
    });
    expect(overlaps).toBe(0);
  }, 60_000);

  it('nadie cruza la línea de pare con el semáforo en rojo', () => {
    const sim = new TrafficSim(graph, cfg, trafico.signals, 3);
    let violations = 0, stoppedAtRed = 0;
    const prev = new Map<number, { piece: unknown }>();
    run(sim, 180, (s) => {
      for (const v of s.vehicles) {
        const before = prev.get(v.id);
        const cur = v.path[0];
        if (before && before.piece !== cur && (before.piece as { kind: string }).kind === 'lane') {
          const lane = before.piece as { signal?: { controller: number; phase: 0 | 1 } };
          if (lane.signal && cur.kind === 'conn') {
            const st = s.light(s.controllers[lane.signal.controller], lane.signal.phase);
            if (st === 'R') violations++;
          }
        }
        if (cur.kind === 'lane' && cur.signal && v.v < 0.2 && s.light(s.controllers[cur.signal.controller], cur.signal.phase) === 'R') stoppedAtRed++;
        prev.set(v.id, { piece: cur });
      }
    });
    console.log(`semáforos: ${stoppedAtRed} muestras de vehículos detenidos en rojo, ${violations} cruces en rojo`);
    expect(stoppedAtRed).toBeGreaterThan(0);
    expect(violations).toBe(0);
  }, 60_000);

  it('frena ante el jugador parado en la calzada y pita', () => {
    const sim = new TrafficSim(graph, { ...cfg, vehicles: 1 }, trafico.signals, 4);
    const v = sim.vehicles[0];
    sim.step(DT);
    // jugador 18 m adelante en el camino del vehículo
    const lane = v.path[0];
    const s = Math.min(lane.poly.length - 1, v.s + 18);
    const p = lane.poly.at(s);
    let honked = false;
    for (let t = 0; t < 12; t += DT) { sim.step(DT, [{ x: p.x, z: p.z, r: 0.4, isPlayer: true }]); if (sim.honks.length) honked = true; }
    const d = Math.hypot(v.x - p.x, v.z - p.z);
    expect(v.v).toBeLessThan(0.3);
    expect(d).toBeGreaterThan(v.length / 2 + 0.4);
    expect(honked).toBe(true);
  });
});
