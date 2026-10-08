import roadsCfg from '../data/roads.json';
import type { Road, WorldMeta } from '../world/types';

type ClassCfg = { minimap: { width: number; color: string } };

/**
 * Minimapa circular "norte arriba": la red vial real se pre-dibuja una vez en un canvas grande
 * (1 px = 0.5 m) y cada frame se recorta alrededor del jugador.
 */
export class Minimap {
  private ctx: CanvasRenderingContext2D;
  private base: HTMLCanvasElement;
  private readonly pxPerM = 2;
  private readonly half: number;
  /** Metros visibles desde el centro hasta el borde. */
  radius = 140;

  constructor(private canvas: HTMLCanvasElement, roads: Road[], meta: WorldMeta, buildingsXZ: [number, number, number][]) {
    this.ctx = canvas.getContext('2d')!;
    this.half = meta.terrain.half;
    const size = Math.ceil(this.half * 2 * this.pxPerM);
    this.base = document.createElement('canvas');
    this.base.width = this.base.height = size;
    const g = this.base.getContext('2d')!;
    g.fillStyle = '#3b3a35';
    g.fillRect(0, 0, size, size);
    const P = (x: number) => (x + this.half) * this.pxPerM;
    // Huellas aproximadas (cuadrado de área equivalente) para dar contexto.
    g.fillStyle = '#575449';
    for (const [x, z, a] of buildingsXZ) {
      const s = Math.sqrt(a) * this.pxPerM;
      g.fillRect(P(x) - s / 2, P(z) - s / 2, s, s);
    }
    // Plaza
    g.fillStyle = '#a39280';
    g.beginPath();
    meta.plaza.ring.forEach(([x, z], i) => (i ? g.lineTo(P(x), P(z)) : g.moveTo(P(x), P(z))));
    g.fill();
    const classes = roadsCfg.classes as Record<string, ClassCfg>;
    const order = ['footway', 'path', 'cycleway', 'steps', 'track', 'service', 'pedestrian', 'living_street',
      'residential', 'unclassified', 'tertiary', 'secondary', 'primary'];
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const cls of order) {
      const c = classes[cls];
      if (!c) continue;
      g.strokeStyle = c.minimap.color;
      g.lineWidth = c.minimap.width * this.pxPerM;
      for (const r of roads) {
        if (r.highway !== cls) continue;
        g.beginPath();
        r.pts.forEach(([x, z], i) => (i ? g.lineTo(P(x), P(z)) : g.moveTo(P(x), P(z))));
        if (r.area) { g.fillStyle = c.minimap.color; g.fill(); } else g.stroke();
      }
    }
    // Hitos
    for (const lm of meta.landmarks) {
      g.fillStyle = '#e8b04a';
      g.beginPath();
      lm.ring.forEach(([x, z], i) => (i ? g.lineTo(P(x), P(z)) : g.moveTo(P(x), P(z))));
      g.fill();
    }
    // Límite del área jugable
    g.strokeStyle = 'rgba(255,80,60,0.9)';
    g.lineWidth = 3;
    const a = meta.area.half;
    g.strokeRect(P(-a), P(-a), a * 2 * this.pxPerM, a * 2 * this.pxPerM);
  }

  draw(x: number, z: number, headingRad: number, cameraYaw: number,
    markers: { x: number; z: number; color: string; label?: string }[] = []) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const scale = W / 2 / this.radius; // px de pantalla por metro
    const srcHalf = this.radius * this.pxPerM;
    const sx = (x + this.half) * this.pxPerM, sz = (z + this.half) * this.pxPerM;
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, W / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#2b2a26';
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(this.base, sx - srcHalf, sz - srcHalf, srcHalf * 2, srcHalf * 2, 0, 0, W, H);
    // Marcadores (p. ej. la moto estacionada)
    for (const mk of markers) {
      const mx = W / 2 + (mk.x - x) * scale, my = H / 2 + (mk.z - z) * scale;
      ctx.fillStyle = mk.color;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(mx, my, 5.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (mk.label) {
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 10px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText(mk.label, mx, my - 9);
      }
    }
    // Cono de visión de la cámara
    ctx.translate(W / 2, H / 2);
    ctx.save();
    ctx.rotate(-cameraYaw);
    ctx.fillStyle = 'rgba(255,255,255,0.13)';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 60 * scale, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5);
    ctx.fill();
    ctx.restore();
    // Jugador (flecha según su orientación)
    ctx.rotate(-headingRad);
    ctx.fillStyle = '#ff4b3a';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(6.5, 7);
    ctx.lineTo(0, 3.5);
    ctx.lineTo(-6.5, 7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    // Norte
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 13px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('N', W / 2, 16);
  }
}
