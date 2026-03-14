import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import {
  manifestRecordSchema,
  parseReadyAvatarManifest,
  readyAvatarManifestSchema,
  READY_AVATAR_MANIFEST_MIME,
  READY_AVATAR_DEFAULT_MAX_SOURCE_ASSET_BYTES,
  walrusAvatarStorageSchema,
  uploadIntentSchema,
  validatePlayableAvatarUpload,
  walletSessionRequestSchema,
  type ShooterCharacter,
  type ShooterStats,
  type WalrusAvatarStorage,
  type WalrusBlobStorage,
} from "@pacific/shared";
import { apiConfig } from "./config.js";
import { createWalletSession, requireWalletSession } from "./auth.js";
import { createDatabase, initDatabase } from "./db.js";
import { readBlobFromGateway, resolveBlobContentType } from "./walrus.js";
import {
  getLocalShooterStatsByWallet,
  getLocalShooterStatsForAvatar,
  recordLocalShooterMatchResult,
  seedLocalShooterStats,
  type ShooterLocalMatchResult,
} from "./shooter-local-store.js";
import {
  getLocalManifestByAvatarObjectId,
  getLocalManifestsByWallet,
  upsertLocalManifestRecord,
  type LocalManifestRecordEntry,
} from "./local-api-store.js";
import {
  blobIdFromWalrusReference,
  isConfiguredPackageId,
  listOwnedOnChainAvatars,
  type OnChainOwnedAvatar,
} from "./avatar-lookup.js";

const app = Fastify({
  logger: true,
  bodyLimit: READY_AVATAR_DEFAULT_MAX_SOURCE_ASSET_BYTES * 2,
});

const sql = createDatabase();

type JsonObject = Record<string, unknown>;

type ActiveAvatarRow = {
  wallet_address: string;
  avatar_object_id: string;
  manifest_blob_id: string;
  updated_at: string;
};

type AvatarObjectStateRow = {
  avatar_object_id: string;
  manifest_blob_id: string;
  updated_at: string;
};

type AvatarManifestRow = {
  avatar_object_id: string;
  manifest_blob_id: string;
  avatar_blob_id: string;
  avatar_blob_object_id: string;
  preview_blob_id: string;
  preview_blob_object_id: string;
  manifest_blob_object_id: string;
  transaction_digest: string | null;
  validation_status: string | null;
  runtime_ready: boolean | null;
  updated_at: string;
  manifest_json: unknown;
};

type AvatarLookupCandidate = {
  objectId: string;
  name: string | null;
  manifestBlobId: string | null;
  modelUrl: string | null;
  runtimeAvatarBlobId: string | null;
  txDigest: string | null;
  status: string | null;
  runtimeReady: boolean;
  shooterStats: ShooterStats;
  shooterCharacter: ShooterCharacter | null;
  shooterStatsUpdatedAt: string | null;
  walrusStorage: WalrusAvatarStorage | null;
  updatedAt: string | null;
  isActive: boolean;
  source: "active-wallet" | "object-state" | "manifest-cache" | "on-chain";
};

type AvatarShooterStatsRow = {
  avatar_object_id: string;
  wallet_address: string;
  wins: number;
  losses: number;
  hp: number;
  updated_at: string;
};

type WalrusAssetExpiryRow = {
  blob_object_id: string;
  blob_id: string;
  wallet_address: string;
  start_epoch: number | string | null;
  end_epoch: number | string | null;
  deletable: boolean | null;
  updated_at: string;
};

type CachedAvatarState = {
  activeAvatarObjectId: string | null;
  activeManifestBlobId: string | null;
  avatars: AvatarLookupCandidate[];
};

const shooterParticipantSchema = z.object({
  avatarObjectId: z.string().startsWith("0x"),
  walletAddress: z.string().startsWith("0x").optional(),
  hp: z.number().int().nonnegative().max(500).optional(),
});

const shooterMatchReportSchema = z
  .object({
    matchId: z.string().min(1).optional(),
    winner: shooterParticipantSchema,
    loser: shooterParticipantSchema,
  })
  .refine((value) => value.winner.avatarObjectId !== value.loser.avatarObjectId, {
    message: "Winner and loser avatar ids must be different.",
  });

const shooterLocalMatchResultSchema = z.object({
  matchId: z.string().min(1).optional(),
  avatarObjectId: z.string().startsWith("0x"),
  walletAddress: z.string().startsWith("0x").optional(),
  result: z.enum(["victory", "defeat", "draw"]),
  hp: z.number().int().nonnegative().max(500).optional(),
});

function defaultShooterStats(): ShooterStats {
  return {
    wins: 0,
    losses: 0,
    hp: apiConfig.SHOOTER_DEFAULT_HP,
  };
}

function normalizeShooterStats(input?: Partial<ShooterStats> | null): ShooterStats {
  const defaults = defaultShooterStats();
  return {
    wins:
      typeof input?.wins === "number" && Number.isFinite(input.wins) && input.wins >= 0
        ? Math.floor(input.wins)
        : defaults.wins,
    losses:
      typeof input?.losses === "number" && Number.isFinite(input.losses) && input.losses >= 0
        ? Math.floor(input.losses)
        : defaults.losses,
    hp:
      typeof input?.hp === "number" && Number.isFinite(input.hp) && input.hp >= 0
        ? Math.floor(input.hp)
        : defaults.hp,
  };
}

function isDefaultShooterStats(stats: ShooterStats) {
  const defaults = defaultShooterStats();
  return (
    stats.wins === defaults.wins &&
    stats.losses === defaults.losses &&
    stats.hp === defaults.hp
  );
}

function normalizeShooterCharacter(input: unknown): ShooterCharacter | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  const payload = input as Record<string, unknown>;
  if (
    typeof payload.id !== "string" ||
    typeof payload.label !== "string" ||
    typeof payload.prefabResource !== "string"
  ) {
    return null;
  }

  return {
    id: payload.id,
    label: payload.label,
    prefabResource: payload.prefabResource,
    role: typeof payload.role === "string" ? payload.role : undefined,
    source: payload.source === "uploaded-file" ? "uploaded-file" : "preset",
    runtimeAssetMime:
      typeof payload.runtimeAssetMime === "string" ? payload.runtimeAssetMime : undefined,
    runtimeAssetFilename:
      typeof payload.runtimeAssetFilename === "string" ? payload.runtimeAssetFilename : undefined,
  } satisfies ShooterCharacter;
}

function getMultiplayerCapacity() {
  return {
    maxPlayers: apiConfig.SHOOTER_MAX_PLAYERS_PER_MATCH,
    maxConcurrentMatches: apiConfig.SHOOTER_MAX_CONCURRENT_MATCHES,
    tickRate: apiConfig.SHOOTER_SERVER_TICK_RATE,
  };
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

function getTimestampValue(value: string | null) {
  if (!value) {
    return 0;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseManifestMetadata(
  payload: unknown,
): {
  name: string | null;
  runtimeAvatarBlobId: string | null;
  shooterStats: ShooterStats;
  shooterCharacter: ShooterCharacter | null;
} {
  try {
    const manifest = parseReadyAvatarManifest(payload);
    return {
      name: manifest.name ?? null,
      runtimeAvatarBlobId: manifest.runtimeAvatar.blobId,
      shooterStats: normalizeShooterStats(manifest.game?.stats),
      shooterCharacter: normalizeShooterCharacter(manifest.game?.character),
    };
  } catch {
    return {
      name: lookupStringField(payload, ["name"]),
      runtimeAvatarBlobId: null,
      shooterStats: normalizeShooterStats({
        wins: lookupNumberField(payload, ["wins", "win_count"]) ?? undefined,
        losses: lookupNumberField(payload, ["losses", "loss_count"]) ?? undefined,
        hp: lookupNumberField(payload, ["hp", "health"]) ?? undefined,
      }),
      shooterCharacter: (() => {
        const id = lookupStringField(payload, ["character_id", "characterId"]);
        const label = lookupStringField(payload, ["character_label", "characterLabel"]);
        const prefabResource = lookupStringField(payload, [
          "prefab_resource",
          "prefabResource",
        ]);
        if (!id || !label || !prefabResource) {
          return null;
        }

        return {
          id,
          label,
          prefabResource,
          role: lookupStringField(payload, ["character_role", "characterRole"]) ?? undefined,
          source: "preset",
        } satisfies ShooterCharacter;
      })(),
    };
  }
}

function parseManifestRuntimePointers(payload: unknown): {
  runtimeAvatarBlobId: string | null;
  previewBlobId: string | null;
} {
  try {
    const manifest = parseReadyAvatarManifest(payload);
    return {
      runtimeAvatarBlobId: manifest.runtimeAvatar.blobId,
      previewBlobId: manifest.preview.blobId,
    };
  } catch {
    return {
      runtimeAvatarBlobId: lookupStringField(payload, [
        "runtimeAvatarBlobId",
        "runtime_avatar_blob_id",
        "avatarBlobId",
      ]),
      previewBlobId: lookupStringField(payload, [
        "previewBlobId",
        "preview_blob_id",
        "previewBlobId",
      ]),
    };
  }
}

function parseManifestStoragePointers(payload: unknown): {
  runtimeAvatarBlobId: string | null;
  runtimeAvatarBlobObjectId: string | null;
  previewBlobId: string | null;
  previewBlobObjectId: string | null;
  sourceAssetBlobId: string | null;
  sourceAssetBlobObjectId: string | null;
} {
  try {
    const manifest = parseReadyAvatarManifest(payload);
    return {
      runtimeAvatarBlobId: manifest.runtimeAvatar.blobId,
      runtimeAvatarBlobObjectId: manifest.runtimeAvatar.blobObjectId ?? null,
      previewBlobId: manifest.preview.blobId,
      previewBlobObjectId: manifest.preview.blobObjectId ?? null,
      sourceAssetBlobId: manifest.sourceAsset?.blobId ?? null,
      sourceAssetBlobObjectId: manifest.sourceAsset?.blobObjectId ?? null,
    };
  } catch {
    return {
      runtimeAvatarBlobId: lookupStringField(payload, [
        "runtimeAvatarBlobId",
        "runtime_avatar_blob_id",
        "avatarBlobId",
      ]),
      runtimeAvatarBlobObjectId: lookupStringField(payload, [
        "runtimeAvatarBlobObjectId",
        "runtime_avatar_blob_object_id",
        "avatarBlobObjectId",
      ]),
      previewBlobId: lookupStringField(payload, [
        "previewBlobId",
        "preview_blob_id",
      ]),
      previewBlobObjectId: lookupStringField(payload, [
        "previewBlobObjectId",
        "preview_blob_object_id",
      ]),
      sourceAssetBlobId: lookupStringField(payload, [
        "sourceAssetBlobId",
        "source_asset_blob_id",
      ]),
      sourceAssetBlobObjectId: lookupStringField(payload, [
        "sourceAssetBlobObjectId",
        "source_asset_blob_object_id",
      ]),
    };
  }
}

function normalizeWalrusBlobStorage(
  value:
    | {
        blobId?: unknown;
        blobObjectId?: unknown;
        startEpoch?: unknown;
        endEpoch?: unknown;
        deletable?: unknown;
      }
    | null
    | undefined,
): WalrusBlobStorage | null {
  if (
    !value ||
    typeof value.blobId !== "string" ||
    value.blobId.length === 0 ||
    typeof value.blobObjectId !== "string" ||
    value.blobObjectId.length === 0
  ) {
    return null;
  }

  const startEpoch = Number(value.startEpoch);
  const endEpoch = Number(value.endEpoch);

  return {
    blobId: value.blobId,
    blobObjectId: value.blobObjectId,
    startEpoch:
      Number.isFinite(startEpoch) && startEpoch >= 0 ? Math.floor(startEpoch) : null,
    endEpoch: Number.isFinite(endEpoch) && endEpoch > 0 ? Math.floor(endEpoch) : null,
    deletable: typeof value.deletable === "boolean" ? value.deletable : null,
  };
}

function summarizeWalrusAvatarStorage(args: {
  runtimeAvatar?: Partial<WalrusBlobStorage> | null;
  preview?: Partial<WalrusBlobStorage> | null;
  manifest?: Partial<WalrusBlobStorage> | null;
  sourceAsset?: Partial<WalrusBlobStorage> | null;
}): WalrusAvatarStorage | null {
  const runtimeAvatar = normalizeWalrusBlobStorage(args.runtimeAvatar);
  const preview = normalizeWalrusBlobStorage(args.preview);
  const manifest = normalizeWalrusBlobStorage(args.manifest);
  const sourceAsset = normalizeWalrusBlobStorage(args.sourceAsset);
  const assets = [runtimeAvatar, preview, manifest, sourceAsset].filter(
    (asset): asset is WalrusBlobStorage => Boolean(asset),
  );

  if (assets.length === 0) {
    return null;
  }

  const endEpochs = assets
    .map((asset) => asset.endEpoch)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  return {
    runtimeAvatar,
    preview,
    manifest,
    sourceAsset,
    minimumEndEpoch: endEpochs.length > 0 ? Math.min(...endEpochs) : null,
    maximumEndEpoch: endEpochs.length > 0 ? Math.max(...endEpochs) : null,
  };
}

function buildApiBaseUrl(
  request: {
    protocol: string;
    headers: Record<string, unknown>;
  },
) {
  const forwardedProto = String(request.headers["x-forwarded-proto"] ?? "").trim();
  const forwardedHost = String(request.headers["x-forwarded-host"] ?? "").trim();
  const host = forwardedHost || String(request.headers.host ?? "").trim();
  const protocol = forwardedProto || request.protocol || "http";
  return host ? `${protocol}://${host}` : apiConfig.APP_ORIGIN;
}

function mergeAvatarCandidate(
  map: Map<string, AvatarLookupCandidate>,
  next: AvatarLookupCandidate,
) {
  const current = map.get(next.objectId);
  if (!current) {
    map.set(next.objectId, next);
    return;
  }

  const currentUpdated = getTimestampValue(current.updatedAt);
  const nextUpdated = getTimestampValue(next.updatedAt);
  const useNextTimestamp = nextUpdated >= currentUpdated;

  map.set(next.objectId, {
    objectId: next.objectId,
    name: next.name ?? current.name,
    manifestBlobId: next.manifestBlobId ?? current.manifestBlobId,
    modelUrl: next.modelUrl ?? current.modelUrl,
    runtimeAvatarBlobId: next.runtimeAvatarBlobId ?? current.runtimeAvatarBlobId,
    txDigest: next.txDigest ?? current.txDigest,
    status: next.status ?? current.status,
    runtimeReady: current.runtimeReady || next.runtimeReady,
    shooterCharacter:
      next.shooterCharacter ?? current.shooterCharacter,
    shooterStats:
      getTimestampValue(next.shooterStatsUpdatedAt) >=
      getTimestampValue(current.shooterStatsUpdatedAt)
        ? next.shooterStats
        : current.shooterStats,
    shooterStatsUpdatedAt:
      getTimestampValue(next.shooterStatsUpdatedAt) >=
      getTimestampValue(current.shooterStatsUpdatedAt)
        ? next.shooterStatsUpdatedAt
        : current.shooterStatsUpdatedAt,
    walrusStorage: next.walrusStorage ?? current.walrusStorage,
    updatedAt: useNextTimestamp ? next.updatedAt : current.updatedAt,
    isActive: current.isActive || next.isActive,
    source: useNextTimestamp ? next.source : current.source,
  });
}

function buildWalrusAssetStorageFromExpiryRow(
  row: WalrusAssetExpiryRow | undefined,
  fallback: {
    blobId: string | null;
    blobObjectId: string | null;
  },
) {
  return normalizeWalrusBlobStorage({
    blobId: row?.blob_id ?? fallback.blobId ?? undefined,
    blobObjectId: row?.blob_object_id ?? fallback.blobObjectId ?? undefined,
    startEpoch: row?.start_epoch ?? null,
    endEpoch: row?.end_epoch ?? null,
    deletable: row?.deletable ?? null,
  });
}

function buildWalrusStorageFromManifestRow(
  row: AvatarManifestRow,
  expiryRowsByBlobObjectId: Map<string, WalrusAssetExpiryRow>,
) {
  const pointers = parseManifestStoragePointers(row.manifest_json);
  return summarizeWalrusAvatarStorage({
    runtimeAvatar: buildWalrusAssetStorageFromExpiryRow(
      expiryRowsByBlobObjectId.get(row.avatar_blob_object_id),
      {
        blobId: row.avatar_blob_id,
        blobObjectId: row.avatar_blob_object_id,
      },
    ),
    preview: buildWalrusAssetStorageFromExpiryRow(
      expiryRowsByBlobObjectId.get(row.preview_blob_object_id),
      {
        blobId: row.preview_blob_id,
        blobObjectId: row.preview_blob_object_id,
      },
    ),
    manifest: buildWalrusAssetStorageFromExpiryRow(
      expiryRowsByBlobObjectId.get(row.manifest_blob_object_id),
      {
        blobId: row.manifest_blob_id,
        blobObjectId: row.manifest_blob_object_id,
      },
    ),
    sourceAsset:
      pointers.sourceAssetBlobId && pointers.sourceAssetBlobObjectId
        ? buildWalrusAssetStorageFromExpiryRow(
            expiryRowsByBlobObjectId.get(pointers.sourceAssetBlobObjectId),
            {
              blobId: pointers.sourceAssetBlobId,
              blobObjectId: pointers.sourceAssetBlobObjectId,
            },
          )
        : null,
  });
}

function resolveAvatarPackageId(packageIdOverride?: string) {
  const candidate =
    packageIdOverride?.trim() ||
    apiConfig.AVATAR_PACKAGE_ID ||
    process.env.VITE_AVATAR_PACKAGE_ID?.trim() ||
    null;

  if (!isConfiguredPackageId(candidate)) {
    throw new Error(
      "Avatar package id is not configured. Set AVATAR_PACKAGE_ID or pass packageId in the request.",
    );
  }

  return candidate;
}

function mapOnChainAvatarToLookupCandidate(
  avatar: OnChainOwnedAvatar,
  isActive: boolean,
): AvatarLookupCandidate {
  return {
    objectId: avatar.objectId,
    name: avatar.name,
    manifestBlobId: avatar.manifestBlobId,
    modelUrl: avatar.modelUrl,
    runtimeAvatarBlobId: null,
    txDigest: avatar.previousTransaction,
    status: "stored",
    runtimeReady: Boolean(avatar.manifestBlobId || avatar.modelUrl),
    shooterCharacter: avatar.shooterCharacter,
    shooterStats: normalizeShooterStats(avatar.shooterStats),
    shooterStatsUpdatedAt: null,
    walrusStorage: null,
    updatedAt: null,
    isActive,
    source: "on-chain",
  };
}

function overlayStoredShooterStats(
  avatars: AvatarLookupCandidate[],
  storedStats: Array<{
    avatarObjectId: string;
    stats: ShooterStats;
    updatedAt: string | null;
  }>,
) {
  if (storedStats.length === 0) {
    return avatars;
  }

  const storedStatsMap = new Map(
    storedStats.map((entry) => [entry.avatarObjectId, entry]),
  );

  return avatars.map((avatar) => {
    const stored = storedStatsMap.get(avatar.objectId);
    if (!stored) {
      return avatar;
    }

    return {
      ...avatar,
      shooterStats: stored.stats,
      shooterStatsUpdatedAt: stored.updatedAt,
      updatedAt: stored.updatedAt ?? avatar.updatedAt,
    } satisfies AvatarLookupCandidate;
  });
}

async function listOwnedAvatarsFromChain(
  walletAddress: string,
  packageIdOverride?: string,
) {
  const packageId = resolveAvatarPackageId(packageIdOverride);
  const avatars = await listOwnedOnChainAvatars(walletAddress, packageId);
  return avatars.map((avatar, index) => mapOnChainAvatarToLookupCandidate(avatar, index === 0));
}

function mapLocalManifestEntryToLookupCandidate(
  entry: LocalManifestRecordEntry,
  isActive: boolean,
): AvatarLookupCandidate {
  const metadata = parseManifestMetadata(entry.manifestJson);
  return {
    objectId: entry.avatarObjectId,
    name: metadata.name,
    manifestBlobId: entry.manifestBlobId,
    modelUrl: entry.manifestBlobId ? `walrus://${entry.manifestBlobId}` : null,
    runtimeAvatarBlobId: metadata.runtimeAvatarBlobId ?? entry.avatarBlobId,
    txDigest: entry.transactionDigest,
    status: entry.validationStatus,
    runtimeReady: entry.runtimeReady,
    shooterCharacter: metadata.shooterCharacter,
    shooterStats: metadata.shooterStats,
    shooterStatsUpdatedAt: entry.updatedAt,
    walrusStorage: entry.walrusStorage,
    updatedAt: entry.updatedAt,
    isActive,
    source: "manifest-cache",
  };
}

async function buildVerifiedOwnedAvatarState(
  walletAddress: string,
  packageIdOverride?: string,
): Promise<CachedAvatarState> {
  const chainOwned = await listOwnedAvatarsFromChain(walletAddress, packageIdOverride);
  const candidates = new Map<string, AvatarLookupCandidate>(
    chainOwned.map((avatar) => [avatar.objectId, avatar]),
  );

  let activeAvatarObjectId = chainOwned[0]?.objectId ?? null;
  let activeManifestBlobId = chainOwned[0]?.manifestBlobId ?? null;

  if (sql) {
    const [activeRows, objectStateRows, manifestRows, shooterStatsRows, walrusExpiryRows] =
      await Promise.all([
      sql`
        select wallet_address, avatar_object_id, manifest_blob_id, updated_at
        from avatar_active_wallet
        where wallet_address = ${walletAddress}
        limit 1
      `,
      sql`
        select avatar_object_id, manifest_blob_id, updated_at
        from avatar_object_state
        where wallet_address = ${walletAddress}
        order by updated_at desc
        limit 64
      `,
      sql`
        select
          avatar_object_id,
          manifest_blob_id,
          avatar_blob_id,
          avatar_blob_object_id,
          preview_blob_id,
          preview_blob_object_id,
          manifest_blob_object_id,
          transaction_digest,
          validation_status,
          runtime_ready,
          updated_at,
          manifest_json
        from avatar_manifests
        where wallet_address = ${walletAddress}
        order by updated_at desc
        limit 64
      `,
      sql`
        select avatar_object_id, wallet_address, wins, losses, hp, updated_at
        from avatar_shooter_stats
        where wallet_address = ${walletAddress}
      `,
      sql`
        select blob_object_id, blob_id, wallet_address, start_epoch, end_epoch, deletable, updated_at
        from walrus_asset_expiry
        where wallet_address = ${walletAddress}
      `,
    ]);

    const active = activeRows[0] as ActiveAvatarRow | undefined;
    const objectStateRowsTyped = objectStateRows as unknown as AvatarObjectStateRow[];
    const manifestRowsTyped = manifestRows as unknown as AvatarManifestRow[];
    const shooterStatsRowsTyped = shooterStatsRows as unknown as AvatarShooterStatsRow[];
    const walrusExpiryRowsTyped = walrusExpiryRows as unknown as WalrusAssetExpiryRow[];
    const shooterStatsMap = new Map<
      string,
      {
        stats: ShooterStats;
        updatedAt: string | null;
      }
    >();
    const walrusExpiryMap = new Map(
      walrusExpiryRowsTyped.map((row) => [row.blob_object_id, row]),
    );

    for (const row of shooterStatsRowsTyped) {
      shooterStatsMap.set(row.avatar_object_id, {
        stats: normalizeShooterStats({
          wins: row.wins,
          losses: row.losses,
          hp: row.hp,
        }),
        updatedAt: row.updated_at,
      });
    }

    for (const row of objectStateRowsTyped) {
      if (!candidates.has(row.avatar_object_id)) {
        continue;
      }

      const shooterState = shooterStatsMap.get(row.avatar_object_id);
      mergeAvatarCandidate(candidates, {
        objectId: row.avatar_object_id,
        name: null,
        manifestBlobId: row.manifest_blob_id,
        modelUrl: row.manifest_blob_id ? `walrus://${row.manifest_blob_id}` : null,
        runtimeAvatarBlobId: null,
        txDigest: null,
        status: null,
        runtimeReady: false,
        shooterCharacter: null,
        shooterStats: shooterState?.stats ?? defaultShooterStats(),
        shooterStatsUpdatedAt: shooterState?.updatedAt ?? null,
        walrusStorage: null,
        updatedAt: row.updated_at,
        isActive: active?.avatar_object_id === row.avatar_object_id,
        source: "object-state",
      });
    }

    for (const row of manifestRowsTyped) {
      if (!candidates.has(row.avatar_object_id)) {
        continue;
      }

      const metadata = parseManifestMetadata(row.manifest_json);
      const shooterState = shooterStatsMap.get(row.avatar_object_id);
      mergeAvatarCandidate(candidates, {
        objectId: row.avatar_object_id,
        name: metadata.name,
        manifestBlobId: row.manifest_blob_id,
        modelUrl: row.manifest_blob_id ? `walrus://${row.manifest_blob_id}` : null,
        runtimeAvatarBlobId: metadata.runtimeAvatarBlobId,
        txDigest: row.transaction_digest,
        status: row.validation_status,
        runtimeReady: Boolean(row.runtime_ready),
        shooterCharacter: metadata.shooterCharacter,
        shooterStats: shooterState?.stats ?? metadata.shooterStats,
        shooterStatsUpdatedAt: shooterState?.updatedAt ?? row.updated_at,
        walrusStorage: buildWalrusStorageFromManifestRow(row, walrusExpiryMap),
        updatedAt: row.updated_at,
        isActive: active?.avatar_object_id === row.avatar_object_id,
        source: "manifest-cache",
      });
    }

    if (active && candidates.has(active.avatar_object_id)) {
      activeAvatarObjectId = active.avatar_object_id;
      activeManifestBlobId =
        candidates.get(active.avatar_object_id)?.manifestBlobId ?? active.manifest_blob_id;
    }
  } else {
    const [manifestEntries, storedStats] = await Promise.all([
      getLocalManifestsByWallet(walletAddress),
      getLocalShooterStatsByWallet(walletAddress),
    ]);

    for (const entry of manifestEntries) {
      if (!candidates.has(entry.avatarObjectId)) {
        continue;
      }

      mergeAvatarCandidate(
        candidates,
        mapLocalManifestEntryToLookupCandidate(
          entry,
          activeAvatarObjectId === entry.avatarObjectId,
        ),
      );
    }

    const merged = overlayStoredShooterStats([...candidates.values()], storedStats);
    merged.forEach((avatar) => {
      candidates.set(avatar.objectId, avatar);
    });
  }

  const avatars = [...candidates.values()]
    .map((avatar) => ({
      ...avatar,
      isActive:
        avatar.objectId === activeAvatarObjectId ||
        (!activeAvatarObjectId && avatar.objectId === chainOwned[0]?.objectId),
    }))
    .sort((left, right) => {
      if (left.isActive !== right.isActive) {
        return left.isActive ? -1 : 1;
      }

      const updatedDiff = getTimestampValue(right.updatedAt) - getTimestampValue(left.updatedAt);
      if (updatedDiff !== 0) {
        return updatedDiff;
      }

      return left.objectId.localeCompare(right.objectId);
    });

  return {
    activeAvatarObjectId: avatars[0]?.objectId ?? null,
    activeManifestBlobId: activeManifestBlobId ?? avatars[0]?.manifestBlobId ?? null,
    avatars,
  };
}

async function verifyAvatarOwnership(walletAddress: string, avatarObjectId: string, packageIdOverride?: string) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const owned = await listOwnedAvatarsFromChain(walletAddress, packageIdOverride);
    if (owned.some((avatar) => avatar.objectId === avatarObjectId)) {
      return true;
    }

    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }

  return false;
}

async function buildUnityProfilePayload(args: {
  sql: typeof sql;
  walletAddress: string;
  avatar: AvatarLookupCandidate;
  request: {
    protocol: string;
    headers: Record<string, unknown>;
  };
}) {
  const { sql: database, walletAddress, avatar, request } = args;
  const apiBaseUrl = buildApiBaseUrl(request);

  let manifestBlobId = avatar.manifestBlobId ?? blobIdFromWalrusReference(avatar.modelUrl);
  let runtimeBlobId = avatar.runtimeAvatarBlobId;
  let previewBlobId: string | null = null;
  let resolvedAvatarName = avatar.name;
  let resolvedShooterCharacter = avatar.shooterCharacter;
  let resolvedShooterStats = normalizeShooterStats(avatar.shooterStats);
  let runtimeHttpUrl =
    avatar.modelUrl && /^https?:/i.test(avatar.modelUrl) ? avatar.modelUrl : null;

  if (manifestBlobId) {
    const manifestBlob = await readBlobFromGateway(
      database,
      manifestBlobId,
      READY_AVATAR_MANIFEST_MIME,
    );
    const manifestPayload = JSON.parse(manifestBlob.body.toString("utf8")) as unknown;
    const runtimePointers = parseManifestRuntimePointers(manifestPayload);
    const manifestMetadata = parseManifestMetadata(manifestPayload);
    runtimeBlobId = runtimeBlobId ?? runtimePointers.runtimeAvatarBlobId;
    previewBlobId = runtimePointers.previewBlobId ?? null;
    resolvedAvatarName = manifestMetadata.name ?? resolvedAvatarName;
    resolvedShooterCharacter = manifestMetadata.shooterCharacter ?? resolvedShooterCharacter;
    if (isDefaultShooterStats(resolvedShooterStats)) {
      resolvedShooterStats = normalizeShooterStats(manifestMetadata.shooterStats);
    }
  } else if (!runtimeBlobId && avatar.modelUrl) {
    runtimeBlobId = blobIdFromWalrusReference(avatar.modelUrl);
  }

  if (!runtimeHttpUrl && runtimeBlobId) {
    runtimeHttpUrl = `${apiBaseUrl}/asset/${runtimeBlobId}`;
  }

  if (!runtimeHttpUrl && !resolvedShooterCharacter) {
    throw new Error("Manifest does not contain a runtime avatar blob id or shooter character preset.");
  }

  return {
    walletAddress,
    avatarObjectId: avatar.objectId,
    avatarName: resolvedAvatarName,
    manifestBlobId,
    avatarBlobId: runtimeBlobId,
    previewBlobId,
    txDigest: avatar.txDigest,
    runtimeState:
      avatar.status ??
      (avatar.runtimeReady ? "playable" : "stored"),
    resolution: runtimeHttpUrl
      ? {
          mode: "http",
          httpUrl: runtimeHttpUrl,
        }
      : undefined,
    manifest: manifestBlobId
      ? {
          url: `${apiBaseUrl}/manifest/${manifestBlobId}`,
        }
      : undefined,
    game: {
      mode: "shooter",
      character: resolvedShooterCharacter,
      stats: resolvedShooterStats,
      multiplayer: getMultiplayerCapacity(),
    },
    shooterCharacter: resolvedShooterCharacter,
    shooterStats: resolvedShooterStats,
    multiplayer: getMultiplayerCapacity(),
    endpoints: {
      reportMatchUrl: `${apiBaseUrl}/shooter/match`,
      reportLocalMatchUrl: `${apiBaseUrl}/shooter/match/local`,
      shooterStatsUrl: `${apiBaseUrl}/shooter/stats/${encodeURIComponent(walletAddress)}`,
    },
    source: avatar.source === "on-chain" ? "on-chain" : "api-cache",
    updatedAt: avatar.updatedAt,
  };
}

function applyShooterStatsToManifestPayload(payload: unknown, stats: ShooterStats) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }

  const manifest = { ...(payload as JsonObject) };
  const game =
    manifest.game && typeof manifest.game === "object" && !Array.isArray(manifest.game)
      ? { ...(manifest.game as JsonObject) }
      : {};

  game.mode = "shooter";
  game.stats = {
    wins: stats.wins,
    losses: stats.losses,
    hp: stats.hp,
  };
  game.multiplayer = getMultiplayerCapacity();
  manifest.game = game;

  return manifest;
}

async function resolveWalletAddressForAvatar(
  database: NonNullable<typeof sql>,
  avatarObjectId: string,
  explicitWalletAddress?: string,
) {
  if (explicitWalletAddress) {
    return explicitWalletAddress;
  }

  const [statsRow] = await database`
    select wallet_address
    from avatar_shooter_stats
    where avatar_object_id = ${avatarObjectId}
    limit 1
  `;
  if (statsRow && typeof (statsRow as { wallet_address?: unknown }).wallet_address === "string") {
    return (statsRow as { wallet_address: string }).wallet_address;
  }

  const [manifestRow] = await database`
    select wallet_address
    from avatar_manifests
    where avatar_object_id = ${avatarObjectId}
    order by updated_at desc
    limit 1
  `;
  if (
    manifestRow &&
    typeof (manifestRow as { wallet_address?: unknown }).wallet_address === "string"
  ) {
    return (manifestRow as { wallet_address: string }).wallet_address;
  }

  const [objectStateRow] = await database`
    select wallet_address
    from avatar_object_state
    where avatar_object_id = ${avatarObjectId}
    limit 1
  `;
  if (
    objectStateRow &&
    typeof (objectStateRow as { wallet_address?: unknown }).wallet_address === "string"
  ) {
    return (objectStateRow as { wallet_address: string }).wallet_address;
  }

  return null;
}

async function upsertShooterStats(args: {
  database: NonNullable<typeof sql>;
  avatarObjectId: string;
  walletAddress: string;
  winDelta: number;
  lossDelta: number;
  hp: number;
}) {
  const { database, avatarObjectId, walletAddress, winDelta, lossDelta, hp } = args;
  const [row] = await database`
    insert into avatar_shooter_stats (
      avatar_object_id,
      wallet_address,
      wins,
      losses,
      hp,
      updated_at
    )
    values (
      ${avatarObjectId},
      ${walletAddress},
      ${winDelta},
      ${lossDelta},
      ${hp},
      now()
    )
    on conflict (avatar_object_id) do update
    set wallet_address = excluded.wallet_address,
        wins = avatar_shooter_stats.wins + ${winDelta},
        losses = avatar_shooter_stats.losses + ${lossDelta},
        hp = excluded.hp,
        updated_at = excluded.updated_at
    returning avatar_object_id, wallet_address, wins, losses, hp, updated_at
  `;

  if (!row) {
    return null;
  }

  const typedRow = row as AvatarShooterStatsRow;
  return {
    avatarObjectId: typedRow.avatar_object_id,
    walletAddress: typedRow.wallet_address,
    stats: normalizeShooterStats({
      wins: typedRow.wins,
      losses: typedRow.losses,
      hp: typedRow.hp,
    }),
    updatedAt: typedRow.updated_at,
  };
}

async function syncManifestCacheShooterStats(
  database: NonNullable<typeof sql>,
  avatarObjectId: string,
  stats: ShooterStats,
) {
  const [manifestRow] = await database`
    select manifest_blob_id, manifest_json
    from avatar_manifests
    where avatar_object_id = ${avatarObjectId}
    order by updated_at desc
    limit 1
  `;

  if (!manifestRow) {
    return;
  }

  const typedRow = manifestRow as { manifest_blob_id: string; manifest_json: unknown };
  const nextPayload = applyShooterStatsToManifestPayload(typedRow.manifest_json, stats);

  await database`
    update avatar_manifests
    set manifest_json = ${JSON.stringify(nextPayload)},
        updated_at = now()
    where manifest_blob_id = ${typedRow.manifest_blob_id}
  `;
}

function requireDatabase(reply: { code: (statusCode: number) => { send: (body: unknown) => unknown } }) {
  if (sql) {
    return sql;
  }

  reply.code(503).send({
    error:
      "DATABASE_URL is not configured. Start the API with a database for wallet sessions and manifest persistence, or use the read-only on-chain routes.",
  });
  return null;
}

function buildAllowedOrigins() {
  const allowed = new Set<string>([apiConfig.APP_ORIGIN]);

  try {
    const configured = new URL(apiConfig.APP_ORIGIN);
    const isLocalHost =
      configured.hostname === "127.0.0.1" || configured.hostname === "localhost";

    if (isLocalHost) {
      for (const host of ["127.0.0.1", "localhost"]) {
        allowed.add(`${configured.protocol}//${host}${configured.port ? `:${configured.port}` : ""}`);
      }

      for (const port of ["4173", "5173", "5174"]) {
        allowed.add(`http://127.0.0.1:${port}`);
        allowed.add(`http://localhost:${port}`);
      }
    }
  } catch {
    // Fall back to the configured origin only.
  }

  return allowed;
}

const allowedOrigins = buildAllowedOrigins();

await app.register(cors, {
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error(`Origin ${origin} is not allowed by CORS.`), false);
  },
  credentials: true,
});

await initDatabase(sql);

app.get("/health", async () => ({
  ok: true,
  network: apiConfig.SUI_NETWORK,
  database: Boolean(sql),
  multiplayer: getMultiplayerCapacity(),
}));

app.post("/session/wallet", async (request, reply) => {
  const body = walletSessionRequestSchema.parse(request.body);

  try {
    const session = await createWalletSession(
      sql,
      body.address,
      body.message,
      body.signature,
    );
    return session;
  } catch (error) {
    return reply.code(401).send({
      error: (error as Error).message,
    });
  }
});

app.post("/avatar/upload", async (request, reply) => {
  const database = requireDatabase(reply);
  if (!database) {
    return;
  }

  const session = await requireWalletSession(database, request, reply);
  if (!session) {
    return;
  }

  const body = uploadIntentSchema.parse(request.body);

  if (body.kind === "avatar" && !body.filename.toLowerCase().endsWith(".vrm")) {
    return reply.code(400).send({
      error: "Only .vrm files can become active playable avatars.",
    });
  }

  if (body.size > apiConfig.MAX_RUNTIME_AVATAR_FILE_BYTES && body.kind === "avatar") {
    return reply.code(400).send({
      error: `Runtime avatar exceeds the ${Math.round(apiConfig.MAX_RUNTIME_AVATAR_FILE_BYTES / (1024 * 1024))}MB limit.`,
    });
  }

  if (
    body.size > apiConfig.MAX_SOURCE_ASSET_FILE_BYTES &&
    (body.kind === "source-asset" || body.kind === "generic-asset")
  ) {
    return reply.code(400).send({
      error: `Source asset exceeds the ${Math.round(apiConfig.MAX_SOURCE_ASSET_FILE_BYTES / (1024 * 1024))}MB limit.`,
    });
  }

  const intentId = randomUUID();
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  await database`
    insert into avatar_upload_intents (
      id,
      wallet_address,
      kind,
      filename,
      size_bytes,
      mime,
      expires_at
    )
    values (
      ${intentId},
      ${session.walletAddress},
      ${body.kind},
      ${body.filename},
      ${body.size},
      ${body.mime},
      ${expiresAt}
    )
  `;

  return {
    intentId,
    walletAddress: session.walletAddress,
    relayHost: apiConfig.WALRUS_UPLOAD_RELAY_URL,
    epochs: apiConfig.WALRUS_EPOCHS,
    maxRuntimeAvatarBytes: apiConfig.MAX_RUNTIME_AVATAR_FILE_BYTES,
    maxSourceAssetBytes: apiConfig.MAX_SOURCE_ASSET_FILE_BYTES,
  };
});

app.post("/avatar/manifest", async (request, reply) => {
  const session = await requireWalletSession(sql, request, reply);
  if (!session) {
    return;
  }

  const body = request.body as { manifest: unknown } & Record<string, unknown>;
  const manifest = readyAvatarManifestSchema.parse(body.manifest);
  const record = manifestRecordSchema.parse(body);

  if (manifest.owner !== session.walletAddress) {
    return reply.code(403).send({ error: "Manifest owner does not match the authenticated wallet." });
  }

  const avatarOwnershipVerified = await verifyAvatarOwnership(
    session.walletAddress,
    record.avatarObjectId,
  );
  if (!avatarOwnershipVerified) {
    return reply.code(403).send({
      error: "Avatar object is not currently owned by the authenticated wallet on Sui.",
    });
  }

  const manifestBlob = await readBlobFromGateway(sql, record.manifestBlobId, READY_AVATAR_MANIFEST_MIME);
  const uploadedManifest = JSON.parse(manifestBlob.body.toString("utf8"));
  const parsedUploadedManifest = parseReadyAvatarManifest(uploadedManifest);

  if (JSON.stringify(parsedUploadedManifest) !== JSON.stringify(manifest)) {
    return reply.code(400).send({
      error: "Manifest stored on Walrus does not match the submitted manifest payload.",
    });
  }

  const isShooterManifest = manifest.game?.mode === "shooter";
  let avatarValidation: ReturnType<typeof validatePlayableAvatarUpload> | null = null;
  let avatarPlayable = true;
  let avatarValidationErrors: string[] = [];
  if (!isShooterManifest) {
    const avatarBlob = await readBlobFromGateway(sql, record.avatarBlobId);
    avatarValidation = validatePlayableAvatarUpload(
      manifest.runtimeAvatar.filename,
      new Uint8Array(avatarBlob.body),
    );
    avatarPlayable = avatarValidation.playable;
    avatarValidationErrors = avatarValidation.errors;
  }

  const previewBlob = await readBlobFromGateway(sql, record.previewBlobId);
  if (previewBlob.body.byteLength === 0) {
    return reply.code(400).send({ error: "Preview blob is empty." });
  }

  const validationStatus =
    avatarPlayable && record.runtimeReady ? "playable" :
    avatarPlayable ? "stored" :
    "invalid";
  const walrusStorage = summarizeWalrusAvatarStorage({
    runtimeAvatar:
      record.walrusStorage?.runtimeAvatar ?? {
        blobId: record.avatarBlobId,
        blobObjectId: record.avatarBlobObjectId,
      },
    preview:
      record.walrusStorage?.preview ?? {
        blobId: record.previewBlobId,
        blobObjectId: record.previewBlobObjectId,
      },
    manifest:
      record.walrusStorage?.manifest ?? {
        blobId: record.manifestBlobId,
        blobObjectId: record.manifestBlobObjectId,
      },
    sourceAsset:
      record.walrusStorage?.sourceAsset ??
      (record.sourceAssetBlobId && record.sourceAssetBlobObjectId
        ? {
            blobId: record.sourceAssetBlobId,
            blobObjectId: record.sourceAssetBlobObjectId,
          }
        : null),
  });

  const initialShooterStats = normalizeShooterStats(manifest.game?.stats);
  if (sql) {
    await sql`
      insert into avatar_manifests (
        manifest_blob_id,
        wallet_address,
        avatar_blob_id,
        avatar_blob_object_id,
        preview_blob_id,
        preview_blob_object_id,
        manifest_blob_object_id,
        avatar_object_id,
        transaction_digest,
        manifest_json,
        epochs,
        validation_status,
        validation_errors,
        runtime_ready,
        updated_at
      )
      values (
        ${record.manifestBlobId},
        ${session.walletAddress},
        ${record.avatarBlobId},
        ${record.avatarBlobObjectId},
        ${record.previewBlobId},
        ${record.previewBlobObjectId},
        ${record.manifestBlobObjectId},
        ${record.avatarObjectId},
        ${record.transactionDigest ?? null},
        ${JSON.stringify(manifest)},
        ${record.epochs},
        ${validationStatus},
        ${JSON.stringify(avatarValidationErrors)},
        ${record.runtimeReady},
        now()
      )
      on conflict (manifest_blob_id) do update
      set wallet_address = excluded.wallet_address,
          avatar_blob_id = excluded.avatar_blob_id,
          avatar_blob_object_id = excluded.avatar_blob_object_id,
          preview_blob_id = excluded.preview_blob_id,
          preview_blob_object_id = excluded.preview_blob_object_id,
          manifest_blob_object_id = excluded.manifest_blob_object_id,
          avatar_object_id = excluded.avatar_object_id,
          transaction_digest = excluded.transaction_digest,
          manifest_json = excluded.manifest_json,
          epochs = excluded.epochs,
          validation_status = excluded.validation_status,
          validation_errors = excluded.validation_errors,
          runtime_ready = excluded.runtime_ready,
          updated_at = excluded.updated_at
    `;

    for (const asset of [
      walrusStorage?.runtimeAvatar,
      walrusStorage?.preview,
      walrusStorage?.manifest,
      walrusStorage?.sourceAsset ?? null,
    ]) {
      if (!asset) {
        continue;
      }

      await sql`
        insert into walrus_asset_expiry (
          blob_object_id,
          blob_id,
          wallet_address,
          start_epoch,
          end_epoch,
          deletable,
          updated_at
        )
        values (
          ${asset.blobObjectId},
          ${asset.blobId},
          ${session.walletAddress},
          ${asset.startEpoch ?? null},
          ${asset.endEpoch ?? null},
          ${asset.deletable ?? null},
          now()
        )
        on conflict (blob_object_id) do update
        set blob_id = excluded.blob_id,
            wallet_address = excluded.wallet_address,
            start_epoch = excluded.start_epoch,
            end_epoch = excluded.end_epoch,
            deletable = excluded.deletable,
            updated_at = excluded.updated_at
      `;
    }

    await sql`
      insert into avatar_shooter_stats (
        avatar_object_id,
        wallet_address,
        wins,
        losses,
        hp,
        updated_at
      )
      values (
        ${record.avatarObjectId},
        ${session.walletAddress},
        ${initialShooterStats.wins},
        ${initialShooterStats.losses},
        ${initialShooterStats.hp},
        now()
      )
      on conflict (avatar_object_id) do update
      set wallet_address = excluded.wallet_address,
          wins = greatest(avatar_shooter_stats.wins, excluded.wins),
          losses = greatest(avatar_shooter_stats.losses, excluded.losses),
          hp = excluded.hp,
          updated_at = excluded.updated_at
    `;
  } else {
    await upsertLocalManifestRecord({
      manifestBlobId: record.manifestBlobId,
      walletAddress: session.walletAddress,
      avatarBlobId: record.avatarBlobId,
      avatarBlobObjectId: record.avatarBlobObjectId,
      previewBlobId: record.previewBlobId,
      previewBlobObjectId: record.previewBlobObjectId,
      manifestBlobObjectId: record.manifestBlobObjectId,
      avatarObjectId: record.avatarObjectId,
      transactionDigest: record.transactionDigest ?? null,
      manifestJson: manifest,
      epochs: record.epochs,
      walrusStorage,
      validationStatus,
      validationErrors: avatarValidationErrors,
      runtimeReady: record.runtimeReady,
    });

    await seedLocalShooterStats({
      avatarObjectId: record.avatarObjectId,
      walletAddress: session.walletAddress,
      stats: initialShooterStats,
    });
  }

  return {
    status: validationStatus,
    validation:
      avatarValidation ??
      {
        mode: "shooter",
        playable: avatarPlayable,
        errors: avatarValidationErrors,
      },
    shooterStats: initialShooterStats,
    walrusStorage,
  };
});

app.post("/avatar/storage/sync", async (request, reply) => {
  const session = await requireWalletSession(sql, request, reply);
  if (!session) {
    return;
  }

  const body = z
    .object({
      avatarObjectId: z.string().startsWith("0x"),
      walrusStorage: walrusAvatarStorageSchema,
    })
    .parse(request.body);

  const ownershipVerified = await verifyAvatarOwnership(
    session.walletAddress,
    body.avatarObjectId,
  );
  if (!ownershipVerified) {
    return reply.code(403).send({
      error: "Avatar object is not currently owned by the authenticated wallet on Sui.",
    });
  }

  const walrusStorage = summarizeWalrusAvatarStorage(body.walrusStorage);
  if (!walrusStorage) {
    return reply.code(400).send({ error: "Walrus storage payload is empty." });
  }

  const assets = [
    walrusStorage.runtimeAvatar,
    walrusStorage.preview,
    walrusStorage.manifest,
    walrusStorage.sourceAsset ?? null,
  ].filter((asset): asset is WalrusBlobStorage => Boolean(asset));

  if (sql) {
    for (const asset of assets) {
      await sql`
        insert into walrus_asset_expiry (
          blob_object_id,
          blob_id,
          wallet_address,
          start_epoch,
          end_epoch,
          deletable,
          updated_at
        )
        values (
          ${asset.blobObjectId},
          ${asset.blobId},
          ${session.walletAddress},
          ${asset.startEpoch ?? null},
          ${asset.endEpoch ?? null},
          ${asset.deletable ?? null},
          now()
        )
        on conflict (blob_object_id) do update
        set blob_id = excluded.blob_id,
            wallet_address = excluded.wallet_address,
            start_epoch = excluded.start_epoch,
            end_epoch = excluded.end_epoch,
            deletable = excluded.deletable,
            updated_at = excluded.updated_at
      `;
    }

    await sql`
      update avatar_manifests
      set updated_at = now()
      where avatar_object_id = ${body.avatarObjectId}
    `;
  } else {
    const existing = await getLocalManifestByAvatarObjectId(body.avatarObjectId);
    if (existing) {
      await upsertLocalManifestRecord({
        manifestBlobId: existing.manifestBlobId,
        walletAddress: existing.walletAddress,
        avatarBlobId: existing.avatarBlobId,
        avatarBlobObjectId: existing.avatarBlobObjectId,
        previewBlobId: existing.previewBlobId,
        previewBlobObjectId: existing.previewBlobObjectId,
        manifestBlobObjectId: existing.manifestBlobObjectId,
        avatarObjectId: existing.avatarObjectId,
        transactionDigest: existing.transactionDigest,
        manifestJson: existing.manifestJson,
        epochs: existing.epochs,
        walrusStorage,
        validationStatus: existing.validationStatus,
        validationErrors: existing.validationErrors,
        runtimeReady: existing.runtimeReady,
      });
    }
  }

  return {
    status: "synced",
    walrusStorage,
  };
});

app.get("/avatar/:wallet", async (request, reply) => {
  const params = request.params as { wallet: string };
  const query = request.query as { packageId?: string };

  try {
    const state = await buildVerifiedOwnedAvatarState(params.wallet, query.packageId);
    const active = state.avatars[0] ?? null;

    return {
      walletAddress: params.wallet,
      avatarObjectId: active?.objectId ?? null,
      manifestBlobId: active?.manifestBlobId ?? null,
      status: active?.status ?? "not-found",
      updatedAt: active?.updatedAt ?? null,
      shooterCharacter: active?.shooterCharacter ?? null,
      shooterStats: active?.shooterStats ?? defaultShooterStats(),
    };
  } catch (error) {
    return reply.code(500).send({
      error: error instanceof Error ? error.message : "Avatar lookup failed.",
    });
  }
});

app.get("/avatar/:wallet/owned", async (request, reply) => {
  const params = request.params as { wallet: string };
  const walletAddress = params.wallet;
  const query = request.query as { packageId?: string };

  try {
    const state = await buildVerifiedOwnedAvatarState(walletAddress, query.packageId);
    return {
      walletAddress,
      activeAvatarObjectId: state.activeAvatarObjectId,
      activeManifestBlobId: state.activeManifestBlobId,
      avatars: state.avatars,
    };
  } catch (error) {
    return reply.code(500).send({
      error: error instanceof Error ? error.message : "Owned-avatar lookup failed.",
    });
  }
});

app.get("/unity/profile/:wallet", async (request, reply) => {
  const params = request.params as { wallet: string };
  const query = request.query as {
    avatarObjectId?: string;
    manifestBlobId?: string;
    packageId?: string;
  };
  const walletAddress = params.wallet;

  try {
    const state = await buildVerifiedOwnedAvatarState(walletAddress, query.packageId);
    const requestedSelection = Boolean(query.avatarObjectId || query.manifestBlobId);
    const selected =
      state.avatars.find((avatar) => avatar.objectId === query.avatarObjectId) ??
      state.avatars.find((avatar) => avatar.manifestBlobId === query.manifestBlobId) ??
      (!requestedSelection ? state.avatars[0] : undefined);

    if (requestedSelection && !selected) {
      return reply.code(404).send({
        error: "Requested avatar is not currently owned by this wallet.",
      });
    }

    if (!selected) {
      return reply.code(404).send({
        error: "No currently owned published avatar was found for this wallet.",
      });
    }

    return buildUnityProfilePayload({
      sql,
      walletAddress,
      avatar: selected,
      request,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unity profile lookup failed.";
    const statusCode = message.includes("package id") ? 400 : 500;
    return reply.code(statusCode).send({ error: message });
  }
});

app.get("/shooter/stats/:wallet", async (request, reply) => {
  const params = request.params as { wallet: string };
  const query = request.query as { packageId?: string };

  try {
    const state = await buildVerifiedOwnedAvatarState(params.wallet, query.packageId);
    return {
      walletAddress: params.wallet,
      multiplayer: getMultiplayerCapacity(),
      avatars: state.avatars.map((avatar) => ({
        avatarObjectId: avatar.objectId,
        walletAddress: params.wallet,
        stats: avatar.shooterStats,
        updatedAt: avatar.updatedAt,
      })),
    };
  } catch (error) {
    return reply.code(500).send({
      error: error instanceof Error ? error.message : "Shooter stats lookup failed.",
    });
  }
});

app.post("/shooter/match/local", async (request, reply) => {
  try {
    const session = await requireWalletSession(sql, request, reply);
    if (!session) {
      return;
    }

    const body = shooterLocalMatchResultSchema.parse(request.body);
    if (body.walletAddress && body.walletAddress !== session.walletAddress) {
      return reply.code(403).send({
        error: "Match result wallet does not match the authenticated wallet session.",
      });
    }

    const ownershipVerified = await verifyAvatarOwnership(
      session.walletAddress,
      body.avatarObjectId,
    );
    if (!ownershipVerified) {
      return reply.code(403).send({
        error: "Avatar object is not currently owned by the authenticated wallet on Sui.",
      });
    }

    const hp =
      typeof body.hp === "number" ? body.hp : apiConfig.SHOOTER_DEFAULT_HP;

    if (sql) {
      const stats = await upsertShooterStats({
        database: sql,
        avatarObjectId: body.avatarObjectId,
        walletAddress: session.walletAddress,
        winDelta: body.result === "victory" ? 1 : 0,
        lossDelta: body.result === "defeat" ? 1 : 0,
        hp,
      });

      if (!stats) {
        return reply.code(500).send({
          error: "Failed to persist shooter match result.",
        });
      }

      await sql`
        insert into avatar_shooter_match_results (
          match_id,
          avatar_object_id,
          wallet_address,
          result,
          hp
        )
        values (
          ${body.matchId ?? randomUUID()},
          ${stats.avatarObjectId},
          ${stats.walletAddress},
          ${body.result},
          ${stats.stats.hp}
        )
      `;

      await syncManifestCacheShooterStats(
        sql,
        stats.avatarObjectId,
        stats.stats,
      );

      return {
        ok: true,
        persistence: "database",
        avatarObjectId: stats.avatarObjectId,
        walletAddress: stats.walletAddress,
        result: body.result,
        stats: stats.stats,
        updatedAt: stats.updatedAt,
      };
    }

    const stats = await recordLocalShooterMatchResult({
      avatarObjectId: body.avatarObjectId,
      walletAddress: session.walletAddress,
      result: body.result as ShooterLocalMatchResult,
      hp,
      matchId: body.matchId,
    });

    return {
      ok: true,
      persistence: "local-file",
      avatarObjectId: stats.avatarObjectId,
      walletAddress: stats.walletAddress,
      result: body.result,
      stats: stats.stats,
      updatedAt: stats.updatedAt,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Local shooter match result failed.";
    return reply.code(400).send({ error: message });
  }
});

app.post("/shooter/match", async (request, reply) => {
  const database = requireDatabase(reply);
  if (!database) {
    return;
  }

  try {
    const body = shooterMatchReportSchema.parse(request.body);
    const winnerWalletAddress = await resolveWalletAddressForAvatar(
      database,
      body.winner.avatarObjectId,
      body.winner.walletAddress,
    );
    const loserWalletAddress = await resolveWalletAddressForAvatar(
      database,
      body.loser.avatarObjectId,
      body.loser.walletAddress,
    );

    if (!winnerWalletAddress || !loserWalletAddress) {
      return reply.code(422).send({
        error:
          "Winner or loser wallet address could not be resolved for shooter match stats update.",
      });
    }

    const winnerHp =
      typeof body.winner.hp === "number" ? body.winner.hp : apiConfig.SHOOTER_DEFAULT_HP;
    const loserHp = typeof body.loser.hp === "number" ? body.loser.hp : 0;

    const winner = await upsertShooterStats({
      database,
      avatarObjectId: body.winner.avatarObjectId,
      walletAddress: winnerWalletAddress,
      winDelta: 1,
      lossDelta: 0,
      hp: winnerHp,
    });
    const loser = await upsertShooterStats({
      database,
      avatarObjectId: body.loser.avatarObjectId,
      walletAddress: loserWalletAddress,
      winDelta: 0,
      lossDelta: 1,
      hp: loserHp,
    });

    if (!winner || !loser) {
      return reply.code(500).send({
        error: "Failed to persist shooter match result.",
      });
    }

    await database`
      insert into avatar_shooter_matches (
        match_id,
        winner_avatar_object_id,
        loser_avatar_object_id,
        winner_wallet_address,
        loser_wallet_address,
        winner_hp,
        loser_hp
      )
      values (
        ${body.matchId ?? randomUUID()},
        ${winner.avatarObjectId},
        ${loser.avatarObjectId},
        ${winner.walletAddress},
        ${loser.walletAddress},
        ${winner.stats.hp},
        ${loser.stats.hp}
      )
    `;

    await Promise.all([
      syncManifestCacheShooterStats(database, winner.avatarObjectId, winner.stats),
      syncManifestCacheShooterStats(database, loser.avatarObjectId, loser.stats),
    ]);

    return {
      ok: true,
      multiplayer: getMultiplayerCapacity(),
      winner,
      loser,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Shooter match report failed.";
    return reply.code(400).send({ error: message });
  }
});

app.get("/manifest/:blobId", async (request, reply) => {
  const params = request.params as { blobId: string };
  const manifestRows = sql
    ? await sql`
        select manifest_json
        from avatar_manifests
        where manifest_blob_id = ${params.blobId}
        limit 1
      `
    : [];

  if (manifestRows.length > 0) {
    return reply.type(READY_AVATAR_MANIFEST_MIME).send((manifestRows[0] as { manifest_json: unknown }).manifest_json);
  }

  const blob = await readBlobFromGateway(sql, params.blobId, READY_AVATAR_MANIFEST_MIME);
  return reply.type(READY_AVATAR_MANIFEST_MIME).send(blob.body);
});

app.get("/asset/:blobId", async (request, reply) => {
  const params = request.params as { blobId: string };
  const contentType = await resolveBlobContentType(sql, params.blobId);
  const blob = await readBlobFromGateway(sql, params.blobId, contentType);

  return reply
    .header("Cache-Control", "public, max-age=300, stale-while-revalidate=86400")
    .type(blob.contentType)
    .send(blob.body);
});

await app.listen({
  host: apiConfig.API_HOST,
  port: apiConfig.API_PORT,
});
