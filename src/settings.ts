/**
 * Opciones del jugador (menú de pausa), guardadas en localStorage. El almacenamiento puede fallar (modo privado,
 * datos bloqueados, iframe aislado): toda lectura y escritura va en try/catch y el juego funciona sin él.
 */
import playerCfg from './data/player.json';

export interface Settings {
  /** Multiplicador de la sensibilidad del ratón (1 = la de player.json). */
  sensitivity: number;
  invertY: boolean;
  /** Volumen general 0..1. */
  volume: number;
  /** Campo de visión vertical en grados (sin el aumento por velocidad de la moto). */
  fov: number;
  /** Datos de depuración (FPS, draw calls, coordenadas). También con F3 o ?debug. */
  debugHud: boolean;
}

/** Límites de los valores numéricos: [mín, máx, paso]. */
export const RANGES = {
  sensitivity: [0.2, 3, 0.05],
  volume: [0, 1, 0.05],
  fov: [50, 90, 1],
} as const;

export const DEFAULTS: Readonly<Settings> = {
  sensitivity: 1, invertY: false, volume: 1, fov: playerCfg.camera.fov, debugHud: false,
};

export const STORAGE_KEY = 'zipa.opciones';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

/** localStorage si se puede usar (acceder a él ya puede lanzar SecurityError). */
function storage(): Store | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/** Completa con los valores por defecto y recorta al rango válido lo que venga guardado (o de cualquier origen). */
export function sanitize(raw: unknown): Settings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const num = (k: keyof typeof RANGES) => {
    const v = o[k], [min, max] = RANGES[k];
    return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : DEFAULTS[k];
  };
  const bool = (k: 'invertY' | 'debugHud') => (typeof o[k] === 'boolean' ? o[k] as boolean : DEFAULTS[k]);
  return { sensitivity: num('sensitivity'), invertY: bool('invertY'), volume: num('volume'), fov: num('fov'), debugHud: bool('debugHud') };
}

export function loadSettings(store: Store | null = storage()): Settings {
  try {
    const s = store?.getItem(STORAGE_KEY);
    return sanitize(s ? JSON.parse(s) : null);
  } catch { return sanitize(null); }
}

/** Devuelve false si no se pudo guardar (las opciones siguen valiendo en esta sesión). */
export function saveSettings(s: Settings, store: Store | null = storage()): boolean {
  try {
    if (!store) return false;
    store.setItem(STORAGE_KEY, JSON.stringify(sanitize(s)));
    return true;
  } catch { return false; }
}
