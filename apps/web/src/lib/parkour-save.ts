export type ParkourSaveRecord = {
  avatarKey: string;
  avatarObjectId: string | null;
  manifestBlobId: string | null;
  roomId: string;
  bestTimeMs: number | null;
  lastCheckpointIndex: number;
  totalRuns: number;
  completedRuns: number;
  updatedAt: string;
};

function createAvatarKey(avatarObjectId: string | null, manifestBlobId: string | null) {
  return avatarObjectId ?? manifestBlobId ?? "anonymous-avatar";
}

function storageKey(avatarKey: string, roomId: string) {
  return `rpo:parkour:${avatarKey}:${roomId}`;
}

export function readParkourSave(
  avatarObjectId: string | null,
  manifestBlobId: string | null,
  roomId: string,
) {
  if (typeof window === "undefined") {
    return null;
  }

  const avatarKey = createAvatarKey(avatarObjectId, manifestBlobId);
  const raw = window.localStorage.getItem(storageKey(avatarKey, roomId));
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ParkourSaveRecord> | null;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    return {
      avatarKey,
      avatarObjectId,
      manifestBlobId,
      roomId,
      bestTimeMs:
        typeof parsed.bestTimeMs === "number" && Number.isFinite(parsed.bestTimeMs)
          ? parsed.bestTimeMs
          : null,
      lastCheckpointIndex:
        typeof parsed.lastCheckpointIndex === "number" ? parsed.lastCheckpointIndex : 0,
      totalRuns: typeof parsed.totalRuns === "number" ? parsed.totalRuns : 0,
      completedRuns: typeof parsed.completedRuns === "number" ? parsed.completedRuns : 0,
      updatedAt:
        typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    } satisfies ParkourSaveRecord;
  } catch {
    return null;
  }
}

export function persistParkourSave(record: ParkourSaveRecord) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(
    storageKey(record.avatarKey, record.roomId),
    JSON.stringify(record),
  );
}

export function upsertParkourSave(
  avatarObjectId: string | null,
  manifestBlobId: string | null,
  roomId: string,
  patch: Partial<Omit<ParkourSaveRecord, "avatarKey" | "avatarObjectId" | "manifestBlobId" | "roomId">>,
) {
  const avatarKey = createAvatarKey(avatarObjectId, manifestBlobId);
  const current =
    readParkourSave(avatarObjectId, manifestBlobId, roomId) ??
    ({
      avatarKey,
      avatarObjectId,
      manifestBlobId,
      roomId,
      bestTimeMs: null,
      lastCheckpointIndex: 0,
      totalRuns: 0,
      completedRuns: 0,
      updatedAt: new Date().toISOString(),
    } satisfies ParkourSaveRecord);

  const next: ParkourSaveRecord = {
    ...current,
    ...patch,
    avatarKey,
    avatarObjectId,
    manifestBlobId,
    roomId,
    updatedAt: new Date().toISOString(),
  };
  persistParkourSave(next);
  return next;
}
