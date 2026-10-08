import type RAPIER from '@dimforge/rapier3d-compat';
import type { Physics } from '../physics';
import cfg from '../data/player.json';

/** Personaje cinemático con el KinematicCharacterController de Rapier. Posición = pies. */
export class Character {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  private kcc: RAPIER.KinematicCharacterController;
  private readonly centerOffset = cfg.capsule.halfHeight + cfg.capsule.radius;
  vel = { x: 0, y: 0, z: 0 };
  grounded = false;
  /** Posición de los pies en el paso anterior y en el actual (para interpolar el render). */
  prev = { x: 0, y: 0, z: 0 };
  curr = { x: 0, y: 0, z: 0 };

  constructor(phys: Physics, x: number, y: number, z: number) {
    const R = phys.R;
    this.body = phys.world.createRigidBody(
      R.RigidBodyDesc.kinematicPositionBased().setTranslation(x, y + this.centerOffset, z),
    );
    this.collider = phys.world.createCollider(R.ColliderDesc.capsule(cfg.capsule.halfHeight, cfg.capsule.radius), this.body);
    this.kcc = phys.world.createCharacterController(0.03);
    this.kcc.setUp({ x: 0, y: 1, z: 0 });
    this.kcc.setMaxSlopeClimbAngle((cfg.maxSlopeDeg * Math.PI) / 180);
    this.kcc.setMinSlopeSlideAngle(((cfg.maxSlopeDeg + 5) * Math.PI) / 180);
    this.kcc.enableAutostep(cfg.autostep.maxHeight, cfg.autostep.minWidth, false);
    this.kcc.enableSnapToGround(cfg.snapToGround);
    this.kcc.setSlideEnabled(true);
    this.kcc.setApplyImpulsesToDynamicBodies(false);
    this.curr = { x, y, z };
    this.prev = { ...this.curr };
  }

  /** Un paso fijo de simulación. wish = dirección deseada en el plano (|wish| <= 1). */
  step(dt: number, wishX: number, wishZ: number, run: boolean, jump: boolean) {
    const speed = run ? cfg.runSpeed : cfg.walkSpeed;
    const tx = wishX * speed, tz = wishZ * speed;
    const a = Math.min(1, cfg.acceleration * dt * (this.grounded ? 1 : 0.35));
    this.vel.x += (tx - this.vel.x) * a;
    this.vel.z += (tz - this.vel.z) * a;
    if (this.grounded) {
      // En el suelo no se empuja hacia abajo (eso hace deslizar por la pendiente): snapToGround lo pega.
      this.vel.y = jump ? cfg.jumpSpeed : 0;
    } else {
      this.vel.y -= cfg.gravity * dt;
    }
    const desired = { x: this.vel.x * dt, y: this.vel.y * dt, z: this.vel.z * dt };
    this.kcc.computeColliderMovement(this.collider, desired);
    const mv = this.kcc.computedMovement();
    const wasJumping = jump && this.grounded;
    this.grounded = this.kcc.computedGrounded() && !wasJumping;
    if (this.vel.y > 0 && mv.y < desired.y * 0.5) this.vel.y = 0; // techo
    // La velocidad horizontal real se ajusta a lo que permitió la colisión (no "empuja" paredes).
    if (dt > 0) {
      this.vel.x = mv.x / dt;
      this.vel.z = mv.z / dt;
    }
    const t = this.body.translation();
    const nx = t.x + mv.x, ny = t.y + mv.y, nz = t.z + mv.z;
    this.body.setNextKinematicTranslation({ x: nx, y: ny, z: nz });
    this.prev = this.curr;
    this.curr = { x: nx, y: ny - this.centerOffset, z: nz };
  }

  teleport(x: number, y: number, z: number) {
    this.body.setTranslation({ x, y: y + this.centerOffset, z }, true);
    this.curr = { x, y, z };
    this.prev = { ...this.curr };
    this.vel = { x: 0, y: 0, z: 0 };
  }

  horizontalSpeed() { return Math.hypot(this.vel.x, this.vel.z); }
}
