import { webEnv } from "../env";
import type { ShooterCharacter, ShooterStats } from "@pacific/shared";

function normalizeShooterStats(value: unknown): ShooterStats {
  if (!value || typeof value !== "object") {
    return { wins: 0, losses: 0, hp: 100 };
  }

  const payload = value as Record<string, unknown>;
  const wins = Number(payload.wins);
  const losses = Number(payload.losses);
  const hp = Number(payload.hp);
  return {
    wins: Number.isFinite(wins) && wins >= 0 ? Math.floor(wins) : 0,
    losses: Number.isFinite(losses) && losses >= 0 ? Math.floor(losses) : 0,
    hp: Number.isFinite(hp) && hp >= 0 ? Math.floor(hp) : 100,
  };
}

export type BackendOwnedAvatar = {
  objectId: string;
  name: string | null;
  manifestBlobId: string | null;
  modelUrl: string | null;
  runtimeAvatarBlobId: string | null;
  txDigest: string | null;
  status: string | null;
  runtimeReady: boolean;
  updatedAt: string | null;
  isActive: boolean;
  source: "active-wallet" | "object-state" | "manifest-cache" | "on-chain";
  shooterStats: ShooterStats;
  shooterCharacter: ShooterCharacter | null;
};

export type BackendOwnedAvatarResponse = {
  walletAddress: string;
  activeAvatarObjectId: string | null;
  activeManifestBlobId: string | null;
  avatars: BackendOwnedAvatar[];
};

function normalizeAvatar(value: unknown): BackendOwnedAvatar | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const payload = value as Record<string, unknown>;
  const objectId = typeof payload.objectId === "string" ? payload.objectId : null;
  if (!objectId) {
    return null;
  }

  const source =
    payload.source === "active-wallet" ||
    payload.source === "object-state" ||
    payload.source === "manifest-cache" ||
    payload.source === "on-chain"
      ? payload.source
      : "manifest-cache";

  return {
    objectId,
    name: typeof payload.name === "string" ? payload.name : null,
    manifestBlobId:
      typeof payload.manifestBlobId === "string" ? payload.manifestBlobId : null,
    modelUrl: typeof payload.modelUrl === "string" ? payload.modelUrl : null,
    runtimeAvatarBlobId:
      typeof payload.runtimeAvatarBlobId === "string"
        ? payload.runtimeAvatarBlobId
        : null,
    txDigest: typeof payload.txDigest === "string" ? payload.txDigest : null,
    status: typeof payload.status === "string" ? payload.status : null,
    runtimeReady: Boolean(payload.runtimeReady),
    updatedAt: typeof payload.updatedAt === "string" ? payload.updatedAt : null,
    isActive: Boolean(payload.isActive),
    source,
    shooterStats: normalizeShooterStats(payload.shooterStats),
    shooterCharacter:
      payload.shooterCharacter &&
      typeof payload.shooterCharacter === "object" &&
      typeof (payload.shooterCharacter as Record<string, unknown>).id === "string" &&
      typeof (payload.shooterCharacter as Record<string, unknown>).label === "string" &&
      typeof (payload.shooterCharacter as Record<string, unknown>).prefabResource === "string"
        ? {
            id: (payload.shooterCharacter as Record<string, unknown>).id as string,
            label: (payload.shooterCharacter as Record<string, unknown>).label as string,
            prefabResource: (payload.shooterCharacter as Record<string, unknown>)
              .prefabResource as string,
            role:
              typeof (payload.shooterCharacter as Record<string, unknown>).role === "string"
                ? ((payload.shooterCharacter as Record<string, unknown>).role as string)
                : undefined,
            source:
              (payload.shooterCharacter as Record<string, unknown>).source === "uploaded-file"
                ? "uploaded-file"
                : "preset",
            runtimeAssetMime:
              typeof (payload.shooterCharacter as Record<string, unknown>).runtimeAssetMime ===
              "string"
                ? ((payload.shooterCharacter as Record<string, unknown>)
                    .runtimeAssetMime as string)
                : undefined,
            runtimeAssetFilename:
              typeof (payload.shooterCharacter as Record<string, unknown>)
                .runtimeAssetFilename === "string"
                ? ((payload.shooterCharacter as Record<string, unknown>)
                    .runtimeAssetFilename as string)
                : undefined,
          }
        : null,
  };
}

export async function fetchOwnedAvatarsFromBackend(
  walletAddress: string,
  packageId?: string,
) {
  const url = new URL(
    `/avatar/${encodeURIComponent(walletAddress)}/owned`,
    webEnv.apiBaseUrl,
  );
  if (packageId) {
    url.searchParams.set("packageId", packageId);
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Owned-avatar lookup failed with HTTP ${response.status}.`,
    );
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const avatarsRaw = Array.isArray(payload.avatars) ? payload.avatars : [];
  const avatars = avatarsRaw
    .map((item) => normalizeAvatar(item))
    .filter((item): item is BackendOwnedAvatar => Boolean(item));

  return {
    walletAddress:
      typeof payload.walletAddress === "string"
        ? payload.walletAddress
        : walletAddress,
    activeAvatarObjectId:
      typeof payload.activeAvatarObjectId === "string"
        ? payload.activeAvatarObjectId
        : null,
    activeManifestBlobId:
      typeof payload.activeManifestBlobId === "string"
        ? payload.activeManifestBlobId
        : null,
    avatars,
  } satisfies BackendOwnedAvatarResponse;
}
