import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type LocalWalletSessionEntry = {
  tokenHash: string;
  walletAddress: string;
  createdAt: string;
  expiresAt: string;
};

export type LocalManifestRecordEntry = {
  manifestBlobId: string;
  walletAddress: string;
  avatarBlobId: string;
  avatarBlobObjectId: string;
  previewBlobId: string;
  previewBlobObjectId: string;
  manifestBlobObjectId: string;
  avatarObjectId: string;
  transactionDigest: string | null;
  manifestJson: unknown;
  epochs: number;
  validationStatus: string;
  validationErrors: string[];
  runtimeReady: boolean;
  createdAt: string;
  updatedAt: string;
};

type LocalApiStore = {
  sessions: Record<string, LocalWalletSessionEntry>;
  manifests: Record<string, LocalManifestRecordEntry>;
};

const localStorePath = fileURLToPath(
  new URL("../.data/api-local-store.json", import.meta.url),
);

let writeQueue = Promise.resolve();

function defaultStore(): LocalApiStore {
  return {
    sessions: {},
    manifests: {},
  };
}

function normalizeSessionEntry(
  tokenHash: string,
  value: Partial<LocalWalletSessionEntry> | null | undefined,
): LocalWalletSessionEntry | null {
  if (
    !value ||
    typeof value.walletAddress !== "string" ||
    value.walletAddress.length === 0 ||
    typeof value.expiresAt !== "string" ||
    value.expiresAt.length === 0
  ) {
    return null;
  }

  return {
    tokenHash,
    walletAddress: value.walletAddress,
    createdAt:
      typeof value.createdAt === "string" && value.createdAt.length > 0
        ? value.createdAt
        : new Date(0).toISOString(),
    expiresAt: value.expiresAt,
  };
}

function normalizeManifestEntry(
  manifestBlobId: string,
  value: Partial<LocalManifestRecordEntry> | null | undefined,
): LocalManifestRecordEntry | null {
  if (
    !value ||
    typeof value.walletAddress !== "string" ||
    value.walletAddress.length === 0 ||
    typeof value.avatarBlobId !== "string" ||
    value.avatarBlobId.length === 0 ||
    typeof value.previewBlobId !== "string" ||
    value.previewBlobId.length === 0 ||
    typeof value.avatarObjectId !== "string" ||
    value.avatarObjectId.length === 0
  ) {
    return null;
  }

  return {
    manifestBlobId,
    walletAddress: value.walletAddress,
    avatarBlobId: value.avatarBlobId,
    avatarBlobObjectId:
      typeof value.avatarBlobObjectId === "string" ? value.avatarBlobObjectId : "",
    previewBlobId: value.previewBlobId,
    previewBlobObjectId:
      typeof value.previewBlobObjectId === "string" ? value.previewBlobObjectId : "",
    manifestBlobObjectId:
      typeof value.manifestBlobObjectId === "string" ? value.manifestBlobObjectId : "",
    avatarObjectId: value.avatarObjectId,
    transactionDigest:
      typeof value.transactionDigest === "string" && value.transactionDigest.length > 0
        ? value.transactionDigest
        : null,
    manifestJson: value.manifestJson ?? {},
    epochs:
      typeof value.epochs === "number" && Number.isFinite(value.epochs) && value.epochs > 0
        ? Math.floor(value.epochs)
        : 0,
    validationStatus:
      typeof value.validationStatus === "string" && value.validationStatus.length > 0
        ? value.validationStatus
        : "stored",
    validationErrors: Array.isArray(value.validationErrors)
      ? value.validationErrors.filter((item): item is string => typeof item === "string")
      : [],
    runtimeReady: Boolean(value.runtimeReady),
    createdAt:
      typeof value.createdAt === "string" && value.createdAt.length > 0
        ? value.createdAt
        : new Date(0).toISOString(),
    updatedAt:
      typeof value.updatedAt === "string" && value.updatedAt.length > 0
        ? value.updatedAt
        : new Date(0).toISOString(),
  };
}

function normalizeStore(value: unknown): LocalApiStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaultStore();
  }

  const raw = value as {
    sessions?: Record<string, Partial<LocalWalletSessionEntry>>;
    manifests?: Record<string, Partial<LocalManifestRecordEntry>>;
  };

  const sessions = Object.fromEntries(
    Object.entries(raw.sessions ?? {})
      .map(([tokenHash, entry]) => [tokenHash, normalizeSessionEntry(tokenHash, entry)])
      .filter((entry): entry is [string, LocalWalletSessionEntry] => Boolean(entry[1])),
  );
  const manifests = Object.fromEntries(
    Object.entries(raw.manifests ?? {})
      .map(([manifestBlobId, entry]) => [
        manifestBlobId,
        normalizeManifestEntry(manifestBlobId, entry),
      ])
      .filter((entry): entry is [string, LocalManifestRecordEntry] => Boolean(entry[1])),
  );

  return {
    sessions,
    manifests,
  };
}

async function ensureStoreDirectory() {
  await fs.mkdir(path.dirname(localStorePath), { recursive: true });
}

async function readStore() {
  try {
    const raw = await fs.readFile(localStorePath, "utf8");
    return normalizeStore(JSON.parse(raw));
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code === "ENOENT") {
      return defaultStore();
    }
    throw error;
  }
}

async function writeStore(store: LocalApiStore) {
  await ensureStoreDirectory();
  await fs.writeFile(localStorePath, JSON.stringify(store, null, 2), "utf8");
}

async function enqueueWrite<T>(callback: () => Promise<T>) {
  const next = writeQueue.then(callback, callback);
  writeQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export async function upsertLocalWalletSession(args: {
  tokenHash: string;
  walletAddress: string;
  expiresAt: string;
}) {
  return enqueueWrite(async () => {
    const store = await readStore();
    const now = new Date().toISOString();
    store.sessions[args.tokenHash] = {
      tokenHash: args.tokenHash,
      walletAddress: args.walletAddress,
      createdAt: store.sessions[args.tokenHash]?.createdAt ?? now,
      expiresAt: args.expiresAt,
    };
    await writeStore(store);
  });
}

export async function getLocalWalletSessionByTokenHash(tokenHash: string) {
  const store = await readStore();
  return store.sessions[tokenHash] ?? null;
}

export async function upsertLocalManifestRecord(
  entry: Omit<LocalManifestRecordEntry, "createdAt" | "updatedAt">,
) {
  return enqueueWrite(async () => {
    const store = await readStore();
    const now = new Date().toISOString();
    const current = store.manifests[entry.manifestBlobId];
    const next: LocalManifestRecordEntry = {
      ...entry,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    store.manifests[entry.manifestBlobId] = next;
    await writeStore(store);
    return next;
  });
}

export async function getLocalManifestsByWallet(walletAddress: string) {
  const store = await readStore();
  return Object.values(store.manifests)
    .filter((entry) => entry.walletAddress === walletAddress)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function getLocalManifestByAvatarObjectId(avatarObjectId: string) {
  const store = await readStore();
  return (
    Object.values(store.manifests)
      .filter((entry) => entry.avatarObjectId === avatarObjectId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null
  );
}
