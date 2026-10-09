/**
 * Vehículos parqueados (ESTIMADO, procedimental y determinista; trafico.json traffic.parked): carros, taxis y camionetas
 * en fila junto al sardinel y grupos de motos en diagonal, sólo en los carriles de parqueo de la simulación
 * (TrafficSim.parkR/parkL: donde sobra ancho entre los carriles y el sardinel), lejos de cruces, cebras y paraderos.
 * layoutParked y parkedColliders son puros (se prueban con vitest); ParkedView los dibuja (estáticos, instanciados).
 */
import * as THREE from 'three/webgpu';
import { DIMS, rng, type TrafficSim, type VehicleType } from './sim';
import { Poly, type RoadGraph } from './graph';
import { TrafficView, vehicleMeshes } from './render';

export type ParkedType = Exclude<VehicleType, 'buseta'>;
export interface ParkedCfg {
  fill: number; curbGap: number; gap: [number, number]; fromJunction: number; fromCrossing: number; fromBusStop: number;
  edgeMargin: number; mix: Record<ParkedType, number>; motoGroup: [number, number]; motoAngle: number; motoSpacing: number; seed: number;
}
/** Un vehículo parqueado: centro (x, z) de la huella, rumbo (como el tráfico), inclinación lateral (moto sobre el gato). */
export interface Parked {
  type: ParkedType; x: number; z: number; yaw: number; roll: number; length: number; width: number;
  /** Arista y lado (1 = derecha de sus puntos, -1 = izquierda) donde está. */
  edge: number; side: 1 | -1;
}
export interface ParkedCollider { x: number; y: number; z: number; hx: number; hy: number; hz: number; yaw: number }

/** Alto de la moto parqueada (sin conductor) para su caja de colisión. */
const MOTO_H = 1.15;

/** Distancia con signo de (x, z) al eje de la arista (positiva hacia `side`), sobre el segmento más cercano. */
function lateralOf(poly: Poly, side: number, x: number, z: number) {
  let best = Infinity, lat = 0;
  for (let i = 1; i < poly.x.length; i++) {
    const ax = poly.x[i - 1], az = poly.z[i - 1], dx = poly.x[i] - ax, dz = poly.z[i] - az, L2 = dx * dx + dz * dz || 1e-12;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
    const d = Math.hypot(x - ax - dx * t, z - az - dz * t);
    if (d < best) { best = d; lat = (((x - ax) * -dz + (z - az) * dx) / Math.sqrt(L2)) * side; }
  }
  return lat;
}

const CORNERS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

/**
 * Puestos ocupados, deterministas para la misma configuración. `avoid`: además de cebras y paraderos, puntos que dejar
 * libres a `r` m (más media huella), p. ej. los cruces peatonales de la red de peatones y la moto del jugador.
 */
export function layoutParked(graph: RoadGraph, sim: Pick<TrafficSim, 'parkR' | 'parkL' | 'spareR' | 'spareL' | 'busStops' | 'areaHalf'>,
  cfg: ParkedCfg, avoid: readonly { x: number; z: number; r: number }[] = []): Parked[] {
  const r = rng(cfg.seed), out: Parked[] = [];
  const radius = new Map(graph.nodes.map((n) => [n.id, n.radius]));
  const cross = (graph.crossings ?? []) as { x: number; z: number }[];
  const types = Object.keys(cfg.mix) as ParkedType[], total = types.reduce((s, k) => s + cfg.mix[k], 0);
  const pick = () => { let u = r() * total; for (const k of types) if ((u -= cfg.mix[k]) < 0) return k; return types[0]; };
  const a = (cfg.motoAngle * Math.PI) / 180, M = DIMS.moto;
  const along = M.length * Math.cos(a) + M.width * Math.sin(a), across = M.length * Math.sin(a) + M.width * Math.cos(a);
  const p = { x: 0, z: 0, tx: 0, tz: 1 };
  // ¿el centro (x, z) queda lejos de cebras, paraderos y del borde del mapa?
  const clear = (x: number, z: number, half: number) =>
    Math.abs(x) < sim.areaHalf - cfg.edgeMargin && Math.abs(z) < sim.areaHalf - cfg.edgeMargin &&
    !cross.some((c) => Math.hypot(c.x - x, c.z - z) < cfg.fromCrossing + half) &&
    !sim.busStops.some((b) => Math.hypot(b.bx - x, b.bz - z) < cfg.fromBusStop + half) &&
    !avoid.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + half);
  for (const e of [...graph.edges].sort((m, n) => m.id - n.id)) {
    for (const side of [1, -1] as const) {
      if (!(side === 1 ? sim.parkR[e.id] : sim.parkL[e.id])) continue;
      const spare = side === 1 ? sim.spareR[e.id] : sim.spareL[e.id], W = e.width / 2;
      const poly = new Poly(e.pts), end = poly.length - (radius.get(e.to) ?? 0) - cfg.fromJunction;
      // sentido del tráfico de ese lado: el de los carriles que van por él (o el único que tiene la vía)
      const fwd = side === 1 ? (e.fw > 0 ? 1 : -1) : (e.bw > 0 ? -1 : 1);
      // cabe sin invadir los carriles (con 15 cm de tolerancia: queda espacio libre en el carril de al lado)
      const fits = (w: number) => cfg.curbGap + w <= spare + 0.15;
      // en las curvas la huella (recta) no debe subirse al andén ni salirse hacia el carril
      const inStrip = (x: number, z: number, yaw: number, length: number, width: number) => {
        const tx = -Math.sin(yaw), tz = -Math.cos(yaw), hl = length / 2, hw = width / 2;
        for (const [u, w] of CORNERS) {
          const lat = lateralOf(poly, side, x + tx * hl * u - tz * hw * w, z + tz * hl * u + tx * hw * w);
          if (lat > W - cfg.curbGap + 0.05 || lat < W - spare - 0.15) return false;
        }
        return true;
      };
      let s = (radius.get(e.from) ?? 0) + cfg.fromJunction + r() * cfg.gap[1];
      while (s < end) {
        if (r() > cfg.fill) { s += 2 + r() * 4; continue; }   // puesto libre
        let type = pick();
        if (type !== 'moto' && !fits(DIMS[type].width)) type = fits(DIMS.carro.width) ? 'carro' : 'moto';
        if (type === 'moto') {
          const n = cfg.motoGroup[0] + Math.floor(r() * (cfg.motoGroup[1] - cfg.motoGroup[0] + 1));
          const len = (n - 1) * cfg.motoSpacing + along;
          if (s + len > end) break;
          const group: Parked[] = [];
          for (let k = 0; k < n; k++) {
            poly.at(s + along / 2 + k * cfg.motoSpacing, p);
            const nx = -p.tz * side, nz = p.tx * side;                 // hacia el sardinel
            const lat = W - cfg.curbGap - across / 2;
            // de frente hacia la calzada, rueda trasera hacia el sardinel
            const fx = fwd * p.tx * Math.cos(a) - nx * Math.sin(a), fz = fwd * p.tz * Math.cos(a) - nz * Math.sin(a);
            const x = p.x + nx * lat, z = p.z + nz * lat;
            const yaw = Math.atan2(-fx, -fz);
            if (clear(x, z, M.length / 2) && inStrip(x, z, yaw, M.length, M.width)) group.push({ type, x, z, yaw, roll: 0.12, length: M.length, width: M.width, edge: e.id, side });
          }
          out.push(...group);
          s += len;
        } else {
          const { length, width } = DIMS[type];
          if (s + length > end) break;
          poly.at(s + length / 2, p);
          const nx = -p.tz * side, nz = p.tx * side, lat = W - cfg.curbGap - width / 2;
          const x = p.x + nx * lat, z = p.z + nz * lat;
          const yaw = Math.atan2(-fwd * p.tx, -fwd * p.tz);
          if (clear(x, z, length / 2) && inStrip(x, z, yaw, length, width)) out.push({ type, x, z, yaw, roll: 0, length, width, edge: e.id, side });
          s += length;
        }
        s += cfg.gap[0] + r() * (cfg.gap[1] - cfg.gap[0]);
      }
    }
  }
  return out;
}

/** Cajas de colisión fijas (sólo rumbo; grupo VEHICLE en main.ts) apoyadas en el terreno. */
export function parkedColliders(parked: Parked[], heightAt: (x: number, z: number) => number): ParkedCollider[] {
  return parked.map((q) => {
    const h = q.type === 'moto' ? MOTO_H : TrafficView.height(q.type);
    return { x: q.x, y: heightAt(q.x, q.z) + h / 2, z: q.z, hx: q.width / 2, hy: h / 2, hz: q.length / 2, yaw: q.yaw };
  });
}

/** Dibujo estático: por tipo, pintura, partes fijas y luces apagadas; siguen la pendiente de la calle. */
export class ParkedView {
  readonly group = new THREE.Group();
  constructor(parked: Parked[], heightAt: (x: number, z: number) => number) {
    this.group.name = 'parqueados';
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(0, 0, 0, 'YXZ');
    const pos = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
    for (const type of ['carro', 'taxi', 'camioneta', 'moto'] as const) {
      const list = parked.filter((v) => v.type === type);
      if (!list.length) continue;
      const m = vehicleMeshes(type, list.length, list.map((v) => Math.round(Math.abs(v.x * 13 + v.z * 7))), type !== 'moto');
      list.forEach((v, i) => {
        const tx = -Math.sin(v.yaw), tz = -Math.cos(v.yaw), h = v.length * 0.4;
        const yf = heightAt(v.x + tx * h, v.z + tz * h), yb = heightAt(v.x - tx * h, v.z - tz * h);
        e.set(Math.atan2(yf - yb, 2 * h), v.yaw, v.roll);
        m4.compose(pos.set(v.x, (yf + yb) / 2, v.z), q.setFromEuler(e), one);
        for (const k of [m.paint, m.fixed, m.lamps]) k.setMatrixAt(i, m4);
      });
      for (const k of [m.paint, m.fixed, m.lamps]) { k.computeBoundingSphere(); this.group.add(k); }
    }
  }
}
