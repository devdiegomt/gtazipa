/**
 * Red peatonal (src/peds/nav.ts) construida con los datos reales del mundo: andenes sobre la malla caminable, nada sobre
 * la calzada salvo los cruces, cebras que unen los dos lados, conectividad, bancas de las materas y alturas del suelo.
 */
import { describe, expect, it } from 'vitest';
import { realNav, sidewalkTriangles, world } from './peds-data';
import { K_AREA, K_CURB, K_PATH, K_SEAT, K_SIDEWALK, ZONE_PARK, ZONE_PLAZA, ZONE_STREET } from '../src/peds/nav';
import plazaCfg from '../src/data/plaza.json';
import parquesCfg from '../src/data/parques.json';
import trafico from '../src/data/trafico.json';
import peatones from '../src/data/peatones.json';

const { nav, input, ms } = realNav();

/** Punto en triángulo con los triángulos crudos (independiente del índice de nav.onWalk). */
function makeOnTriangles(T: Float32Array) {
  const C = 4, cells = new Map<number, number[]>();
  const key = (i: number, j: number) => i * 100003 + j;
  for (let t = 0; t + 5 < T.length; t += 6) {
    const x0 = Math.min(T[t], T[t + 2], T[t + 4]), x1 = Math.max(T[t], T[t + 2], T[t + 4]);
    const z0 = Math.min(T[t + 1], T[t + 3], T[t + 5]), z1 = Math.max(T[t + 1], T[t + 3], T[t + 5]);
    for (let i = Math.floor(x0 / C); i <= Math.floor(x1 / C); i++) for (let j = Math.floor(z0 / C); j <= Math.floor(z1 / C); j++) {
      const k = key(i, j);
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k)!.push(t);
    }
  }
  return (x: number, z: number, eps = 0.02) => {
    for (const t of cells.get(key(Math.floor(x / C), Math.floor(z / C))) ?? []) {
      const ax = T[t], az = T[t + 1], bx = T[t + 2], bz = T[t + 3], cx = T[t + 4], cz = T[t + 5];
      const A = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
      if (Math.abs(A) < 1e-6) continue;
      // coordenadas baricéntricas con tolerancia en metros (aristas compartidas entre triángulos)
      const w0 = ((bx - x) * (cz - z) - (bz - z) * (cx - x)) / A, w1 = ((cx - x) * (az - z) - (cz - z) * (ax - x)) / A, w2 = 1 - w0 - w1;
      const L = Math.sqrt(Math.abs(A));
      if (w0 > -eps / L && w1 > -eps / L && w2 > -eps / L) return true;
    }
    return false;
  };
}

describe('red peatonal (datos reales)', () => {
  it('se construye rápido y con todas sus partes', () => {
    console.log(`[peds] red: ${ms.toFixed(0)} ms`, JSON.stringify(nav.stats));
    expect(ms).toBeLessThan(5000);
    const S = nav.stats;
    expect(S.andenes).toBeGreaterThan(3000);
    expect(S.plaza).toBeGreaterThan(300);
    expect(S.parque).toBeGreaterThan(100);
    expect(S.cebras + S.cebrasFallidas).toBe((input.graph.crossings as unknown[]).length);
    expect(S.cruces).toBeGreaterThan(S.cebras);
    expect(nav.attractors.length).toBeGreaterThan(10);
  });

  it('cada nodo de andén está sobre un triángulo caminable; ningún nodo sobre la calzada', () => {
    const onTri = makeOnTriangles(sidewalkTriangles());
    let off = 0, road = 0, curbs = 0;
    for (let i = 0; i < nav.n; i++) {
      const k = nav.kind[i], x = nav.x[i], z = nav.z[i];
      if (k === K_SIDEWALK && !onTri(x, z)) off++;
      // bordes de cruce: en el andén o, si el cruce llega a la plaza, al parque o a un sendero, sobre ellos
      if (k === K_CURB && !(onTri(x, z) || nav.inPlaza(x, z) || nav.inPark(x, z) || nav.onPath(x, z))) curbs++;
      if (!nav.allowed(x, z) || nav.carriagewayDist(x, z) < -0.05) road++;
    }
    expect(off).toBe(0);
    expect(curbs).toBe(0);
    expect(road).toBe(0);
  });

  it('sólo los cruces pisan la calzada: las demás aristas son caminables de punta a punta', () => {
    let bad = 0, crossOnRoad = 0, crossings = 0;
    for (let e = 0; e < nav.m; e++) {
      const a = nav.ea[e], b = nav.eb[e];
      if (nav.ecross[e] >= 0) {
        crossings++;
        // el medio del cruce queda sobre la calzada (es lo que hay que cruzar)
        const mx = (nav.x[a] + nav.x[b]) / 2, mz = (nav.z[a] + nav.z[b]) / 2;
        if (nav.carriagewayDist(mx, mz) < 0) crossOnRoad++;
        continue;
      }
      if (!nav.clearSegment(nav.x[a], nav.z[a], nav.x[b], nav.z[b], 0.5)) bad++;
      // la franja lateral también es caminable
      const w = nav.ewl[e];
      if (w > 0) {
        const L = nav.elen[e] || 1, px = -(nav.z[b] - nav.z[a]) / L * w, pz = (nav.x[b] - nav.x[a]) / L * w;
        if (!nav.clearSegment(nav.x[a] + px, nav.z[a] + pz, nav.x[b] + px, nav.z[b] + pz, 0.5)) bad++;
        if (!nav.clearSegment(nav.x[a] - px, nav.z[a] - pz, nav.x[b] - px, nav.z[b] - pz, 0.5)) bad++;
      }
    }
    expect(bad).toBe(0);
    expect(crossings).toBe(nav.crossings.length);
    expect(crossOnRoad).toBe(crossings);
    for (const c of nav.crossings) expect(nav.ecross[c.edge]).toBe(c.id);
  });

  it('las cebras unen los dos lados de la vía y quedan conectadas a la red de andenes', () => {
    const zebras = nav.crossings.filter((c) => c.kind === 'cebra');
    expect(zebras.length).toBeGreaterThanOrEqual(15);
    for (const c of zebras) {
      // a y b a lados opuestos del eje de la vía, fuera de la calzada
      const sa = (c.ax - c.cx) * -c.dz + (c.az - c.cz) * c.dx, sb = (c.bx - c.cx) * -c.dz + (c.bz - c.cz) * c.dx;
      expect(sa * sb).toBeLessThan(0);
      expect(Math.min(Math.abs(sa), Math.abs(sb))).toBeGreaterThan(c.half - 0.1);
      expect(nav.allowed(c.ax, c.az) && nav.allowed(c.bx, c.bz)).toBe(true);
      // cada extremo tiene, además del cruce, al menos un vecino en el andén
      expect(nav.degree(c.a)).toBeGreaterThanOrEqual(2);
      expect(nav.degree(c.b)).toBeGreaterThanOrEqual(2);
      expect(nav.edgeBetween(c.a, c.b)).toBe(c.edge);
      expect(nav.comp[c.a]).toBe(nav.comp[c.b]);
      // borde del andén donde se espera: entre el nodo y la calzada, a ≥ curbEspera de ella
      const L = Math.hypot(c.bx - c.ax, c.bz - c.az), ux = (c.bx - c.ax) / L, uz = (c.bz - c.az) / L, E = peatones.nav.cruce.curbEspera;
      if (c.curbA > 0) expect(nav.carriagewayDist(c.ax + ux * c.curbA, c.az + uz * c.curbA)).toBeGreaterThanOrEqual(E - 1e-9);
      if (c.curbB > 0) expect(nav.carriagewayDist(c.bx - ux * c.curbB, c.bz - uz * c.curbB)).toBeGreaterThanOrEqual(E - 1e-9);
    }
    // semaforizadas: las cebras a menos de radioSemaforo de un semáforo del grafo
    const R = peatones.nav.cruce.radioSemaforo;
    for (const c of nav.crossings) {
      const near = input.graph.signals.some((s) => Math.hypot(s.x - c.cx, s.z - c.cz) < R);
      expect(c.signalized).toBe(near);
    }
  });

  it('conectividad: los grandes barrios, y la plaza con el parque, son una sola red cada uno', () => {
    // En el centro histórico casi no hay andén en los datos (las fachadas llegan a la calzada estimada): la red queda
    // partida en unos pocos barrios grandes. Ver openIssues del informe.
    const { comp, sizes, largest } = nav.components();
    const sorted = [...sizes].sort((a, b) => b - a);
    const top5 = sorted.slice(0, 5).reduce((s, v) => s + v, 0);
    console.log(`[peds] componentes: ${sizes.length}, mayor ${(100 * largest / nav.n).toFixed(1)} %, 5 mayores ${(100 * top5 / nav.n).toFixed(1)} %`);
    expect(largest / nav.n).toBeGreaterThan(0.4);
    expect(top5 / nav.n).toBeGreaterThan(0.85);
    // la plaza y el parque: una sola componente que también llega a andenes de la calle
    const area = (zone: number) => { const r: number[] = []; for (let i = 0; i < nav.n; i++) if (nav.zone[i] === zone && nav.kind[i] === K_AREA) r.push(i); return r; };
    const pl = area(ZONE_PLAZA), pk = area(ZONE_PARK);
    const c0 = comp[pl[0]];
    expect(pl.every((i) => comp[i] === c0)).toBe(true);
    expect(pk.filter((i) => comp[i] === c0).length / pk.length).toBeGreaterThan(0.95);
    let street = 0;
    for (let i = 0; i < nav.n; i++) if (comp[i] === c0 && nav.zone[i] === ZONE_STREET && (nav.kind[i] === K_SIDEWALK || nav.kind[i] === K_PATH)) street++;
    expect(street).toBeGreaterThan(100);
    // cada componente grande tiene destinos (atractores) propios
    for (let c = 0; c < sizes.length; c++) {
      if (sizes[c] >= 4 * peatones.nav.atractores.minComponente) expect(nav.compAttr[c].length).toBeGreaterThan(0);
    }
    // los campos de distancia llegan a toda su componente y a nada más
    for (const at of nav.attractors) {
      const c = comp[at.node];
      for (let i = 0; i < nav.n; i += 17) expect(at.dist[i] < 1e8).toBe(comp[i] === c);
    }
  });

  it('bancas: puestos sobre el anillo de cada matera (y el borde de la fuente), mirando hacia afuera', () => {
    const PL = plazaCfg.planter, planters = world.plaza.planters ?? [];
    const FT = parquesCfg.independencia.fountain, fountains = (world.parks ?? []).flatMap((p) => p.fountains);
    const plazaSeats = nav.seats.filter((s) => s.zone === ZONE_PLAZA);
    expect(plazaSeats.length).toBeGreaterThanOrEqual(planters.length * peatones.nav.asientosPorMatera * 0.8);
    for (const s of nav.seats) {
      const isPlaza = s.zone === ZONE_PLAZA;
      const centers = isPlaza ? planters.map((p) => ({ x: p.x, z: p.z, R: PL.outerRadius, depth: PL.benchDepth, h: PL.seatHeight }))
        : fountains.map((f) => ({ x: f.x, z: f.z, R: Math.max(1.2, f.radius), depth: FT.rimWidth, h: FT.rimHeight }));
      const c = centers.reduce((b, p) => (Math.hypot(p.x - s.x, p.z - s.z) < Math.hypot(b.x - s.x, b.z - s.z) ? p : b));
      const r = Math.hypot(s.x - c.x, s.z - c.z);
      // la cadera sobre el asiento (entre el borde interior y el exterior del anillo) y a su altura
      expect(r).toBeGreaterThan(c.R - c.depth);
      expect(r).toBeLessThan(c.R);
      expect(s.seatY).toBeCloseTo(input.heightAt(c.x, c.z) + c.h, 5);
      // de frente hacia afuera: avance (-sin h, -cos h) en la dirección radial
      const out = (-Math.sin(s.heading) * (s.x - c.x) - Math.cos(s.heading) * (s.z - c.z)) / r;
      expect(out).toBeGreaterThan(0.99);
      // los pies (nodo de acceso) afuera del anillo, en la red
      expect(Math.hypot(s.fx - c.x, s.fz - c.z)).toBeGreaterThan(c.R);
      expect(nav.kind[s.node]).toBe(K_SEAT);
      expect(nav.degree(s.node)).toBeGreaterThan(0);
    }
  });

  it('altura del suelo: terreno + 0,15 en el andén, + 0,025 en la plaza, + 0,03 en el parque', () => {
    const swH = trafico.sidewalks.height, A = peatones.nav.alturas;
    let checked = 0;
    for (let i = 0; i < nav.n; i += 7) {
      const x = nav.x[i], z = nav.z[i], h = input.heightAt(x, z), y = nav.groundY(x, z);
      if (nav.onWalk(x, z)) expect(y - h).toBeCloseTo(swH, 6);
      else if (nav.zone[i] === ZONE_PLAZA) expect(y - h).toBeCloseTo(A.plaza, 6);
      else if (nav.zone[i] === ZONE_PARK) expect(y - h).toBeCloseTo(A.parque, 6);
      else continue;
      checked++;
    }
    expect(checked).toBeGreaterThan(500);
    // sobre la calzada (en medio de un cruce), el terreno
    const c = nav.crossings[0];
    expect(nav.groundY(c.cx, c.cz)).toBeCloseTo(input.heightAt(c.cx, c.cz), 6);
  });
});
