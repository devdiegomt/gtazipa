import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { MotoDynamics, atmosphere, type MotoEnv, type MotoSpec } from '../src/vehicles/motoDynamics';
import vehicles from '../src/data/vehicles.json';

/**
 * La moto debe comportarse como una 125 cc real (referencia: Honda CB125F, ~100 km/h de punta a nivel del mar)
 * y sentir la altitud de Zipaquirá (cota del origen del mundo, ~2 616 m).
 */
const spec = vehicles.moto.spec as unknown as MotoSpec;
const surf = vehicles.moto.surfaces as Record<string, { mu: number; crr: number }>;
const world = JSON.parse(readFileSync('public/world/world.json', 'utf8'));
const zipa = atmosphere(world.origin.elevation);
const env = (surface: string, atm = zipa): MotoEnv => ({ ...surf[surface], ...atm, slopeSin: 0 });
const DT = 1 / 60;

function run(m: MotoDynamics, seconds: number, inp: { throttle: number; brake: number; steer: number }, e: MotoEnv, until?: (m: MotoDynamics) => boolean) {
  let t = 0, dist = 0;
  while (t < seconds) {
    m.step(DT, inp, e);
    dist += m.v * DT;
    t += DT;
    if (until?.(m)) break;
  }
  return { t, dist };
}

describe('moto 125 cc', () => {
  it('la altitud reduce la densidad del aire y la potencia (~77 % en Zipaquirá)', () => {
    console.log(`Zipaquirá ${world.origin.elevation} m: densidad ${zipa.airDensity.toFixed(3)} kg/m³, potencia ${(zipa.powerFactor * 100).toFixed(0)} %`);
    expect(zipa.airDensity).toBeGreaterThan(0.9);
    expect(zipa.airDensity).toBeLessThan(1.0);
  });

  it('velocidad máxima: ~100 km/h a nivel del mar, menos en Zipaquirá', () => {
    const sea = new MotoDynamics(spec);
    run(sea, 90, { throttle: 1, brake: 0, steer: 0 }, env('asphalt', atmosphere(0)));
    const alt = new MotoDynamics(spec);
    run(alt, 90, { throttle: 1, brake: 0, steer: 0 }, env('asphalt'));
    console.log(`punta: nivel del mar ${sea.speedKmh.toFixed(1)} km/h · Zipaquirá ${alt.speedKmh.toFixed(1)} km/h · marcha ${alt.gear + 1}`);
    expect(sea.speedKmh).toBeGreaterThan(92);
    expect(sea.speedKmh).toBeLessThan(110);
    expect(alt.speedKmh).toBeGreaterThan(80);
    expect(alt.speedKmh).toBeLessThan(sea.speedKmh);
    expect(alt.gear).toBe(4);
  });

  it('0–50 km/h en 4–8 s (125 cc a 2 600 m)', () => {
    const m = new MotoDynamics(spec);
    const { t } = run(m, 20, { throttle: 1, brake: 0, steer: 0 }, env('asphalt'), (x) => x.speedKmh >= 50);
    console.log(`0–50 km/h: ${t.toFixed(2)} s, marcha ${m.gear + 1}`);
    expect(t).toBeGreaterThan(4);
    expect(t).toBeLessThan(8);
  });

  it('frenada de 50 km/h: 11–17 m en asfalto, más larga en adoquín', () => {
    const brake = (surface: string) => {
      const m = new MotoDynamics(spec);
      m.v = 50 / 3.6;
      m.gear = 2;
      return run(m, 20, { throttle: 0, brake: 1, steer: 0 }, env(surface), (x) => x.v <= 0.01).dist;
    };
    const asf = brake('asphalt'), ado = brake('sett');
    console.log(`frenada 50→0: asfalto ${asf.toFixed(1)} m · adoquín (sett) ${ado.toFixed(1)} m`);
    expect(asf).toBeGreaterThan(11);
    expect(asf).toBeLessThan(17);
    expect(ado).toBeGreaterThan(asf * 1.2);
  });

  it('inclinación máxima limitada por la adherencia (asfalto > adoquín) y giro coherente', () => {
    const lean = (surface: string) => {
      const m = new MotoDynamics(spec);
      m.v = 40 / 3.6;
      run(m, 3, { throttle: 0.35, brake: 0, steer: 1 }, env(surface));
      return m;
    };
    const a = lean('asphalt'), c = lean('sett');
    const deg = (r: number) => (r * 180) / Math.PI;
    const radius = a.v / a.yawRate;
    console.log(`inclinación máx: asfalto ${deg(a.lean).toFixed(1)}° · adoquín ${deg(c.lean).toFixed(1)}° · radio a ${a.speedKmh.toFixed(0)} km/h: ${radius.toFixed(1)} m`);
    expect(deg(a.lean)).toBeGreaterThan(30);
    expect(deg(a.lean)).toBeLessThan(45);
    expect(deg(c.lean)).toBeLessThan(deg(a.lean) - 5);
    expect(a.yawRate).toBeGreaterThan(0); // steer > 0 = derecha
    // Equilibrio en curva: v²/R = g·tan(φ)
    expect(Math.abs((a.v * a.v) / radius - 9.81 * Math.tan(a.lean))).toBeLessThan(0.5);
  });

  it('frenar fuerte en plena curva hace que la moto se abra (círculo de fricción)', () => {
    const m = new MotoDynamics(spec);
    m.v = 45 / 3.6;
    run(m, 2, { throttle: 0.4, brake: 0, steer: 1 }, env('asphalt'));
    let maxSlip = 0;
    for (let i = 0; i < 60; i++) { m.step(DT, { throttle: 0, brake: 1, steer: 1 }, env('asphalt')); maxSlip = Math.max(maxSlip, m.slip); }
    expect(maxSlip).toBeGreaterThan(0);
  });

  it('no tiene reversa: detenida y con freno, se empuja hacia atrás a paso de peatón', () => {
    const m = new MotoDynamics(spec);
    run(m, 1.5, { throttle: 0, brake: 1, steer: 0 }, env('asphalt'));
    expect(m.v).toBeLessThan(0);
    expect(m.v).toBeGreaterThan(-1.5);
  });
});
