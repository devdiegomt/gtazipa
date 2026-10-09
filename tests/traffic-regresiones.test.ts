/**
 * Regresiones halladas en la revisión adversarial de la Fase 0: el que viene detrás no "veía" un vehículo corto en
 * cola si ya había mirado uno más adelante; una reserva retenida en un tramo corto entre dos cruces; prelaciones
 * dobles en un mismo ciclo; apariciones en carriles sin salida; reparto desigual de los intentos de aparición.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DIMS, TrafficSim, type TrafficCfg, type Vehicle, type VehicleType } from '../src/traffic/sim';
import type { Lane, Piece, RoadGraph, REdge, RNode } from '../src/traffic/graph';
import trafico from '../src/data/trafico.json';
import { stripOverlap } from './traffic-overlap';

const graph: RoadGraph = JSON.parse(readFileSync('public/world/roadgraph.json', 'utf8'));
const cfg = trafico.traffic as unknown as TrafficCfg;
const DT = 1 / 30;
const all = () => true;

const node = (id: number, x: number, z: number, edges: number[]): RNode =>
  ({ id, x, z, y: 0, edges, exit: false, degree: edges.length, radius: edges.length >= 3 ? 4 : 0 });
const edge = (id: number, from: number, to: number, pts: [number, number][]): REdge => ({ id, way: id, name: null,
  highway: 'residential', from, to, pts, width: 6, surface: 'asphalt', fw: 1, bw: 0, oneway: 1, speed: 30,
  length: pts.slice(1).reduce((a, p, i) => a + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0) });

/** Pone el vehículo en `path` a la distancia `s` de la primera pieza, con velocidad `v`. */
function put(veh: Vehicle, type: VehicleType, path: Piece[], s: number, v: number) {
  Object.assign(veh, { type, length: DIMS[type].length, width: DIMS[type].width, path, s, v, active: true, res: null });
  const p = path[0].poly.at(s);
  veh.x = veh.px = p.x; veh.z = veh.pz = p.z; veh.tx = veh.ptx = p.tx; veh.tz = veh.ptz = p.tz;
}

describe('regresiones del tráfico', () => {
  it('el que viene detrás frena ante una moto en cola aunque ya haya visto otra más adelante', () => {
    // carril recto de un sentido: moto detenida por un obstáculo, otra moto en cola detrás y una buseta que llega
    const g: RoadGraph = { nodes: [node(1, 300, 0, [0]), node(2, 0, 0, [0])], edges: [edge(0, 1, 2, [[300, 0], [0, 0]])],
      signals: [], crossings: [] };
    const sim = new TrafficSim(g, { ...cfg, vehicles: 3, mix: { carro: 1 } }, trafico.signals, 1);
    const lane = sim.lg.lanes[0];
    const [m1, m2, bus] = sim.vehicles;
    put(m1, 'moto', [lane], 200, 0);
    put(m2, 'moto', [lane], 200 - DIMS.moto.length - cfg.idm.s0, 0);
    put(bus, 'buseta', [lane], 150, 6);
    const q = lane.poly.at(204);
    const obs = [{ x: q.x, z: q.z, r: 0.3, isPlayer: false }];
    let worst = -Infinity;
    for (let t = 0; t < 30; t += DT) {
      sim.step(DT, obs, null, all);
      worst = Math.max(worst, bus.s + bus.length / 2 - (m2.s - m2.length / 2));   // > 0: el frente pasa la cola
    }
    console.log(`buseta: ${(-worst).toFixed(2)} m de la cola de la moto (debe frenar ante ella: blk=${bus.blocker})`);
    expect(worst).toBeLessThan(0);
  });

  it('la reserva se suelta cuando la cola sale del cruce, aunque el tramo siguiente sea corto', () => {
    // cruce P (grado 4): A cruza de oeste a este hacia un tramo de 9 m sin salida y se detiene en él; C llega del
    // norte y cruza hacia el sur (trayectoria en conflicto con la de A). Con la reserva retenida, C esperaba siempre.
    const g: RoadGraph = {
      nodes: [node(1, -60, 0, [0]), node(2, 0, 0, [0, 1, 2, 3]), node(3, 13, 0, [1]), node(4, 0, 60, [2]), node(5, 0, -60, [3])],
      edges: [edge(0, 1, 2, [[-60, 0], [0, 0]]), edge(1, 2, 3, [[0, 0], [13, 0]]), edge(2, 2, 4, [[0, 0], [0, 60]]),
        edge(3, 5, 2, [[0, -60], [0, 0]])],
      signals: [], crossings: [],
    };
    const sim = new TrafficSim(g, { ...cfg, vehicles: 2, mix: { carro: 1 } }, trafico.signals, 1);
    const lane = (e: number) => sim.lg.lanes.find((l) => l.edge.id === e)!;
    const conn = (a: Lane, b: Lane) => a.outs.find((c) => c.to === b)!;
    const [a, c] = sim.vehicles;
    const west = lane(0), shortEast = lane(1), south = lane(2), north = lane(3);
    expect(shortEast.poly.length).toBeLessThan(a.length + 1 + a.length / 2 + cfg.idm.s0 + 0.5);   // A no llega a s > largo + 1
    const aConn = conn(west, shortEast), cConn = conn(north, south);
    expect((sim as unknown as { conflicts: Map<number, Set<number>> }).conflicts.get(aConn.id)?.has(cConn.id)).toBe(true);
    put(a, 'carro', [west, aConn, shortEast], 30, 6);
    put(c, 'carro', [north, cConn, south], 5, 0);
    let aStopped = -1, cIn = -1, minDist = Infinity;
    for (let t = 0; t < 40; t += DT) {
      sim.step(DT, [], null, all);
      if (aStopped < 0 && a.path[0] === shortEast && a.v < 0.05) aStopped = sim.time;
      if (cIn < 0 && c.path[0] === cConn) cIn = sim.time;
      minDist = Math.min(minDist, Math.hypot(a.x - c.x, a.z - c.z));
    }
    console.log(`A detenido en el tramo corto a los ${aStopped.toFixed(1)} s (s=${a.s.toFixed(2)}, reserva ${a.res ? 'retenida' : 'suelta'}); ` +
      `C entra al cruce a los ${cIn.toFixed(1)} s; distancia mínima ${minDist.toFixed(2)} m`);
    expect(aStopped).toBeGreaterThan(0);
    expect(a.res).toBeNull();
    expect(cIn).toBeGreaterThan(0);
    expect(minDist).toBeGreaterThan(a.length / 2 + c.width / 2);
  });

  it('jugador que se mueve y mira: sin reservas en conflicto, sin choques en el carril, nada aparece a la vista', () => {
    type P = { x: number; z: number };
    const HALF = 400, cone = { half: Math.PI / 4, range: 300 };
    let seedState = 99;
    const rand = () => { seedState = (seedState * 16807) % 2147483647; return seedState / 2147483647; };
    for (const seed of [1, 2, 3]) {
      const sim = new TrafficSim(graph, cfg, trafico.signals, seed, HALF, { x: 0, z: 0 });
      const S = sim as unknown as { conflicts: Map<number, Set<number>>; occupancy: Map<number, Set<number>>;
        place: (...a: unknown[]) => boolean };
      const V = sim.vehicles;
      // reparto de los intentos de aparición: último intento e inicio de la inactividad por vehículo
      const lastTry = V.map(() => -Infinity), offSince = V.map((v) => (v.active ? Infinity : 0));
      const place = S.place.bind(sim);
      S.place = (...args: unknown[]) => { lastTry[(args[0] as Vehicle).id] = sim.time; return place(...args); };
      let p: P = { x: 0, z: 0 }, yaw = 0, target: P | null = null, left = 0;
      let conflictPairs = 0, laneOverlaps = 0, deadSpawns = 0, seenFlips = 0, maxGap = 0;
      const was = V.map((v) => ({ on: v.active, x: v.x, z: v.z }));
      for (let t = 0; t < 360; t += DT) {
        // el jugador: va en moto a un borde, se queda mirando alrededor, o salta (viaje rápido)
        if ((left -= DT) <= 0) {
          const r = rand();
          if (r < 0.4) target = { x: (rand() * 2 - 1) * 395, z: (rand() < 0.5 ? -1 : 1) * 390 };
          else if (r < 0.7) { target = null; p = { x: (rand() * 2 - 1) * 390, z: (rand() * 2 - 1) * 390 }; }
          else target = null;
          left = 20 + rand() * 40;
        }
        if (target) {
          const dx = target.x - p.x, dz = target.z - p.z, d = Math.hypot(dx, dz);
          if (d > 1) { const k = Math.min(1, (25 * DT) / d); p = { x: p.x + dx * k, z: p.z + dz * k }; yaw = Math.atan2(dx, dz); }
        } else yaw += 0.25 * DT;
        const fx = Math.sin(yaw), fz = Math.cos(yaw);
        /** En el cono de vista; con margen, "claramente" dentro (a 1 m de cualquier borde). */
        const inCone = (x: number, z: number, m = 0) => {
          const dx = x - p.x, dz = z - p.z, d = Math.hypot(dx, dz);
          if (d > cone.range - m) return false;
          const ang = Math.acos(Math.max(-1, Math.min(1, (dx * fx + dz * fz) / (d || 1))));
          return ang < cone.half && d * Math.sin(cone.half - ang) >= m;
        };
        sim.step(DT, [], p, (x, z) => inCone(x, z));

        for (const v of V) {
          const w = was[v.id];
          if (v.active && !w.on && (inCone(v.x, v.z, 1) || (v.path[0] as Lane).outs?.length === 0)) {
            if (inCone(v.x, v.z, 1)) seenFlips++; else deadSpawns++;
          }
          if (!v.active && w.on && inCone(w.x, w.z, 1)) seenFlips++;
          if (v.active !== w.on) offSince[v.id] = v.active ? Infinity : sim.time;
          if (!v.active) maxGap = Math.max(maxGap, sim.time - Math.max(lastTry[v.id], offSince[v.id]));
          w.on = v.active; w.x = v.x; w.z = v.z;
        }
        // dos reservas en conflicto en el mismo cruce a la vez (p. ej. dos prelaciones del mismo ciclo)
        for (const ids of S.occupancy.values()) {
          const held = [...ids].map((id) => V[id]).filter((v) => v.res);
          for (let i = 0; i < held.length; i++) for (let j = i + 1; j < held.length; j++) {
            if (S.conflicts.get(held[i].res!.id)?.has(held[j].res!.id)) conflictPairs++;
          }
        }
        // dos vehículos en la misma pieza (carril o conector) que se montan uno sobre otro
        const byPiece = new Map<Piece, Vehicle[]>();
        for (const v of V) if (v.active) { const k = v.path[0]; if (!byPiece.has(k)) byPiece.set(k, []); byPiece.get(k)!.push(v); }
        for (const list of byPiece.values()) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
          if (stripOverlap(list[i], list[j])) laneOverlaps++;   // misma franja (no la moto que filtra al lado)
        }
      }
      console.log(`semilla ${seed}: reservas en conflicto ${conflictPairs}, superposiciones en un carril ${laneOverlaps}, ` +
        `apariciones en carril sin salida ${deadSpawns}, aparecer/desaparecer a la vista ${seenFlips}, ` +
        `mayor espera sin intento de aparición ${maxGap.toFixed(1)} s`);
      expect(conflictPairs).toBe(0);
      expect(laneOverlaps).toBe(0);
      expect(deadSpawns).toBe(0);
      expect(seenFlips).toBe(0);
      expect(maxGap).toBeLessThan(10);
    }
  }, 120_000);
});

