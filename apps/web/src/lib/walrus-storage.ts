import {
  READY_AVATAR_MAX_EPOCHS,
  type WalrusAvatarStorage,
  type WalrusBlobStorage,
} from "@pacific/shared";

export type WalrusNetworkClock = {
  currentEpoch: number;
  epochDurationMs: number;
  firstEpochStartMs: number;
};

export type WalrusRetentionStatus = {
  protectionLabel: string;
  shortLabel: string;
  detail: string;
  expiresAt: string | null;
  daysLeft: number | null;
  monthsLeft: number | null;
  renewRecommended: boolean;
  expired: boolean;
};

const dayMs = 24 * 60 * 60 * 1000;

type WalrusClientLike = {
  walrus: {
    stakingState(): Promise<{
      epoch: number;
      epoch_duration: string;
      first_epoch_start: string;
    }>;
  };
};

function finiteEpoch(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function normalizeAsset(asset: WalrusBlobStorage | null | undefined) {
  if (!asset) {
    return null;
  }

  return {
    blobId: asset.blobId,
    blobObjectId: asset.blobObjectId,
    startEpoch: finiteEpoch(asset.startEpoch ?? null),
    endEpoch: finiteEpoch(asset.endEpoch ?? null),
    deletable: typeof asset.deletable === "boolean" ? asset.deletable : null,
  } satisfies WalrusBlobStorage;
}

export function summarizeWalrusStorage(
  storage: WalrusAvatarStorage | null | undefined,
): WalrusAvatarStorage | null {
  if (!storage) {
    return null;
  }

  const runtimeAvatar = normalizeAsset(storage.runtimeAvatar);
  const preview = normalizeAsset(storage.preview);
  const manifest = normalizeAsset(storage.manifest);
  const sourceAsset = normalizeAsset(storage.sourceAsset ?? null);
  const assets = [runtimeAvatar, preview, manifest, sourceAsset].filter(
    (asset): asset is NonNullable<typeof asset> => asset !== null,
  );

  if (assets.length === 0) {
    return null;
  }

  const endEpochs = assets
    .map((asset) => finiteEpoch(asset.endEpoch ?? null))
    .filter((epoch): epoch is number => typeof epoch === "number");

  return {
    runtimeAvatar,
    preview,
    manifest,
    sourceAsset,
    minimumEndEpoch: endEpochs.length > 0 ? Math.min(...endEpochs) : null,
    maximumEndEpoch: endEpochs.length > 0 ? Math.max(...endEpochs) : null,
  };
}

export function collectWalrusAssets(storage: WalrusAvatarStorage | null | undefined) {
  const summary = summarizeWalrusStorage(storage);
  if (!summary) {
    return [];
  }

  const seen = new Set<string>();
  return [summary.runtimeAvatar, summary.preview, summary.manifest, summary.sourceAsset ?? null]
    .filter((asset): asset is NonNullable<typeof asset> => asset !== null)
    .filter((asset) => {
      if (seen.has(asset.blobObjectId)) {
        return false;
      }

      seen.add(asset.blobObjectId);
      return true;
    });
}

export async function fetchWalrusNetworkClock(client: WalrusClientLike): Promise<WalrusNetworkClock> {
  const state = await client.walrus.stakingState();
  const epochDurationMs = Number(state.epoch_duration);
  const firstEpochStartMs = Number(state.first_epoch_start);

  return {
    currentEpoch: Math.floor(state.epoch),
    epochDurationMs:
      Number.isFinite(epochDurationMs) && epochDurationMs > 0 ? epochDurationMs : 0,
    firstEpochStartMs:
      Number.isFinite(firstEpochStartMs) && firstEpochStartMs > 0 ? firstEpochStartMs : 0,
  };
}

export function getWalrusExpiryDate(
  clock: WalrusNetworkClock | null | undefined,
  endEpoch: number | null | undefined,
) {
  const normalizedEndEpoch = finiteEpoch(endEpoch ?? null);
  if (!clock || !normalizedEndEpoch || !clock.epochDurationMs || !clock.firstEpochStartMs) {
    return null;
  }

  const timestamp = clock.firstEpochStartMs + normalizedEndEpoch * clock.epochDurationMs;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function describeWalrusRetention(
  storage: WalrusAvatarStorage | null | undefined,
  clock: WalrusNetworkClock | null | undefined,
): WalrusRetentionStatus {
  const summary = summarizeWalrusStorage(storage);
  const assets = collectWalrusAssets(summary);
  const allNonDeletable =
    assets.length > 0 && assets.every((asset) => asset.deletable === false);
  const protectionLabel = allNonDeletable ? "Non-deletable" : "Renewable";
  const endEpoch = summary?.minimumEndEpoch ?? null;
  const expiryDate = getWalrusExpiryDate(clock, endEpoch);

  if (!summary || !expiryDate) {
    return {
      protectionLabel,
      shortLabel: `Up to ${READY_AVATAR_MAX_EPOCHS} Walrus epochs`,
      detail:
        "Walrus keeps the character files for a fixed term, not forever. This build uses the max term and supports renewal before expiry.",
      expiresAt: null,
      daysLeft: null,
      monthsLeft: null,
      renewRecommended: false,
      expired: false,
    };
  }

  const remainingMs = expiryDate.getTime() - Date.now();
  const expired = remainingMs <= 0;
  const daysLeft = expired ? 0 : Math.ceil(remainingMs / dayMs);
  const monthsLeft = expired ? 0 : Math.ceil(daysLeft / 30);
  const shortLabel =
    daysLeft > 60 ? `${monthsLeft} month${monthsLeft === 1 ? "" : "s"} left` : `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`;
  const detail = expired
    ? `Walrus storage expired on ${expiryDate.toLocaleString()}. Renew the NFT assets to keep the operator playable.`
    : `Protected until ${expiryDate.toLocaleString()} (${shortLabel}). Renew before that date to keep this NFT operator playable.`;

  return {
    protectionLabel,
    shortLabel,
    detail,
    expiresAt: expiryDate.toISOString(),
    daysLeft,
    monthsLeft,
    renewRecommended: daysLeft <= 120,
    expired,
  };
}

export function extendWalrusStorageWindow(
  storage: WalrusAvatarStorage,
  epochs: number = READY_AVATAR_MAX_EPOCHS,
) {
  const summary = summarizeWalrusStorage(storage);
  if (!summary) {
    return null;
  }

  const extendAsset = (asset: WalrusBlobStorage | null) => {
    if (!asset) {
      return null;
    }

    const nextEndEpoch = finiteEpoch(asset.endEpoch ?? null);
    return {
      ...asset,
      endEpoch: nextEndEpoch ? nextEndEpoch + epochs : null,
      deletable: asset.deletable ?? false,
    } satisfies WalrusBlobStorage;
  };

  return summarizeWalrusStorage({
    runtimeAvatar: extendAsset(summary.runtimeAvatar),
    preview: extendAsset(summary.preview),
    manifest: extendAsset(summary.manifest),
    sourceAsset: extendAsset(summary.sourceAsset ?? null),
    minimumEndEpoch: summary.minimumEndEpoch,
    maximumEndEpoch: summary.maximumEndEpoch,
  });
}
