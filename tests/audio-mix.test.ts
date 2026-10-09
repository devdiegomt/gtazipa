/**
 * Lógica pura del audio de la ciudad (src/audio/mix.ts): espacialización, reparto de voces con histéresis, motores,
 * campanas y su horario en tiempo de juego, pasos desde la fase del caminado y mezcla del ambiente por zona.
 * (El grafo WebAudio se verifica aparte, renderizando en Chromium sin pantalla.)
 */
import { describe, expect, it } from 'vitest';
import {
  BELL_PARTIALS, BELLS, BellSchedule, ENGINES, FOOT, StepDetector, VoicePool, belfryPosition, birdSong, bellFrequencies, countNear,
  engineHarmonics, engineState, footClass, mulberry32, newEngineState, newSpatial, newZoneMix, pealPattern, spatialize,
  trafficDensity, zoneMix, ZoneMap, type AudioVehicle, type BirdNote, type PealStrike,
} from '../src/audio/mix';

const veh = (x: number, z: number, type = 'carro', active = true, v = 8): AudioVehicle => ({ x, z, v, type, active });

describe('espacialización', () => {
  const L = { x: 0, y: 2, z: 0, fx: 0, fz: -1 };   // mirando hacia −z: la derecha es +x
  it('paneo según el lado, atenuación por distancia y silencio al final del alcance', () => {
    const s = newSpatial();
    expect(spatialize(L, 10, 2, 0, 5, 80, s).pan).toBeGreaterThan(0.7);
    expect(spatialize(L, -10, 2, 0, 5, 80, s).pan).toBeLessThan(-0.7);
    expect(Math.abs(spatialize(L, 0, 2, -10, 5, 80, s).pan)).toBeLessThan(1e-9);
    expect(spatialize(L, 0, 2, -3, 5, 80, s).gain).toBe(1);               // dentro del radio de referencia
    expect(spatialize(L, 0, 2, -20, 5, 80, s).gain).toBeCloseTo(0.25, 5);  // 5 / 20
    expect(spatialize(L, 0, 2, -80, 5, 80, s).gain).toBe(0);
    const near = spatialize(L, 0, 2, -10, 5, 80, s).gain;
    expect(spatialize(L, 0, 2, -40, 5, 80, s).gain).toBeLessThan(near);
  });
  it('detrás suena más apagado que delante (corte del paso bajo)', () => {
    const s = newSpatial();
    const front = spatialize(L, 0, 2, -20, 5, 80, s).lp;
    const back = spatialize(L, 0, 2, 20, 5, 80, s).lp;
    expect(back).toBeLessThan(front * 0.7);
    // la dirección de vista no necesita estar normalizada
    expect(spatialize({ ...L, fz: -7 }, 10, 2, 0, 5, 80, s).pan).toBeCloseTo(spatialize(L, 10, 2, 0, 5, 80, newSpatial()).pan, 9);
  });
  it('girar la cámara cambia el lado: mirando hacia +x, lo que está en +z queda a la derecha', () => {
    const s = newSpatial();
    expect(spatialize({ x: 0, y: 0, z: 0, fx: 1, fz: 0 }, 0, 0, 10, 5, 80, s).pan).toBeGreaterThan(0.7);
  });
});

describe('reparto de voces de motor', () => {
  const opts = { active: 3, voices: 5, maxDist: 80, hyst: 0.75, jump: 12 };
  it('suenan los vehículos activos más cercanos', () => {
    const p = new VoicePool(opts);
    const vs = [veh(50, 0), veh(10, 0), veh(5, 0, 'carro', false), veh(30, 0), veh(20, 0), veh(200, 0)];
    p.assign(vs, 0, 0, 0);
    const voiced = [...p.veh].filter((i) => i >= 0).sort();
    expect(voiced).toEqual([1, 3, 4]);
    expect([...p.changed].filter((c) => c === 1)).toHaveLength(3);
  });
  it('alcance por tipo: una buseta se oye desde más lejos que un carro', () => {
    const p = new VoicePool({ ...opts, active: 1 });
    p.assign([veh(40, 0, 'carro'), veh(50, 0, 'buseta')], 0, 0, 0);
    expect(p.voiceOf(1)).toBeGreaterThanOrEqual(0);
    expect(p.voiceOf(0)).toBe(-1);
  });
  it('histéresis: el que suena sólo cede ante uno claramente más cerca', () => {
    const p = new VoicePool({ ...opts, active: 1 });
    const vs = [veh(20, 0), veh(30, 0)];
    p.assign(vs, 0, 0, 0);
    expect(p.voiceOf(0)).toBeGreaterThanOrEqual(0);
    vs[1].x = 17;                            // más cerca, pero no lo bastante (17 > 0,75 × 20)
    p.assign(vs, 0, 0, 0.1);
    expect(p.voiceOf(0)).toBeGreaterThanOrEqual(0);
    expect(p.voiceOf(1)).toBe(-1);
    vs[1].x = 14;                            // ahora sí (14 < 15)
    p.assign(vs, 0, 0, 0.2);
    expect(p.voiceOf(1)).toBeGreaterThanOrEqual(0);
    expect(p.voiceOf(0)).toBe(-1);
    // y no vuelve atrás por oscilaciones pequeñas
    vs[0].x = 13;
    p.assign(vs, 0, 0, 0.3);
    expect(p.voiceOf(1)).toBeGreaterThanOrEqual(0);
  });
  it('fundido cruzado: el que entra toma una voz en silencio, distinta de la que se desvanece', () => {
    const p = new VoicePool({ ...opts, active: 1, voices: 2 });
    const vs = [veh(20, 0), veh(60, 0)];
    p.assign(vs, 0, 0, 0);
    const a = p.voiceOf(0);
    vs[1].x = 5;
    p.assign(vs, 0, 0, 1);
    const b = p.voiceOf(1);
    expect(b).not.toBe(a);
    expect(p.changed[a]).toBe(2);           // liberada en esta llamada: se desvanece
    expect(p.changed[b]).toBe(1);
    expect(p.freeFor[b]).toBe(Infinity);     // nunca usada: entra desde silencio
    // la siguiente reasignación reutiliza la voz que lleva más tiempo libre (la que se desvaneció hace 1 s)
    vs[0].x = 1;
    p.assign(vs, 0, 0, 2);
    expect(p.voiceOf(0)).toBe(a);
    expect(p.freeFor[a]).toBeCloseTo(1, 9);
  });
  it('un vehículo reciclado (salta de sitio) o inactivo pierde su voz', () => {
    const p = new VoicePool(opts);
    const vs = [veh(10, 0), veh(20, 0)];
    p.assign(vs, 0, 0, 0);
    const a = p.voiceOf(0);
    vs[0].x = 10.5; vs[0].z = 30;            // reapareció en otro sitio (cerca, sigue entre los elegidos)
    p.assign(vs, 0, 0, 0.1);
    expect(p.changed[a]).toBe(2);
    expect(p.voiceOf(0)).not.toBe(a);         // voz nueva (fundido), no la misma con un salto
    vs[1].active = false;
    p.assign(vs, 0, 0, 0.2);
    expect(p.voiceOf(1)).toBe(-1);
  });
  it('sin vehículos en el alcance no suena nada y es determinista', () => {
    const p = new VoicePool(opts);
    p.assign([veh(500, 0), veh(0, 300)], 0, 0, 0);
    expect([...p.veh].every((i) => i === -1)).toBe(true);
    const r = mulberry32(3);
    const vs = Array.from({ length: 60 }, () => veh(r() * 160 - 80, r() * 160 - 80));
    const a = new VoicePool(opts), b = new VoicePool(opts);
    for (let s = 0; s < 50; s++) {
      for (const v of vs) { v.x += 0.5; v.z -= 0.3; }
      a.assign(vs, 0, 0, s / 30); b.assign(vs, 0, 0, s / 30);
    }
    expect([...a.veh]).toEqual([...b.veh]);
  });
});

describe('motores', () => {
  it('el tono sube con la velocidad dentro de una marcha y cae al cambiar', () => {
    const spec = ENGINES.moto, e = newEngineState();
    const f = (v: number) => engineState(spec, v, 0.5, e).f;
    expect(f(0)).toBeCloseTo(spec.idle / 120, 6);                // ralentí: 1 400 rpm → 11,7 Hz
    expect(f(4)).toBeGreaterThan(f(2));
    expect(f(5.4)).toBeGreaterThan(f(5.6));                      // 1ª → 2ª
    expect(engineState(spec, 30, 0, e).rpm).toBeLessThanOrEqual(spec.shift * 1.08);
  });
  it('la carga sale de la aceleración', () => {
    const e = newEngineState();
    expect(engineState(ENGINES.carro, 10, 2, e).load).toBeGreaterThan(engineState(ENGINES.carro, 10, 0, e).load);
    expect(engineState(ENGINES.carro, 10, -3, e).load).toBeCloseTo(0.1, 9);
  });
  it('los órdenes de encendido dominan el espectro (4 cilindros: cada 4.º armónico del ciclo)', () => {
    const a = engineHarmonics(ENGINES.carro);
    expect(a[0]).toBe(0);
    expect(a[4]).toBeGreaterThan(a[3] * 3);
    expect(a[8]).toBeGreaterThan(a[7] * 3);
    const t = engineHarmonics(ENGINES.taxi);
    expect(t[3]).toBeGreaterThan(t[2] * 2);
    const m = engineHarmonics(ENGINES.moto);
    expect(m[2]).toBeGreaterThan(m[1]);                         // monocilíndrico: pares reforzados
  });
  it('densidad de tráfico: sólo activos, más cerca y más rápido pesa más', () => {
    expect(trafficDensity([veh(10, 0, 'carro', false)], 0, 0)).toBe(0);
    expect(trafficDensity([veh(10, 0)], 0, 0)).toBeGreaterThan(trafficDensity([veh(100, 0)], 0, 0));
    expect(trafficDensity([veh(10, 0, 'carro', true, 12)], 0, 0)).toBeGreaterThan(trafficDensity([veh(10, 0, 'carro', true, 0)], 0, 0));
    expect(trafficDensity([veh(200, 0)], 0, 0)).toBe(0);
  });
  it('countNear cuenta sólo activos dentro del radio', () => {
    const ps = [{ x: 1, z: 1, active: true }, { x: 2, z: 0, active: false }, { x: 50, z: 0, active: true }];
    expect(countNear(ps, 0, 0, 35)).toBe(1);
  });
});

describe('campanas', () => {
  it('parciales de una campana afinada: hum, prima, tercera menor, quinta, nominal', () => {
    const by = Object.fromEntries(BELL_PARTIALS.map((p) => [p.name, p]));
    expect(by.hum.ratio).toBe(0.5);
    expect(by.prima.ratio).toBe(1);
    expect(by.tercera.ratio).toBeCloseTo(6 / 5, 6);
    expect(by.quinta.ratio).toBe(1.5);
    expect(by.nominal.ratio).toBe(2);
    // los graves duran más que los agudos
    expect(by.hum.tau).toBeGreaterThan(by.nominal.tau);
    expect(by.nominal.tau).toBeGreaterThan(BELL_PARTIALS[BELL_PARTIALS.length - 1].tau);
    expect(bellFrequencies(0)[4]).toBeCloseTo(BELLS[0] * 2, 6);
  });
  it('patrón del repique: ordenado, las tres campanas, ~17 s, determinista', () => {
    const p = pealPattern(7);
    expect(p.length).toBeGreaterThan(15);
    for (let i = 1; i < p.length; i++) expect(p[i].t).toBeGreaterThanOrEqual(p[i - 1].t);
    expect(new Set(p.map((s) => s.bell))).toEqual(new Set([0, 1, 2]));
    expect(p[p.length - 1].t).toBeGreaterThan(12);
    expect(p[p.length - 1].t).toBeLessThan(25);
    expect(pealPattern(7)).toEqual(p);
    expect(p.every((s) => s.vel > 0 && s.vel <= 1)).toBe(true);
  });
  it('horario en tiempo de juego: repique al empezar y cada periodo; en pausa (dt = 0) nada avanza', () => {
    const pat = pealPattern(1);
    const s = new BellSchedule(pat, 3, 120);
    const out: PealStrike[] = [];
    const hits: number[] = [];
    for (let i = 0; i < 300 * 30; i++) {
      const n = s.advance(1 / 30, out);
      for (let k = 0; k < n; k++) hits.push(s.t);
    }
    // repiques a los 3, 123 y 243 s: tres veces el patrón completo
    expect(hits.length).toBe(pat.length * 3);
    expect(hits[0]).toBeGreaterThanOrEqual(3);
    expect(hits[0]).toBeLessThan(3 + 1 / 30 + 1e-9);
    expect(hits[pat.length]).toBeGreaterThanOrEqual(123);
    expect(hits[pat.length]).toBeLessThan(124);
    const t = s.t;
    for (let i = 0; i < 1000; i++) expect(s.advance(0, out)).toBe(0);
    expect(s.t).toBe(t);
  });
  it('ring(): repique a pedido, sin pisar uno en curso, y el automático se aplaza', () => {
    const pat = pealPattern(2);
    const s = new BellSchedule(pat, 1000, 300);
    const out: PealStrike[] = [];
    s.advance(10, out);
    s.ring();
    expect(s.ringing).toBe(true);
    let total = 0;
    for (let i = 0; i < 30 * 30; i++) { if (i === 30) s.ring(); total += s.advance(1 / 30, out); }
    expect(total).toBe(pat.length);
    expect(s.ringing).toBe(false);
  });
  it('un dt grande entrega varios golpes de una vez, en orden', () => {
    const pat = pealPattern(3);
    const s = new BellSchedule(pat, 0, 300);
    const out: PealStrike[] = [];
    const n = s.advance(7, out);
    expect(n).toBe(pat.filter((p) => p.t <= 7).length);
    expect(out.slice(0, n)).toEqual(pat.slice(0, n));
  });
});

describe('pasos', () => {
  /** Integra la fase como Avatar.animate (zancada 1,6 m caminando, 1,25 m corriendo). */
  const walk = (speed: number, seconds: number, grounded = (_t: number) => true, dt = 1 / 60) => {
    const d = new StepDetector();
    let phase = 0;
    const ev: { t: number; e: number }[] = [];
    for (let t = 0; t < seconds; t += dt) {
      phase += (speed / (speed > 4 ? 1.25 : 1.6)) * Math.PI * dt;
      const e = d.update(phase, speed, grounded(t), dt);
      if (e) ev.push({ t, e });
    }
    return ev;
  };
  it('caminando a 1,6 m/s: una pisada por cada medio ciclo (≈ 1 por segundo por pie)', () => {
    const ev = walk(1.6, 10);
    expect(ev.every((e) => e.e === 1)).toBe(true);
    expect(ev.length).toBeGreaterThanOrEqual(9);
    expect(ev.length).toBeLessThanOrEqual(10);
    // la primera cuando la fase cruza π/2 (piernas más abiertas)
    expect(ev[0].t).toBeCloseTo(0.5, 1);
  });
  it('corriendo, más pisadas por segundo; quieto, ninguna; con FPS bajos, a lo sumo una por frame', () => {
    expect(walk(6, 5).length).toBeGreaterThan(walk(1.6, 5).length * 2);
    expect(walk(0, 5)).toHaveLength(0);
    expect(walk(0.3, 20)).toHaveLength(0);
    const slow = walk(6, 5, () => true, 0.1);
    expect(slow.length).toBeLessThanOrEqual(50);
  });
  it('en el aire no suena; al caer tras un salto, aterrizaje', () => {
    const ev = walk(3, 4, (t) => !(t > 1 && t < 1.6));
    expect(ev.filter((e) => e.t > 1 && e.t < 1.6)).toHaveLength(0);
    const land = ev.filter((e) => e.e === 2);
    expect(land).toHaveLength(1);
    expect(land[0].t).toBeCloseTo(1.6, 1);
    // un bache corto (bordillo del andén) no es aterrizaje
    expect(walk(3, 4, (t) => !(t > 1 && t < 1.1)).filter((e) => e.e === 2)).toHaveLength(0);
  });
  it('superficies → clase de pisada', () => {
    expect(footClass('asphalt')).toBe('asfalto');
    expect(footClass('sidewalk')).toBe('anden');
    expect(footClass('lot')).toBe('anden');
    expect(footClass('plaza')).toBe('ladrillo');
    expect(footClass('sett')).toBe('piedra');
    expect(footClass('paving_stones')).toBe('piedra');
    expect(footClass('grass')).toBe('pasto');
    expect(footClass('unpaved')).toBe('tierra');
    expect(footClass('¿?')).toBe('anden');
    for (const f of Object.values(FOOT)) { expect(f.decay).toBeGreaterThan(0); expect(f.hz).toBeGreaterThan(100); }
    expect(FOOT.piedra.gap).toBeGreaterThan(0);                  // talón y punta en el empedrado
    expect(FOOT.pasto.decay).toBeGreaterThan(FOOT.anden.decay);  // el pasto cruje más largo y suave
  });
});

describe('ambiente por zona', () => {
  const base = { crowd: 0, plaza: 0, park: 0, street: 0, traffic: 0 };
  it('la multitud sube el murmullo (saturando) y más en la plaza', () => {
    const m = (z: Partial<typeof base>) => zoneMix({ ...base, ...z }, newZoneMix());
    expect(m({ crowd: 0 }).murmur).toBe(0);
    expect(m({ crowd: 20 }).murmur).toBeGreaterThan(m({ crowd: 5 }).murmur);
    expect(m({ crowd: 400 }).murmur).toBeLessThanOrEqual(1);
    expect(m({ crowd: 400 }).murmur - m({ crowd: 200 }).murmur).toBeLessThan(0.01);
    expect(m({ crowd: 30, plaza: 1 }).murmur).toBeGreaterThan(m({ crowd: 30 }).murmur);
    expect(m({ crowd: 0 }).talk).toBe(0);
    expect(m({ crowd: 10 }).talk).toBeGreaterThan(0);
  });
  it('pájaros en el parque, rumor con el tráfico (más en la calle)', () => {
    const m = (z: Partial<typeof base>) => zoneMix({ ...base, ...z }, newZoneMix());
    expect(m({ park: 1 }).birds).toBeGreaterThan(m({ street: 1 }).birds * 4);
    expect(m({ traffic: 5 }).rumble).toBeGreaterThan(m({ traffic: 0 }).rumble);
    expect(m({ traffic: 5, street: 1 }).rumble).toBeGreaterThan(m({ traffic: 5 }).rumble);
    expect(m({ traffic: 1e6, street: 1 }).rumble).toBeLessThanOrEqual(1.07);
    expect(m({ crowd: -3, plaza: 7 }).murmur).toBe(0);           // entradas fuera de rango se recortan
  });
  it('cantos: el copetón silba entre 3 y 5 kHz con trino final; notas en orden y sin reservar al reutilizar', () => {
    const notes: BirdNote[] = [];
    const r = mulberry32(9);
    const n = birdSong('copeton', r, notes);
    expect(n).toBeGreaterThanOrEqual(7);
    for (let i = 0; i < n; i++) {
      expect(Math.min(notes[i].f0, notes[i].f1)).toBeGreaterThan(2800);
      expect(Math.max(notes[i].f0, notes[i].f1)).toBeLessThan(5600);
      if (i) expect(notes[i].t).toBeGreaterThan(notes[i - 1].t + notes[i - 1].dur - 1e-9);
    }
    const first = notes[0];
    birdSong('chip', r, notes);
    expect(notes[0]).toBe(first);                                // mismos objetos
    const m = birdSong('mirla', r, notes);
    expect(Math.max(...notes.slice(0, m).map((b) => b.f0))).toBeLessThan(3600);
  });
});

describe('campanario', () => {
  it('torre oriental de la Catedral con los datos del mundo', async () => {
    const world = (await import('../public/world/world.json')).default as unknown as
      { landmarks: { name: string; model?: { origin: number[]; axisU: number[]; axisV: number[]; floorY: number; facadeWidth: number } }[] };
    const cat = (await import('../src/data/catedral.json')).default;
    const lm = world.landmarks.find((l) => l.model && /Catedral/.test(l.name))!;
    const p = belfryPosition(lm.model!, cat.towers);
    // delante del centroide de la huella (la fachada mira a la plaza), a ~25 m sobre el atrio
    expect(p.y).toBeGreaterThan(lm.model!.floorY + 22);
    expect(p.y).toBeLessThan(lm.model!.floorY + 30);
    expect(Math.hypot(p.x - 42.88, p.z + 31.53)).toBeLessThan(0.05);   // el valor por defecto de CityAudio
    const w = belfryPosition(lm.model!, cat.towers, false);
    expect(Math.hypot(p.x - w.x, p.z - w.z)).toBeCloseTo(lm.model!.facadeWidth - cat.towers.width, 3);
  });
});

describe('zonas', () => {
  it('pesos suaves desde los polígonos de world.json: plaza, parque y calle', async () => {
    const world = (await import('../public/world/world.json')).default as unknown as
      { plaza: { ring: number[][] }; parks: { ring: number[][] }[] };
    const zm = new ZoneMap(world.plaza.ring, world.parks.map((p) => p.ring));
    const w = { plaza: 0, park: 0, street: 0 };
    expect(zm.at(0, 0, w)).toEqual({ plaza: 1, park: 0, street: 0 });              // centro de la plaza
    const [px, pz] = world.parks[0].ring.slice(0, -1).reduce(([a, b], [x, z], _i, r) => [a + x / r.length, b + z / r.length], [0, 0]);
    zm.at(px, pz, w);
    expect(w.park).toBe(1);
    expect(w.street).toBe(0);
    zm.at(300, 300, w);
    expect(w).toEqual({ plaza: 0, park: 0, street: 1 });
    // borde suave: a 9 m de un lado de la plaza, mitad y mitad
    const [a, b] = world.plaza.ring;
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2, dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
    let nx = dz / L, nz = -dx / L;
    if (zm.at(mx + nx, mz + nz, w).plaza === 1) { nx = -nx; nz = -nz; }   // normal hacia afuera
    zm.at(mx + nx * 9, mz + nz * 9, w);
    expect(w.plaza).toBeCloseTo(0.5, 1);
    expect(w.street).toBeCloseTo(0.5, 1);
  });
});
