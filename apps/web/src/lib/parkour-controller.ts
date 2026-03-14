import * as THREE from "three";
import type { ParkourCourse, ParkourObstacle } from "./parkour-course";
import { getObstacleBounds } from "./parkour-course";

const UP_AXIS = new THREE.Vector3(0, 1, 0);
const FALLBACK_FORWARD = new THREE.Vector3(0, 0, -1);
const EPSILON = 1e-5;

export type ParkourStance =
  | "stand"
  | "crouch"
  | "slide"
  | "roll"
  | "vault"
  | "climb";

type TransitionState = {
  kind: "vault" | "climb";
  time: number;
  duration: number;
  start: THREE.Vector3;
  end: THREE.Vector3;
  arcHeight: number;
  facingYaw: number;
};

export type ParkourControllerState = {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  grounded: boolean;
  facingYaw: number;
  stance: ParkourStance;
  checkpointIndex: number;
  elapsedMs: number;
  timerStarted: boolean;
  finished: boolean;
  forcedCrouch: boolean;
  slideTime: number;
  rollTime: number;
  transition: TransitionState | null;
};

export type ParkourControllerInput = {
  moveForward: number;
  moveRight: number;
  run: boolean;
  jumpPressed: boolean;
  crouchHeld: boolean;
  rollPressed: boolean;
  respawnPressed: boolean;
  cameraForward: THREE.Vector3;
};

export type ParkourControllerConfig = {
  walkSpeed: number;
  runSpeed: number;
  crouchSpeed: number;
  slideSpeed: number;
  rollSpeed: number;
  gravity: number;
  jumpVelocity: number;
  standingHeight: number;
  crouchHeight: number;
  radius: number;
};

export type ParkourStepResult = {
  horizontalSpeed: number;
  jumpStarted: boolean;
  vaultStarted: boolean;
  climbStarted: boolean;
  checkpointReached: number | null;
  finishedRun: boolean;
  grounded: boolean;
  stance: ParkourStance;
};

export const DEFAULT_PARKOUR_CONTROLLER_CONFIG: ParkourControllerConfig = {
  walkSpeed: 3.4,
  runSpeed: 6.8,
  crouchSpeed: 2.2,
  slideSpeed: 7.8,
  rollSpeed: 6.4,
  gravity: 18,
  jumpVelocity: 7.2,
  standingHeight: 1.75,
  crouchHeight: 1.05,
  radius: 0.4,
};

function resolveForward(cameraForward: THREE.Vector3) {
  const forward = cameraForward.clone().setY(0);
  if (forward.lengthSq() <= EPSILON) {
    return FALLBACK_FORWARD.clone();
  }

  return forward.normalize();
}

function getCurrentHeight(
  state: ParkourControllerState,
  config: ParkourControllerConfig,
) {
  return state.stance === "crouch" || state.stance === "slide" || state.stance === "roll"
    ? config.crouchHeight
    : config.standingHeight;
}

function hasHorizontalFootprint(
  position: THREE.Vector3,
  radius: number,
  obstacle: ParkourObstacle,
) {
  const bounds = getObstacleBounds(obstacle);
  return (
    position.x + radius > bounds.minX &&
    position.x - radius < bounds.maxX &&
    position.z + radius > bounds.minZ &&
    position.z - radius < bounds.maxZ
  );
}

function hasStandingClearance(
  position: THREE.Vector3,
  course: ParkourCourse,
  config: ParkourControllerConfig,
) {
  const headY = position.y + config.standingHeight;
  for (const obstacle of course.obstacles) {
    const bounds = getObstacleBounds(obstacle);
    if (
      hasHorizontalFootprint(position, config.radius, obstacle) &&
      headY > bounds.minY + 0.02 &&
      position.y < bounds.maxY - 0.02 &&
      obstacle.kind === "ceiling"
    ) {
      return false;
    }
  }

  return true;
}

function findSupportSurface(
  position: THREE.Vector3,
  course: ParkourCourse,
  config: ParkourControllerConfig,
) {
  let support = 0;
  let supportObstacle: ParkourObstacle | null = null;

  for (const obstacle of course.obstacles) {
    if (obstacle.kind === "ceiling") {
      continue;
    }

    if (!hasHorizontalFootprint(position, config.radius * 0.65, obstacle)) {
      continue;
    }

    const bounds = getObstacleBounds(obstacle);
    const top = bounds.maxY;
    if (top > support && position.y >= top - 1.4) {
      support = top;
      supportObstacle = obstacle;
    }
  }

  return {
    y: support,
    obstacle: supportObstacle,
  };
}

function resolveHorizontalAxis(
  state: ParkourControllerState,
  axis: "x" | "z",
  otherAxis: "x" | "z",
  height: number,
  course: ParkourCourse,
  config: ParkourControllerConfig,
) {
  for (const obstacle of course.obstacles) {
    if (obstacle.kind === "ceiling") {
      continue;
    }

    const bounds = getObstacleBounds(obstacle);
    const footY = state.position.y;
    const headY = footY + height;
    if (footY >= bounds.maxY - 0.04 || headY <= bounds.minY + 0.04) {
      continue;
    }

    const radius = config.radius;
    const withinOtherAxis =
      state.position[otherAxis] + radius > bounds[otherAxis === "x" ? "minX" : "minZ"] &&
      state.position[otherAxis] - radius < bounds[otherAxis === "x" ? "maxX" : "maxZ"];
    if (!withinOtherAxis) {
      continue;
    }

    if (axis === "x") {
      if (
        state.position.x + radius > bounds.minX &&
        state.position.x < obstacle.position.x &&
        state.velocity.x > 0
      ) {
        state.position.x = bounds.minX - radius;
        state.velocity.x = 0;
      } else if (
        state.position.x - radius < bounds.maxX &&
        state.position.x > obstacle.position.x &&
        state.velocity.x < 0
      ) {
        state.position.x = bounds.maxX + radius;
        state.velocity.x = 0;
      }
    } else {
      if (
        state.position.z + radius > bounds.minZ &&
        state.position.z < obstacle.position.z &&
        state.velocity.z > 0
      ) {
        state.position.z = bounds.minZ - radius;
        state.velocity.z = 0;
      } else if (
        state.position.z - radius < bounds.maxZ &&
        state.position.z > obstacle.position.z &&
        state.velocity.z < 0
      ) {
        state.position.z = bounds.maxZ + radius;
        state.velocity.z = 0;
      }
    }
  }
}

function resolveCeiling(
  state: ParkourControllerState,
  height: number,
  course: ParkourCourse,
  config: ParkourControllerConfig,
) {
  const headY = state.position.y + height;
  for (const obstacle of course.obstacles) {
    const bounds = getObstacleBounds(obstacle);
    if (!hasHorizontalFootprint(state.position, config.radius, obstacle)) {
      continue;
    }

    if (
      headY > bounds.minY &&
      state.position.y < bounds.maxY &&
      state.velocity.y > 0
    ) {
      state.position.y = bounds.minY - height;
      state.velocity.y = 0;
    }
  }
}

function findObstacleAhead(
  state: ParkourControllerState,
  direction: THREE.Vector3,
  course: ParkourCourse,
  config: ParkourControllerConfig,
  predicate: (obstacle: ParkourObstacle, bounds: ReturnType<typeof getObstacleBounds>) => boolean,
) {
  let best: { obstacle: ParkourObstacle; bounds: ReturnType<typeof getObstacleBounds>; distance: number } | null = null;

  for (const obstacle of course.obstacles) {
    const bounds = getObstacleBounds(obstacle);
    if (!predicate(obstacle, bounds)) {
      continue;
    }

    const toObstacle = obstacle.position.clone().sub(state.position);
    const forwardDistance = toObstacle.dot(direction);
    if (forwardDistance <= 0 || forwardDistance > 1.6) {
      continue;
    }

    const lateral = toObstacle.clone().sub(direction.clone().multiplyScalar(forwardDistance));
    if (lateral.length() > Math.max(obstacle.size.x, obstacle.size.z) * 0.6 + config.radius) {
      continue;
    }

    if (!best || forwardDistance < best.distance) {
      best = {
        obstacle,
        bounds,
        distance: forwardDistance,
      };
    }
  }

  return best;
}

function startTransition(
  state: ParkourControllerState,
  kind: "vault" | "climb",
  end: THREE.Vector3,
  duration: number,
  arcHeight: number,
) {
  state.transition = {
    kind,
    time: 0,
    duration,
    start: state.position.clone(),
    end: end.clone(),
    arcHeight,
    facingYaw: state.facingYaw,
  };
  state.stance = kind;
  state.grounded = false;
  state.velocity.set(0, 0, 0);
}

function updateTransition(
  state: ParkourControllerState,
  deltaSeconds: number,
) {
  if (!state.transition) {
    return false;
  }

  state.transition.time += deltaSeconds;
  const t = Math.min(1, state.transition.time / state.transition.duration);
  const eased = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
  state.position.lerpVectors(state.transition.start, state.transition.end, eased);
  state.position.y += Math.sin(Math.PI * t) * state.transition.arcHeight;
  state.facingYaw = state.transition.facingYaw;

  if (t >= 1) {
    state.position.copy(state.transition.end);
    state.transition = null;
    state.stance = "stand";
    state.grounded = true;
    state.velocity.set(0, 0, 0);
  }

  return true;
}

export function createParkourControllerState(
  spawn: THREE.Vector3,
  checkpointIndex = 0,
): ParkourControllerState {
  return {
    position: spawn.clone(),
    velocity: new THREE.Vector3(),
    grounded: true,
    facingYaw: 0,
    stance: "stand",
    checkpointIndex,
    elapsedMs: 0,
    timerStarted: false,
    finished: false,
    forcedCrouch: false,
    slideTime: 0,
    rollTime: 0,
    transition: null,
  };
}

export function respawnAtCheckpoint(
  state: ParkourControllerState,
  course: ParkourCourse,
) {
  const nextSpawn =
    course.checkpointSpawns[state.checkpointIndex] ?? course.start;
  state.position.copy(nextSpawn);
  state.velocity.set(0, 0, 0);
  state.grounded = true;
  state.stance = "stand";
  state.transition = null;
  state.slideTime = 0;
  state.rollTime = 0;
}

export function restartParkourRun(
  state: ParkourControllerState,
  course: ParkourCourse,
) {
  state.checkpointIndex = 0;
  state.elapsedMs = 0;
  state.timerStarted = false;
  state.finished = false;
  respawnAtCheckpoint(state, course);
}

export function stepParkourController(
  state: ParkourControllerState,
  input: ParkourControllerInput,
  deltaSeconds: number,
  course: ParkourCourse,
  config: ParkourControllerConfig = DEFAULT_PARKOUR_CONTROLLER_CONFIG,
): ParkourStepResult {
  let checkpointReached: number | null = null;
  let finishedRun = false;
  let jumpStarted = false;
  let vaultStarted = false;
  let climbStarted = false;

  if (input.respawnPressed) {
    if (state.finished) {
      restartParkourRun(state, course);
    } else {
      respawnAtCheckpoint(state, course);
    }
  }

  if (updateTransition(state, deltaSeconds)) {
    const support = findSupportSurface(state.position, course, config);
    if (state.transition === null) {
      state.position.y = support.y;
    }
  } else {
    const forward = resolveForward(input.cameraForward);
    const right = new THREE.Vector3().crossVectors(forward, UP_AXIS).normalize();
    const desiredDirection = forward
      .multiplyScalar(input.moveForward)
      .add(right.multiplyScalar(input.moveRight));
    const hasMovementIntent = desiredDirection.lengthSq() > EPSILON;
    if (hasMovementIntent) {
      desiredDirection.normalize();
      state.facingYaw = Math.atan2(desiredDirection.x, desiredDirection.z);
    }

    state.forcedCrouch = !hasStandingClearance(state.position, course, config);

    if (state.rollTime > 0) {
      state.rollTime = Math.max(0, state.rollTime - deltaSeconds);
      state.stance = "roll";
    } else if (state.slideTime > 0) {
      state.slideTime = Math.max(0, state.slideTime - deltaSeconds);
      state.stance = "slide";
    } else if (input.crouchHeld || state.forcedCrouch) {
      state.stance = "crouch";
    } else {
      state.stance = "stand";
    }

    if (hasMovementIntent && (input.run || input.jumpPressed)) {
      state.timerStarted = true;
    }

    if (hasMovementIntent && input.jumpPressed) {
      const vaultCandidate = findObstacleAhead(
        state,
        desiredDirection,
        course,
        config,
        (obstacle, bounds) =>
          Boolean(obstacle.vaultable) &&
          obstacle.kind !== "ceiling" &&
          bounds.maxY - state.position.y >= 0.35 &&
          bounds.maxY - state.position.y <= 1.25,
      );

      if (vaultCandidate && state.grounded) {
        const end = vaultCandidate.obstacle.position
          .clone()
          .add(
            desiredDirection
              .clone()
              .multiplyScalar(vaultCandidate.obstacle.size.z * 0.6 + 1.1),
          );
        end.y = vaultCandidate.bounds.maxY;
        startTransition(state, "vault", end, 0.5, 0.7);
        vaultStarted = true;
      } else {
        const climbCandidate = findObstacleAhead(
          state,
          desiredDirection,
          course,
          config,
          (obstacle, bounds) =>
            Boolean(obstacle.climbable) &&
            bounds.maxY - state.position.y >= 1.15 &&
            bounds.maxY - state.position.y <= 3.3,
        );

        if (climbCandidate) {
          const end = climbCandidate.obstacle.position
            .clone()
            .add(desiredDirection.clone().multiplyScalar(1.4));
          end.y = climbCandidate.bounds.maxY;
          startTransition(state, "climb", end, 0.72, 0.38);
          climbStarted = true;
        }
      }
    }

    if (!vaultStarted && !climbStarted) {
      if (
        input.rollPressed &&
        state.grounded &&
        hasMovementIntent &&
        state.stance !== "slide" &&
        state.stance !== "roll"
      ) {
        state.stance = "roll";
        state.rollTime = 0.52;
        state.velocity.x = desiredDirection.x * config.rollSpeed;
        state.velocity.z = desiredDirection.z * config.rollSpeed;
      } else if (
        input.crouchHeld &&
        state.grounded &&
        input.run &&
        hasMovementIntent &&
        state.stance === "stand"
      ) {
        state.stance = "slide";
        state.slideTime = 0.62;
        state.velocity.x = desiredDirection.x * config.slideSpeed;
        state.velocity.z = desiredDirection.z * config.slideSpeed;
      }

      if (input.jumpPressed && state.grounded && state.stance !== "roll") {
        state.velocity.y = config.jumpVelocity;
        state.grounded = false;
        jumpStarted = true;
      }

      if (state.stance === "slide") {
        state.velocity.x *= 1 - Math.min(0.9, deltaSeconds * 1.8);
        state.velocity.z *= 1 - Math.min(0.9, deltaSeconds * 1.8);
      } else if (state.stance === "roll") {
        state.velocity.x *= 1 - Math.min(0.9, deltaSeconds * 1.35);
        state.velocity.z *= 1 - Math.min(0.9, deltaSeconds * 1.35);
      } else {
        const targetSpeed =
          state.stance === "crouch"
            ? config.crouchSpeed
            : input.run
              ? config.runSpeed
              : config.walkSpeed;
        const target = hasMovementIntent
          ? desiredDirection.clone().multiplyScalar(targetSpeed)
          : new THREE.Vector3();
        const acceleration = state.grounded ? 14 : 7;
        state.velocity.x = THREE.MathUtils.damp(
          state.velocity.x,
          target.x,
          acceleration,
          deltaSeconds,
        );
        state.velocity.z = THREE.MathUtils.damp(
          state.velocity.z,
          target.z,
          acceleration,
          deltaSeconds,
        );
      }

      state.velocity.y -= config.gravity * deltaSeconds;

      state.position.x += state.velocity.x * deltaSeconds;
      resolveHorizontalAxis(state, "x", "z", getCurrentHeight(state, config), course, config);
      state.position.z += state.velocity.z * deltaSeconds;
      resolveHorizontalAxis(state, "z", "x", getCurrentHeight(state, config), course, config);

      state.position.x = THREE.MathUtils.clamp(
        state.position.x,
        -course.roomHalfExtent,
        course.roomHalfExtent,
      );
      state.position.z = THREE.MathUtils.clamp(
        state.position.z,
        -course.roomHalfExtent,
        course.roomHalfExtent,
      );

      state.position.y += state.velocity.y * deltaSeconds;
      resolveCeiling(state, getCurrentHeight(state, config), course, config);

      const support = findSupportSurface(state.position, course, config);
      if (state.velocity.y <= 0 && state.position.y <= support.y + 0.12) {
        state.position.y = support.y;
        state.velocity.y = 0;
        state.grounded = true;
      } else {
        state.grounded = false;
      }

      state.forcedCrouch = !hasStandingClearance(state.position, course, config);
      if (state.forcedCrouch && state.stance === "stand") {
        state.stance = "crouch";
      }

      if (state.timerStarted && !state.finished) {
        state.elapsedMs += deltaSeconds * 1000;
      }

      if (support.obstacle?.checkpointIndex !== undefined) {
        if (support.obstacle.checkpointIndex > state.checkpointIndex) {
          state.checkpointIndex = support.obstacle.checkpointIndex;
          checkpointReached = support.obstacle.checkpointIndex;
        }

        if (support.obstacle.kind === "finish" && !state.finished) {
          state.finished = true;
          finishedRun = true;
        }
      }
    }
  }

  return {
    horizontalSpeed: Math.hypot(state.velocity.x, state.velocity.z),
    jumpStarted,
    vaultStarted,
    climbStarted,
    checkpointReached,
    finishedRun,
    grounded: state.grounded,
    stance: state.stance,
  };
}
