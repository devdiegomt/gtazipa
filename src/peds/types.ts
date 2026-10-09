/**
 * Contrato entre la simulación de peatones (sim.ts, pura) y su dibujo (render.ts). Unidades SI; x/z en metros del
 * mundo, ángulos en radianes. Dirección de avance (-sin(heading), -cos(heading)), como el avatar del jugador.
 */

/** Postura: caminar, de pie quieto (charla, mirar), esperando para cruzar, sentado, corriendo (huye), en el suelo. */
export type PedPose = 'walk' | 'idle' | 'wait' | 'sit' | 'run' | 'fallen';

export interface Ped {
  id: number;
  /** false = inactivo, fuera del mundo esperando un punto de aparición oculto: no se dibuja. */
  active: boolean;
  x: number; z: number;
  /** Altura del suelo bajo los pies (terreno, +0,15 m sobre el andén, adoquín de la plaza…). */
  y: number;
  heading: number;
  /** Estado del paso anterior de la simulación (el render interpola). */
  px: number; py: number; pz: number; pheading: number;
  /** m/s sobre el suelo. */
  speed: number;
  /** Fase del ciclo de paso (rad, avanza con la distancia recorrida). */
  phase: number;
  pose: PedPose;
  /** Segundos en la postura actual (transiciones y gestos). */
  poseTime: number;
  /** Altura del asiento sobre el suelo cuando pose = 'sit' (0 si no). */
  seatH: number;
  /** Semilla de aspecto: estatura, complexión, ropa, sombrero, ruana, mochila… (determinista por peatón). */
  look: number;
  /** Escala de estatura (1 = 1,70 m). */
  height: number;
}
