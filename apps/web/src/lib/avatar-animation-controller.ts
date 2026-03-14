import * as THREE from "three";
import {
  type RuntimeAnimationStateName,
  RUNTIME_ANIMATION_STATES,
} from "./runtime-animation-config";
import type { LoadedAnimationBundle } from "./runtime-animation-library";

export type AvatarAnimationMotionSample = {
  grounded: boolean;
  horizontalSpeed: number;
  running: boolean;
  jumpStarted: boolean;
  verticalVelocity: number;
};

export type AvatarAnimationDebugState = {
  currentState: RuntimeAnimationStateName | "missing";
  grounded: boolean;
  speed: number;
  jumpActive: boolean;
  missingClips: RuntimeAnimationStateName[];
  issues: string[];
};

type AnimationActionMap = Record<RuntimeAnimationStateName, THREE.AnimationAction>;

const STATE_FALLBACKS: Record<RuntimeAnimationStateName, RuntimeAnimationStateName[]> = {
  idle: ["walk", "run", "jump"],
  walk: ["run", "idle", "jump"],
  run: ["walk", "idle", "jump"],
  jump: ["idle", "walk", "run"],
};

const BASE_SPEEDS: Record<RuntimeAnimationStateName, number> = {
  idle: 0,
  walk: 2.8,
  run: 4.9,
  jump: 0,
};

function deriveTargetState(
  sample: AvatarAnimationMotionSample,
): RuntimeAnimationStateName {
  if (!sample.grounded || sample.jumpStarted || sample.verticalVelocity > 0.1) {
    return "jump";
  }

  if (sample.horizontalSpeed < 0.12) {
    return "idle";
  }

  return sample.running ? "run" : "walk";
}

export class AvatarAnimationController {
  readonly mixer: THREE.AnimationMixer;
  readonly missingClips: RuntimeAnimationStateName[];
  readonly issues: string[];

  private readonly actions: Partial<AnimationActionMap>;
  private readonly availableStates: RuntimeAnimationStateName[];
  private currentState: RuntimeAnimationStateName | "missing";

  constructor(root: THREE.Object3D, bundle: LoadedAnimationBundle) {
    this.mixer = new THREE.AnimationMixer(root);
    this.missingClips = bundle.missingStates;
    this.issues = [...bundle.issues];
    this.actions = {};
    this.availableStates = [];
    this.currentState = "missing";

    for (const state of RUNTIME_ANIMATION_STATES) {
      const clip = bundle.clips[state];
      if (!clip) {
        continue;
      }

      const action = this.mixer.clipAction(clip);
      action.enabled = true;
      action.clampWhenFinished = state === "jump";
      action.setLoop(state === "jump" ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
      action.weight = 0;
      this.actions[state] = action;
      this.availableStates.push(state);
    }

    const initialState = this.resolveActionState("idle");
    if (initialState) {
      this.currentState = initialState;
      const initialAction = this.actions[initialState];
      initialAction?.reset();
      initialAction?.setEffectiveWeight(1);
      initialAction?.play();
    }
  }

  get state() {
    return this.currentState;
  }

  update(sample: AvatarAnimationMotionSample, deltaSeconds: number) {
    if (this.currentState === "missing") {
      this.mixer.update(deltaSeconds);
      return this.getDebugState(sample);
    }

    const targetState = this.resolveActionState(deriveTargetState(sample));
    if (!targetState) {
      this.currentState = "missing";
      this.mixer.update(deltaSeconds);
      return this.getDebugState(sample);
    }

    if (targetState !== this.currentState) {
      this.transitionTo(targetState);
    }

    const walkAction = this.actions.walk;
    if (walkAction) {
      walkAction.timeScale = Math.max(sample.horizontalSpeed / BASE_SPEEDS.walk, 0.75);
    }

    const runAction = this.actions.run;
    if (runAction) {
      runAction.timeScale = Math.max(sample.horizontalSpeed / BASE_SPEEDS.run, 0.9);
    }

    this.mixer.update(deltaSeconds);
    return this.getDebugState(sample);
  }

  dispose() {
    this.mixer.stopAllAction();
  }

  private transitionTo(nextState: RuntimeAnimationStateName) {
    const resolvedState = this.resolveActionState(nextState);
    if (!resolvedState) {
      this.currentState = "missing";
      return;
    }

    const nextAction = this.actions[resolvedState];
    const currentAction =
      this.currentState === "missing" ? null : this.actions[this.currentState];

    if (!nextAction) {
      this.currentState = "missing";
      return;
    }

    nextAction.reset();
    nextAction.enabled = true;
    nextAction.play();

    if (currentAction && currentAction !== nextAction) {
      nextAction.crossFadeFrom(currentAction, resolvedState === "jump" ? 0.08 : 0.18, false);
    } else {
      nextAction.fadeIn(resolvedState === "jump" ? 0.08 : 0.18);
    }

    this.currentState = resolvedState;
  }

  private resolveActionState(
    requestedState: RuntimeAnimationStateName,
  ): RuntimeAnimationStateName | null {
    if (this.actions[requestedState]) {
      return requestedState;
    }

    for (const fallbackState of STATE_FALLBACKS[requestedState]) {
      if (this.actions[fallbackState]) {
        return fallbackState;
      }
    }

    return this.availableStates[0] ?? null;
  }

  private getDebugState(sample: AvatarAnimationMotionSample): AvatarAnimationDebugState {
    return {
      currentState: this.currentState,
      grounded: sample.grounded,
      speed: sample.horizontalSpeed,
      jumpActive: !sample.grounded || this.currentState === "jump",
      missingClips: this.missingClips,
      issues: this.issues,
    };
  }
}
