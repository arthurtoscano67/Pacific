import { useEffect, useRef } from "react";
import type { VRM } from "@pixiv/three-vrm";
import * as THREE from "three";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin } from "@pixiv/three-vrm";
import { loadManifest } from "../lib/avatar-runtime";
import { AvatarAnimationController } from "../lib/avatar-animation-controller";
import {
  createParkourRoom,
  type ParkourPeerSnapshot,
} from "../lib/parkour-room";
import {
  createParkourCourse,
  mountParkourCourse,
} from "../lib/parkour-course";
import {
  createParkourControllerState,
  stepParkourController,
  type ParkourStance,
} from "../lib/parkour-controller";
import {
  loadAvatarFromManifest,
  loadManifestFromWalrus,
} from "../lib/play-world";
import {
  readParkourSave,
  upsertParkourSave,
  type ParkourSaveRecord,
} from "../lib/parkour-save";
import { loadRuntimeAnimationBundle } from "../lib/runtime-animation-library";
import type { AvatarRuntimeSource } from "./AvatarRuntimeCanvas";

declare global {
  interface Window {
    render_game_to_text?: () => string;
    advanceTime?: (ms: number) => void;
  }
}

type WalrusClient = {
  walrus: {
    readBlob(options: { blobId: string }): Promise<Uint8Array<ArrayBufferLike>>;
  };
};

export type ParkourWorldState = {
  status: string;
  avatarReady: boolean;
  placeholderVisible: boolean;
  pointerLocked: boolean;
  roomId: string;
  checkpointIndex: number;
  totalCheckpoints: number;
  elapsedMs: number;
  bestTimeMs: number | null;
  totalRuns: number;
  completedRuns: number;
  participants: number;
  stance: ParkourStance;
  speed: number;
  error: string | null;
  saveUpdatedAt: string | null;
  peers: Array<{
    peerId: string;
    label: string;
    checkpointIndex: number;
    speed: number;
  }>;
};

type Props = {
  runtimeSource: AvatarRuntimeSource;
  apiBaseUrl: string;
  walrusClient: WalrusClient;
  avatarObjectId: string | null;
  avatarName: string | null;
  manifestBlobId: string | null;
  roomId: string;
  onStateChange?: (next: ParkourWorldState) => void;
};

const CONTROLS_TEXT =
  "Click to lock, WASD move, Shift sprint, Space jump/vault/climb, C duck/slide, Q roll, R restart";

function createPlaceholderRunner() {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    color: "#a8471d",
    roughness: 0.82,
    metalness: 0.08,
  });
  const capsule = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.36, 1.1, 6, 12),
    material,
  );
  capsule.position.y = 0.9;
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.28, 20, 20),
    material.clone(),
  );
  head.position.y = 1.7;
  group.add(capsule, head);
  return {
    group,
    dispose() {
      capsule.geometry.dispose();
      (capsule.material as THREE.Material).dispose();
      head.geometry.dispose();
      (head.material as THREE.Material).dispose();
    },
  };
}

function createGhostRunner(color: string) {
  const material = new THREE.MeshStandardMaterial({
    color,
    transparent: true,
    opacity: 0.65,
    roughness: 0.4,
    metalness: 0.05,
  });
  const mesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.32, 0.9, 5, 10),
    material,
  );
  mesh.position.y = 0.7;
  return {
    mesh,
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}

function createLoader() {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  return loader;
}

function formatRuntimeSize(sizeBytes: number) {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return "unknown size";
  }

  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ParkourWorldCanvas({
  runtimeSource,
  apiBaseUrl,
  walrusClient,
  avatarObjectId,
  avatarName,
  manifestBlobId,
  roomId,
  onStateChange,
}: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!mountRef.current) {
      return;
    }

    const course = createParkourCourse();
    const saveRecord =
      readParkourSave(avatarObjectId, manifestBlobId, roomId) ??
      ({
        avatarKey: avatarObjectId ?? manifestBlobId ?? "anonymous-avatar",
        avatarObjectId,
        manifestBlobId,
        roomId,
        bestTimeMs: null,
        lastCheckpointIndex: 0,
        totalRuns: 0,
        completedRuns: 0,
        updatedAt: null,
      } as Omit<ParkourSaveRecord, "updatedAt"> & { updatedAt: string | null });

    const spawn =
      course.checkpointSpawns[saveRecord.lastCheckpointIndex] ?? course.start;
    const controller = createParkourControllerState(
      spawn,
      saveRecord.lastCheckpointIndex,
    );

    let disposed = false;
    let animationFrame = 0;
    let status = "Booting parkour world";
    let avatarReady = false;
    let placeholderVisible = true;
    let pointerLocked = false;
    let currentError: string | null = null;
    let currentManifestBlobId = manifestBlobId;
    let currentSave = saveRecord;
    let currentSpeed = 0;
    let lastCheckpoint = controller.checkpointIndex;
    let lastHudAt = 0;
    let lastRunFinishedAt = 0;
    let currentAvatarBlobId: string | null = null;
    let revokeAvatarUrl: (() => void) | null = null;
    const peerMap = new Map<string, ParkourPeerSnapshot>();
    const ghostMap = new Map<string, ReturnType<typeof createGhostRunner>>();
    const keys = new Set<string>();
    const mount = mountRef.current;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
    });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.shadowMap.enabled = true;
    mount.innerHTML = "";
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#dce7ef");
    scene.fog = new THREE.Fog("#e9dfcc", 28, 120);

    const camera = new THREE.PerspectiveCamera(
      60,
      mount.clientWidth / Math.max(mount.clientHeight, 1),
      0.1,
      220,
    );
    camera.position.set(0, 2.2, 5.6);

    const controls = new PointerLockControls(camera, renderer.domElement);
    controls.pointerSpeed = 0.9;

    const hemisphere = new THREE.HemisphereLight("#ffffff", "#8896a3", 1.15);
    const sun = new THREE.DirectionalLight("#fff7e5", 1.45);
    sun.position.set(8, 14, 6);
    sun.castShadow = false;
    scene.add(hemisphere, sun);

    const disposeCourse = mountParkourCourse(scene, course);

    const playerRoot = new THREE.Group();
    scene.add(playerRoot);
    const placeholder = createPlaceholderRunner();
    playerRoot.add(placeholder.group);

    const playerVisualRoot = new THREE.Group();
    playerRoot.add(playerVisualRoot);

    let vrm: VRM | null = null;
    let animationController: AvatarAnimationController | null = null;

    const room = createParkourRoom({
      roomId,
      label: avatarName ?? "Runner",
      avatarObjectId,
      color: "#5b7aa8",
    });

    const syncHud = () => {
      onStateChange?.({
        status,
        avatarReady,
        placeholderVisible,
        pointerLocked,
        roomId,
        checkpointIndex: controller.checkpointIndex,
        totalCheckpoints: course.checkpointSpawns.length - 1,
        elapsedMs: controller.elapsedMs,
        bestTimeMs: currentSave.bestTimeMs,
        totalRuns: currentSave.totalRuns,
        completedRuns: currentSave.completedRuns,
        participants: ghostMap.size + 1,
        stance: controller.stance,
        speed: currentSpeed,
        error: currentError,
        saveUpdatedAt: currentSave.updatedAt,
        peers: [...peerMap.values()]
          .sort((left, right) => right.updatedAt - left.updatedAt)
          .map((peer) => ({
            peerId: peer.peerId,
            label: peer.label,
            checkpointIndex: peer.checkpointIndex,
            speed: peer.speed,
          })),
      });
    };

    const syncStatus = (next: string) => {
      status = next;
      syncHud();
    };

    const updateGhosts = () => {
      const now = Date.now();
      for (const [peerId, snapshot] of [...peerMap.entries()]) {
        if (now - snapshot.updatedAt > 4000) {
          peerMap.delete(peerId);
          const ghost = ghostMap.get(peerId);
          if (ghost) {
            scene.remove(ghost.mesh);
            ghost.dispose();
            ghostMap.delete(peerId);
          }
          continue;
        }

        let ghost = ghostMap.get(peerId);
        if (!ghost) {
          ghost = createGhostRunner(snapshot.color);
          ghostMap.set(peerId, ghost);
          scene.add(ghost.mesh);
        }
        ghost.mesh.position.set(
          snapshot.position.x,
          snapshot.position.y,
          snapshot.position.z,
        );
        ghost.mesh.rotation.y = snapshot.facingYaw;
      }
    };

    const roomUnsubscribe = room.subscribe((message) => {
      if (message.roomId !== roomId) {
        return;
      }

      if (message.type === "leave") {
        peerMap.delete(message.peerId);
        const ghost = ghostMap.get(message.peerId);
        if (ghost) {
          scene.remove(ghost.mesh);
          ghost.dispose();
          ghostMap.delete(message.peerId);
        }
        syncHud();
        return;
      }

      if (message.snapshot.peerId === room.peerId) {
        return;
      }

      peerMap.set(message.snapshot.peerId, message.snapshot);
    });

    const clock = new THREE.Clock();
    const cameraLook = new THREE.Vector3();
    const cameraFocus = new THREE.Vector3();
    const desiredCamera = new THREE.Vector3();

    const withTimeout = async <T,>(
      promise: Promise<T>,
      timeoutMs: number,
      message: string,
    ) => {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
      });

      try {
        return await Promise.race([promise, timeoutPromise]);
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      }
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
    };

    const onKeyUp = (event: KeyboardEvent) => {
      keys.delete(event.code);
    };

    const onCanvasClick = () => controls.lock();
    const onLock = () => {
      pointerLocked = true;
      syncHud();
    };
    const onUnlock = () => {
      pointerLocked = false;
      syncHud();
    };

    window.addEventListener("resize", onResize);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    renderer.domElement.addEventListener("click", onCanvasClick);
    controls.addEventListener("lock", onLock);
    controls.addEventListener("unlock", onUnlock);

    const renderGameToText = () =>
      JSON.stringify({
        mode: "parkour-world",
        coordinateSystem: "Origin at start pad. +X right, +Y up, +Z forward along the course.",
        status,
        runtimeReady: avatarReady,
        placeholderVisible,
        manifestBlobId: currentManifestBlobId,
        avatarBlobId: currentAvatarBlobId,
        roomId,
        participants: ghostMap.size + 1,
        checkpointIndex: controller.checkpointIndex,
        totalCheckpoints: course.checkpointSpawns.length - 1,
        elapsedMs: Math.round(controller.elapsedMs),
        bestTimeMs: currentSave.bestTimeMs,
        stance: controller.stance,
        speed: Number(currentSpeed.toFixed(2)),
        controls: CONTROLS_TEXT,
        player: {
          x: Number(controller.position.x.toFixed(3)),
          y: Number(controller.position.y.toFixed(3)),
          z: Number(controller.position.z.toFixed(3)),
          facingYaw: Number(controller.facingYaw.toFixed(3)),
          grounded: controller.grounded,
        },
        peers: [...peerMap.values()].map((peer) => ({
          label: peer.label,
          checkpointIndex: peer.checkpointIndex,
          x: Number(peer.position.x.toFixed(2)),
          y: Number(peer.position.y.toFixed(2)),
          z: Number(peer.position.z.toFixed(2)),
        })),
      });

    window.render_game_to_text = renderGameToText;
    window.advanceTime = (ms: number) => {
      const steps = Math.max(1, Math.round(ms / (1000 / 60)));
      const delta = ms / steps / 1000;
      for (let index = 0; index < steps; index += 1) {
        stepFrame(delta);
      }
    };

    async function loadAvatarAsset() {
      const manifest = runtimeSource.kind === "remote"
        ? await (async () => {
            try {
              return await loadManifest(runtimeSource.manifestBlobId, apiBaseUrl);
            } catch {
              syncStatus("API unavailable, reading manifest from Walrus");
              return loadManifestFromWalrus(walrusClient, runtimeSource.manifestBlobId);
            }
          })()
        : runtimeSource.manifest;

      currentManifestBlobId =
        runtimeSource.kind === "remote"
          ? runtimeSource.manifestBlobId
          : manifestBlobId;
      currentAvatarBlobId = manifest.runtimeAvatar.blobId;
      const sizeLabel = formatRuntimeSize(manifest.runtimeAvatar.size);
      syncStatus(`Loading avatar runtime (${sizeLabel})`);

      const loaded = runtimeSource.kind === "remote"
        ? await (async () => {
            try {
              const url = `${apiBaseUrl}/asset/${manifest.runtimeAvatar.blobId}`;
              const gltf = await withTimeout(
                createLoader().loadAsync(url),
                180_000,
                "Runtime VRM download timed out after 180s.",
              );
              return {
                gltf,
                vrm: gltf.userData.vrm as VRM | null,
                revokeAvatarUrl: () => {},
                manifest,
              };
            } catch {
              syncStatus(
                `API unavailable, reading runtime avatar from Walrus (${sizeLabel}). Large files can take 30-120s.`,
              );
              return withTimeout(
                loadAvatarFromManifest(walrusClient, manifest),
                180_000,
                "Runtime avatar download timed out after 180s.",
              );
            }
          })()
        : await withTimeout(
            (async () => {
              const gltf = await createLoader().loadAsync(runtimeSource.avatarUrl);
              return {
                gltf,
                vrm: gltf.userData.vrm as VRM | null,
                revokeAvatarUrl: () => {},
                manifest,
              };
            })(),
            180_000,
            "Local runtime avatar load timed out after 180s.",
          );

      revokeAvatarUrl = loaded.revokeAvatarUrl;
      vrm = loaded.vrm;
      if (!vrm?.humanoid) {
        throw new Error("Avatar did not load as a VRM humanoid.");
      }

      syncStatus("Binding avatar animations");
      const animationBundle = await loadRuntimeAnimationBundle(
        walrusClient,
        vrm,
        loaded.gltf as GLTF,
        loaded.manifest,
      );
      animationController = new AvatarAnimationController(vrm.scene, animationBundle);

      placeholderVisible = false;
      playerVisualRoot.clear();
      playerVisualRoot.add(vrm.scene);
      const bounds = new THREE.Box3().setFromObject(vrm.scene);
      vrm.scene.position.y = -bounds.min.y;
      avatarReady = true;
      syncStatus("Parkour avatar ready");
    }

    function updateLocalAvatarVisual() {
      playerRoot.position.copy(controller.position);
      playerRoot.rotation.y = controller.facingYaw;

      const crouchScale =
        controller.stance === "crouch" || controller.stance === "slide" || controller.stance === "roll"
          ? 0.82
          : 1;
      placeholder.group.scale.set(1, crouchScale, 1);
      playerVisualRoot.scale.set(1, crouchScale, 1);
    }

    function updateAvatarAnimation(
      deltaSeconds: number,
      horizontalSpeed: number,
      jumpStarted: boolean,
    ) {
      if (!vrm || !animationController) {
        return;
      }

      animationController.update(
        {
          grounded: controller.grounded,
          horizontalSpeed,
          running: keys.has("ShiftLeft") || keys.has("ShiftRight"),
          jumpStarted,
          verticalVelocity: controller.velocity.y,
        },
        deltaSeconds,
      );
      vrm.update(deltaSeconds);
    }

    function saveCheckpoint(checkpointIndex: number) {
      currentSave = upsertParkourSave(avatarObjectId, manifestBlobId, roomId, {
        lastCheckpointIndex: checkpointIndex,
      });
      syncHud();
    }

    function saveFinish() {
      const bestTimeMs =
        currentSave.bestTimeMs === null
          ? controller.elapsedMs
          : Math.min(currentSave.bestTimeMs, controller.elapsedMs);
      currentSave = upsertParkourSave(avatarObjectId, manifestBlobId, roomId, {
        bestTimeMs,
        completedRuns: currentSave.completedRuns + 1,
        totalRuns: currentSave.totalRuns + 1,
        lastCheckpointIndex: 0,
      });
      syncHud();
    }

    function stepFrame(deltaSeconds: number) {
      controls.getDirection(cameraLook);
      const result = stepParkourController(
        controller,
        {
          moveForward:
            Number(keys.has("KeyW") || keys.has("ArrowUp")) -
            Number(keys.has("KeyS") || keys.has("ArrowDown")),
          moveRight:
            Number(keys.has("KeyD") || keys.has("ArrowRight")) -
            Number(keys.has("KeyA") || keys.has("ArrowLeft")),
          run: keys.has("ShiftLeft") || keys.has("ShiftRight"),
          jumpPressed: keys.has("Space"),
          crouchHeld: keys.has("KeyC") || keys.has("ControlLeft") || keys.has("ControlRight"),
          rollPressed: keys.has("KeyQ"),
          respawnPressed: keys.has("KeyR"),
          cameraForward: cameraLook,
        },
        deltaSeconds,
        course,
      );

      currentSpeed = result.horizontalSpeed;

      if (result.checkpointReached !== null && result.checkpointReached !== lastCheckpoint) {
        lastCheckpoint = result.checkpointReached;
        saveCheckpoint(result.checkpointReached);
      }

      if (result.finishedRun && performance.now() - lastRunFinishedAt > 500) {
        lastRunFinishedAt = performance.now();
        saveFinish();
      }

      updateLocalAvatarVisual();
      updateAvatarAnimation(deltaSeconds, result.horizontalSpeed, result.jumpStarted);

      cameraFocus.set(
        controller.position.x,
        controller.position.y + 1.45,
        controller.position.z,
      );
      desiredCamera.copy(cameraFocus).addScaledVector(cameraLook, -4.9);
      desiredCamera.y = Math.max(desiredCamera.y, controller.position.y + 1.4);
      camera.position.lerp(desiredCamera, 0.14);
      camera.lookAt(cameraFocus);

      room.publish({
        position: {
          x: controller.position.x,
          y: controller.position.y,
          z: controller.position.z,
        },
        facingYaw: controller.facingYaw,
        checkpointIndex: controller.checkpointIndex,
        stance: controller.stance,
        speed: result.horizontalSpeed,
      });
      updateGhosts();

      const now = performance.now();
      if (now - lastHudAt > 100) {
        lastHudAt = now;
        syncHud();
      }

      renderer.render(scene, camera);
    }

    const animate = () => {
      animationFrame = requestAnimationFrame(animate);
      stepFrame(clock.getDelta());
    };

    syncHud();
    animate();

    loadAvatarAsset().catch((error) => {
      currentError = error instanceof Error ? error.message : "Avatar load failed.";
      syncStatus(currentError);
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      renderer.domElement.removeEventListener("click", onCanvasClick);
      controls.removeEventListener("lock", onLock);
      controls.removeEventListener("unlock", onUnlock);
      if (controls.isLocked) {
        controls.unlock();
      }
      roomUnsubscribe();
      room.close();
      delete window.render_game_to_text;
      delete window.advanceTime;
      animationController?.dispose();
      placeholder.dispose();
      for (const ghost of ghostMap.values()) {
        scene.remove(ghost.mesh);
        ghost.dispose();
      }
      ghostMap.clear();
      peerMap.clear();
      revokeAvatarUrl?.();
      disposeCourse();
      renderer.dispose();
      mount.innerHTML = "";
      if (!disposed) {
        syncHud();
      }
    };
  }, [
    apiBaseUrl,
    avatarName,
    avatarObjectId,
    manifestBlobId,
    onStateChange,
    roomId,
    runtimeSource,
    walrusClient,
  ]);

  return <div className="runtime-canvas parkour-canvas" ref={mountRef} />;
}
