/**
 * Pasos del jugador con el avatar real: Avatar.walkPhase (sólo lectura) + StepDetector, como lo usará main.ts.
 */
import { describe, expect, it } from 'vitest';
import { Avatar } from '../src/player/avatar';
import { StepDetector } from '../src/audio/mix';

describe('pasos desde el avatar', () => {
  it('caminar y correr producen pisadas al ritmo de la animación; quieto, ninguna', () => {
    const run = (speed: number, seconds: number) => {
      const a = new Avatar(), d = new StepDetector(), dt = 1 / 60;
      let n = 0;
      for (let t = 0; t < seconds; t += dt) {
        a.animate(speed, true, 0, dt);
        if (d.update(a.walkPhase, speed, true, dt) === 1) n++;
      }
      return n;
    };
    // 1,6 m/s con zancada de 1,6 m por medio ciclo: una pisada por segundo
    expect(run(1.6, 10)).toBeGreaterThanOrEqual(9);
    expect(run(1.6, 10)).toBeLessThanOrEqual(10);
    // corriendo a 6 m/s (zancada 1,25 m): ~4,8 pisadas por segundo
    expect(run(6, 10)).toBeGreaterThanOrEqual(46);
    expect(run(6, 10)).toBeLessThanOrEqual(48);
    expect(run(0, 10)).toBe(0);
  });
  it('la pisada coincide con las piernas más abiertas (|balanceo| máximo)', () => {
    const a = new Avatar(), d = new StepDetector(), dt = 1 / 240;
    const legs = (a as unknown as { legL: { root: { rotation: { x: number } } } }).legL.root.rotation;
    const swings: number[] = [];
    for (let t = 0; t < 4; t += dt) {
      a.animate(1.6, true, 0, dt);
      if (d.update(a.walkPhase, 1.6, true, dt) === 1) swings.push(Math.abs(legs.x));
    }
    const amp = Math.min(1.6 / 6, 1) * 0.6;
    expect(swings.length).toBeGreaterThan(2);
    for (const s of swings) expect(s).toBeGreaterThan(amp * 0.99);
  });
});
