import { useEffect, useRef, useState } from "react";
import type { ReadyAvatarManifest } from "@pacific/shared";
import type { VRM } from "@pixiv/three-vrm";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin } from "@pixiv/three-vrm";
import { loadManifest } from "../lib/avatar-runtime";
import { AvatarAnimationController } from "../lib/avatar-animation-controller";
import {
  createPlayerControllerState,
  stepPlayerController,
} from "../lib/player-controller";
import { loadRuntimeAnimationBundle } from "../lib/runtime-animation-library";
import {
  loadAvatarFromManifest,
  loadManifestFromWalrus,
} from "../lib/play-world";

declare global {
  interface Window {
    render_game_to_text?: () => string;
    advanceTime?: (ms: number) => void;
  }
}

export type AvatarRuntimeSource =
  | {
      kind: "local";
      manifest: ReadyAvatarManifest;
      avatarUrl: string;
    }
  | {
      kind: "remote";
      manifestBlobId: string;
    };

type Props = {
  runtimeSource: AvatarRuntimeSource | null;
  apiBaseUrl: string;
  walrusClient?: {
    walrus: {
      readBlob(options: { blobId: string }): Promise<Uint8Array<ArrayBufferLike>>;
    };
  };
  onPlayableReady?: () => void;
  onRuntimeError?: (message: string) => void;
};

function createLoader() {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  return loader;
}

function createFallbackReadClient() {
  return {
    walrus: {
      async readBlob(_options: { blobId: string }) {
        throw new Error("Walrus read client is unavailable.");
      },
    },
  };
}

function createLoadingPlaceholder() {
  const root = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.34, 1.02, 6, 10),
    new THREE.MeshStandardMaterial({
      color: "#c8895e",
      roughness: 0.84,
      metalness: 0.04,
    }),
  );
  body.position.y = 0.9;
  body.castShadow = true;
  body.receiveShadow = true;

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.25, 20, 20),
    new THREE.MeshStandardMaterial({
      color: "#e5bc95",
      roughness: 0.74,
      metalness: 0.02,
    }),
  );
  head.position.y = 1.72;
  head.castShadow = true;
  head.receiveShadow = true;

  root.add(body, head);
  return root;
}

function createWorldDecor() {
  const group = new THREE.Group();
  const meadow = new THREE.Mesh(
    new THREE.PlaneGeometry(180, 180),
    new THREE.MeshStandardMaterial({
      color: "#b7c49b",
      roughness: 0.96,
      metalness: 0.02,
    }),
  );
  meadow.rotation.x = -Math.PI / 2;
  meadow.receiveShadow = true;
  group.add(meadow);

  const spawnPad = new THREE.Mesh(
    new THREE.CylinderGeometry(1.7, 1.7, 0.14, 32),
    new THREE.MeshStandardMaterial({
      color: "#f3e8d4",
      roughness: 0.81,
      metalness: 0.03,
    }),
  );
  spawnPad.position.set(0, 0.07, 0);
  spawnPad.receiveShadow = true;
  group.add(spawnPad);

  const propMaterial = new THREE.MeshStandardMaterial({
    color: "#879874",
    roughness: 0.91,
    metalness: 0.03,
  });
  const accentMaterial = new THREE.MeshStandardMaterial({
    color: "#b98058",
    roughness: 0.82,
    metalness: 0.03,
  });

  const addBlock = (
    x: number,
    z: number,
    width: number,
    height: number,
    depth: number,
    accent = false,
  ) => {
    const block = new THREE.Mesh(
      new THREE.BoxGeometry(width, height, depth),
      accent ? accentMaterial : propMaterial,
    );
    block.position.set(x, height / 2, z);
    block.castShadow = true;
    block.receiveShadow = true;
    group.add(block);
  };

  addBlock(-9, -8, 7, 1.2, 6, true);
  addBlock(10, -10, 6, 1.5, 7);
  addBlock(-14, 9, 8, 2.2, 8);
  addBlock(13, 12, 5, 1.4, 5, true);
  addBlock(-2, 19, 5, 1.1, 5);
  addBlock(18, 2, 4, 2.6, 4);

  const grid = new THREE.GridHelper(180, 72, "#8ca07f", "#afc29f");
  grid.position.y = 0.02;
  group.add(grid);

  return group;
}

export function AvatarRuntimeCanvas({
  runtimeSource,
  apiBaseUrl,
  walrusClient,
  onPlayableReady,
  onRuntimeError,
}: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState("Idle");

  useEffect(() => {
    if (!mountRef.current || !runtimeSource) {
      return;
    }

    let disposed = false;
    let frameId = 0;
    let currentStatus = "Idle";
    let jumpRequested = false;
    let currentAvatarBlobId: string | null = null;
    let revokeRemoteAvatarUrl: (() => void) | null = null;
    const mount = mountRef.current;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.06;
    mount.innerHTML = "";
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#a8c5dd");
    scene.fog = new THREE.Fog("#dce7ef", 28, 170);

    const skyDome = new THREE.Mesh(
      new THREE.SphereGeometry(180, 36, 24),
      new THREE.MeshBasicMaterial({
        color: "#c7dff2",
        side: THREE.BackSide,
      }),
    );
    scene.add(skyDome);

    const camera = new THREE.PerspectiveCamera(
      52,
      mount.clientWidth / Math.max(mount.clientHeight, 1),
      0.1,
      220,
    );
    camera.position.set(0, 2.15, 5.6);

    const hemisphere = new THREE.HemisphereLight("#fff7ea", "#6f7e64", 0.9);
    const ambient = new THREE.AmbientLight("#f7f0df", 0.24);
    const sun = new THREE.DirectionalLight("#fff2d5", 1.45);
    sun.position.set(18, 26, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = 120;
    sun.shadow.camera.left = -28;
    sun.shadow.camera.right = 28;
    sun.shadow.camera.top = 28;
    sun.shadow.camera.bottom = -28;
    scene.add(hemisphere, ambient, sun);

    const worldDecor = createWorldDecor();
    scene.add(worldDecor);

    const avatarRoot = new THREE.Group();
    scene.add(avatarRoot);
    const loadingPlaceholder = createLoadingPlaceholder();
    avatarRoot.add(loadingPlaceholder);

    const clock = new THREE.Clock();
    const keys = new Set<string>();
    const playerState = createPlayerControllerState();
    const cameraForward = new THREE.Vector3();
    const cameraFocus = new THREE.Vector3();
    const desiredCameraPosition = new THREE.Vector3();
    const cameraOffset = new THREE.Vector3(0, 1.85, 4.8);

    let vrm: VRM | null = null;
    let animationController: AvatarAnimationController | null = null;
    let animationState = "missing";
    let animationIssue: string | null = "Animation clips are not loaded yet.";
    let speed = 0;
    let grounded = true;

    const withTimeout = async <T,>(promise: Promise<T>, timeoutMs: number, message: string) => {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      });

      try {
        return await Promise.race([promise, timeoutPromise]);
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      }
    };

    const syncStatus = (next: string) => {
      currentStatus = next;
      setStatus(next);
    };

    const onResize = () => {
      if (!mountRef.current) {
        return;
      }

      camera.aspect = mountRef.current.clientWidth / Math.max(mountRef.current.clientHeight, 1);
      camera.updateProjectionMatrix();
      renderer.setSize(mountRef.current.clientWidth, mountRef.current.clientHeight);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      keys.add(event.code);
      if (event.code === "Space" && !event.repeat) {
        jumpRequested = true;
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      keys.delete(event.code);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("resize", onResize);

    const stepFrame = (deltaSeconds: number) => {
      if (vrm && animationController) {
        camera.getWorldDirection(cameraForward);
        cameraForward.setY(0);
        if (cameraForward.lengthSq() < 1e-6) {
          cameraForward.set(0, 0, -1);
        } else {
          cameraForward.normalize();
        }

        const movement = stepPlayerController(
          playerState,
          {
            moveForward:
              Number(keys.has("KeyW") || keys.has("ArrowUp")) -
              Number(keys.has("KeyS") || keys.has("ArrowDown")),
            moveRight:
              Number(keys.has("KeyD") || keys.has("ArrowRight")) -
              Number(keys.has("KeyA") || keys.has("ArrowLeft")),
            run: keys.has("ShiftLeft") || keys.has("ShiftRight"),
            jumpPressed: jumpRequested,
            cameraForward,
          },
          deltaSeconds,
        );
        jumpRequested = false;

        avatarRoot.position.copy(playerState.position);
        if (movement.isMoving) {
          avatarRoot.rotation.y = THREE.MathUtils.lerp(
            avatarRoot.rotation.y,
            playerState.facingYaw,
            Math.min(1, deltaSeconds * 14),
          );
        }

        const animationDebug = animationController.update(
          {
            grounded: movement.isGrounded,
            horizontalSpeed: movement.horizontalSpeed,
            running: movement.isRunning,
            jumpStarted: movement.jumpStarted,
            verticalVelocity: movement.verticalVelocity,
          },
          deltaSeconds,
        );
        animationState = animationDebug.currentState;
        animationIssue =
          animationDebug.missingClips.length > 0
            ? `Missing animation clips: ${animationDebug.missingClips.join(", ")}`
            : animationDebug.issues[0] ?? null;
        speed = animationDebug.speed;
        grounded = animationDebug.grounded;
        vrm.update(deltaSeconds);

        cameraFocus.set(
          avatarRoot.position.x,
          avatarRoot.position.y + 1.42,
          avatarRoot.position.z,
        );
        desiredCameraPosition
          .copy(cameraFocus)
          .add(
            cameraOffset
              .clone()
              .applyAxisAngle(new THREE.Vector3(0, 1, 0), avatarRoot.rotation.y),
          );
        desiredCameraPosition.y = Math.max(desiredCameraPosition.y, 1.2);
        camera.position.lerp(desiredCameraPosition, 0.11);
        camera.lookAt(cameraFocus);
      }

      renderer.render(scene, camera);
    };

    const renderGameToText = () =>
      JSON.stringify({
        coordinateSystem: "Origin at spawn. +X right, +Y up, +Z forward.",
        manifestBlobId:
          runtimeSource.kind === "remote" ? runtimeSource.manifestBlobId : null,
        avatarBlobId: currentAvatarBlobId,
        status: currentStatus,
        runtimeReady: Boolean(vrm?.humanoid),
        player: {
          x: Number(playerState.position.x.toFixed(3)),
          y: Number(playerState.position.y.toFixed(3)),
          z: Number(playerState.position.z.toFixed(3)),
          facingYaw: Number(playerState.facingYaw.toFixed(3)),
          grounded,
          speed: Number(speed.toFixed(3)),
        },
        animation: {
          state: animationState,
          issue: animationIssue,
        },
        controls:
          "WASD move, Shift run, Space jump",
      });

    window.render_game_to_text = renderGameToText;
    window.advanceTime = (ms: number) => {
      const steps = Math.max(1, Math.round(ms / (1000 / 60)));
      const delta = ms / steps / 1000;
      for (let index = 0; index < steps; index += 1) {
        stepFrame(delta);
      }
    };

    const tick = () => {
      frameId = requestAnimationFrame(tick);
      stepFrame(clock.getDelta());
    };
    tick();

    (async () => {
      const animationReadClient = walrusClient ?? createFallbackReadClient();
      let manifest: ReadyAvatarManifest;
      syncStatus(
        runtimeSource.kind === "remote" ? "Loading manifest" : "Loading local manifest",
      );
      if (runtimeSource.kind === "remote") {
        manifest = await (async () => {
          try {
            return await loadManifest(runtimeSource.manifestBlobId, apiBaseUrl);
          } catch (apiError) {
            if (!walrusClient) {
              throw apiError;
            }

            syncStatus("API unavailable, reading manifest from Walrus");
            return loadManifestFromWalrus(walrusClient, runtimeSource.manifestBlobId);
          }
        })();
      } else {
        manifest = runtimeSource.manifest;
      }

      currentAvatarBlobId = manifest.runtimeAvatar.blobId;
      const runtimeSize = Number.isFinite(manifest.runtimeAvatar.size)
        ? `${(manifest.runtimeAvatar.size / (1024 * 1024)).toFixed(1)} MB`
        : "unknown size";

      syncStatus(`Loading runtime VRM (${runtimeSize})`);

      const loader = createLoader();
      const gltf = await (async () => {
        if (runtimeSource.kind !== "remote") {
          return loader.loadAsync(runtimeSource.avatarUrl);
        }

        const apiAvatarUrl = `${apiBaseUrl}/asset/${manifest.runtimeAvatar.blobId}`;
        try {
          return await loader.loadAsync(apiAvatarUrl);
        } catch (apiError) {
          if (!walrusClient) {
            throw apiError;
          }

          syncStatus("API unavailable, reading runtime avatar from Walrus");
          const loaded = await withTimeout(
            loadAvatarFromManifest(walrusClient, manifest),
            240_000,
            "Runtime avatar download timed out after 240s.",
          );
          revokeRemoteAvatarUrl = loaded.revokeAvatarUrl;
          return loaded.gltf;
        }
      })();

      if (disposed) {
        return;
      }

      vrm = gltf.userData.vrm as VRM | null;
      if (!vrm?.humanoid) {
        throw new Error("Avatar did not load as a VRM humanoid.");
      }

      avatarRoot.remove(loadingPlaceholder);
      avatarRoot.add(vrm.scene);

      let bounds = new THREE.Box3().setFromObject(vrm.scene);
      const avatarHeight = bounds.max.y - bounds.min.y;
      if (avatarHeight > 0) {
        const targetHeight = 1.72;
        const scale = THREE.MathUtils.clamp(targetHeight / avatarHeight, 0.45, 1.9);
        vrm.scene.scale.setScalar(scale);
        bounds = new THREE.Box3().setFromObject(vrm.scene);
      }

      vrm.scene.traverse((node) => {
        if ((node as THREE.Mesh).isMesh) {
          const mesh = node as THREE.Mesh;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
        }
      });

      vrm.scene.position.y = -bounds.min.y;
      const animationBundle = await loadRuntimeAnimationBundle(
        animationReadClient,
        vrm,
        gltf,
        manifest,
      );
      animationController = new AvatarAnimationController(vrm.scene, animationBundle);
      animationState = animationController.state;
      animationIssue =
        animationBundle.missingStates.length > 0
          ? `Missing animation clips: ${animationBundle.missingStates.join(", ")}`
          : animationBundle.issues[0] ?? null;

      if (animationController.state === "missing") {
        syncStatus("Playable, but animation clips are missing.");
      } else {
        syncStatus("Playable");
      }
      onPlayableReady?.();
    })().catch((error) => {
      console.error(error);
      if (!disposed) {
        const message = error instanceof Error ? error.message : "Avatar load failed.";
        syncStatus(message);
        onRuntimeError?.(message);
      }
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("resize", onResize);
      delete window.render_game_to_text;
      delete window.advanceTime;
      animationController?.dispose();
      renderer.dispose();
      revokeRemoteAvatarUrl?.();
      mount.innerHTML = "";
    };
  }, [apiBaseUrl, onPlayableReady, onRuntimeError, runtimeSource, walrusClient]);

  return (
    <section className="runtime-shell">
      <div className="runtime-status">{status}</div>
      <div className="runtime-canvas" ref={mountRef} />
    </section>
  );
}
