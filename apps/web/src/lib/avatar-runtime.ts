import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRM, VRMLoaderPlugin } from "@pixiv/three-vrm";
import {
  READY_AVATAR_PREVIEW_MIME,
  parseReadyAvatarManifest,
  type ReadyAvatarManifest,
  type VrmValidationSummary,
  validatePlayableAvatarUpload,
} from "@pacific/shared";
import { webEnvLimits } from "../env";

function createLoader() {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  return loader;
}

export async function validateLocalAvatarFile(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return validatePlayableAvatarUpload(
    file.name,
    bytes,
    webEnvLimits.maxRuntimeAvatarBytes,
  );
}

export async function renderLocalAvatarPreview(file: File): Promise<{
  previewBlob: Blob;
  previewUrl: string;
  validation: VrmValidationSummary;
}> {
  const validation = await validateLocalAvatarFile(file);
  if (!validation.playable) {
    throw new Error(validation.errors.join(" "));
  }

  const loader = createLoader();
  const url = URL.createObjectURL(file);

  try {
    const gltf = await loader.loadAsync(url);
    const vrm = gltf.userData.vrm as VRM | undefined;
    if (!vrm?.humanoid) {
      throw new Error("VRM runtime could not bind the humanoid.");
    }

    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(1);
    renderer.setSize(512, 512, false);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#f7f0e0");

    const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
    const keyLight = new THREE.DirectionalLight("#fff7e2", 2.2);
    keyLight.position.set(3, 4, 5);
    const fillLight = new THREE.HemisphereLight("#ffffff", "#d4b58f", 1.6);
    scene.add(keyLight, fillLight);

    const bounds = new THREE.Box3().setFromObject(vrm.scene);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    vrm.scene.position.sub(center);
    vrm.scene.position.y = -bounds.min.y;
    scene.add(vrm.scene);

    camera.position.set(0, Math.max(size.y * 0.62, 1.3), Math.max(size.z * 2.2, 2.6));
    camera.lookAt(new THREE.Vector3(0, Math.max(size.y * 0.55, 1.1), 0));
    renderer.render(scene, camera);

    const previewBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob);
            return;
          }

          reject(new Error("Preview rendering failed."));
        },
        READY_AVATAR_PREVIEW_MIME,
      );
    });

    renderer.dispose();
    const previewUrl = URL.createObjectURL(previewBlob);
    return {
      previewBlob,
      previewUrl,
      validation,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function quaternionKeyframes(
  bone: THREE.Object3D,
  axis: THREE.Vector3,
  angles: number[],
  times: number[],
) {
  const rest = bone.quaternion.clone();
  const values = angles.flatMap((angle) => {
    const quaternion = rest.clone().multiply(
      new THREE.Quaternion().setFromAxisAngle(axis, angle),
    );
    return [quaternion.x, quaternion.y, quaternion.z, quaternion.w];
  });

  return new THREE.QuaternionKeyframeTrack(`${bone.uuid}.quaternion`, times, values);
}

export function createAvatarAnimationSet(vrm: VRM) {
  const hips = vrm.humanoid.getNormalizedBoneNode("hips");
  const leftUpperLeg = vrm.humanoid.getNormalizedBoneNode("leftUpperLeg");
  const rightUpperLeg = vrm.humanoid.getNormalizedBoneNode("rightUpperLeg");
  const leftLowerLeg = vrm.humanoid.getNormalizedBoneNode("leftLowerLeg");
  const rightLowerLeg = vrm.humanoid.getNormalizedBoneNode("rightLowerLeg");
  const leftUpperArm = vrm.humanoid.getNormalizedBoneNode("leftUpperArm");
  const rightUpperArm = vrm.humanoid.getNormalizedBoneNode("rightUpperArm");
  const spine = vrm.humanoid.getNormalizedBoneNode("spine");

  if (
    !hips ||
    !leftUpperLeg ||
    !rightUpperLeg ||
    !leftLowerLeg ||
    !rightLowerLeg ||
    !leftUpperArm ||
    !rightUpperArm ||
    !spine
  ) {
    throw new Error("VRM is missing one or more locomotion bones.");
  }

  const idleTimes = [0, 1, 2];
  const idleClip = new THREE.AnimationClip("idle", 2, [
    new THREE.VectorKeyframeTrack(
      `${hips.uuid}.position`,
      idleTimes,
      [
        hips.position.x,
        hips.position.y,
        hips.position.z,
        hips.position.x,
        hips.position.y + 0.03,
        hips.position.z,
        hips.position.x,
        hips.position.y,
        hips.position.z,
      ],
    ),
    quaternionKeyframes(spine, new THREE.Vector3(0, 0, 1), [0, 0.03, 0], idleTimes),
    quaternionKeyframes(leftUpperArm, new THREE.Vector3(0, 0, 1), [-1.02, -0.98, -1.02], idleTimes),
    quaternionKeyframes(rightUpperArm, new THREE.Vector3(0, 0, 1), [1.02, 0.98, 1.02], idleTimes),
    quaternionKeyframes(leftUpperArm, new THREE.Vector3(1, 0, 0), [-0.06, -0.04, -0.06], idleTimes),
    quaternionKeyframes(rightUpperArm, new THREE.Vector3(1, 0, 0), [-0.06, -0.04, -0.06], idleTimes),
  ]);

  const walkTimes = [0, 0.5, 1];
  const walkClip = new THREE.AnimationClip("walk", 1, [
    quaternionKeyframes(leftUpperLeg, new THREE.Vector3(1, 0, 0), [0.5, -0.5, 0.5], walkTimes),
    quaternionKeyframes(rightUpperLeg, new THREE.Vector3(1, 0, 0), [-0.5, 0.5, -0.5], walkTimes),
    quaternionKeyframes(leftLowerLeg, new THREE.Vector3(1, 0, 0), [0.1, 0.7, 0.1], walkTimes),
    quaternionKeyframes(rightLowerLeg, new THREE.Vector3(1, 0, 0), [0.7, 0.1, 0.7], walkTimes),
    quaternionKeyframes(leftUpperArm, new THREE.Vector3(0, 0, 1), [-1.0, -1.08, -1.0], walkTimes),
    quaternionKeyframes(rightUpperArm, new THREE.Vector3(0, 0, 1), [1.0, 1.08, 1.0], walkTimes),
    quaternionKeyframes(leftUpperArm, new THREE.Vector3(1, 0, 0), [-0.32, 0.2, -0.32], walkTimes),
    quaternionKeyframes(rightUpperArm, new THREE.Vector3(1, 0, 0), [0.32, -0.2, 0.32], walkTimes),
    new THREE.VectorKeyframeTrack(
      `${hips.uuid}.position`,
      walkTimes,
      [
        hips.position.x,
        hips.position.y,
        hips.position.z,
        hips.position.x,
        hips.position.y + 0.06,
        hips.position.z,
        hips.position.x,
        hips.position.y,
        hips.position.z,
      ],
    ),
  ]);

  return {
    idleClip,
    walkClip,
  };
}

export async function loadManifest(blobId: string, apiBaseUrl: string) {
  const response = await fetch(`${apiBaseUrl}/manifest/${blobId}`);
  if (!response.ok) {
    throw new Error("Manifest could not be loaded.");
  }

  return parseReadyAvatarManifest((await response.json()) as unknown) as ReadyAvatarManifest;
}
