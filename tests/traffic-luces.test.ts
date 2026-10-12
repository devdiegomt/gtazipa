/**
 * Luces de los vehículos (Fase 1): geometría (freno atrás, farolas adelante, direccionales a cada lado) y estado
 * (freno al frenar o detenido, direccional del lado que indica la simulación, parqueo en ambas, parpadeo con el reloj
 * de la simulación: en pausa no cambia).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildModel, lampState } from '../src/traffic/render';
import { TrafficSim, blinkOn, type TrafficCfg, type Vehicle, type VehicleType } from '../src/traffic/sim';
import trafico from '../src/data/trafico.json';

const TYPES: VehicleType[] = ['carro', 'taxi', 'moto', 'buseta', 'camioneta'];

describe('luces de los vehículos', () => {
  it('cada modelo tiene freno atrás, farolas adelante y una direccional a cada lado, dentro de la carrocería', () => {
    for (const type of TYPES) {
      const { paint, lamps } = buildModel(type);
      paint.computeBoundingBox();
      const half = paint.boundingBox!.max.x, kind = lamps.getAttribute('aLamp'), pos = lamps.getAttribute('position');
      const seen = new Set<number>();
      for (let i = 0; i < pos.count; i++) {
        const k = kind.getX(i), x = pos.getX(i), z = pos.getZ(i);
        seen.add(k);
        if (k === 0) expect(z, `${type}: freno atrás`).toBeGreaterThan(0);
        if (k === 3) expect(z, `${type}: farola adelante`).toBeLessThan(0);
        if (k === 1) expect(x, `${type}: direccional izquierda`).toBeLessThan(0);
        if (k === 2) expect(x, `${type}: direccional derecha`).toBeGreaterThan(0);
        expect(Math.abs(x)).toBeLessThan(half + 0.06);
      }
      expect([...seen].sort()).toEqual([0, 1, 2, 3]);
    }
    // moto parqueada: sin conductor
    const tri = (g: { getAttribute(n: string): { count: number } }) => g.getAttribute('position').count;
    expect(tri(buildModel('moto', false).fixed)).toBeLessThan(tri(buildModel('moto').fixed));
  });

  it('estado: freno, direccionales, parqueo y farola (motos siempre encendida)', () => {
    const v = { id: 3, type: 'carro', v: 8, braking: false, blink: 0, hazard: false } as Vehicle;
    const out = new Float32Array(8);
    const on = blinkOn(0, 3) ? 0 : 0.34;           // un instante con la direccional encendida
    lampState(v, on, 0, out, 1);
    expect([...out.slice(4)]).toEqual([0, 0, 0, 0]);
    v.braking = true; lampState(v, on, 0, out, 1); expect(out[4]).toBe(1);
    v.braking = false; v.v = 0; lampState(v, on, 0, out, 1); expect(out[4]).toBe(1);   // detenido
    v.v = 8; v.blink = -1; lampState(v, on, 0, out, 1); expect([out[5], out[6]]).toEqual([1, 0]);
    v.blink = 1; lampState(v, on, 0, out, 1); expect([out[5], out[6]]).toEqual([0, 1]);
    v.blink = 0; v.hazard = true; lampState(v, on, 0, out, 1); expect([out[5], out[6]]).toEqual([1, 1]);
    lampState(v, on + 1 / 3, 0, out, 1); expect([out[5], out[6]]).toEqual([0, 0]);    // medio periodo después
    v.hazard = false; lampState(v, on, 1, out, 1); expect(out[4]).toBeCloseTo(0.35, 6); expect(out[7]).toBe(1);   // de noche
    const m = { ...v, type: 'moto' } as Vehicle;
    lampState(m, on, 0, out, 0); expect(out[3]).toBe(1);
  });

  it('en el tráfico: parpadeo ~1,5 Hz a medias; congelado si la simulación no avanza', () => {
    const graph = JSON.parse(readFileSync('public/world/roadgraph.json', 'utf8'));
    const sim = new TrafficSim(graph, trafico.traffic as unknown as TrafficCfg, trafico.signals, 5);
    const out = new Float32Array(sim.vehicles.length * 4);
    let blinking = 0, lit = 0, flips = 0;
    const last = new Float32Array(sim.vehicles.length);
    for (let i = 0; i < 1800; i++) {
      sim.step(1 / 30);
      for (const v of sim.vehicles) {
        if (!v.active || v.blink === 0) continue;
        lampState(v, sim.time, 0, out, v.id);
        const s = out[v.id * 4 + (v.blink < 0 ? 1 : 2)];
        blinking++; lit += s;
        if (s !== last[v.id]) flips++;
        last[v.id] = s;
      }
    }
    expect(blinking).toBeGreaterThan(1000);
    expect(lit / blinking).toBeGreaterThan(0.4);
    expect(lit / blinking).toBeLessThan(0.6);
    expect(flips / blinking).toBeGreaterThan(0.05);              // ~3 cambios por segundo a 30 Hz = 0,1
    const a = new Float32Array(out), t = sim.time;
    for (const v of sim.vehicles) if (v.active) lampState(v, t, 0, out, v.id);
    const b = new Float32Array(out);
    for (const v of sim.vehicles) if (v.active) lampState(v, t, 0, out, v.id);   // pausa: mismo reloj, mismo estado
    expect([...out]).toEqual([...b]);
    expect(a.length).toBe(b.length);
  });
});
