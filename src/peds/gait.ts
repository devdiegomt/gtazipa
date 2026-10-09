/**
 * Marcha de los peatones: contrato entre la fase del ciclo de paso (sim.ts) y la colocación de los pies (render.ts).
 * Puro (sin three): lo importan la simulación, el render y las pruebas.
 *
 * La simulación avanza la fase con la DISTANCIA recorrida sobre el suelo, no con el tiempo:
 *   phase += distancia · pedPhasePerMetre(speed, height)
 * Un ciclo (2π rad) = una zancada = dos pasos. Con esa relación el pie de apoyo queda quieto sobre el suelo (no
 * patina): durante el apoyo el tobillo retrocede, respecto a la cadera, exactamente lo que avanza el cuerpo.
 * Parado (distancia 0) la fase no cambia. Referencias: caminando a 1,3 m/s ≈ 4,6 rad/m (zancada 1,37 m, 1,9 pasos/s);
 * corriendo a 3,6 m/s ≈ 2,5 rad/m (zancada 2,5 m, 2,9 pasos/s), para una persona de 1,70 m (height = 1).
 *
 * pedFoot() es la trayectoria del tobillo en el cuerpo de referencia (1,70 m, pies en y = 0, mirando a -Z); el shader de
 * render.ts evalúa la misma fórmula (si se cambia una, cambiar la otra).
 */

/** Zancada (m por ciclo completo, dos pasos) a `speed` m/s para estatura `height` (1 = 1,70 m). */
export function pedStride(speed: number, height = 1) {
  const v = Math.max(0, speed);
  return height * Math.min(0.62 + 0.58 * v, 0.9 + 0.45 * v);
}

/** Radianes de fase por metro recorrido. */
export function pedPhasePerMetre(speed: number, height = 1) {
  return (2 * Math.PI) / pedStride(speed, height);
}

/** Mezcla de carrera (0 caminar … 1 correr) según la rapidez; 'run' la adelanta (trote). */
export function pedRunBlend(speed: number, running: boolean) {
  const r = (speed - 2.0) / 1.2, j = (speed - 1.2) / 1.4;
  return Math.min(1, Math.max(0, running ? Math.max(r, j) : r));
}

// Medidas del pie (cuerpo de referencia): tobillo a 0,08 m del suelo, talón 0,06 m detrás, metatarso 0,13 m delante.
export const ANKLE_Y = 0.08, HEEL = 0.06, BALL = 0.13;

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Corrección del tobillo al inclinar el pie `p` rad (+ = punta arriba, gira sobre el talón; − = sobre el metatarso). */
function tilt(p: number, out: { y: number; z: number }) {
  const k = p >= 0 ? -HEEL : BALL;
  out.y = ANKLE_Y * (Math.cos(p) - 1) - k * Math.sin(p);
  out.z = ANKLE_Y * Math.sin(p) + k * (Math.cos(p) - 1);
  return out;
}

const TILT = { y: 0, z: 0 };

export interface FootState { z: number; y: number; pitch: number; stance: boolean }

/**
 * Tobillo de una pierna en el cuerpo de referencia: u ∈ [0, 1) fase propia de la pierna (izquierda u = phase/2π,
 * derecha +0,5), stride = zancada del cuerpo de referencia (pedStride(speed, 1)), run ∈ [0, 1].
 * z: + atrás (el cuerpo mira a -Z); y: altura del tobillo; pitch: inclinación del pie.
 */
export function pedFoot(u: number, stride: number, run: number, out: FootState = { z: 0, y: 0, pitch: 0, stance: true }) {
  const beta = 0.6 + (0.38 - 0.6) * run;          // fracción del ciclo en apoyo
  const E = beta * stride;                         // recorrido del tobillo durante el apoyo
  const d = 0.05 + 0.05 * run;                     // el apoyo queda algo detrás de la cadera
  const ps = 0.2 * (1 - run), pe = -(0.7 + 0.25 * run);
  const t = TILT;
  if (u < beta) {
    const x = u / beta;
    const p = ps * (1 - smooth(0, 0.15, x)) + pe * smooth(0.5, 1, x);
    tilt(p, t);
    out.z = -E / 2 + d + E * x + t.z;
    out.y = ANKLE_Y + t.y;
    out.pitch = p;
    out.stance = true;
  } else {
    const x = (u - beta) / (1 - beta);
    tilt(pe, t);
    const ze = E / 2 + d + t.z, ye = ANKLE_Y + t.y;
    tilt(ps, t);
    const zs = -E / 2 + d + t.z, ys = ANKLE_Y + t.y;
    // Hermite: el pie sale y llega con la velocidad del apoyo (quieto en el mundo)
    const m = -(1 - beta) / beta;
    const h = m * (2 * x * x * x - 3 * x * x + x) + 3 * x * x - 2 * x * x * x;
    out.z = ze + (zs - ze) * h;
    out.y = ye + (ys - ye) * smooth(0, 1, x) + (0.07 + 0.21 * run) * Math.sin(Math.PI * x);
    out.pitch = pe + (ps - pe) * smooth(0, 0.7, x) + 0.12 * (1 - run) * Math.sin(Math.PI * x);
    out.stance = false;
  }
  return out;
}
