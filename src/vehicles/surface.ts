import type { Road } from '../world/types';

/**
 * Superficie del suelo en un punto: la de la vía OSM bajo la rueda (surface=* o la de su clase, ver roads.json),
 * la plaza adoquinada, o "lot" (predios, andenes sin mapear). Índice en rejilla de 8 m.
 */
export class SurfaceMap {
  private cell = 8;
  private grid = new Map<string, { ax: number; az: number; bx: number; bz: number; hw: number; surface: string }[]>();

  constructor(roads: Road[], private plaza: [number, number][] | undefined) {
    for (const r of roads) {
      if (r.area) continue;
      const hw = r.width / 2;
      for (let i = 0; i < r.pts.length - 1; i++) {
        const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1];
        const seg = { ax, az, bx, bz, hw, surface: r.surface };
        const x0 = Math.floor((Math.min(ax, bx) - hw) / this.cell), x1 = Math.floor((Math.max(ax, bx) + hw) / this.cell);
        const z0 = Math.floor((Math.min(az, bz) - hw) / this.cell), z1 = Math.floor((Math.max(az, bz) + hw) / this.cell);
        for (let cx = x0; cx <= x1; cx++) {
          for (let cz = z0; cz <= z1; cz++) {
            const k = `${cx},${cz}`;
            if (!this.grid.has(k)) this.grid.set(k, []);
            this.grid.get(k)!.push(seg);
          }
        }
      }
    }
  }

  at(x: number, z: number): string {
    const segs = this.grid.get(`${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`) ?? [];
    let best: string | null = null, bestD = Infinity;
    for (const s of segs) {
      const dx = s.bx - s.ax, dz = s.bz - s.az;
      const L2 = dx * dx + dz * dz || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / L2));
      const d = Math.hypot(x - (s.ax + t * dx), z - (s.az + t * dz));
      if (d <= s.hw && d < bestD) { bestD = d; best = s.surface; }
    }
    if (best) return best;
    if (this.plaza && inside(x, z, this.plaza)) return 'plaza';
    return 'lot';
  }
}

function inside(x: number, z: number, ring: [number, number][]) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}
