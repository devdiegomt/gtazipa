/**
 * Menú de pausa: Reanudar, Opciones y Controles. Se abre con P o Escape y solo al perderse el pointer lock que el juego
 * había tomado (con el puntero capturado Chrome consume el Escape y lo suelta: esa pérdida es la que pausa).
 * Nunca empieza en pausa.
 */
import { RANGES, sanitize, type Settings } from '../settings';

export type PauseAction = 'pause' | 'resume' | null;

/** Lógica de la pausa (sin DOM, para las pruebas): decide qué hace cada tecla y cada cambio del pointer lock. */
export class PauseState {
  paused = false;
  private locked = false;
  /** El propio menú soltó el puntero (abrir con P): ese desbloqueo no es una pérdida. */
  private selfUnlock = false;
  private lostAt = -Infinity;

  constructor(readonly enabled = true) {}

  /** pointerlockchange. Pausa si el juego tenía el puntero y lo perdió (Esc, Alt+Tab…) sin que el menú lo soltara. */
  lockChange(locked: boolean, now: number): PauseAction {
    const was = this.locked, mine = this.selfUnlock;
    this.locked = locked;
    this.selfUnlock = false;
    if (locked || !was) return null;
    this.lostAt = now;
    return this.enabled && !this.paused && !mine ? 'pause' : null;
  }

  /** Teclas P / Escape (sin repetición). */
  key(code: string, now: number): PauseAction {
    if (!this.enabled) return null;
    if (code === 'KeyP') return this.paused ? 'resume' : 'pause';
    // si además de soltar el puntero llega la tecla Esc (algunos navegadores, Chromium sin interfaz), la que llega
    // justo después de perderlo se ignora para no cerrar el menú recién abierto; con el puntero aún capturado pausa
    if (code === 'Escape' && now - this.lostAt > 400) return this.paused && !this.locked ? 'resume' : 'pause';
    return null;
  }

  /** El menú va a soltar el puntero (abrir la pausa con él capturado). */
  willUnlock() { if (this.locked) this.selfUnlock = true; }
}

/** Menú de pausa del DOM (#pause en index.html). */
export class PauseMenu {
  readonly state: PauseState;
  private root = document.getElementById('pause')!;
  private panel = this.root.querySelector<HTMLElement>('.panel')!;
  private resumeBtn = this.root.querySelector<HTMLButtonElement>('[data-act="resume"]')!;
  private inputs: Record<'sensitivity' | 'volume' | 'fov' | 'invertY' | 'debugHud', HTMLInputElement>;

  constructor(private canvas: HTMLElement, private settings: Settings, enabled: boolean,
    private onPause: (paused: boolean) => void, private onSettings: (s: Settings) => void) {
    this.state = new PauseState(enabled);
    const q = (id: string) => this.root.querySelector<HTMLInputElement>(`#${id}`)!;
    this.inputs = { sensitivity: q('opt-sens'), volume: q('opt-vol'), fov: q('opt-fov'), invertY: q('opt-invert'), debugHud: q('opt-debug') };
    for (const k of ['sensitivity', 'volume', 'fov'] as const) {
      const [min, max, step] = RANGES[k];
      Object.assign(this.inputs[k], { min, max, step });
    }
    this.show();
    for (const el of Object.values(this.inputs)) el.addEventListener('input', () => this.read());

    this.resumeBtn.addEventListener('click', () => this.set(false, true));
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('[data-tab]')) b.addEventListener('click', () => this.tab(b.dataset.tab!));
    this.tab('options');

    document.addEventListener('pointerlockchange', () => {
      if (this.state.lockChange(document.pointerLockElement === canvas, performance.now()) === 'pause') this.set(true);
    });
    addEventListener('keydown', (e) => {
      if (e.code === 'F3') {
        // F3 = "buscar siguiente" en el navegador
        e.preventDefault();
        if (!e.repeat && enabled) this.update({ debugHud: !this.settings.debugHud });
        return;
      }
      if (e.repeat) return;
      const a = this.state.key(e.code, performance.now());
      if (a) { e.preventDefault(); this.set(a === 'pause', e.code !== 'Escape'); }
    });
  }

  get paused() { return this.state.paused; }

  /**
   * Abre o cierra el menú. `gesture`: viene de un clic o una tecla del jugador, así que al reanudar se puede pedir
   * de nuevo el pointer lock (Escape no cuenta como gesto para el navegador y la petición falla sin más).
   */
  set(paused: boolean, gesture = false) {
    if (paused === this.state.paused) return;
    this.state.paused = paused;
    this.root.hidden = !paused;
    if (paused) {
      if (document.pointerLockElement === this.canvas) { this.state.willUnlock(); document.exitPointerLock(); }
      // foco en el panel, no en Reanudar: Espacio (saltar / freno fuerte) o Enter no reanudan sin querer; Tab llega
      // a los botones
      this.panel.focus({ preventScroll: true });
    } else {
      (document.activeElement as HTMLElement | null)?.blur?.();
      if (gesture && document.pointerLockElement !== this.canvas) this.canvas.requestPointerLock?.()?.catch?.(() => {});
    }
    this.onPause(paused);
  }

  /** Cambia opciones desde fuera del formulario (F3) y refleja el cambio en él. */
  update(patch: Partial<Settings>) {
    this.settings = sanitize({ ...this.settings, ...patch });
    this.show();
    this.onSettings(this.settings);
  }

  private tab(name: string) {
    for (const el of this.root.querySelectorAll<HTMLElement>('[data-tab]')) {
      if (el.tagName === 'BUTTON') el.classList.toggle('on', el.dataset.tab === name);
      else el.hidden = el.dataset.tab !== name;
    }
  }

  private read() {
    const i = this.inputs;
    this.update({ sensitivity: +i.sensitivity.value, volume: +i.volume.value, fov: +i.fov.value,
      invertY: i.invertY.checked, debugHud: i.debugHud.checked });
  }

  /** Vuelca las opciones al formulario y a las etiquetas de valor. */
  private show() {
    const s = this.settings, i = this.inputs;
    i.sensitivity.value = String(s.sensitivity);
    i.volume.value = String(s.volume);
    i.fov.value = String(s.fov);
    i.invertY.checked = s.invertY;
    i.debugHud.checked = s.debugHud;
    const out = (el: HTMLInputElement, text: string) => { const o = el.parentElement?.querySelector('output'); if (o) o.textContent = text; };
    out(i.sensitivity, `${s.sensitivity.toFixed(2)}×`);
    out(i.volume, `${Math.round(s.volume * 100)} %`);
    out(i.fov, `${s.fov}°`);
  }
}
