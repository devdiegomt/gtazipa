/**
 * Opciones del menú de pausa (localStorage que puede fallar) y lógica de la pausa (teclas y pointer lock).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULTS, RANGES, STORAGE_KEY, loadSettings, sanitize, saveSettings } from '../src/settings';
import { PauseState } from '../src/ui/pause';

/** Almacenamiento en memoria; `fail` hace que lea o escriba lanzando (modo privado, cuota, datos bloqueados). */
function memory(fail: { get?: boolean; set?: boolean } = {}) {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => { if (fail.get) throw new Error('SecurityError'); return m.get(k) ?? null; },
    setItem: (k: string, v: string) => { if (fail.set) throw new Error('QuotaExceededError'); m.set(k, v); },
  };
}

describe('opciones', () => {
  afterEach(() => { delete (globalThis as Record<string, unknown>).localStorage; });

  it('sin nada guardado (o sin almacenamiento) usa los valores por defecto', () => {
    expect(loadSettings(memory())).toEqual(DEFAULTS);
    expect(loadSettings(null)).toEqual(DEFAULTS);
    expect(DEFAULTS).toMatchObject({ sensitivity: 1, invertY: false, volume: 1, debugHud: false });
  });

  it('guarda y vuelve a cargar', () => {
    const st = memory();
    const s = { sensitivity: 1.5, invertY: true, volume: 0.35, fov: 75, debugHud: true };
    expect(saveSettings(s, st)).toBe(true);
    expect(JSON.parse(st.m.get(STORAGE_KEY)!)).toEqual(s);
    expect(loadSettings(st)).toEqual(s);
  });

  it('el almacenamiento que lanza no rompe nada', () => {
    expect(loadSettings(memory({ get: true }))).toEqual(DEFAULTS);
    expect(saveSettings({ ...DEFAULTS, fov: 70 }, memory({ set: true }))).toBe(false);
    // acceder a localStorage ya lanza (iframe aislado, cookies bloqueadas)
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
    expect(loadSettings()).toEqual(DEFAULTS);
    expect(saveSettings(DEFAULTS)).toBe(false);
  });

  it('JSON roto, tipos equivocados y valores fuera de rango', () => {
    const st = memory();
    st.m.set(STORAGE_KEY, '{no es json');
    expect(loadSettings(st)).toEqual(DEFAULTS);
    st.m.set(STORAGE_KEY, JSON.stringify({ sensitivity: 99, volume: -2, fov: 'ancho', invertY: 'sí', debugHud: true, otra: 1 }));
    expect(loadSettings(st)).toEqual({ ...DEFAULTS, sensitivity: RANGES.sensitivity[1], volume: 0, debugHud: true });
    expect(sanitize({ fov: Number.NaN, sensitivity: 0 })).toEqual({ ...DEFAULTS, sensitivity: RANGES.sensitivity[0] });
    expect(sanitize([1, 2])).toEqual(DEFAULTS);
  });
});

describe('pausa', () => {
  it('no empieza en pausa; P la abre y la cierra', () => {
    const p = new PauseState();
    expect(p.paused).toBe(false);
    expect(p.key('KeyP', 0)).toBe('pause');
    p.paused = true;
    expect(p.key('KeyP', 10)).toBe('resume');
    expect(p.key('KeyW', 10)).toBe(null);
  });

  it('Escape abre y cierra, con o sin el puntero capturado', () => {
    const p = new PauseState();
    expect(p.key('Escape', 0)).toBe('pause');          // nunca se capturó (cámara por arrastre)
    p.paused = true;
    expect(p.key('Escape', 100)).toBe('resume');
    p.paused = false;
    p.lockChange(true, 200);
    // capturado: Chrome consume la tecla y suelta el puntero (eso pausa); si la tecla llega igual, también pausa
    expect(p.key('Escape', 300)).toBe('pause');
  });

  it('perder el puntero que el juego tenía pausa; si lo soltó el menú, no', () => {
    const p = new PauseState();
    expect(p.lockChange(false, 0)).toBe(null);         // nunca lo tuvo
    p.lockChange(true, 10);
    expect(p.lockChange(false, 20)).toBe('pause');     // Esc, Alt+Tab…
    p.paused = true;
    // el Esc que soltó el puntero llega después como tecla: no cierra el menú recién abierto
    expect(p.key('Escape', 120)).toBe(null);
    expect(p.key('Escape', 900)).toBe('resume');
    p.paused = false;
    // P con el puntero capturado: el menú lo suelta él mismo
    p.lockChange(true, 1000);
    expect(p.key('KeyP', 1100)).toBe('pause');
    p.paused = true;
    p.willUnlock();
    expect(p.lockChange(false, 1110)).toBe(null);
    // ya en pausa, perderlo no hace nada
    p.lockChange(true, 1200);
    expect(p.lockChange(false, 1300)).toBe(null);
  });

  it('desactivada (capturas): ni teclas ni pérdida del puntero la abren', () => {
    const p = new PauseState(false);
    expect(p.key('KeyP', 0)).toBe(null);
    expect(p.key('Escape', 0)).toBe(null);
    p.lockChange(true, 0);
    expect(p.lockChange(false, 10)).toBe(null);
  });
});
