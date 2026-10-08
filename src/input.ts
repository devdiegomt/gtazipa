/** Teclado + ratón (pointer lock, con arrastre como alternativa). Desactivado (pausa) no registra nada. */
export class Input {
  private keys = new Set<string>();
  private enabled = true;
  private jumpQueued = false;
  private interactQueued = false;
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  private dragging = false;

  constructor(el: HTMLElement) {
    addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      if (e.code === 'Space') { if (!e.repeat) this.jumpQueued = true; e.preventDefault(); }
      if ((e.code === 'KeyE' || e.code === 'KeyF') && !e.repeat) this.interactQueued = true;
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    el.addEventListener('click', () => {
      if (this.enabled && document.pointerLockElement !== el) el.requestPointerLock?.()?.catch?.(() => {});
    });
    el.addEventListener('mousedown', () => { this.dragging = this.enabled; });
    addEventListener('mouseup', () => { this.dragging = false; });
    addEventListener('mousemove', (e) => {
      if (this.enabled && (document.pointerLockElement === el || this.dragging)) {
        this.mouseDX += e.movementX;
        this.mouseDY += e.movementY;
      }
    });
    el.addEventListener('wheel', (e) => { if (this.enabled) this.wheel += e.deltaY; e.preventDefault(); }, { passive: false });
  }

  /** Pausa: deja de registrar entrada y descarta lo acumulado (teclas sostenidas, saltos, ratón). */
  setEnabled(on: boolean) {
    this.enabled = on;
    this.keys.clear();
    this.jumpQueued = this.interactQueued = this.dragging = false;
    this.mouseDX = this.mouseDY = this.wheel = 0;
  }

  down(...codes: string[]) { return codes.some((c) => this.keys.has(c)); }

  /** Ejes de movimiento: x = derecha, y = adelante. */
  axes() {
    const x = (this.down('KeyD', 'ArrowRight') ? 1 : 0) - (this.down('KeyA', 'ArrowLeft') ? 1 : 0);
    const y = (this.down('KeyW', 'ArrowUp') ? 1 : 0) - (this.down('KeyS', 'ArrowDown') ? 1 : 0);
    return { x, y };
  }

  get run() { return this.down('ShiftLeft', 'ShiftRight'); }

  consumeJump() { const j = this.jumpQueued; this.jumpQueued = false; return j; }

  /** E / F: subir o bajar de la moto. */
  consumeInteract() { const j = this.interactQueued; this.interactQueued = false; return j; }

  consumeMouse() {
    const r = { dx: this.mouseDX, dy: this.mouseDY, wheel: this.wheel };
    this.mouseDX = this.mouseDY = this.wheel = 0;
    return r;
  }
}
