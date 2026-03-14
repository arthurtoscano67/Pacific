export const LAST_PUBLISHED_AVATAR_KEY = "rpo:lastPublishedAvatar";
export const LAST_PUBLISHED_AVATAR_EVENT = "rpo:lastPublishedAvatar:updated";

export type PublishedAvatarRecord = {
  avatarBlobId: string;
  sourceAssetBlobId?: string | null;
  previewBlobId: string;
  manifestBlobId: string;
  avatarObjectId: string;
  txDigest: string | null;
  publishedAt: string;
};

function isPublishedAvatarRecord(value: unknown): value is PublishedAvatarRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const payload = value as Record<string, unknown>;
  return (
    typeof payload.avatarBlobId === "string" &&
    payload.avatarBlobId.length > 0 &&
    (typeof payload.sourceAssetBlobId === "string" ||
      payload.sourceAssetBlobId === null ||
      typeof payload.sourceAssetBlobId === "undefined") &&
    typeof payload.previewBlobId === "string" &&
    payload.previewBlobId.length > 0 &&
    typeof payload.manifestBlobId === "string" &&
    payload.manifestBlobId.length > 0 &&
    typeof payload.avatarObjectId === "string" &&
    payload.avatarObjectId.length > 0 &&
    (typeof payload.txDigest === "string" || payload.txDigest === null) &&
    typeof payload.publishedAt === "string" &&
    payload.publishedAt.length > 0
  );
}

export function readLastPublishedAvatar() {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(LAST_PUBLISHED_AVATAR_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return isPublishedAvatarRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function persistLastPublishedAvatar(record: PublishedAvatarRecord) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(LAST_PUBLISHED_AVATAR_KEY, JSON.stringify(record));
  window.dispatchEvent(new Event(LAST_PUBLISHED_AVATAR_EVENT));
}
