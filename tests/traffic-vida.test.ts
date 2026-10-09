/**
 * Tráfico de la Fase 1 («Vida»): motos que filtran entre la fila, busetas que paran a recoger gente y direccionales.
 * Mapa real, varios minutos simulados, con un jugador que se mueve y un cono de vista como en el juego.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { TrafficSim, brakeLit, type TrafficCfg, type Vehicle } from '../src/traffic/sim';
import type { Lane, RoadGraph } from '../src/traffic/graph';
import trafico from '../src/data/trafico.json';
import { bodiesOverlap } from './traffic-overlap';

const graph: RoadGraph = JSON.parse(readFileSync('public/world/roadgraph.json', 'utf8'));
const cfg = trafico.traffic as unknown as TrafficCfg;
const DT = 1 / 30;

describe('tráfico con vida', () => {
  it('las motos filtran sin tocar a nadie, no se pasan el rojo y llegan adelante de la fila', () => {
    let filtering = 0, motoOverlaps = 0, redRuns = 0, frontMoto = 0, frontAll = 0;
    for (const seed of [2, 5, 9]) {
      const sim = new TrafficSim(graph, cfg, trafico.signals, seed);
      const prev = sim.vehicles.map((v) => v.path[0]);
      for (let t = 0; t < 240; t += DT) {
        sim.step(DT);
        const V = sim.vehicles;
        for (const v of V) {
          if (!v.active) { prev[v.id] = v.path[0]; continue; }
          if (v.type === 'moto' && Math.abs(v.lat) > 0.5) filtering++;
          // entró a un cruce desde un carril con semáforo: la luz no puede llevar más de 0,5 s en rojo
          const p = prev[v.id];
          if (p !== v.path[0] && p?.kind === 'lane' && p.signal && v.path[0].kind === 'conn') {
            const c = sim.controllers[p.signal.controller];
            const tRed = sim.light(c, p.signal.phase) === 'R' ? redAge(sim, c.offset, p.signal.phase) : 0;
            if (tRed > 0.5 && v.type === 'moto') redRuns++;
          }
          prev[v.id] = v.path[0];
        }
        for (let i = 0; i < V.length; i++) for (let j = i + 1; j < V.length; j++) {
          const a = V[i], b = V[j];
          if (a.active && b.active && (a.type === 'moto' || b.type === 'moto') && bodiesOverlap(a, b)) motoOverlaps++;
        }
        // en cada carril semaforizado con fila detenida en rojo: ¿quién está más adelante?
        if (Math.round(t * 30) % 30 === 0) {
          const head = new Map<Lane, Vehicle>();
          for (const v of V) {
            const l = v.path[0];
            if (!v.active || l.kind !== 'lane' || !l.signal || v.v > 0.3 || l.poly.length - v.s > 12) continue;
            if (sim.light(sim.controllers[l.signal.controller], l.signal.phase) !== 'R') continue;
            const h = head.get(l);
            if (!h || v.s > h.s) head.set(l, v);
          }
          for (const [l, h] of head) {
            if (!sim.vehicles.some((o) => o.active && o !== h && o.path[0] === l && o.type !== 'moto')) continue;
            frontAll++;
            if (h.type === 'moto') frontMoto++;
          }
        }
      }
    }
    console.log(`motos filtrando ${filtering} muestras; solapes con motos ${motoOverlaps}; motos en rojo ${redRuns}; ` +
      `filas en rojo con moto adelante ${frontMoto}/${frontAll}`);
    expect(filtering).toBeGreaterThan(200);
    expect(motoOverlaps).toBe(0);
    expect(redRuns).toBe(0);
    expect(frontMoto / Math.max(1, frontAll)).toBeGreaterThan(0.3);
  }, 120_000);

  it('busetas: paraderos fuera de cruces y cebras, paran unos segundos con luces de parqueo y siguen', () => {
    const sim = new TrafficSim(graph, cfg, trafico.signals, 3);
    const stops = sim.busStops;
    expect(stops.length).toBeGreaterThan(5);
    const bc = cfg.busStops!;
    for (const b of stops) {
      for (const n of graph.nodes) if (n.radius > 0) expect(Math.hypot(b.bx - n.x, b.bz - n.z)).toBeGreaterThan(n.radius + bc.fromJunction - 0.5);
      for (const c of graph.crossings as { x: number; z: number }[]) expect(Math.hypot(b.bx - c.x, b.bz - c.z)).toBeGreaterThan(bc.fromCrossing - 0.5);
    }
    const dwell = new Map<number, number>();
    let served = 0, maxDwell = 0, worstWait = 0;
    for (let t = 0; t < 600; t += DT) {
      sim.step(DT);
      for (const v of sim.vehicles) {
        if (!v.active) continue;
        if (v.type === 'buseta' && v.hazard) {
          dwell.set(v.id, (dwell.get(v.id) ?? 0) + DT);
          expect(brakeLit(v)).toBe(true);
          expect(v.v).toBeLessThan(0.3);
        } else if (dwell.has(v.id)) { served++; maxDwell = Math.max(maxDwell, dwell.get(v.id)!); dwell.delete(v.id); }
        if (v.why === 'busstop' || (v.blocker >= 0 && sim.vehicles[v.blocker].hazard)) worstWait = Math.max(worstWait, v.wait);
      }
    }
    console.log(`${stops.length} paraderos; ${served} paradas atendidas, la más larga ${maxDwell.toFixed(1)} s; ` +
      `espera máxima detrás de una buseta parada ${worstWait.toFixed(1)} s`);
    expect(served).toBeGreaterThan(3);
    expect(maxDwell).toBeLessThan(bc.dwell[1] + 1.5);
    expect(worstWait).toBeLessThan(bc.dwell[1] + 10);
  }, 120_000);

  it('direccionales: se encienden antes de girar y del lado del giro', () => {
    const sim = new TrafficSim(graph, cfg, trafico.signals, 7);
    let turns = 0, signalled = 0, wrong = 0;
    const prev = sim.vehicles.map((v) => v.path[0]);
    const blinkBefore = sim.vehicles.map(() => 0);
    for (let t = 0; t < 180; t += DT) {
      sim.step(DT);
      for (const v of sim.vehicles) {
        if (!v.active) { prev[v.id] = v.path[0]; continue; }
        const p0 = v.path[0];
        if (p0 !== prev[v.id] && p0.kind === 'conn' && (p0.turn === 'L' || p0.turn === 'R')) {
          turns++;
          const want = p0.turn === 'R' ? 1 : -1;
          if (blinkBefore[v.id] === want) signalled++;
          else if (blinkBefore[v.id] === -want) wrong++;
        }
        if (p0.kind === 'lane') blinkBefore[v.id] = v.blink;
        prev[v.id] = p0;
      }
    }
    console.log(`${turns} giros; ${signalled} con la direccional correcta antes de entrar; ${wrong} del lado contrario`);
    expect(turns).toBeGreaterThan(50);
    expect(signalled / turns).toBeGreaterThan(0.9);
    expect(wrong).toBe(0);
  }, 60_000);
});

/** Segundos que lleva la fase en rojo (misma cuenta que TrafficSim.light). */
function redAge(sim: TrafficSim, offset: number, phase: 0 | 1) {
  const s = trafico.signals, half = s.green + s.yellow + s.allRed;
  const t = (sim.time + offset) % sim.cycle;
  const local = phase === 0 ? t : (t + half) % sim.cycle;
  return local - (s.green + s.yellow);
}
