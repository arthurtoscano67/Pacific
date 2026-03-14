import type { SuiGrpcClient } from "@mysten/sui/grpc";
import type { ShooterCharacter, ShooterStats } from "@pacific/shared";
import { webEnv } from "../env";

type JsonObject = Record<string, unknown>;
type OwnedAvatarObject = {
  objectId: string;
  type: string;
  version: string;
  previousTransaction: string | null;
  json: Record<string, unknown> | null;
};

export type OnChainAvatarCandidate = {
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

const simpleAvatarType = `${webEnv.avatarPackageId}::simple_avatar::Avatar`;
const avatarModuleType = `${webEnv.avatarPackageId}::avatar::Avatar`;

function isConfiguredPackageId(value: string) {
  return /^0x[0-9a-fA-F]+$/.test(value) && !/^0x0+$/.test(value);
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
  client: SuiGrpcClient,
  owner: string,
  type: string,
) {
  const objects: OwnedAvatarObject[] = [];

  let cursor: string | null = null;
  let hasNextPage = true;
  while (hasNextPage) {
    const response = (await client.listOwnedObjects({
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
): OnChainAvatarCandidate | null {
  const json = object.json;
  if (!json) {
    return null;
  }

  const name = lookupStringField(json, ["name"]);
  const manifestBlobId = lookupStringField(json, [
    "manifest_blob_id",
    "manifestBlobId",
  ]);
  const modelUrl = lookupStringField(json, ["model_url", "modelUrl"]);

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
      hp: Math.max(0, Math.floor(lookupNumberField(json, ["hp", "health"]) ?? 100)),
    },
    shooterCharacter: (() => {
      const characterId = lookupStringField(json, ["character_id", "characterId"]);
      const characterLabel = lookupStringField(json, ["character_label", "characterLabel"]);
      const prefabResource = lookupStringField(json, ["prefab_resource", "prefabResource"]);
      if (!characterId || !characterLabel || !prefabResource) {
        return null;
      }

      return {
        id: characterId,
        label: characterLabel,
        prefabResource,
        role: lookupStringField(json, ["character_role", "characterRole"]) ?? undefined,
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

export async function queryOwnedOnChainAvatars(
  client: SuiGrpcClient,
  owner: string,
) {
  if (!isConfiguredPackageId(webEnv.avatarPackageId)) {
    throw new Error(
      "Set VITE_AVATAR_PACKAGE_ID to the deployed Avatar package before loading on-chain avatars.",
    );
  }

  const [simpleObjects, avatarObjects] = await Promise.all([
    listOwnedObjectsByType(client, owner, simpleAvatarType),
    listOwnedObjectsByType(client, owner, avatarModuleType),
  ]);

  const seenIds = new Set<string>();
  const all = [...simpleObjects, ...avatarObjects].filter((object) => {
    if (seenIds.has(object.objectId)) {
      return false;
    }

    seenIds.add(object.objectId);
    return true;
  });

  const avatars = all
    .map((object) => parseCandidate(object))
    .filter((avatar): avatar is OnChainAvatarCandidate => Boolean(avatar))
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

  return avatars;
}
