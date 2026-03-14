import type { ReadyAvatarManifest } from "@pacific/shared";
import type { VRM } from "@pixiv/three-vrm";
import { VRMLoaderPlugin } from "@pixiv/three-vrm";
import {
  createVRMAnimationClip,
  type VRMAnimation,
  VRMAnimationLoaderPlugin,
  VRMLookAtQuaternionProxy,
} from "@pixiv/three-vrm-animation";
import * as THREE from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { createPreparedHumanoidAnimationClips } from "./prepared-humanoid-animation-clips";
import {
  clipSearchPattern,
  DEFAULT_RUNTIME_ANIMATION_CONFIG,
  resolveRuntimeAnimationReference,
  RUNTIME_ANIMATION_STATES,
  type RuntimeAnimationStateName,
} from "./runtime-animation-config";
import { blobIdFromWalrusReference } from "./play-world";

type WalrusReadClient = {
  walrus: {
    readBlob(options: { blobId: string }): Promise<Uint8Array<ArrayBufferLike>>;
  };
};

type RuntimeAnimationClipMap = Partial<
  Record<RuntimeAnimationStateName, THREE.AnimationClip>
>;

export type LoadedAnimationBundle = {
  clips: RuntimeAnimationClipMap;
  missingStates: RuntimeAnimationStateName[];
  issues: string[];
  sourceByState: Partial<Record<RuntimeAnimationStateName, string>>;
};

function isDirectUrl(reference: string) {
  return /^(https?:|blob:|data:)/i.test(reference);
}

function findEmbeddedClip(gltf: GLTF, state: RuntimeAnimationStateName) {
  const pattern = clipSearchPattern(state);
  return (
    gltf.animations.find((clip) => pattern.test(clip.name)) ??
    gltf.animations.find(
      (clip) => clip.name.toLowerCase() === DEFAULT_RUNTIME_ANIMATION_CONFIG[state].name,
    ) ??
    null
  );
}

function ensureLookAtProxy(vrm: VRM) {
  if (!vrm.lookAt) {
    return;
  }

  const existingProxy = vrm.scene.children.find(
    (child) => child instanceof VRMLookAtQuaternionProxy,
  );
  if (existingProxy) {
    if (!existingProxy.name) {
      existingProxy.name = "lookAtQuaternionProxy";
    }
    return;
  }

  const proxy = new VRMLookAtQuaternionProxy(vrm.lookAt);
  proxy.name = "lookAtQuaternionProxy";
  vrm.scene.add(proxy);
}

async function loadVrmAnimationClipFromReference(
  client: WalrusReadClient,
  vrm: VRM,
  reference: string,
  state: RuntimeAnimationStateName,
) {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

  let objectUrl: string | null = null;
  let loadTarget = reference;
  const blobId = blobIdFromWalrusReference(reference);
  if (blobId || !isDirectUrl(reference)) {
    const walrusBlobId = blobId ?? reference;
    const bytes = await client.walrus.readBlob({ blobId: walrusBlobId });
    objectUrl = URL.createObjectURL(
      new Blob([new Uint8Array(bytes)], {
        type: "model/gltf-binary",
      }),
    );
    loadTarget = objectUrl;
  }

  try {
    const gltf = await loader.loadAsync(loadTarget);
    const vrmAnimations = (gltf.userData.vrmAnimations as VRMAnimation[] | undefined) ?? [];
    const vrmAnimation = vrmAnimations[0];
    if (!vrmAnimation) {
      throw new Error(`No VRM animation track was found in the ${state} clip reference.`);
    }

    ensureLookAtProxy(vrm);
    const clip = createVRMAnimationClip(vrmAnimation, vrm);
    clip.name = state;
    return clip;
  } finally {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }
  }
}

export async function loadRuntimeAnimationBundle(
  client: WalrusReadClient,
  vrm: VRM,
  avatarGltf: GLTF,
  manifest: ReadyAvatarManifest | null,
): Promise<LoadedAnimationBundle> {
  const issues: string[] = [];
  const clips: RuntimeAnimationClipMap = {};
  const sourceByState: LoadedAnimationBundle["sourceByState"] = {};

  let preparedClips: RuntimeAnimationClipMap = {};
  try {
    preparedClips = createPreparedHumanoidAnimationClips(vrm);
  } catch (error) {
    issues.push(
      error instanceof Error
        ? error.message
        : "Prepared humanoid animation clips could not be created.",
    );
  }

  for (const state of RUNTIME_ANIMATION_STATES) {
    const reference = resolveRuntimeAnimationReference(manifest, state);

    if (reference) {
      try {
        clips[state] = await loadVrmAnimationClipFromReference(client, vrm, reference, state);
        sourceByState[state] = `vrma:${reference}`;
        continue;
      } catch (error) {
        issues.push(
          `Failed to load ${state} animation from ${reference}: ${
            error instanceof Error ? error.message : "Unknown animation load error."
          }`,
        );
      }
    }

    const embeddedClip = findEmbeddedClip(avatarGltf, state);
    if (embeddedClip) {
      clips[state] = embeddedClip;
      sourceByState[state] = "embedded";
      continue;
    }

    const preparedClip = preparedClips[state];
    if (preparedClip) {
      clips[state] = preparedClip;
      sourceByState[state] = "prepared";
    }
  }

  const missingStates = RUNTIME_ANIMATION_STATES.filter((state) => !clips[state]);

  return {
    clips,
    missingStates,
    issues,
    sourceByState,
  };
}
