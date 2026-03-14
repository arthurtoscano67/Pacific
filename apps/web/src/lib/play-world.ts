import {
  parseReadyAvatarManifest,
  READY_AVATAR_VRM_MIME,
  type ReadyAvatarManifest,
} from "@pacific/shared";
import * as THREE from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRM, VRMLoaderPlugin } from "@pixiv/three-vrm";
import { createAvatarAnimationSet } from "./avatar-runtime";

type WalrusReadClient = {
  walrus: {
    readBlob(options: { blobId: string }): Promise<Uint8Array<ArrayBufferLike>>;
  };
};

export type LoadedAvatarWorld = {
  manifest: ReadyAvatarManifest;
  gltf: GLTF;
  vrm: VRM;
  revokeAvatarUrl: () => void;
};

export type LoadedAvatarAsset = {
  avatarBlobId: string | null;
  manifest: ReadyAvatarManifest | null;
  gltf: GLTF;
  vrm: VRM;
  revokeAvatarUrl: () => void;
};

export type RuntimeAnimationState = {
  mixer: THREE.AnimationMixer | null;
  idleAction: THREE.AnimationAction | null;
  locomotionAction: THREE.AnimationAction | null;
};

function createVrmLoader() {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  return loader;
}

function normalizeWalrusReference(reference: string) {
  const trimmed = reference.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function blobIdFromWalrusReference(reference: string) {
  const normalized = normalizeWalrusReference(reference);
  if (!normalized) {
    return null;
  }

  if (normalized.startsWith("walrus://")) {
    const blobId = normalized.slice("walrus://".length).split(/[/?#]/)[0];
    return blobId.length > 0 ? blobId : null;
  }

  return null;
}

function isDirectUrl(reference: string) {
  return /^(https?:|blob:|data:)/i.test(reference);
}

async function loadAvatarFromUrl(url: string, avatarBlobId: string | null): Promise<LoadedAvatarAsset> {
  const loader = createVrmLoader();
  const gltf = await loader.loadAsync(url);
  const vrm = gltf.userData.vrm as VRM | undefined;
  if (!vrm?.humanoid) {
    throw new Error("Avatar did not load as a VRM humanoid.");
  }

  return {
    avatarBlobId,
    manifest: null,
    gltf,
    vrm,
    revokeAvatarUrl: () => {},
  };
}

function decodeJson(bytes: Uint8Array<ArrayBufferLike>, blobId: string) {
  try {
    const text = new TextDecoder().decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Blob ${blobId} is not valid JSON.`);
  }
}

function parseManifestFromBytes(bytes: Uint8Array<ArrayBufferLike>) {
  try {
    return parseReadyAvatarManifest(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
  } catch {
    return null;
  }
}

export async function loadManifestFromWalrus(client: WalrusReadClient, manifestBlobId: string) {
  const bytes = await client.walrus.readBlob({ blobId: manifestBlobId });
  const payload = decodeJson(bytes, manifestBlobId);
  return parseReadyAvatarManifest(payload);
}

export async function loadAvatarWorldFromWalrus(
  client: WalrusReadClient,
  manifestBlobId: string,
): Promise<LoadedAvatarWorld> {
  const manifest = await loadManifestFromWalrus(client, manifestBlobId);
  const avatar = await loadAvatarFromManifest(client, manifest);

  return {
    ...avatar,
    manifest: avatar.manifest ?? manifest,
  };
}

export async function loadAvatarFromManifest(
  client: WalrusReadClient,
  manifest: ReadyAvatarManifest,
): Promise<LoadedAvatarAsset> {
  const loaded = await loadAvatarFromBlobId(
    client,
    manifest.runtimeAvatar.blobId,
    manifest.runtimeAvatar.mime,
  );
  return {
    ...loaded,
    manifest,
  };
}

export async function loadAvatarFromBlobId(
  client: WalrusReadClient,
  avatarBlobId: string,
  mime = READY_AVATAR_VRM_MIME,
): Promise<LoadedAvatarAsset> {
  const avatarBytes = await client.walrus.readBlob({ blobId: avatarBlobId });
  const manifest = parseManifestFromBytes(avatarBytes);
  if (manifest) {
    return loadAvatarFromManifest(client, manifest);
  }

  const browserAvatarBytes = new Uint8Array(avatarBytes);
  const avatarBlob = new Blob([browserAvatarBytes], {
    type: mime,
  });
  const avatarUrl = URL.createObjectURL(avatarBlob);

  try {
    const loaded = await loadAvatarFromUrl(avatarUrl, avatarBlobId);

    return {
      ...loaded,
      revokeAvatarUrl: () => URL.revokeObjectURL(avatarUrl),
    };
  } catch (error) {
    URL.revokeObjectURL(avatarUrl);
    throw error;
  }
}

export async function loadAvatarFromModelReference(
  client: WalrusReadClient,
  modelReference: string,
): Promise<LoadedAvatarAsset> {
  const blobId = blobIdFromWalrusReference(modelReference);
  if (blobId) {
    return loadAvatarFromBlobId(client, blobId);
  }

  if (isDirectUrl(modelReference)) {
    return loadAvatarFromUrl(modelReference, null);
  }

  return loadAvatarFromBlobId(client, modelReference);
}

function findClip(clips: THREE.AnimationClip[], pattern: RegExp) {
  return clips.find((clip) => pattern.test(clip.name)) ?? null;
}

export function createRuntimeAnimationState(vrm: VRM, gltf: GLTF): RuntimeAnimationState {
  let idleClip: THREE.AnimationClip | null = null;
  let locomotionClip: THREE.AnimationClip | null = null;

  if (gltf.animations.length > 0) {
    idleClip = findClip(gltf.animations, /idle|stand|rest/i) ?? gltf.animations[0];
    locomotionClip =
      findClip(gltf.animations, /walk|run|jog|locomotion|move/i) ??
      gltf.animations.find((clip) => clip !== idleClip) ??
      null;
  } else {
    try {
      const generated = createAvatarAnimationSet(vrm);
      idleClip = generated.idleClip;
      locomotionClip = generated.walkClip;
    } catch {
      idleClip = null;
      locomotionClip = null;
    }
  }

  if (!idleClip && !locomotionClip) {
    return {
      mixer: null,
      idleAction: null,
      locomotionAction: null,
    };
  }

  const mixer = new THREE.AnimationMixer(vrm.scene);
  const idleAction = idleClip ? mixer.clipAction(idleClip) : null;
  const locomotionAction =
    locomotionClip && locomotionClip !== idleClip ? mixer.clipAction(locomotionClip) : null;

  idleAction?.play();
  locomotionAction?.play();
  locomotionAction?.setEffectiveWeight(0);

  return {
    mixer,
    idleAction,
    locomotionAction,
  };
}

export function updateRuntimeAnimationBlend(
  state: RuntimeAnimationState,
  isMoving: boolean,
  deltaSeconds: number,
) {
  if (!state.mixer) {
    return;
  }

  if (state.idleAction && state.locomotionAction) {
    state.idleAction.setEffectiveWeight(isMoving ? 0.15 : 1);
    state.locomotionAction.setEffectiveWeight(isMoving ? 1 : 0);
  } else if (state.locomotionAction && !state.idleAction) {
    state.locomotionAction.setEffectiveWeight(isMoving ? 1 : 0.35);
  }

  state.mixer.update(deltaSeconds);
}
