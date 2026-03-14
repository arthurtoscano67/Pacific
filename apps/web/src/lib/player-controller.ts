import * as THREE from "three";

const UP_AXIS = new THREE.Vector3(0, 1, 0);
const FALLBACK_FORWARD = new THREE.Vector3(0, 0, -1);
const EPSILON = 1e-6;

export type PlayerControllerState = {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  verticalVelocity: number;
  grounded: boolean;
  facingYaw: number;
};

export type PlayerControllerInput = {
  moveForward: number;
  moveRight: number;
  run: boolean;
  jumpPressed: boolean;
  cameraForward: THREE.Vector3;
};

export type PlayerControllerConfig = {
  walkSpeed: number;
  runSpeed: number;
  groundAcceleration: number;
  airAcceleration: number;
  groundDrag: number;
  airDrag: number;
  gravity: number;
  fallGravityMultiplier: number;
  maxFallSpeed: number;
  jumpVelocity: number;
  roomHalfExtent: number;
};

export const DEFAULT_PLAYER_CONTROLLER_CONFIG: PlayerControllerConfig = {
  walkSpeed: 3.2,
  runSpeed: 5.8,
  groundAcceleration: 14,
  airAcceleration: 5,
  groundDrag: 12,
  airDrag: 1.2,
  gravity: 19.5,
  fallGravityMultiplier: 1.5,
  maxFallSpeed: 32,
  jumpVelocity: 6.4,
  roomHalfExtent: 24,
};

export function createPlayerControllerState(spawn = new THREE.Vector3(0, 0, 0)): PlayerControllerState {
  return {
    position: spawn.clone(),
    velocity: new THREE.Vector3(),
    verticalVelocity: 0,
    grounded: true,
    facingYaw: 0,
  };
}

export function stepPlayerController(
  state: PlayerControllerState,
  input: PlayerControllerInput,
  deltaSeconds: number,
  config: PlayerControllerConfig = DEFAULT_PLAYER_CONTROLLER_CONFIG,
) {
  const wasGrounded = state.grounded;
  const forward = input.cameraForward.clone().setY(0);
  if (forward.lengthSq() <= EPSILON) {
    forward.copy(FALLBACK_FORWARD);
  } else {
    forward.normalize();
  }

  const right = new THREE.Vector3().crossVectors(forward, UP_AXIS).normalize();
  const movement = forward.multiplyScalar(input.moveForward).add(right.multiplyScalar(input.moveRight));

  let hasInput = false;
  if (movement.lengthSq() > EPSILON) {
    movement.normalize();
    hasInput = true;
  }

  const targetSpeed = hasInput ? (input.run ? config.runSpeed : config.walkSpeed) : 0;
  const targetVelocity = movement.multiplyScalar(targetSpeed);
  const acceleration = state.grounded ? config.groundAcceleration : config.airAcceleration;
  const blend = THREE.MathUtils.clamp(acceleration * deltaSeconds, 0, 1);
  state.velocity.lerp(targetVelocity, blend);

  if (!hasInput) {
    const drag = state.grounded ? config.groundDrag : config.airDrag;
    state.velocity.multiplyScalar(Math.max(0, 1 - drag * deltaSeconds));
    if (state.velocity.lengthSq() < 1e-4) {
      state.velocity.set(0, 0, 0);
    }
  }

  state.position.addScaledVector(state.velocity, deltaSeconds);
  const horizontalSpeed = state.velocity.length();
  const isMoving = horizontalSpeed > 0.12;
  if (isMoving) {
    state.facingYaw = Math.atan2(state.velocity.x, state.velocity.z);
  }

  const jumpStarted = input.jumpPressed && state.grounded;
  if (jumpStarted) {
    state.verticalVelocity = config.jumpVelocity;
    state.grounded = false;
  }

  const gravityScale =
    state.verticalVelocity > 0 && !state.grounded ? 1 : config.fallGravityMultiplier;
  state.verticalVelocity -= config.gravity * gravityScale * deltaSeconds;
  state.verticalVelocity = Math.max(state.verticalVelocity, -config.maxFallSpeed);
  state.position.y += state.verticalVelocity * deltaSeconds;

  if (state.position.y <= 0) {
    state.position.y = 0;
    state.verticalVelocity = 0;
    state.grounded = true;
  }

  state.position.x = THREE.MathUtils.clamp(
    state.position.x,
    -config.roomHalfExtent,
    config.roomHalfExtent,
  );
  state.position.z = THREE.MathUtils.clamp(
    state.position.z,
    -config.roomHalfExtent,
    config.roomHalfExtent,
  );

  return {
    isMoving,
    isGrounded: state.grounded,
    isRunning: input.run && horizontalSpeed > config.walkSpeed * 0.8,
    horizontalSpeed,
    verticalVelocity: state.verticalVelocity,
    jumpStarted,
    justLanded: !wasGrounded && state.grounded,
  };
}
