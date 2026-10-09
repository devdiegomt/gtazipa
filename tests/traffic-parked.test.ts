/**
 * Vehículos parqueados (Fase 1): sólo en el carril de parqueo, junto al sardinel, lejos de cruces, cebras y paraderos,
 * sin montarse entre sí; y el tráfico (motos que filtran y busetas que se orillan incluidas) nunca los toca.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { TrafficSim, type TrafficCfg, type Vehicle } from '../src/traffic/sim';
import { Poly, type RoadGraph } from '../src/traffic/graph';
import { layoutParked, parkedColliders, type Parked, type ParkedCfg } from '../src/traffic/parked';
import trafico from '../src/data/trafico.json';
import { bodiesOverlap } from './traffic-overlap';

const graph: RoadGraph = JSON.parse(readFileSync('public/world/roadgraph.json', 'utf8'));
const cfg = trafico.traffic as unknown as TrafficCfg;
const pcfg = trafico.traffic.parked as unknown as ParkedCfg;
const DT = 1 / 30;

/** Huella de un parqueado con la forma que usa bodiesOverlap. */
const body = (q: Parked) => ({ x: q.x, z: q.z, tx: -Math.sin(q.yaw), tz: -Math.cos(q.yaw), length: q.length, width: q.width }) as Vehicle;
/** Esquinas de la huella. */
function corners(q: Parked) {
  const tx = -Math.sin(q.yaw), tz = -Math.cos(q.yaw), rx = -tz, rz = tx, hl = q.length / 2, hw = q.width / 2;
  return [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([a, b]) => [q.x + tx * hl * a + rx * hw * b, q.z + tz * hl * a + rz * hw * b]);
}
/** Distancia con signo de (x, z) al eje de la arista, positiva hacia `side`, y abscisa más cercana. */
function lateral(poly: Poly, side: number, x: number, z: number) {
  let best = Infinity, lat = 0, s = 0;
  const p = { x: 0, z: 0, tx: 0, tz: 1 };
  for (let t = 0; t <= poly.length; t += 0.25) {
    poly.at(t, p);
    const d = Math.hypot(x - p.x, z - p.z);
    if (d < best) { best = d; lat = ((x - p.x) * -p.tz + (z - p.z) * p.tx) * side; s = t; }
  }
  return { lat, s };
}

describe('vehículos parqueados', () => {
  const sim = new TrafficSim(graph, cfg, trafico.signals, 4);
  const parked = layoutParked(graph, sim, pcfg);

  it('deterministas, variados y sólo en carriles de parqueo, junto al sardinel', () => {
    expect(layoutParked(graph, sim, pcfg)).toEqual(parked);
    const n = (t: string) => parked.filter((q) => q.type === t).length;
    console.log(`${parked.length} parqueados: ${n('carro')} carros, ${n('taxi')} taxis, ${n('camioneta')} camionetas, ${n('moto')} motos`);
    expect(parked.length).toBeGreaterThan(40);
    for (const t of ['carro', 'taxi', 'camioneta', 'moto']) expect(n(t)).toBeGreaterThan(2);
    const nodes = new Map(graph.nodes.map((k) => [k.id, k]));
    for (const q of parked) {
      const e = graph.edges.find((k) => k.id === q.edge)!;
      expect(q.side === 1 ? sim.parkR[e.id] : sim.parkL[e.id]).toBe(1);
      const poly = new Poly(e.pts), W = e.width / 2, spare = q.side === 1 ? sim.spareR[e.id] : sim.spareL[e.id];
      for (const [x, z] of corners(q)) {
        const { lat, s } = lateral(poly, q.side, x, z);
        expect(lat).toBeLessThan(W - pcfg.curbGap + 0.1);               // no se sube al andén (en curva la esquina sale un poco)
        expect(lat).toBeGreaterThan(W - spare - 0.15 - 0.02);           // no invade el carril
        expect(s).toBeGreaterThan(nodes.get(e.from)!.radius + pcfg.fromJunction - 0.3);
        expect(s).toBeLessThan(poly.length - nodes.get(e.to)!.radius - pcfg.fromJunction + 0.3);
      }
      for (const c of graph.crossings as { x: number; z: number }[]) expect(Math.hypot(c.x - q.x, c.z - q.z)).toBeGreaterThan(pcfg.fromCrossing);
      for (const b of sim.busStops) expect(Math.hypot(b.bx - q.x, b.bz - q.z)).toBeGreaterThan(pcfg.fromBusStop);
    }
  });

  it('nadie se monta sobre otro; las motos, en diagonal con la rueda trasera hacia el sardinel', () => {
    for (let i = 0; i < parked.length; i++) for (let j = i + 1; j < parked.length; j++) {
      expect(bodiesOverlap(body(parked[i]), body(parked[j]), 0.02)).toBe(false);
    }
    for (const q of parked.filter((k) => k.type === 'moto')) {
      const e = graph.edges.find((k) => k.id === q.edge)!, poly = new Poly(e.pts);
      const tx = -Math.sin(q.yaw), tz = -Math.cos(q.yaw);
      const front = lateral(poly, q.side, q.x + tx, q.z + tz).lat, rear = lateral(poly, q.side, q.x - tx, q.z - tz).lat;
      expect(rear - front).toBeGreaterThan(1.2);   // ~2 · sen 60°
    }
  });

  it('cajas de colisión apoyadas en el suelo, una por vehículo', () => {
    const col = parkedColliders(parked, (x, z) => 0.01 * x + 2600);
    expect(col.length).toBe(parked.length);
    for (const [i, c] of col.entries()) {
      expect(c.y - c.hy).toBeCloseTo(0.01 * parked[i].x + 2600, 6);
      expect(c.hz).toBe(parked[i].length / 2);
      expect(c.hy).toBeGreaterThan(0.5);
    }
  });

  it('el tráfico nunca toca un parqueado (motos que filtran y busetas que se orillan incluidas)', () => {
    let touches = 0, near = 0;
    for (const seed of [4, 8]) {
      const s = new TrafficSim(graph, cfg, trafico.signals, seed);
      // jugador en el centro de los carriles de parqueo, para que el tráfico circule por allí
      const cx = parked.reduce((a, q) => a + q.x, 0) / parked.length, cz = parked.reduce((a, q) => a + q.z, 0) / parked.length;
      for (let t = 0; t < 180; t += DT) {
        s.step(DT, [], { x: cx, z: cz });
        for (const v of s.vehicles) {
          if (!v.active) continue;
          for (const q of parked) {
            if (Math.abs(v.x - q.x) > 8 || Math.abs(v.z - q.z) > 8) continue;
            near++;
            if (bodiesOverlap(v, body(q), 0.05)) touches++;
          }
        }
      }
    }
    console.log(`${near} muestras de vehículos junto a un parqueado; ${touches} contactos`);
    expect(near).toBeGreaterThan(1000);
    expect(touches).toBe(0);
  }, 120_000);
});
