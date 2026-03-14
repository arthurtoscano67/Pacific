export const READY_AVATAR_SCHEMA = "ready-player-avatar/2.0";
export const READY_AVATAR_TYPE = "avatar-package";
export const READY_AVATAR_NETWORK = "sui:mainnet";
export const READY_AVATAR_RUNTIME_FORMAT = "vrm-1.0";
export const READY_AVATAR_RUNTIME_SKELETON = "vrm-humanoid";
export const READY_AVATAR_OBJECT_SCHEMA_VERSION = 1;
export const READY_AVATAR_DEFAULT_MAX_SOURCE_ASSET_BYTES = 250 * 1024 * 1024;
export const READY_AVATAR_DEFAULT_MAX_RUNTIME_AVATAR_BYTES = 100 * 1024 * 1024;
export const READY_AVATAR_DEFAULT_EPOCHS = 52;
export const READY_AVATAR_VRM_MIME = "model/vrm";
export const READY_AVATAR_PREVIEW_MIME = "image/png";
export const READY_AVATAR_MANIFEST_MIME = "application/json";
export const READY_AVATAR_ACTIVE_RUNTIME = "playable";
export const READY_AVATAR_PENDING_RUNTIME = "stored";

export const REQUIRED_VRM_BONES = [
  "hips",
  "spine",
  "chest",
  "neck",
  "head",
  "leftUpperArm",
  "leftLowerArm",
  "leftHand",
  "rightUpperArm",
  "rightLowerArm",
  "rightHand",
  "leftUpperLeg",
  "leftLowerLeg",
  "leftFoot",
  "rightUpperLeg",
  "rightLowerLeg",
  "rightFoot",
] as const;

export const PLAYER_CONTROLLER_KEYS = [
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
] as const;
