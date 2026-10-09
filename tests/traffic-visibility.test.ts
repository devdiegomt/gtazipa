/**
 * Aparición y desaparición de vehículos sólo fuera de la vista del jugador, y pitos que suenan una sola vez.
 * La visibilidad se modela como un cono de 90° delante del jugador hasta 300 m (main.ts usa frustum + distancia +
 * rayo de oclusión).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { TrafficSim, type TrafficCfg, type Vehicle } from '../src/traffic/sim';
import type { RoadGraph } from '../src/traffic/graph';
import trafico from '../src/data/trafico.json';

const graph: RoadGraph = JSON.parse(readFileSync('public/world/roadgraph.json', 'utf8'));
const cfg = trafico.traffic as unknown as TrafficCfg;
const DT = 1 / 30;
const RANGE = 300;
const on = (v: Vehicle) => v.active !== false;   // (el código anterior no tenía `active`)

/** Cono de 90° hacia `yaw` desde p; con `margin` > 0 exige que el punto quede al menos a esa distancia del borde. */
function cone(p: { x: number; z: number }, yaw: number, margin = 0) {
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  return (x: number, z: number) => {
    const dx = x - p.x, dz = z - p.z;
    const along = dx * fx + dz * fz, side = Math.abs(dx * fz - dz * fx);
    return (along - side) / Math.SQRT2 >= margin && Math.hypot(dx, dz) <= RANGE - margin;
  };
}

describe('tráfico fuera de la vista', () => {
  it('nadie aparece, desaparece ni salta de sitio donde el jugador lo ve', () => {
    const sim = new TrafficSim(graph, cfg, trafico.signals, 11, 400, { x: 0, z: 0 });
    // recorrido: en moto por tres tramos (mirando hacia adelante), quieto girando la cámara, y dos viajes instantáneos
    const legs: { to: { x: number; z: number } }[] = [{ to: { x: 300, z: -250 } }, { to: { x: -200, z: -300 } }, { to: { x: -390, z: 200 } }];
    const plan: { p: { x: number; z: number }; yaw: number }[] = [];
    let p = { x: 0, z: 0 };
    for (const { to } of legs) {
      const L = Math.hypot(to.x - p.x, to.z - p.z), yaw = Math.atan2(to.x - p.x, to.z - p.z);
      for (let d = 0; d < L; d += 25 * DT) plan.push({ p: { x: p.x + ((to.x - p.x) / L) * d, z: p.z + ((to.z - p.z) / L) * d }, yaw });
      p = to;
    }
    for (const stop of [p, { x: 200, z: 300 }, { x: 0, z: 0 }]) {
      const yaw0 = plan[plan.length - 1].yaw;
      for (let t = 0; t < 30; t += DT) plan.push({ p: stop, yaw: yaw0 + (t * 15 * Math.PI) / 180 });   // 15°/s
    }
    const prev = sim.vehicles.map((v) => ({ on: on(v), x: v.x, z: v.z }));
    let bad = 0, spawns = 0, despawns = 0, keptVisibleFar = 0;
    const log: string[] = [];
    for (const { p, yaw } of plan) {
      const visible = cone(p, yaw), clearly = cone(p, yaw, 1);   // 1 m de margen: lo que avanzó el vehículo en el paso
      sim.step(DT, [], p, visible);
      for (const v of sim.vehicles) {
        const b = prev[v.id], now = on(v);
        const jump = b.on && now && Math.hypot(v.x - b.x, v.z - b.z) > 15;
        if (b.on && !now) despawns++;
        if (!b.on && now) spawns++;
        if (jump) { spawns++; despawns++; }
        const wrong = (b.on && (!now || jump) && clearly(b.x, b.z)) || (now && (!b.on || jump) && visible(v.x, v.z));
        if (wrong) { bad++; if (log.length < 5) log.push(`v${v.id} t=${sim.time.toFixed(1)} (${b.x.toFixed(0)},${b.z.toFixed(0)}) → (${v.x.toFixed(0)},${v.z.toFixed(0)})`); }
        if (now && visible(v.x, v.z) && Math.hypot(v.x - p.x, v.z - p.z) > cfg.despawnDistance!) keptVisibleFar++;
        b.on = now; b.x = v.x; b.z = v.z;
      }
    }
    console.log(`${spawns} apariciones y ${despawns} desapariciones, ${bad} a la vista ${log.join('; ')}; ` +
      `${keptVisibleFar} muestras de vehículos visibles más allá de ${cfg.despawnDistance} m que siguieron circulando`);
    expect(bad).toBe(0);
    expect(spawns).toBeGreaterThan(100);        // la prueba de verdad ejercitó el reciclaje
    expect(keptVisibleFar).toBeGreaterThan(0);  // y la regla de no reciclar lo visible
  }, 60_000);

  it('a la vista no se recicla aunque pase de despawnDistance; más allá de despawnHardDistance sí', () => {
    // (respaldo por si `visible` no tuviera en cuenta la niebla; aquí con un límite menor para que caiga dentro del mapa)
    const sim = new TrafficSim(graph, { ...cfg, despawnHardDistance: 650 }, trafico.signals, 11, 400, { x: 0, z: 0 });
    for (let t = 0; t < 5; t += DT) sim.step(DT, [], { x: 0, z: 0 });
    const all = () => true;
    // el jugador "ve" todo: tras saltar lejos nadie desaparece (todos siguen circulando, ninguno salta)
    const far = { x: 390, z: 390 };
    const before = sim.vehicles.map((v) => ({ on: on(v), x: v.x, z: v.z }));
    for (let t = 0; t < 3; t += DT) sim.step(DT, [], far, all);
    const hard = sim.cfg.despawnHardDistance!;
    let vanished = 0, kept = 0, fogged = 0;
    for (const v of sim.vehicles) {
      const b = before[v.id];
      if (!b.on) continue;
      const d0 = Math.hypot(b.x - far.x, b.z - far.z);   // en 3 s nadie recorre más de 60 m
      if (d0 < hard - 60) { if (!on(v) || Math.hypot(v.x - b.x, v.z - b.z) > 60) vanished++; else kept++; }
      if (d0 > hard + 60 && !on(v)) fogged++;
      if (on(v)) expect(Math.hypot(v.x - far.x, v.z - far.z)).toBeLessThanOrEqual(hard);
    }
    console.log(`todo a la vista: ${kept} siguen circulando, ${vanished} desaparecieron; ${fogged} reciclados más allá de ${hard} m`);
    expect(vanished).toBe(0);
    expect(kept).toBeGreaterThan(50);
    expect(fogged).toBeGreaterThan(0);
  }, 30_000);

  it('es determinista: misma semilla y mismas entradas (con visibilidad) dan el mismo estado', () => {
    const run = () => {
      const sim = new TrafficSim(graph, cfg, trafico.signals, 11, 400, { x: 0, z: 0 });
      for (let i = 0; i < 30 * 40; i++) { const p = { x: i * 0.5, z: -i * 0.3 }; sim.step(DT, [], p, cone(p, i / 100)); }
      return sim.vehicles.map((v) => `${v.active}:${v.x.toFixed(6)},${v.z.toFixed(6)},${v.v.toFixed(6)}`).join('|');
    };
    expect(run()).toBe(run());
  }, 30_000);
});

describe('pitos', () => {
  it('se acumulan entre pasos y drainHonks() entrega cada uno una sola vez', () => {
    const sim = new TrafficSim(graph, { ...cfg, vehicles: 1 }, trafico.signals, 4);
    const v = sim.vehicles[0];
    sim.step(DT);
    // jugador 18 m adelante en el camino del vehículo
    const lane = v.path[0];
    const q = lane.poly.at(Math.min(lane.poly.length - 1, v.s + 18));
    const obs = [{ x: q.x, z: q.z, r: 0.4, isPlayer: true }];
    let events = 0, last = v.lastHonk;
    // sin drenar: el arreglo crece con cada pito
    for (let t = 0; t < 12; t += DT) {
      sim.step(DT, obs);
      if (v.lastHonk !== last) { events++; last = v.lastHonk; }
      expect(sim.honks.length).toBe(events);
    }
    expect(events).toBeGreaterThanOrEqual(2);
    let drained = sim.drainHonks().length;
    expect(drained).toBe(events);
    expect(sim.honks.length).toBe(0);
    expect(sim.drainHonks()).toEqual([]);
    // ciclo de render a 144 FPS: ~5 drenajes por paso de tráfico (30 Hz)
    for (let t = 0; t < 20; t += DT) {
      sim.step(DT, obs);
      if (v.lastHonk !== last) { events++; last = v.lastHonk; }
      for (let k = 0; k < 5; k++) for (const h of sim.drainHonks()) { expect(h).toBe(v); drained++; }
    }
    expect(drained).toBe(events);
    expect(events).toBeGreaterThanOrEqual(6);
  });
});
