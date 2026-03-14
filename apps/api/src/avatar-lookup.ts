import { SuiGrpcClient } from "@mysten/sui/grpc";
import type { ShooterCharacter, ShooterStats } from "@pacific/shared";
import { apiConfig } from "./config.js";

type JsonObject = Record<string, unknown>;

type OwnedAvatarObject = {
  objectId: string;
  type: string;
  version: string;
  previousTransaction: string | null;
  json: Record<string, unknown> | null;
};

export type OnChainOwnedAvatar = {
  objectId: string;
  type: string;
  version: string;
  previousTransaction: string | null;
  name: string | null;
  manifestBlobId: string | null;
  modelUrl: string | null;
  shooterStats: ShooterStats;
  shooterCharacter: ShooterCharacter | null;
};

const suiClient = new SuiGrpcClient({
  network: apiConfig.SUI_NETWORK,
  baseUrl: apiConfig.SUI_GRPC_URL,
});

export function isConfiguredPackageId(value: string | null | undefined): value is string {
  if (!value) {
    return false;
  }

  return /^0x[0-9a-fA-F]+$/.test(value) && !/^0x0+$/.test(value);
}

export function blobIdFromWalrusReference(reference: string | null | undefined) {
  if (!reference) {
    return null;
  }

  const normalized = reference.trim();
  if (!normalized.startsWith("walrus://")) {
    return null;
  }

  const blobId = normalized.slice("walrus://".length).split(/[/?#]/)[0];
  return blobId.length > 0 ? blobId : null;
}

function normalizeKey(key: string) {
  return key.toLowerCase().replace(/_/g, "");
}

function lookupStringField(payload: unknown, fieldNames: string[]) {
  const targetKeys = new Set(fieldNames.map(normalizeKey));
  const queue: unknown[] = [payload];
  const visited = new Set<unknown>();

  while (queue.length > 0) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || visited.has(value)) {
      continue;
    }

    visited.add(value);
    for (const [key, entry] of Object.entries(value as JsonObject)) {
      if (targetKeys.has(normalizeKey(key)) && typeof entry === "string" && entry.length > 0) {
        return entry;
      }

      if (entry && typeof entry === "object") {
        queue.push(entry);
      }
    }
  }

  return null;
}

function lookupNumberField(payload: unknown, fieldNames: string[]) {
  const targetKeys = new Set(fieldNames.map(normalizeKey));
  const queue: unknown[] = [payload];
  const visited = new Set<unknown>();

  while (queue.length > 0) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || visited.has(value)) {
      continue;
    }

    visited.add(value);
    for (const [key, entry] of Object.entries(value as JsonObject)) {
      if (targetKeys.has(normalizeKey(key))) {
        const parsed = Number(entry);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }

      if (entry && typeof entry === "object") {
        queue.push(entry);
      }
    }
  }

  return null;
}

async function listOwnedObjectsByType(
  owner: string,
  type: string,
) {
  const objects: OwnedAvatarObject[] = [];

  let cursor: string | null = null;
  let hasNextPage = true;
  while (hasNextPage) {
    const response = (await suiClient.listOwnedObjects({
      owner,
      type,
      cursor,
      limit: 50,
      include: {
        json: true,
        previousTransaction: true,
      },
    })) as {
      objects: OwnedAvatarObject[];
      cursor: string | null;
      hasNextPage: boolean;
    };

    objects.push(...response.objects);
    cursor = response.cursor;
    hasNextPage = response.hasNextPage;
  }

  return objects;
}

function parseCandidate(
  object: OwnedAvatarObject,
): OnChainOwnedAvatar | null {
  const json = object.json;
  if (!json) {
    return null;
  }

  const name = lookupStringField(json, ["name"]);
  const modelUrl = lookupStringField(json, ["model_url", "modelUrl"]);
  const manifestBlobId =
    lookupStringField(json, ["manifest_blob_id", "manifestBlobId"]) ??
    blobIdFromWalrusReference(modelUrl);

  if (!manifestBlobId && !modelUrl) {
    return null;
  }

  return {
    objectId: object.objectId,
    type: object.type,
    version: object.version,
    previousTransaction: object.previousTransaction ?? null,
    name,
    manifestBlobId,
    modelUrl,
    shooterStats: {
      wins: Math.max(0, Math.floor(lookupNumberField(json, ["wins", "win_count"]) ?? 0)),
      losses: Math.max(0, Math.floor(lookupNumberField(json, ["losses", "loss_count"]) ?? 0)),
      hp: Math.max(
        0,
        Math.floor(lookupNumberField(json, ["hp", "health"]) ?? apiConfig.SHOOTER_DEFAULT_HP),
      ),
    },
    shooterCharacter: (() => {
      const characterId = lookupStringField(json, ["character_id", "characterId"]);
      const characterLabel = lookupStringField(json, ["character_label", "characterLabel"]);
      const prefabResource = lookupStringField(json, ["prefab_resource", "prefabResource"]);
      if (!characterId || !characterLabel || !prefabResource) {
        return null;
      }

      const role = lookupStringField(json, ["character_role", "characterRole"]) ?? undefined;
      return {
        id: characterId,
        label: characterLabel,
        prefabResource,
        role,
        source: "preset",
      } satisfies ShooterCharacter;
    })(),
  };
}

function parseVersion(value: string) {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

export async function listOwnedOnChainAvatars(
  owner: string,
  packageId: string,
) {
  if (!isConfiguredPackageId(packageId)) {
    throw new Error(
      "Avatar package id is not configured. Set AVATAR_PACKAGE_ID or pass packageId in the request.",
    );
  }

  const simpleAvatarType = `${packageId}::simple_avatar::Avatar`;
  const avatarModuleType = `${packageId}::avatar::Avatar`;

  const [simpleObjects, avatarObjects] = await Promise.all([
    listOwnedObjectsByType(owner, simpleAvatarType),
    listOwnedObjectsByType(owner, avatarModuleType),
  ]);

  const seenIds = new Set<string>();
  return [...simpleObjects, ...avatarObjects]
    .filter((object) => {
      if (seenIds.has(object.objectId)) {
        return false;
      }

      seenIds.add(object.objectId);
      return true;
    })
    .map((object) => parseCandidate(object))
    .filter((avatar): avatar is OnChainOwnedAvatar => Boolean(avatar))
    .sort((left, right) => {
      const versionDiff = parseVersion(right.version) - parseVersion(left.version);
      if (versionDiff !== 0n) {
        return versionDiff > 0n ? 1 : -1;
      }

      if (left.previousTransaction === right.previousTransaction) {
        return 0;
      }

      return (right.previousTransaction ?? "").localeCompare(left.previousTransaction ?? "");
    });
}
