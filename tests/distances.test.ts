import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import geodesic from 'geographiclib-geodesic';
import type { Corner, Road, WorldMeta } from '../src/world/types';

/**
 * La distancia entre esquinas reales en el juego debe coincidir con OSM (±1 m).
 * Referencia: distancia geodésica WGS84 (GeographicLib, independiente de pyproj) entre las lat/lon
 * originales de los nodos OSM. Juego: distancia euclídea en el plano XZ (1 unidad = 1 m).
 */
const W = 'public/world/';
const corners: Corner[] = JSON.parse(readFileSync(W + 'corners.json', 'utf8'));
const roads: Road[] = JSON.parse(readFileSync(W + 'roads.json', 'utf8'));
const world: WorldMeta = JSON.parse(readFileSync(W + 'world.json', 'utf8'));
const geod = geodesic.Geodesic.WGS84;

// Pares de esquinas (nodo OSM compartido por la calle y la carrera indicadas).
const PAIRS: [number, number, string][] = [
  [1317234021, 1317234219, 'Calle 4 × Carrera 7  ↔  Calle 4 × Carrera 8 (junto a la plaza)'],
  [1317282610, 1317233810, 'Calle 1 × Carrera 6  ↔  Calle 7 × Carrera 9 (diagonal NO–SE)'],
  [1317234187, 349656928, 'Calle 2 × Carrera 4  ↔  Calle 5 × Carrera 12 (oeste–este)'],
];

const byNode = new Map(corners.map((c) => [c.node, c]));

describe('escala y proyección del mundo', () => {
  for (const [a, b, label] of PAIRS) {
    it(label, () => {
      const A = byNode.get(a), B = byNode.get(b);
      expect(A, `esquina ${a}`).toBeDefined();
      expect(B, `esquina ${b}`).toBeDefined();
      const real = geod.Inverse(A!.lat, A!.lon, B!.lat, B!.lon).s12 as number;
      const game = Math.hypot(B!.x - A!.x, B!.z - A!.z);
      console.log(`${label}: OSM ${real.toFixed(3)} m · juego ${game.toFixed(3)} m · Δ ${(game - real).toFixed(3)} m`);
      expect(real).toBeGreaterThan(50);
      expect(Math.abs(game - real)).toBeLessThanOrEqual(1.0);
    });
  }

  it('las esquinas son vértices de la red vial que usa el juego', () => {
    for (const [a, b] of PAIRS) {
      for (const id of [a, b]) {
        const c = byNode.get(id)!;
        const onRoad = roads.some((r) => r.pts.some(([x, z]) => Math.hypot(x - c.x, z - c.z) < 0.02));
        expect(onRoad, `nodo ${id} en roads.json`).toBe(true);
      }
    }
  });

  it('las lat/lon de las esquinas son las del extracto OSM original', () => {
    const raw = 'data/cache/osm_raw.json';
    if (!existsSync(raw)) return; // la caché no se versiona; se comprueba si existe
    const nodes = new Map<number, { lat: number; lon: number }>();
    for (const e of JSON.parse(readFileSync(raw, 'utf8')).elements) if (e.type === 'node') nodes.set(e.id, e);
    for (const [a, b] of PAIRS) {
      for (const id of [a, b]) {
        expect(nodes.get(id)?.lat).toBe(byNode.get(id)!.lat);
        expect(nodes.get(id)?.lon).toBe(byNode.get(id)!.lon);
      }
    }
  });

  it('el origen (0,0) es el centroide de la plaza', () => {
    const ring = world.plaza.ring;
    let A = 0, cx = 0, cz = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x0, z0] = ring[i], [x1, z1] = ring[i + 1];
      const f = x0 * z1 - x1 * z0;
      A += f; cx += (x0 + x1) * f; cz += (z0 + z1) * f;
    }
    cx /= 3 * A; cz /= 3 * A;
    expect(Math.hypot(cx, cz)).toBeLessThan(0.05);
  });
});
