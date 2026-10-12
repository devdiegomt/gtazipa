/**
 * Simulación de peatones (src/peds/sim.ts) sobre la red real y con el tráfico real: burbuja con aparición y desaparición
 * sólo fuera de la vista, nadie en la calzada salvo en los cruces, semáforos en rojo con tiempo suficiente, brechas,
 * plaza poblada y bancas ocupadas, choques poco frecuentes, contrato de types.ts y gait.ts, atropello y huida,
 * determinismo y coste por paso. La visibilidad se modela como en las pruebas del tráfico: un cono de 90° hasta 300 m.
 */
import { describe, expect, it } from 'vitest';
import { graph, realNav, world } from './peds-data';
import { PedSim, type PedHazard } from '../src/peds/sim';
import { TrafficSim, type TrafficCfg } from '../src/traffic/sim';
import { pedPhasePerMetre } from '../src/peds/gait';
import trafico from '../src/data/trafico.json';
import plazaCfg from '../src/data/plaza.json';
import peatones from '../src/data/peatones.json';

const { nav, input } = realNav();
const tcfg = trafico.traffic as unknown as TrafficCfg;
const DT = 1 / 30, RANGE = 300, TAU = Math.PI * 2;
type P = { x: number; z: number };

/** Cono de 90° hacia `yaw` desde p; con `margin` > 0 exige que el punto quede al menos a esa distancia del borde. */
function cone(p: P, yaw: number, margin = 0) {
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  return (x: number, z: number) => {
    const dx = x - p.x, dz = z - p.z;
    const along = dx * fx + dz * fz, side = Math.abs(dx * fz - dz * fx);
    return (along - side) / Math.SQRT2 >= margin && Math.hypot(dx, dz) <= RANGE - margin;
  };
}

/** Distancia de (x, z) al segmento de un cruce. */
function segDist(x: number, z: number, ax: number, az: number, bx: number, bz: number) {
  const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1;
  const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / L2));
  return Math.hypot(ax + ex * t - x, az + ez * t - z);
}

/** Rojo que le queda a una fase (s), con la misma regla que TrafficSim.light. */
function redLeft(traffic: TrafficSim, controller: number, phase: 0 | 1) {
  const sg = traffic.sig, half = sg.green + sg.yellow + sg.allRed, cycle = 2 * half;
  const t = (traffic.time + traffic.controllers[controller].offset) % cycle;
  const local = phase === 0 ? t : (t + half) % cycle;
  return local >= sg.green + sg.yellow ? cycle - local : 0;
}

/**
 * Corre tráfico + peatones con un plan del jugador y comprueba en cada paso los invariantes; devuelve contadores.
 * `ride`: el jugador va en moto (peligro 'moto') cuando se mueve; los vehículos cercanos se pasan como 'vehicle'.
 */
function run(seed: number, plan: { p: P; yaw: number; v: P }[], opts: { onStep?: (i: number, sim: PedSim, tr: TrafficSim) => void } = {}) {
  const start = plan[0].p;
  const traffic = new TrafficSim(graph, tcfg, trafico.signals, seed, 400, start);
  const sim = new PedSim(nav, traffic, undefined, seed, start);
  const peds = sim.peds;
  const prev = peds.map((q) => ({ on: q.active, x: q.x, z: q.z, phase: q.phase, look: q.look, waiting: false }));
  const onRoad = new Uint8Array(peds.length);
  const c = { visibleSpawn: 0, visibleDespawn: 0, spawns: 0, despawns: 0, nan: 0, roadOff: 0, contract: 0, gait: 0, gaitChecked: 0,
    sigEntries: 0, sigBad: 0, gapStarts: 0, gapBad: 0, obsBad: 0, snapshots: 0, closePairs: 0, maxActive: 0, falls: 0 };
  const hazards: PedHazard[] = [];
  const obsRef = sim.obstaclesForTraffic();
  for (let i = 0; i < plan.length; i++) {
    const { p, yaw, v } = plan[i];
    const vis = cone(p, yaw), clearly = cone(p, yaw, 1);
    const moving = Math.hypot(v.x, v.z) > 0.5;
    hazards.length = 0;
    hazards.push({ x: p.x, z: p.z, vx: v.x, vz: v.z, r: moving ? 0.6 : 0.35, kind: moving ? 'moto' : 'player' });
    for (const veh of traffic.vehicles) {
      if (veh.active && Math.hypot(veh.x - p.x, veh.z - p.z) < 40) hazards.push({ x: veh.x, z: veh.z, vx: veh.tx * veh.v, vz: veh.tz * veh.v, r: veh.width / 2, kind: 'vehicle' });
    }
    traffic.step(DT, [...sim.obstaclesForTraffic(), { x: p.x, z: p.z, r: 0.5, isPlayer: true }], p, vis);
    sim.step(DT, p, hazards, vis);
    c.falls += sim.drainFalls().length;
    // obstáculos para el tráfico: el mismo arreglo, sólo peatones activos sobre la calzada
    if (sim.obstaclesForTraffic() !== obsRef) c.obsBad++;
    for (const o of sim.obstaclesForTraffic()) if (o.isPlayer || nav.carriagewayDist(o.x, o.z) > 0.45) c.obsBad++;
    let active = 0;
    for (const q of peds) {
      const b = prev[q.id];
      if (q.active) {
        active++;
        if (![q.x, q.y, q.z, q.heading, q.phase, q.speed, q.px, q.pz, q.poseTime].every(Number.isFinite)) c.nan++;
      }
      // aparición y desaparición (un salto de más de 3 m, o reaparecer como otra persona, cuenta como las dos) sólo
      // donde no se ve
      const jump = b.on && q.active && (Math.hypot(q.x - b.x, q.z - b.z) > 3 || q.look !== b.look);
      if (b.on && (!q.active || jump)) { c.despawns++; if (clearly(b.x, b.z)) c.visibleDespawn++; }
      if (q.active && (!b.on || jump)) { c.spawns++; if (vis(q.x, q.z)) c.visibleSpawn++; }
      if (q.active) {
        // contrato: estado anterior para interpolar, fase en [0, 2π), sentado ⇔ seatH > 0
        if (b.on && !jump && (q.px !== b.x || q.pz !== b.z)) c.contract++;
        if (!(q.phase >= 0 && q.phase < TAU) || q.poseTime < 0 || (q.pose === 'sit') !== (q.seatH > 0)) c.contract++;
        // marcha: la fase avanza la distancia recorrida · pedPhasePerMetre (el pie no patina)
        if (b.on && !jump) {
          const moved = Math.hypot(q.x - q.px, q.z - q.pz);
          let d = (b.phase + moved * pedPhasePerMetre(q.speed, q.height)) - q.phase;
          d -= TAU * Math.round(d / TAU);
          c.gaitChecked++;
          if (Math.abs(d) > 1e-6) c.gait++;
        }
        // calzada: sólo sobre el segmento de un cruce que esté recorriendo
        const cd = nav.carriagewayDist(q.x, q.z), road = cd < -0.2;
        if (road) {
          const k = sim.crossingOf(q.id), cr = k >= 0 ? nav.crossings[k] : null;
          if (!cr || segDist(q.x, q.z, cr.ax, cr.az, cr.bx, cr.bz) > 1.6) { c.roadOff++; if (c.roadOff < 8 || c.roadOff % 200 === 0) { const A = q as any; console.log('roadOff', i, q.id, q.pose, 'mode', A.mode, 'cross', A.cross, k, 'cd', cd.toFixed(2), 'pos', q.x.toFixed(1), q.z.toFixed(1), 'flee', A.fleeT.toFixed(2), 'leader', A.leader, 'edge', A.edge, 'ecross', A.edge >= 0 ? nav.ecross[A.edge] : -9, 's', A.s.toFixed(2), 'len', A.len.toFixed(2), 'lat', A.lat.toFixed(2), 'seg', cr ? segDist(q.x, q.z, cr.ax, cr.az, cr.bx, cr.bz).toFixed(2) : '-'); } }
          // entrada a la calzada en un cruce semaforizado: rojo para la vía cruzada y tiempo para cruzar
          if (!onRoad[q.id] && cr) {
            const sg = sim.signalOf(k);
            if (sg.controller >= 0) {
              c.sigEntries++;
              const L = Math.hypot(cr.bx - cr.ax, cr.bz - cr.az);
              if (traffic.light(traffic.controllers[sg.controller], sg.phase) !== 'R' || redLeft(traffic, sg.controller, sg.phase) < L / 1.8 + 1) c.sigBad++;
            }
          }
        }
        onRoad[q.id] = road ? 1 : 0;
        // cruce sin semáforo: al decidir cruzar, ningún vehículo encima del cruce
        const waiting = sim.waiting(q.id), k = sim.crossingOf(q.id);
        if (b.waiting && !waiting && k >= 0 && q.pose !== 'fallen' && sim.signalOf(k).controller < 0) {
          c.gapStarts++;
          const cr = nav.crossings[k];
          for (const veh of traffic.vehicles) {
            if (veh.active && segDist(veh.x, veh.z, cr.ax, cr.az, cr.bx, cr.bz) - veh.length / 2 < 1.0) c.gapBad++;
          }
        }
        b.waiting = waiting;
      } else { onRoad[q.id] = 0; b.waiting = false; if (q.x > -5000) c.contract++; }
      b.on = q.active; b.x = q.x; b.z = q.z; b.phase = q.phase; b.look = q.look;
    }
    c.maxActive = Math.max(c.maxActive, active);
    if (i % 15 === 0) {
      c.snapshots++;
      const A = peds.filter((q) => q.active);
      for (let x = 0; x < A.length; x++) for (let y = x + 1; y < A.length; y++) if (Math.hypot(A[x].x - A[y].x, A[x].z - A[y].z) < 0.3) c.closePairs++;
    }
    opts.onStep?.(i, sim, traffic);
  }
  return { c, sim, traffic };
}

/** Plan: quieto girando la cámara `still` s en `from`, luego en moto a `speed` m/s por los puntos dados (mirando adelante). */
function makePlan(from: P, still: number, legs: P[], speed: number) {
  const plan: { p: P; yaw: number; v: P }[] = [];
  for (let t = 0; t < still; t += DT) plan.push({ p: { ...from }, yaw: t * 0.25, v: { x: 0, z: 0 } });
  let p = { ...from };
  for (const to of legs) {
    const L = Math.hypot(to.x - p.x, to.z - p.z), ux = (to.x - p.x) / L, uz = (to.z - p.z) / L, yaw = Math.atan2(ux, uz);
    for (let d = 0; d < L; d += speed * DT) plan.push({ p: { x: p.x + ux * d, z: p.z + uz * d }, yaw, v: { x: ux * speed, z: uz * speed } });
    p = { ...to };
  }
  return plan;
}

describe('simulación de peatones', () => {
  it('recorrido largo con tráfico: burbuja oculta, calzada sólo en cruces, plaza llena, bancas, contrato y marcha', () => {
    const P0 = { x: nav.plazaCenter.x, z: nav.plazaCenter.z };
    const plan = makePlan(P0, 45, [{ x: 150, z: 60 }, { x: 200, z: -150 }, { x: -140, z: -95 }, P0], 7);
    for (let t = 0; t < 20; t += DT) plan.push({ p: { ...P0 }, yaw: 1 + t * 0.3, v: { x: 0, z: 0 } });
    let plazaCrowd = 0, sitters = 0, sitBad = 0;
    const planters = world.plaza.planters ?? [], PL = plazaCfg.planter;
    const { c, sim } = run(11, plan, {
      onStep: (i, s) => {
        if (i !== Math.round(44 / DT)) return;
        // con el jugador en la plaza: decenas de personas a menos de 40 m del centro, y gente sentada en las bancas
        for (const q of s.peds) {
          if (!q.active) continue;
          if (Math.hypot(q.x - P0.x, q.z - P0.z) < 40) plazaCrowd++;
          if (q.pose !== 'sit' || !nav.inPlaza(q.x, q.z)) continue;
          // sentado sobre el anillo de la banca de la matera más cercana, la cadera a la altura del asiento
          sitters++;
          const pl = planters.reduce((b, p) => (Math.hypot(p.x - q.x, p.z - q.z) < Math.hypot(b.x - q.x, b.z - q.z) ? p : b));
          const r = Math.hypot(pl.x - q.x, pl.z - q.z);
          // (la plaza es un plano inclinado: cuesta arriba de la matera el asiento queda más bajo sobre el adoquín)
          if (r < PL.outerRadius - PL.benchDepth || r > PL.outerRadius || Math.abs(q.y + q.seatH - (input.heightAt(pl.x, pl.z) + PL.seatHeight)) > 0.01) sitBad++;
        }
      },
    });
    const pairsPerSnapshot = c.closePairs / c.snapshots;
    console.log(`[peds] recorrido ${(plan.length * DT).toFixed(0)} s: plaza ${plazaCrowd} (sentados ${sitters}),`, JSON.stringify(c),
      `pares < 0,3 m por instante ${pairsPerSnapshot.toFixed(2)}`, JSON.stringify(sim.stats()));
    expect(c.nan).toBe(0);
    expect(c.visibleSpawn).toBe(0);
    expect(c.visibleDespawn).toBe(0);
    expect(c.spawns).toBeGreaterThan(200);
    expect(c.roadOff).toBe(0);
    expect(c.contract).toBe(0);
    expect(c.gait).toBe(0);
    expect(c.gaitChecked).toBeGreaterThan(100000);
    expect(c.sigBad).toBe(0);
    expect(c.gapStarts).toBeGreaterThan(20);
    expect(c.gapBad).toBe(0);
    expect(c.obsBad).toBe(0);
    expect(c.maxActive).toBe(peatones.sim.peatones);
    expect(plazaCrowd).toBeGreaterThanOrEqual(25);
    expect(sitters).toBeGreaterThanOrEqual(8);
    expect(sitBad).toBe(0);
    // casi nadie se encarama sobre otro (de 140 personas, en promedio menos de 2 pares a menos de 0,3 m)
    expect(pairsPerSnapshot).toBeLessThan(2);
  }, 60_000);

  it('cruces semaforizados: sólo se entra con el rojo de la vía cruzada y tiempo para cruzar', () => {
    // fase resuelta = fase de los carriles con semáforo que pasan por la cebra (geometría independiente)
    const P1 = { x: 298, z: -262 };
    const traffic0 = new TrafficSim(graph, tcfg, trafico.signals, 11, 400, P1);
    const sim0 = new PedSim(nav, traffic0, undefined, 3, P1);
    let checked = 0;
    for (const cr of nav.crossings) {
      const sg = sim0.signalOf(cr.id);
      if (!cr.signalized || sg.controller < 0) continue;
      const phases = new Set<number>();
      for (const l of traffic0.lg.lanes) {
        const ls = l.signal;
        if (!ls || ls.controller !== sg.controller) continue;
        const X = l.poly.x, Z = l.poly.z;
        for (let i = 1; i < X.length; i++) {
          const d1 = (cr.bx - cr.ax) * (Z[i - 1] - cr.az) - (cr.bz - cr.az) * (X[i - 1] - cr.ax);
          const d2 = (cr.bx - cr.ax) * (Z[i] - cr.az) - (cr.bz - cr.az) * (X[i] - cr.ax);
          const d3 = (X[i] - X[i - 1]) * (cr.az - Z[i - 1]) - (Z[i] - Z[i - 1]) * (cr.ax - X[i - 1]);
          const d4 = (X[i] - X[i - 1]) * (cr.bz - Z[i - 1]) - (Z[i] - Z[i - 1]) * (cr.bx - X[i - 1]);
          if (d1 * d2 < 0 && d3 * d4 < 0) { phases.add(ls.phase); break; }
        }
      }
      if (!phases.size) continue;
      expect([...phases]).toEqual([sg.phase]);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(10);
    // junto al semáforo de la (298, -270): cinco cebras y cruces de esquina; el jugador quieto mirando alrededor
    const plan = makePlan(P1, 200, [], 0);
    const { c } = run(11, plan);
    console.log('[peds] semáforos:', JSON.stringify(c));
    expect(c.sigEntries).toBeGreaterThan(15);
    expect(c.sigBad).toBe(0);
    expect(c.roadOff).toBe(0);
    expect(c.gapBad).toBe(0);
    expect(c.visibleSpawn + c.visibleDespawn).toBe(0);
  }, 60_000);

  it('atropello: cae, se levanta y sale corriendo; una moto que se le viene encima lo hace correr', () => {
    const P0 = { x: nav.plazaCenter.x, z: nav.plazaCenter.z };
    const sim = new PedSim(nav, null, undefined, 5, P0);
    for (let i = 0; i < 90; i++) sim.step(DT, P0, [], () => false);
    // un peatón que camina solo por un andén, lejos del jugador y de los demás
    const pick = () => sim.peds.find((q) => q.active && q.pose === 'walk' && q.speed > 0.8 && sim.crossingOf(q.id) < 0 &&
      Math.hypot(q.x - P0.x, q.z - P0.z) > 15 && sim.peds.every((o) => o === q || !o.active || Math.hypot(o.x - q.x, o.z - q.z) > 2.5))!;
    const q = pick();
    expect(q).toBeTruthy();
    // la moto lo atraviesa a 8 m/s (el barrido de este paso pasa por él)
    const ux = Math.cos(q.heading), uz = -Math.sin(q.heading);   // de lado
    const moto: PedHazard = { x: q.x + ux * 8 * DT * 0.5, z: q.z + uz * 8 * DT * 0.5, vx: ux * 8, vz: uz * 8, r: 0.6, kind: 'moto' };
    sim.step(DT, P0, [moto], () => false);
    expect(q.pose).toBe('fallen');
    expect(sim.drainFalls()).toEqual([q.id]);
    expect(sim.drainFalls()).toEqual([]);
    const fx = q.x, fz = q.z;
    let t = 0, ran = false;
    for (; t < 10 && !ran; t += DT) {
      sim.step(DT, P0, [], () => false);
      if (t < peatones.sim.caida.suelo[0] - 0.1) expect(q.pose).toBe('fallen');
      ran = q.pose === 'run';
    }
    expect(ran).toBe(true);
    expect(t).toBeLessThan(peatones.sim.caida.suelo[1] + 1.5);
    for (let i = 0; i < 30; i++) sim.step(DT, P0, [], () => false);
    expect(Math.hypot(q.x - fx, q.z - fz)).toBeGreaterThan(2);
    // otra moto que se le viene encima a 10 m/s desde 12 m: corre (o ya se apartó) antes de que llegue
    const r = pick();
    const vx = -Math.sin(r.heading), vz = -Math.cos(r.heading);
    let scared = false;
    for (let k = 0; k < 30 && !scared; k++) {
      const d = 12 - k * 10 * DT;
      const h: PedHazard = { x: r.x + vx * d, z: r.z + vz * d, vx: -vx * 10, vz: -vz * 10, r: 0.6, kind: 'moto' };
      sim.step(DT, P0, [h], () => false);
      scared = r.pose === 'run';
    }
    expect(scared).toBe(true);
  }, 60_000);

  it('el jugador a pie: nadie lo atraviesa; quien se lo encuentra de frente se aparta o da media vuelta', () => {
    const P0 = { x: nav.plazaCenter.x, z: nav.plazaCenter.z };
    const sim = new PedSim(nav, null, undefined, 9, P0);
    for (let i = 0; i < 60; i++) sim.step(DT, P0, [], () => false);
    // el jugador se para 1,8 m delante de cada peatón que camina por un andén
    const targets = sim.peds.filter((q) => q.active && q.pose === 'walk' && sim.crossingOf(q.id) < 0).slice(0, 6);
    for (const q of targets) {
      const pl = { x: q.x - Math.sin(q.heading) * 1.8, z: q.z - Math.cos(q.heading) * 1.8 };
      let minD = Infinity;
      for (let i = 0; i < 6 / DT; i++) {
        sim.step(DT, pl, [{ x: pl.x, z: pl.z, vx: 0, vz: 0, r: 0.35, kind: 'player' }], () => false);
        if (q.active) minD = Math.min(minD, Math.hypot(q.x - pl.x, q.z - pl.z));
      }
      expect(minD).toBeGreaterThan(0.45);
    }
  }, 60_000);

  it('determinista para una semilla (con tráfico y un recorrido)', () => {
    const P0 = { x: nav.plazaCenter.x, z: nav.plazaCenter.z };
    const plan = makePlan(P0, 8, [{ x: 60, z: 40 }], 6);
    const a = run(21, plan).sim, b = run(21, plan).sim;
    const key = (s: PedSim) => s.peds.map((q) => [q.active, q.x, q.z, q.y, q.heading, q.phase, q.pose, q.look, q.height].join(',')).join(';');
    expect(key(a)).toBe(key(b));
    const c = run(22, plan).sim;
    expect(key(c)).not.toBe(key(a));
  }, 60_000);

  it('coste por paso con 140 peatones y tráfico (medido; límite holgado)', () => {
    const P0 = { x: nav.plazaCenter.x, z: nav.plazaCenter.z };
    const traffic = new TrafficSim(graph, tcfg, trafico.signals, 11, 400, P0);
    const sim = new PedSim(nav, traffic, undefined, 17, P0);
    const hz: PedHazard[] = [{ x: P0.x, z: P0.z, vx: 0, vz: 0, r: 0.35, kind: 'player' }];
    const times: number[] = [];
    for (let i = 0; i < 1500; i++) {
      const vis = cone(P0, i / 300);
      traffic.step(DT, [...sim.obstaclesForTraffic()], P0, vis);
      const t0 = performance.now();
      sim.step(DT, P0, hz, vis);
      if (i >= 300) times.push(performance.now() - t0);
    }
    times.sort((x, y) => x - y);
    const mean = times.reduce((s, v) => s + v, 0) / times.length, p99 = times[Math.floor(times.length * 0.99)];
    console.log(`[peds] paso de 140 peatones: media ${mean.toFixed(3)} ms, p50 ${times[times.length >> 1].toFixed(3)} ms, p99 ${p99.toFixed(3)} ms, máx ${times[times.length - 1].toFixed(3)} ms`);
    expect(sim.stats().active).toBe(peatones.sim.peatones);
    expect(mean).toBeLessThan(1.5);
  }, 60_000);
});
