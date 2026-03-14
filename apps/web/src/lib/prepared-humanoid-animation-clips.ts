import type { VRM } from "@pixiv/three-vrm";
import * as THREE from "three";
import type { RuntimeAnimationStateName } from "./runtime-animation-config";

type HumanoidBoneName = Parameters<VRM["humanoid"]["getNormalizedBoneNode"]>[0];

type BoneFrame = {
  x?: number;
  y?: number;
  z?: number;
};

type HumanoidBoneSet = {
  hips: THREE.Object3D;
  spine: THREE.Object3D | null;
  chest: THREE.Object3D | null;
  head: THREE.Object3D | null;
  leftUpperArm: THREE.Object3D;
  leftLowerArm: THREE.Object3D | null;
  rightUpperArm: THREE.Object3D;
  rightLowerArm: THREE.Object3D | null;
  leftUpperLeg: THREE.Object3D;
  leftLowerLeg: THREE.Object3D;
  leftFoot: THREE.Object3D | null;
  rightUpperLeg: THREE.Object3D;
  rightLowerLeg: THREE.Object3D;
  rightFoot: THREE.Object3D | null;
};

export type PreparedHumanoidClipBundle = Record<
  RuntimeAnimationStateName,
  THREE.AnimationClip
>;

function getRequiredBone(vrm: VRM, boneName: HumanoidBoneName) {
  const bone = vrm.humanoid.getNormalizedBoneNode(boneName);
  if (!bone) {
    throw new Error(`Prepared humanoid clips require the '${boneName}' bone.`);
  }

  return bone;
}

function getOptionalBone(vrm: VRM, boneName: HumanoidBoneName) {
  return vrm.humanoid.getNormalizedBoneNode(boneName) ?? null;
}

function getHumanoidBoneSet(vrm: VRM): HumanoidBoneSet {
  return {
    hips: getRequiredBone(vrm, "hips"),
    spine: getOptionalBone(vrm, "spine"),
    chest: getOptionalBone(vrm, "chest") ?? getOptionalBone(vrm, "upperChest"),
    head: getOptionalBone(vrm, "head"),
    leftUpperArm: getRequiredBone(vrm, "leftUpperArm"),
    leftLowerArm: getOptionalBone(vrm, "leftLowerArm"),
    rightUpperArm: getRequiredBone(vrm, "rightUpperArm"),
    rightLowerArm: getOptionalBone(vrm, "rightLowerArm"),
    leftUpperLeg: getRequiredBone(vrm, "leftUpperLeg"),
    leftLowerLeg: getRequiredBone(vrm, "leftLowerLeg"),
    leftFoot: getOptionalBone(vrm, "leftFoot"),
    rightUpperLeg: getRequiredBone(vrm, "rightUpperLeg"),
    rightLowerLeg: getRequiredBone(vrm, "rightLowerLeg"),
    rightFoot: getOptionalBone(vrm, "rightFoot"),
  };
}

function quaternionTrack(
  bone: THREE.Object3D | null,
  times: number[],
  frames: BoneFrame[],
) {
  if (!bone) {
    return null;
  }

  const rest = bone.quaternion.clone();
  const values = frames.flatMap((frame) => {
    const delta = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(frame.x ?? 0, frame.y ?? 0, frame.z ?? 0, "XYZ"),
    );
    const quaternion = rest.clone().multiply(delta);
    return [quaternion.x, quaternion.y, quaternion.z, quaternion.w];
  });

  return new THREE.QuaternionKeyframeTrack(`${bone.uuid}.quaternion`, times, values);
}

function vectorTrack(
  bone: THREE.Object3D | null,
  times: number[],
  offsets: THREE.Vector3[],
) {
  if (!bone) {
    return null;
  }

  const rest = bone.position.clone();
  const values = offsets.flatMap((offset) => {
    const position = rest.clone().add(offset);
    return [position.x, position.y, position.z];
  });

  return new THREE.VectorKeyframeTrack(`${bone.uuid}.position`, times, values);
}

function compactTracks(tracks: Array<THREE.KeyframeTrack | null>) {
  return tracks.filter((track): track is THREE.KeyframeTrack => Boolean(track));
}

function createIdleClip(bones: HumanoidBoneSet) {
  const duration = 2.4;
  const times = [0, 0.6, 1.2, 1.8, duration];

  return new THREE.AnimationClip(
    "idle",
    duration,
    compactTracks([
      vectorTrack(bones.hips, times, [
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0.025, 0),
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0.018, 0),
        new THREE.Vector3(0, 0, 0),
      ]),
      quaternionTrack(bones.spine, times, [
        { z: 0.02 },
        { z: -0.025 },
        { z: 0.018 },
        { z: -0.015 },
        { z: 0.02 },
      ]),
      quaternionTrack(bones.chest, times, [
        { x: 0.015, z: -0.02 },
        { x: 0.025, z: 0.015 },
        { x: 0.01, z: -0.015 },
        { x: 0.02, z: 0.012 },
        { x: 0.015, z: -0.02 },
      ]),
      quaternionTrack(bones.head, times, [
        { z: -0.01 },
        { z: 0.012 },
        { z: -0.008 },
        { z: 0.01 },
        { z: -0.01 },
      ]),
      quaternionTrack(bones.leftUpperArm, times, [
        { x: -0.1, z: -1.02 },
        { x: -0.08, z: -0.98 },
        { x: -0.1, z: -1.02 },
        { x: -0.09, z: -0.99 },
        { x: -0.1, z: -1.02 },
      ]),
      quaternionTrack(bones.rightUpperArm, times, [
        { x: -0.1, z: 1.02 },
        { x: -0.08, z: 0.98 },
        { x: -0.1, z: 1.02 },
        { x: -0.09, z: 0.99 },
        { x: -0.1, z: 1.02 },
      ]),
      quaternionTrack(bones.leftLowerArm, times, [
        { x: -0.28 },
        { x: -0.24 },
        { x: -0.28 },
        { x: -0.25 },
        { x: -0.28 },
      ]),
      quaternionTrack(bones.rightLowerArm, times, [
        { x: -0.28 },
        { x: -0.24 },
        { x: -0.28 },
        { x: -0.25 },
        { x: -0.28 },
      ]),
      quaternionTrack(bones.leftUpperLeg, times, [
        { x: 0.02 },
        { x: -0.01 },
        { x: 0.02 },
        { x: -0.01 },
        { x: 0.02 },
      ]),
      quaternionTrack(bones.rightUpperLeg, times, [
        { x: -0.01 },
        { x: 0.02 },
        { x: -0.01 },
        { x: 0.02 },
        { x: -0.01 },
      ]),
    ]),
  );
}

function createLocomotionClip(
  clipName: "walk" | "run",
  bones: HumanoidBoneSet,
  config: {
    duration: number;
    stride: number;
    armSwing: number;
    forearmSwing: number;
    lowerLegBend: number;
    footTilt: number;
    hipsBounce: number;
    forwardLean: number;
    chestTwist: number;
  },
) {
  const times = [
    0,
    config.duration * 0.25,
    config.duration * 0.5,
    config.duration * 0.75,
    config.duration,
  ];

  return new THREE.AnimationClip(
    clipName,
    config.duration,
    compactTracks([
      vectorTrack(bones.hips, times, [
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, config.hipsBounce, 0.04),
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, config.hipsBounce, -0.04),
        new THREE.Vector3(0, 0, 0),
      ]),
      quaternionTrack(bones.spine, times, [
        { x: config.forwardLean * 0.75, z: 0.02 },
        { x: config.forwardLean * 0.85, z: -0.02 },
        { x: config.forwardLean * 0.75, z: 0.02 },
        { x: config.forwardLean * 0.85, z: -0.02 },
        { x: config.forwardLean * 0.75, z: 0.02 },
      ]),
      quaternionTrack(bones.chest, times, [
        { x: config.forwardLean, y: config.chestTwist },
        { x: config.forwardLean * 1.05, y: -config.chestTwist },
        { x: config.forwardLean, y: config.chestTwist },
        { x: config.forwardLean * 1.05, y: -config.chestTwist },
        { x: config.forwardLean, y: config.chestTwist },
      ]),
      quaternionTrack(bones.leftUpperLeg, times, [
        { x: config.stride },
        { x: 0.08 },
        { x: -config.stride },
        { x: 0.08 },
        { x: config.stride },
      ]),
      quaternionTrack(bones.rightUpperLeg, times, [
        { x: -config.stride },
        { x: 0.08 },
        { x: config.stride },
        { x: 0.08 },
        { x: -config.stride },
      ]),
      quaternionTrack(bones.leftLowerLeg, times, [
        { x: 0.08 },
        { x: config.lowerLegBend },
        { x: 0.18 },
        { x: 0.45 },
        { x: 0.08 },
      ]),
      quaternionTrack(bones.rightLowerLeg, times, [
        { x: 0.18 },
        { x: 0.45 },
        { x: 0.08 },
        { x: config.lowerLegBend },
        { x: 0.18 },
      ]),
      quaternionTrack(bones.leftFoot, times, [
        { x: -config.footTilt },
        { x: config.footTilt * 0.7 },
        { x: config.footTilt },
        { x: -config.footTilt * 0.6 },
        { x: -config.footTilt },
      ]),
      quaternionTrack(bones.rightFoot, times, [
        { x: config.footTilt },
        { x: -config.footTilt * 0.6 },
        { x: -config.footTilt },
        { x: config.footTilt * 0.7 },
        { x: config.footTilt },
      ]),
      quaternionTrack(bones.leftUpperArm, times, [
        { x: -config.armSwing, z: -0.95 },
        { x: -0.05, z: -1.05 },
        { x: config.armSwing * 0.65, z: -1.1 },
        { x: -0.02, z: -1.01 },
        { x: -config.armSwing, z: -0.95 },
      ]),
      quaternionTrack(bones.rightUpperArm, times, [
        { x: config.armSwing, z: 0.95 },
        { x: -0.02, z: 1.01 },
        { x: -config.armSwing * 0.65, z: 1.1 },
        { x: -0.05, z: 1.05 },
        { x: config.armSwing, z: 0.95 },
      ]),
      quaternionTrack(bones.leftLowerArm, times, [
        { x: -0.1 },
        { x: -config.forearmSwing },
        { x: -0.18 },
        { x: -config.forearmSwing * 0.6 },
        { x: -0.1 },
      ]),
      quaternionTrack(bones.rightLowerArm, times, [
        { x: -0.18 },
        { x: -config.forearmSwing * 0.6 },
        { x: -0.1 },
        { x: -config.forearmSwing },
        { x: -0.18 },
      ]),
    ]),
  );
}

function createJumpClip(bones: HumanoidBoneSet) {
  const duration = 0.9;
  const times = [0, 0.14, 0.28, 0.48, 0.72, duration];

  return new THREE.AnimationClip(
    "jump",
    duration,
    compactTracks([
      vectorTrack(bones.hips, times, [
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, -0.08, 0),
        new THREE.Vector3(0, 0.16, 0.06),
        new THREE.Vector3(0, 0.22, 0.02),
        new THREE.Vector3(0, -0.04, -0.03),
        new THREE.Vector3(0, 0, 0),
      ]),
      quaternionTrack(bones.spine, times, [
        { x: 0, z: 0 },
        { x: -0.22, z: 0 },
        { x: 0.18, z: 0 },
        { x: 0.08, z: 0 },
        { x: -0.12, z: 0 },
        { x: 0, z: 0 },
      ]),
      quaternionTrack(bones.chest, times, [
        { x: 0.02 },
        { x: -0.24 },
        { x: 0.28 },
        { x: 0.16 },
        { x: -0.18 },
        { x: 0.02 },
      ]),
      quaternionTrack(bones.leftUpperLeg, times, [
        { x: -0.04 },
        { x: -0.95 },
        { x: 0.35 },
        { x: 0.28 },
        { x: -0.82 },
        { x: -0.04 },
      ]),
      quaternionTrack(bones.rightUpperLeg, times, [
        { x: -0.04 },
        { x: -0.95 },
        { x: 0.35 },
        { x: 0.28 },
        { x: -0.82 },
        { x: -0.04 },
      ]),
      quaternionTrack(bones.leftLowerLeg, times, [
        { x: 0.08 },
        { x: 1.18 },
        { x: 0.2 },
        { x: 0.12 },
        { x: 1.02 },
        { x: 0.08 },
      ]),
      quaternionTrack(bones.rightLowerLeg, times, [
        { x: 0.08 },
        { x: 1.18 },
        { x: 0.2 },
        { x: 0.12 },
        { x: 1.02 },
        { x: 0.08 },
      ]),
      quaternionTrack(bones.leftFoot, times, [
        { x: 0 },
        { x: -0.25 },
        { x: 0.18 },
        { x: 0.12 },
        { x: -0.2 },
        { x: 0 },
      ]),
      quaternionTrack(bones.rightFoot, times, [
        { x: 0 },
        { x: -0.25 },
        { x: 0.18 },
        { x: 0.12 },
        { x: -0.2 },
        { x: 0 },
      ]),
      quaternionTrack(bones.leftUpperArm, times, [
        { x: -0.24, z: -0.96 },
        { x: -0.64, z: -0.8 },
        { x: -1.05, z: -0.54 },
        { x: -0.92, z: -0.6 },
        { x: -0.48, z: -0.86 },
        { x: -0.24, z: -0.96 },
      ]),
      quaternionTrack(bones.rightUpperArm, times, [
        { x: -0.24, z: 0.96 },
        { x: -0.64, z: 0.8 },
        { x: -1.05, z: 0.54 },
        { x: -0.92, z: 0.6 },
        { x: -0.48, z: 0.86 },
        { x: -0.24, z: 0.96 },
      ]),
      quaternionTrack(bones.leftLowerArm, times, [
        { x: -0.08 },
        { x: -0.28 },
        { x: -0.44 },
        { x: -0.32 },
        { x: -0.18 },
        { x: -0.08 },
      ]),
      quaternionTrack(bones.rightLowerArm, times, [
        { x: -0.08 },
        { x: -0.28 },
        { x: -0.44 },
        { x: -0.32 },
        { x: -0.18 },
        { x: -0.08 },
      ]),
    ]),
  );
}

export function createPreparedHumanoidAnimationClips(vrm: VRM): PreparedHumanoidClipBundle {
  const bones = getHumanoidBoneSet(vrm);

  return {
    idle: createIdleClip(bones),
    walk: createLocomotionClip("walk", bones, {
      duration: 1.0,
      stride: 0.62,
      armSwing: 0.48,
      forearmSwing: 0.34,
      lowerLegBend: 0.82,
      footTilt: 0.28,
      hipsBounce: 0.045,
      forwardLean: 0.08,
      chestTwist: 0.06,
    }),
    run: createLocomotionClip("run", bones, {
      duration: 0.74,
      stride: 0.95,
      armSwing: 0.82,
      forearmSwing: 0.46,
      lowerLegBend: 1.05,
      footTilt: 0.44,
      hipsBounce: 0.08,
      forwardLean: 0.2,
      chestTwist: 0.1,
    }),
    jump: createJumpClip(bones),
  };
}
