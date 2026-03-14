import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ShooterStats } from "@pacific/shared";
import { apiConfig } from "./config.js";

export type ShooterLocalMatchResult = "victory" | "defeat" | "draw";

type LocalShooterStatsEntry = {
  avatarObjectId: string;
  walletAddress: string;
  wins: number;
  losses: number;
  hp: number;
  updatedAt: string;
};

type LocalShooterMatchEntry = {
  matchId: string;
  avatarObjectId: string;
  walletAddress: string;
  result: ShooterLocalMatchResult;
  hp: number;
  createdAt: string;
};

type LocalShooterStore = {
  stats: Record<string, LocalShooterStatsEntry>;
  matchResults: LocalShooterMatchEntry[];
};

const localStorePath = fileURLToPath(
  new URL("../.data/shooter-local-store.json", import.meta.url),
);

let writeQueue = Promise.resolve();

function defaultStore(): LocalShooterStore {
  return {
    stats: {},
    matchResults: [],
  };
}

function normalizeStatsEntry(
  avatarObjectId: string,
  value: Partial<LocalShooterStatsEntry> | null | undefined,
): LocalShooterStatsEntry | null {
  if (!value || typeof value.walletAddress !== "string" || value.walletAddress.length === 0) {
    return null;
  }

  return {
    avatarObjectId,
    walletAddress: value.walletAddress,
    wins:
      typeof value.wins === "number" && Number.isFinite(value.wins) && value.wins >= 0
        ? Math.floor(value.wins)
        : 0,
    losses:
      typeof value.losses === "number" && Number.isFinite(value.losses) && value.losses >= 0
        ? Math.floor(value.losses)
        : 0,
    hp:
      typeof value.hp === "number" && Number.isFinite(value.hp) && value.hp >= 0
        ? Math.floor(value.hp)
        : apiConfig.SHOOTER_DEFAULT_HP,
    updatedAt:
      typeof value.updatedAt === "string" && value.updatedAt.length > 0
        ? value.updatedAt
        : new Date(0).toISOString(),
  };
}

function normalizeStore(value: unknown): LocalShooterStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaultStore();
  }

  const raw = value as {
    stats?: Record<string, Partial<LocalShooterStatsEntry>>;
    matchResults?: Array<Partial<LocalShooterMatchEntry>>;
  };

  const stats = Object.fromEntries(
    Object.entries(raw.stats ?? {})
      .map(([avatarObjectId, entry]) => [avatarObjectId, normalizeStatsEntry(avatarObjectId, entry)])
      .filter((entry): entry is [string, LocalShooterStatsEntry] => Boolean(entry[1])),
  );

  const matchResults = Array.isArray(raw.matchResults)
    ? raw.matchResults
        .filter(
          (entry): entry is Partial<LocalShooterMatchEntry> =>
            Boolean(
              entry &&
                typeof entry.matchId === "string" &&
                typeof entry.avatarObjectId === "string" &&
                typeof entry.walletAddress === "string" &&
                (entry.result === "victory" ||
                  entry.result === "defeat" ||
                  entry.result === "draw"),
            ),
        )
        .map((entry) => ({
          matchId: entry.matchId as string,
          avatarObjectId: entry.avatarObjectId as string,
          walletAddress: entry.walletAddress as string,
          result: entry.result as ShooterLocalMatchResult,
          hp:
            typeof entry.hp === "number" && Number.isFinite(entry.hp) && entry.hp >= 0
              ? Math.floor(entry.hp)
              : apiConfig.SHOOTER_DEFAULT_HP,
          createdAt:
            typeof entry.createdAt === "string" && entry.createdAt.length > 0
              ? entry.createdAt
              : new Date(0).toISOString(),
        }))
    : [];

  return {
    stats,
    matchResults,
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

async function writeStore(store: LocalShooterStore) {
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

export async function getLocalShooterStatsByWallet(walletAddress: string) {
  const store = await readStore();
  return Object.values(store.stats)
    .filter((entry) => entry.walletAddress === walletAddress)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((entry) => ({
      avatarObjectId: entry.avatarObjectId,
      walletAddress: entry.walletAddress,
      stats: {
        wins: entry.wins,
        losses: entry.losses,
        hp: entry.hp,
      } satisfies ShooterStats,
      updatedAt: entry.updatedAt,
    }));
}

export async function getLocalShooterStatsForAvatar(avatarObjectId: string) {
  const store = await readStore();
  const entry = store.stats[avatarObjectId];
  if (!entry) {
    return null;
  }

  return {
    avatarObjectId: entry.avatarObjectId,
    walletAddress: entry.walletAddress,
    stats: {
      wins: entry.wins,
      losses: entry.losses,
      hp: entry.hp,
    } satisfies ShooterStats,
    updatedAt: entry.updatedAt,
  };
}

export async function recordLocalShooterMatchResult(args: {
  avatarObjectId: string;
  walletAddress: string;
  result: ShooterLocalMatchResult;
  hp?: number;
  matchId?: string | null;
}) {
  return enqueueWrite(async () => {
    const store = await readStore();
    const current = store.stats[args.avatarObjectId];
    const now = new Date().toISOString();
    const hp =
      typeof args.hp === "number" && Number.isFinite(args.hp) && args.hp >= 0
        ? Math.floor(args.hp)
        : apiConfig.SHOOTER_DEFAULT_HP;

    const next: LocalShooterStatsEntry = {
      avatarObjectId: args.avatarObjectId,
      walletAddress: args.walletAddress,
      wins:
        (current?.wins ?? 0) + (args.result === "victory" ? 1 : 0),
      losses:
        (current?.losses ?? 0) + (args.result === "defeat" ? 1 : 0),
      hp,
      updatedAt: now,
    };

    store.stats[args.avatarObjectId] = next;
    store.matchResults.unshift({
      matchId: args.matchId?.trim() || `${args.avatarObjectId}:${now}`,
      avatarObjectId: args.avatarObjectId,
      walletAddress: args.walletAddress,
      result: args.result,
      hp,
      createdAt: now,
    });
    store.matchResults = store.matchResults.slice(0, 512);

    await writeStore(store);

    return {
      avatarObjectId: next.avatarObjectId,
      walletAddress: next.walletAddress,
      stats: {
        wins: next.wins,
        losses: next.losses,
        hp: next.hp,
      } satisfies ShooterStats,
      updatedAt: next.updatedAt,
    };
  });
}

export async function seedLocalShooterStats(args: {
  avatarObjectId: string;
  walletAddress: string;
  stats: ShooterStats;
}) {
  return enqueueWrite(async () => {
    const store = await readStore();
    const current = store.stats[args.avatarObjectId];
    const now = new Date().toISOString();
    const next: LocalShooterStatsEntry = {
      avatarObjectId: args.avatarObjectId,
      walletAddress: args.walletAddress,
      wins: Math.max(current?.wins ?? 0, Math.max(0, Math.floor(args.stats.wins))),
      losses: Math.max(current?.losses ?? 0, Math.max(0, Math.floor(args.stats.losses))),
      hp: Math.max(0, Math.floor(args.stats.hp)),
      updatedAt: now,
    };

    store.stats[args.avatarObjectId] = next;
    await writeStore(store);

    return {
      avatarObjectId: next.avatarObjectId,
      walletAddress: next.walletAddress,
      stats: {
        wins: next.wins,
        losses: next.losses,
        hp: next.hp,
      } satisfies ShooterStats,
      updatedAt: next.updatedAt,
    };
  });
}
