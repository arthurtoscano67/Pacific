import * as THREE from "three";

export type ParkourObstacleKind =
  | "solid"
  | "checkpoint"
  | "finish"
  | "ceiling";

export type ParkourObstacle = {
  id: string;
  position: THREE.Vector3;
  size: THREE.Vector3;
  color: string;
  kind: ParkourObstacleKind;
  vaultable?: boolean;
  climbable?: boolean;
  checkpointIndex?: number;
};

export type ParkourCourse = {
  roomHalfExtent: number;
  start: THREE.Vector3;
  finish: THREE.Vector3;
  checkpointSpawns: THREE.Vector3[];
  obstacles: ParkourObstacle[];
};

function obstacle(
  id: string,
  x: number,
  y: number,
  z: number,
  width: number,
  height: number,
  depth: number,
  color: string,
  extras: Partial<ParkourObstacle> = {},
): ParkourObstacle {
  return {
    id,
    position: new THREE.Vector3(x, y, z),
    size: new THREE.Vector3(width, height, depth),
    color,
    kind: "solid",
    ...extras,
  };
}

export function createParkourCourse(): ParkourCourse {
  const checkpointSpawns = [
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 1.35, 18),
    new THREE.Vector3(0, 4.35, 35),
    new THREE.Vector3(0, 1.85, 64),
    new THREE.Vector3(0, 4.1, 87),
  ];

  const obstacles: ParkourObstacle[] = [
    obstacle("start-pad", 0, 0.15, 0, 10, 0.3, 10, "#d5b389"),
    obstacle("vault-01", 0, 0.45, 8, 2.8, 0.9, 1.8, "#c7784d", {
      vaultable: true,
    }),
    obstacle("vault-02", 1.6, 0.6, 12, 2.4, 1.2, 1.8, "#cd8550", {
      vaultable: true,
    }),
    obstacle("platform-01", 0, 0.65, 18, 7.4, 1.3, 6.4, "#5b7aa8", {
      checkpointIndex: 1,
      kind: "checkpoint",
    }),
    obstacle("climb-wall", 0, 1.9, 28, 8.4, 3.8, 1.4, "#8d5a4d", {
      climbable: true,
    }),
    obstacle("platform-02", 0, 3.9, 35, 9.6, 0.8, 13, "#5a86bd", {
      checkpointIndex: 2,
      kind: "checkpoint",
    }),
    obstacle("tunnel-left", -4.4, 0.9, 46, 1.2, 1.8, 10, "#40372e"),
    obstacle("tunnel-right", 4.4, 0.9, 46, 1.2, 1.8, 10, "#40372e"),
    obstacle("tunnel-ceiling", 0, 1.8, 46, 8.8, 0.5, 10, "#40372e", {
      kind: "ceiling",
    }),
    obstacle("roll-bar", 0, 1.0, 56, 4.8, 0.4, 1.2, "#8d5a4d", {
      kind: "ceiling",
    }),
    obstacle("beam", 0, 1.55, 64, 1.4, 0.35, 10.5, "#d9c37b", {
      checkpointIndex: 3,
      kind: "checkpoint",
    }),
    obstacle("jump-pad-01", -2.4, 2.2, 74, 3.4, 0.5, 3.4, "#7d95d1"),
    obstacle("jump-pad-02", 1.8, 3.0, 81, 3.4, 0.5, 3.4, "#7d95d1"),
    obstacle("finish", 0, 3.8, 87, 8.8, 0.6, 8.8, "#4d9f63", {
      checkpointIndex: 4,
      kind: "finish",
    }),
  ];

  return {
    roomHalfExtent: 30,
    start: checkpointSpawns[0],
    finish: new THREE.Vector3(0, 4.1, 87),
    checkpointSpawns,
    obstacles,
  };
}

function addCourseBox(scene: THREE.Scene, obstacle: ParkourObstacle) {
  const geometry = new THREE.BoxGeometry(
    obstacle.size.x,
    obstacle.size.y,
    obstacle.size.z,
  );
  const material = new THREE.MeshStandardMaterial({
    color: obstacle.color,
    roughness: 0.86,
    metalness: 0.06,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(obstacle.position);
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

export function mountParkourCourse(scene: THREE.Scene, course: ParkourCourse) {
  const disposers: Array<() => void> = [];

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(120, 120, 1, 1),
    new THREE.MeshStandardMaterial({
      color: "#d9c8a7",
      roughness: 0.98,
      metalness: 0.02,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  disposers.push(() => {
    scene.remove(ground);
    ground.geometry.dispose();
    (ground.material as THREE.Material).dispose();
  });

  const grid = new THREE.GridHelper(120, 60, "#b59870", "#d5c5a8");
  grid.position.y = 0.01;
  scene.add(grid);
  disposers.push(() => {
    scene.remove(grid);
    grid.geometry.dispose();
    const material = grid.material as THREE.Material | THREE.Material[];
    if (Array.isArray(material)) {
      for (const item of material) {
        item.dispose();
      }
    } else {
      material.dispose();
    }
  });

  const boundaryMaterial = new THREE.MeshStandardMaterial({
    color: "#eadfc7",
    transparent: true,
    opacity: 0.35,
    roughness: 1,
  });
  const boundaryGeometry = new THREE.BoxGeometry(course.roomHalfExtent * 2, 4, 0.5);
  const northWall = new THREE.Mesh(boundaryGeometry, boundaryMaterial);
  northWall.position.set(0, 2, course.roomHalfExtent);
  const southWall = northWall.clone();
  southWall.position.set(0, 2, -course.roomHalfExtent);
  scene.add(northWall, southWall);
  disposers.push(() => {
    scene.remove(northWall, southWall);
    boundaryGeometry.dispose();
    boundaryMaterial.dispose();
  });

  for (const obstacle of course.obstacles) {
    const mesh = addCourseBox(scene, obstacle);
    disposers.push(() => {
      scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    });
  }

  return () => {
    for (const dispose of disposers) {
      dispose();
    }
  };
}

export function getObstacleBounds(obstacle: ParkourObstacle) {
  const half = obstacle.size.clone().multiplyScalar(0.5);
  return {
    minX: obstacle.position.x - half.x,
    maxX: obstacle.position.x + half.x,
    minY: obstacle.position.y - half.y,
    maxY: obstacle.position.y + half.y,
    minZ: obstacle.position.z - half.z,
    maxZ: obstacle.position.z + half.z,
  };
}
