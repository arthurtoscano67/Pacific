export const WORLD_ENTRY_KEY = "rpo:worldEntry";

export type WorldEntry = {
  source: "onchain" | "fallback";
  avatarObjectId: string | null;
  name: string | null;
  manifestBlobId: string | null;
  modelUrl: string | null;
  txDigest: string | null;
  selectedAt: string;
};

export function persistWorldEntry(
  entry: Omit<WorldEntry, "selectedAt">,
) {
  if (typeof window === "undefined") {
    return;
  }

  const payload: WorldEntry = {
    ...entry,
    selectedAt: new Date().toISOString(),
  };
  window.localStorage.setItem(WORLD_ENTRY_KEY, JSON.stringify(payload));
}

export function readWorldEntry() {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(WORLD_ENTRY_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const value = parsed as Record<string, unknown>;
    if (value.source !== "onchain" && value.source !== "fallback") {
      return null;
    }

    return {
      source: value.source,
      avatarObjectId:
        typeof value.avatarObjectId === "string" ? value.avatarObjectId : null,
      name: typeof value.name === "string" ? value.name : null,
      manifestBlobId:
        typeof value.manifestBlobId === "string" ? value.manifestBlobId : null,
      modelUrl: typeof value.modelUrl === "string" ? value.modelUrl : null,
      txDigest: typeof value.txDigest === "string" ? value.txDigest : null,
      selectedAt:
        typeof value.selectedAt === "string" ? value.selectedAt : new Date().toISOString(),
    } satisfies WorldEntry;
  } catch {
    return null;
  }
}
