import { useCallback, useEffect, useMemo, useState } from "react";
import { useCurrentAccount, useCurrentClient, useDAppKit } from "@mysten/dapp-kit-react";
import { ConnectButton } from "@mysten/dapp-kit-react/ui";
import {
  type ShooterCharacter,
  type ShooterStats,
  type WalrusAvatarStorage,
} from "@pacific/shared";
import { SiteTabs } from "../components/SiteTabs";
import { webEnv } from "../env";
import {
  fetchOwnedAvatarsFromBackend,
  type BackendOwnedAvatar,
} from "../lib/backend-avatar";
import { queryOwnedOnChainAvatars } from "../lib/on-chain-avatar";
import { blobIdFromWalrusReference, loadManifestFromWalrus } from "../lib/play-world";
import { ensureWalletSession, type WalletSession } from "../lib/session";

type UnityLoadStatus = "idle" | "searching" | "ready" | "error";
type UnityHandoffMode = "api" | "local-blob";
type UnityBuildState = "idle" | "checking" | "valid" | "invalid";
type WalletSessionState = "idle" | "verifying" | "ready" | "error";

type MultiplayerCapacity = {
  maxPlayers: number;
  maxConcurrentMatches: number;
  tickRate: number;
};

type UnityAvatarOption = {
  source: "backend" | "onchain";
  objectId: string;
  name: string | null;
  manifestBlobId: string | null;
  previewBlobId: string | null;
  modelUrl: string | null;
  runtimeAvatarBlobId: string | null;
  txDigest: string | null;
  status: string | null;
  runtimeReady: boolean;
  updatedAt: string | null;
  isActive: boolean;
  shooterStats: ShooterStats;
  shooterCharacter: ShooterCharacter | null;
  walrusStorage: WalrusAvatarStorage | null;
};

const photonRealtimeAppIdStorageKey = "pacific:photonRealtimeAppId";
const photonFixedRegionStorageKey = "pacific:photonFixedRegion";

const defaultShooterStats: ShooterStats = {
  wins: 0,
  losses: 0,
  hp: 100,
};

const defaultMultiplayerCapacity: MultiplayerCapacity = {
  maxPlayers: 64,
  maxConcurrentMatches: 512,
  tickRate: 30,
};

function pickDefaultAvatar(avatars: UnityAvatarOption[]) {
  return (
    avatars.find(
      (avatar) =>
        avatar.isActive &&
        (avatar.runtimeReady || avatar.status === "playable") &&
        Boolean(avatar.shooterCharacter),
    ) ??
    avatars.find(
      (avatar) =>
        (avatar.runtimeReady || avatar.status === "playable") &&
        Boolean(avatar.shooterCharacter),
    ) ??
    avatars.find((avatar) => Boolean(avatar.shooterCharacter)) ??
    null
  );
}

function normalizeShooterStats(value: unknown): ShooterStats {
  if (!value || typeof value !== "object") {
    return defaultShooterStats;
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

function normalizeMultiplayerCapacity(value: unknown): MultiplayerCapacity {
  if (!value || typeof value !== "object") {
    return defaultMultiplayerCapacity;
  }

  const payload = value as Record<string, unknown>;
  const maxPlayers = Number(payload.maxPlayers);
  const maxConcurrentMatches = Number(payload.maxConcurrentMatches);
  const tickRate = Number(payload.tickRate);
  return {
    maxPlayers:
      Number.isFinite(maxPlayers) && maxPlayers > 0
        ? Math.floor(maxPlayers)
        : defaultMultiplayerCapacity.maxPlayers,
    maxConcurrentMatches:
      Number.isFinite(maxConcurrentMatches) && maxConcurrentMatches > 0
        ? Math.floor(maxConcurrentMatches)
        : defaultMultiplayerCapacity.maxConcurrentMatches,
    tickRate:
      Number.isFinite(tickRate) && tickRate > 0
        ? Math.floor(tickRate)
        : defaultMultiplayerCapacity.tickRate,
  };
}

function appendQuery(url: string, key: string, value: string) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}

function readStoredValue(key: string) {
  if (typeof window === "undefined") {
    return "";
  }

  const value = window.localStorage.getItem(key);
  return typeof value === "string" ? value.trim() : "";
}

function normalizeShooterCharacter(value: unknown): ShooterCharacter | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const payload = value as Record<string, unknown>;
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
  };
}

function looksLikeUnityWebglIndex(html: string) {
  const normalized = html.toLowerCase();
  const hasUnityMarker =
    normalized.includes("createunityinstance") ||
    normalized.includes("unity-canvas") ||
    normalized.includes(".loader.js") ||
    normalized.includes("unityprogress") ||
    normalized.includes("unityloader");
  if (hasUnityMarker) {
    return true;
  }

  if (normalized.includes('id="root"')) {
    return false;
  }

  return false;
}

function toAvatarOptionFromBackend(avatar: BackendOwnedAvatar): UnityAvatarOption {
  return {
    source: "backend",
    objectId: avatar.objectId,
    name: avatar.name,
    manifestBlobId: avatar.manifestBlobId,
    previewBlobId: null,
    modelUrl: avatar.modelUrl,
    runtimeAvatarBlobId: avatar.runtimeAvatarBlobId,
    txDigest: avatar.txDigest,
    status: avatar.status,
    runtimeReady: avatar.runtimeReady,
    updatedAt: avatar.updatedAt,
    isActive: avatar.isActive,
    shooterStats: avatar.shooterStats ?? defaultShooterStats,
    shooterCharacter: avatar.shooterCharacter,
    walrusStorage: avatar.walrusStorage,
  };
}

export function UnityPage() {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const dAppKit = useDAppKit();
  const pagePath = useMemo(() => window.location.pathname.replace(/\/+$/, "") || "/unity", []);
  const isRuntimeScreen = pagePath === "/play" || pagePath === "/world";
  const requestedFullscreen = useMemo(
    () => new URLSearchParams(window.location.search).get("fullscreen") === "1",
    [],
  );
  const preferredAvatarObjectId = useMemo(
    () => new URLSearchParams(window.location.search).get("avatarObjectId"),
    [],
  );
  const preferredManifestBlobId = useMemo(
    () => new URLSearchParams(window.location.search).get("manifestBlobId"),
    [],
  );
  const [status, setStatus] = useState<UnityLoadStatus>("idle");
  const [statusDetail, setStatusDetail] = useState(
    "Connect wallet to load your shooter operator.",
  );
  const [error, setError] = useState<string | null>(null);
  const [avatars, setAvatars] = useState<UnityAvatarOption[]>([]);
  const [selectedAvatar, setSelectedAvatar] = useState<UnityAvatarOption | null>(null);
  const [handoffMode, setHandoffMode] = useState<UnityHandoffMode>("api");
  const [localProfileUrl, setLocalProfileUrl] = useState<string | null>(null);
  const [localPreviewUrl, setLocalPreviewUrl] = useState<string | null>(null);
  const [, setLocalRuntimeAssetUrl] = useState<string | null>(null);
  const [unityBuildState, setUnityBuildState] = useState<UnityBuildState>("idle");
  const [unityBuildError, setUnityBuildError] = useState<string | null>(null);
  const [multiplayerCapacity, setMultiplayerCapacity] = useState<MultiplayerCapacity>(
    defaultMultiplayerCapacity,
  );
  const photonRealtimeAppIdOverride = readStoredValue(photonRealtimeAppIdStorageKey);
  const photonFixedRegionOverride =
    readStoredValue(photonFixedRegionStorageKey) || webEnv.photonFixedRegion;
  const [walletSession, setWalletSession] = useState<WalletSession | null>(null);
  const [walletSessionState, setWalletSessionState] = useState<WalletSessionState>("idle");
  const [walletSessionError, setWalletSessionError] = useState<string | null>(null);

  const clearLocalUrls = useCallback(() => {
    setLocalProfileUrl((current) => {
      if (current) {
        URL.revokeObjectURL(current);
      }
      return null;
    });
    setLocalPreviewUrl((current) => {
      if (current) {
        URL.revokeObjectURL(current);
      }
      return null;
    });
    setLocalRuntimeAssetUrl((current) => {
      if (current) {
        URL.revokeObjectURL(current);
      }
      return null;
    });
  }, []);

  const hydrateShooterAvatarOptions = useCallback(
    async (input: UnityAvatarOption[]) => {
      const hydrated = await Promise.all(
        input.map(async (avatar) => {
          if (avatar.shooterCharacter || !avatar.manifestBlobId) {
            return avatar;
          }

          try {
            const manifest = await loadManifestFromWalrus(client, avatar.manifestBlobId);
            return {
              ...avatar,
              name: manifest.name || avatar.name,
              previewBlobId: manifest.preview.blobId || avatar.previewBlobId,
              runtimeAvatarBlobId:
                manifest.runtimeAvatar.blobId || avatar.runtimeAvatarBlobId,
              runtimeReady: avatar.runtimeReady || Boolean(manifest.game?.character),
              status:
                manifest.game?.character && !avatar.status ? "playable" : avatar.status,
              shooterStats: manifest.game?.stats ?? avatar.shooterStats,
              shooterCharacter: manifest.game?.character ?? avatar.shooterCharacter,
            } satisfies UnityAvatarOption;
          } catch {
            return avatar;
          }
        }),
      );

      return hydrated.filter((avatar) => Boolean(avatar.shooterCharacter));
    },
    [client],
  );

  const loadOwnedAvatars = useCallback(async () => {
    const walletAddress = account?.address ?? null;
    if (!walletAddress) {
      clearLocalUrls();
      setStatus("idle");
      setStatusDetail("Connect wallet to load your shooter operator.");
      setError(null);
      setAvatars([]);
      setSelectedAvatar(null);
      setHandoffMode("api");
      setMultiplayerCapacity(defaultMultiplayerCapacity);
      return;
    }

    setStatus("searching");
    setStatusDetail("Loading characters.");
    setError(null);
    clearLocalUrls();

    try {
      const result = await fetchOwnedAvatarsFromBackend(walletAddress, webEnv.avatarPackageId);
      const nextAvatars = await hydrateShooterAvatarOptions(
        result.avatars.map((avatar) => toAvatarOptionFromBackend(avatar)),
      );

      setAvatars(nextAvatars);
      const nextSelected =
        nextAvatars.find((avatar) => avatar.objectId === preferredAvatarObjectId) ??
        nextAvatars.find(
          (avatar) =>
            Boolean(preferredManifestBlobId) &&
            avatar.manifestBlobId === preferredManifestBlobId,
        ) ??
        pickDefaultAvatar(nextAvatars);
      setSelectedAvatar(nextSelected);
      setHandoffMode("api");

      if (!nextSelected) {
        setStatus("idle");
        setStatusDetail("No playable characters were found for this wallet yet.");
        return;
      }

      setStatus("ready");
      setStatusDetail(
        nextAvatars.length > 1
          ? "Characters ready. Select one to play."
          : "Character ready. Press Play Game to open the game screen.",
      );
    } catch (backendError) {
      try {
        const onChain = await queryOwnedOnChainAvatars(client, walletAddress);
        const nextAvatars = await hydrateShooterAvatarOptions(
          onChain.map((avatar) => ({
            source: "onchain" as const,
            objectId: avatar.objectId,
            name: avatar.name,
            manifestBlobId: avatar.manifestBlobId,
            previewBlobId: null,
            modelUrl: avatar.modelUrl,
            runtimeAvatarBlobId: null,
            txDigest: avatar.previousTransaction,
            status: "stored",
            runtimeReady: false,
            updatedAt: null,
            isActive: false,
            shooterStats: avatar.shooterStats,
            shooterCharacter: avatar.shooterCharacter,
            walrusStorage: null,
          })),
        );

        setAvatars(nextAvatars);
        const nextSelected =
          nextAvatars.find((avatar) => avatar.objectId === preferredAvatarObjectId) ??
          nextAvatars.find(
            (avatar) =>
              Boolean(preferredManifestBlobId) &&
              avatar.manifestBlobId === preferredManifestBlobId,
          ) ??
          pickDefaultAvatar(nextAvatars);
        setSelectedAvatar(nextSelected);
        setHandoffMode("local-blob");

        if (!nextSelected) {
          setStatus("idle");
          setStatusDetail(
            `API unavailable at ${webEnv.apiBaseUrl}. No usable on-chain operator was found.`,
          );
          return;
        }

        setStatus("searching");
        setStatusDetail("Loading characters.");
      } catch (chainError) {
        const backendMessage =
          backendError instanceof Error ? backendError.message : "Backend avatar lookup failed.";
        const chainMessage =
          chainError instanceof Error ? chainError.message : "On-chain avatar query failed.";
        const message = `${backendMessage} ${chainMessage} Start API with: npm run dev:api`;
        setStatus("error");
        setStatusDetail(message);
        setError(message);
        setAvatars([]);
        setSelectedAvatar(null);
        setHandoffMode("api");
      }
    }
  }, [
    account?.address,
    clearLocalUrls,
    client,
    hydrateShooterAvatarOptions,
    preferredAvatarObjectId,
    preferredManifestBlobId,
  ]);

  useEffect(() => {
    void loadOwnedAvatars();
  }, [loadOwnedAvatars]);

  useEffect(() => {
    let cancelled = false;

    if (!account?.address) {
      setWalletSession(null);
      setWalletSessionState("idle");
      setWalletSessionError(null);
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      try {
        setWalletSessionState("verifying");
        setWalletSessionError(null);
        const session = await ensureWalletSession(dAppKit, account.address, walletSession);
        if (cancelled) {
          return;
        }

        setWalletSession(session);
        setWalletSessionState("ready");
      } catch (caught) {
        if (cancelled) {
          return;
        }

        setWalletSession(null);
        setWalletSessionState("error");
        setWalletSessionError(
          caught instanceof Error ? caught.message : "Wallet verification session failed.",
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [account?.address, dAppKit, walletSession]);

  useEffect(() => {
    let cancelled = false;

    if (handoffMode !== "local-blob" || !selectedAvatar || !account?.address) {
      clearLocalUrls();
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      try {
        setStatus("searching");
        setStatusDetail("Preparing local profile and runtime handoff.");
        setError(null);

        let resolvedManifestBlobId = selectedAvatar.manifestBlobId;
        let runtimeBlobId = selectedAvatar.runtimeAvatarBlobId;
        let runtimeMime = "model/vrm";
        let previewMime = "image/png";
        let runtimeUrl =
          selectedAvatar.modelUrl && /^https?:/i.test(selectedAvatar.modelUrl)
            ? selectedAvatar.modelUrl
            : null;
        let previewUrl: string | null = null;
        let resolvedName = selectedAvatar.name;
        let resolvedPreviewBlobId = selectedAvatar.previewBlobId;
        let resolvedShooterStats = selectedAvatar.shooterStats ?? defaultShooterStats;
        let resolvedShooterCharacter = selectedAvatar.shooterCharacter;
        let resolvedMultiplayerCapacity = multiplayerCapacity;

        if (!resolvedManifestBlobId && selectedAvatar.modelUrl) {
          resolvedManifestBlobId = blobIdFromWalrusReference(selectedAvatar.modelUrl);
        }

        if (resolvedManifestBlobId) {
          const manifest = await loadManifestFromWalrus(client, resolvedManifestBlobId);
          runtimeBlobId = manifest.runtimeAvatar.blobId;
          runtimeMime = manifest.runtimeAvatar.mime || runtimeMime;
          previewMime = manifest.preview.mime || previewMime;
          resolvedName = manifest.name || resolvedName;
          resolvedPreviewBlobId = manifest.preview.blobId || resolvedPreviewBlobId;
          resolvedShooterStats = manifest.game?.stats ?? resolvedShooterStats;
          resolvedShooterCharacter = manifest.game?.character ?? resolvedShooterCharacter;
          resolvedMultiplayerCapacity = normalizeMultiplayerCapacity(manifest.game?.multiplayer);
        } else if (!runtimeBlobId && selectedAvatar.modelUrl) {
          runtimeBlobId = blobIdFromWalrusReference(selectedAvatar.modelUrl);
        }

        if (!runtimeUrl && runtimeBlobId) {
          const bytes = await client.walrus.readBlob({ blobId: runtimeBlobId });
          runtimeUrl = URL.createObjectURL(
            new Blob([new Uint8Array(bytes)], {
              type: runtimeMime,
            }),
          );
        }

        if (resolvedPreviewBlobId) {
          const previewBytes = await client.walrus.readBlob({ blobId: resolvedPreviewBlobId });
          previewUrl = URL.createObjectURL(
            new Blob([new Uint8Array(previewBytes)], {
              type: previewMime,
            }),
          );
        }

        const profilePayload = {
          walletAddress: account.address,
          avatarObjectId: selectedAvatar.objectId,
          avatarName: resolvedName,
          manifestBlobId: resolvedManifestBlobId,
          avatarBlobId: runtimeBlobId,
          previewBlobId: resolvedPreviewBlobId,
          txDigest: selectedAvatar.txDigest,
          runtimeState:
            selectedAvatar.status ?? (selectedAvatar.runtimeReady ? "playable" : "stored"),
          resolution: runtimeUrl
            ? {
                mode: "http",
                httpUrl: runtimeUrl,
              }
            : undefined,
          game: {
            mode: "shooter",
            character: resolvedShooterCharacter,
            stats: resolvedShooterStats,
            multiplayer: resolvedMultiplayerCapacity,
          },
          shooterCharacter: resolvedShooterCharacter,
          shooterStats: resolvedShooterStats,
          multiplayer: resolvedMultiplayerCapacity,
          endpoints: {
            reportMatchUrl: `${webEnv.apiBaseUrl}/shooter/match`,
            reportLocalMatchUrl: `${webEnv.apiBaseUrl}/shooter/match/local`,
            shooterStatsUrl: `${webEnv.apiBaseUrl}/shooter/stats/${encodeURIComponent(
              account.address,
            )}`,
          },
        };

        const profileUrl = URL.createObjectURL(
          new Blob([JSON.stringify(profilePayload)], {
            type: "application/json",
          }),
        );

        if (cancelled) {
          URL.revokeObjectURL(profileUrl);
          if (runtimeUrl && runtimeUrl.startsWith("blob:")) {
            URL.revokeObjectURL(runtimeUrl);
          }
          if (previewUrl) {
            URL.revokeObjectURL(previewUrl);
          }
          return;
        }

        clearLocalUrls();
        setLocalRuntimeAssetUrl(runtimeUrl && runtimeUrl.startsWith("blob:") ? runtimeUrl : null);
        setLocalPreviewUrl(previewUrl);
        setLocalProfileUrl(profileUrl);
        setMultiplayerCapacity(resolvedMultiplayerCapacity);
        setAvatars((current) =>
          current.map((avatar) =>
            avatar.objectId === selectedAvatar.objectId
              ? {
                  ...avatar,
                  name: resolvedName ?? avatar.name,
                  previewBlobId: resolvedPreviewBlobId ?? avatar.previewBlobId,
                  shooterCharacter: resolvedShooterCharacter ?? avatar.shooterCharacter,
                  shooterStats: resolvedShooterStats,
                }
              : avatar,
          ),
        );
        setSelectedAvatar((current) =>
          current && current.objectId === selectedAvatar.objectId
            ? {
                ...current,
                name: resolvedName ?? current.name,
                previewBlobId: resolvedPreviewBlobId ?? current.previewBlobId,
                shooterCharacter: resolvedShooterCharacter ?? current.shooterCharacter,
                shooterStats: resolvedShooterStats,
              }
            : current,
        );
        setStatus("ready");
        setStatusDetail("API offline, but local shooter handoff is ready.");
      } catch (caught) {
        if (cancelled) {
          return;
        }

        const message =
          caught instanceof Error ? caught.message : "Failed to prepare local Unity handoff.";
        setStatus("error");
        setStatusDetail(message);
        setError(message);
        clearLocalUrls();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    account?.address,
    clearLocalUrls,
    client,
    handoffMode,
    multiplayerCapacity,
    selectedAvatar,
  ]);

  useEffect(() => {
    return () => {
      clearLocalUrls();
    };
  }, [clearLocalUrls]);

  const unityProfileEndpoint = useMemo(() => {
    if (!account?.address || !selectedAvatar || handoffMode !== "api") {
      return null;
    }

    let url = `${webEnv.apiBaseUrl}/unity/profile/${encodeURIComponent(account.address)}`;
    url = appendQuery(url, "avatarObjectId", selectedAvatar.objectId);
    if (selectedAvatar.manifestBlobId) {
      url = appendQuery(url, "manifestBlobId", selectedAvatar.manifestBlobId);
    }
    if (webEnv.avatarPackageId) {
      url = appendQuery(url, "packageId", webEnv.avatarPackageId);
    }
    url = appendQuery(url, "mode", "shooter");
    return url;
  }, [account?.address, handoffMode, selectedAvatar]);

  useEffect(() => {
    let cancelled = false;
    if (!unityProfileEndpoint || handoffMode !== "api") {
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      try {
        const response = await fetch(unityProfileEndpoint, { cache: "no-store" });
        if (!response.ok) {
          return;
        }

        const payload = (await response.json()) as Record<string, unknown>;
        if (cancelled) {
          return;
        }

        setMultiplayerCapacity(normalizeMultiplayerCapacity(payload.multiplayer));
        const nextStats = normalizeShooterStats(payload.shooterStats);
        const nextShooterCharacter = normalizeShooterCharacter(payload.shooterCharacter);
        const nextPreviewBlobId =
          typeof payload.previewBlobId === "string" && payload.previewBlobId.length > 0
            ? payload.previewBlobId
            : null;

        setAvatars((current) =>
          current.map((avatar) =>
            selectedAvatar && avatar.objectId === selectedAvatar.objectId
              ? {
                  ...avatar,
                  shooterStats: nextStats,
                  shooterCharacter: nextShooterCharacter ?? avatar.shooterCharacter,
                  previewBlobId: nextPreviewBlobId ?? avatar.previewBlobId,
                }
              : avatar,
          ),
        );
        setSelectedAvatar((current) =>
          current
            ? {
                ...current,
                shooterStats: nextStats,
                shooterCharacter: nextShooterCharacter ?? current.shooterCharacter,
                previewBlobId: nextPreviewBlobId ?? current.previewBlobId,
              }
            : current,
        );
      } catch {
        // Keep defaults if the profile endpoint is unavailable.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [handoffMode, selectedAvatar, unityProfileEndpoint]);

  const selectedPreviewUrl = useMemo(() => {
    if (handoffMode === "local-blob" && localPreviewUrl) {
      return localPreviewUrl;
    }

    if (!selectedAvatar?.previewBlobId) {
      return null;
    }

    return `${webEnv.apiBaseUrl}/asset/${encodeURIComponent(selectedAvatar.previewBlobId)}`;
  }, [handoffMode, localPreviewUrl, selectedAvatar?.previewBlobId]);

  const buildRuntimeHref = useCallback(
    (avatarObjectId?: string | null, manifestBlobId?: string | null) => {
      const url = new URL("/world", window.location.origin);
      url.searchParams.set("mode", "shooter");
      url.searchParams.set("fullscreen", "1");
      if (avatarObjectId) {
        url.searchParams.set("avatarObjectId", avatarObjectId);
      }
      if (manifestBlobId) {
        url.searchParams.set("manifestBlobId", manifestBlobId);
      }
      return `${url.pathname}${url.search}`;
    },
    [],
  );

  const activeProfileUrl = handoffMode === "api" ? unityProfileEndpoint : localProfileUrl;
  const effectivePhotonRealtimeAppId =
    photonRealtimeAppIdOverride.length > 0
      ? photonRealtimeAppIdOverride
      : webEnv.photonAppIdRealtime;
  const effectivePhotonFixedRegion =
    photonFixedRegionOverride.trim().toLowerCase() || webEnv.photonFixedRegion;

  const unityLaunchUrl = useMemo(() => {
    if (!activeProfileUrl) {
      return null;
    }

    let launchUrl = appendQuery(webEnv.unityWebglUrl, "mode", "shooter");
    launchUrl = appendQuery(launchUrl, "profile", activeProfileUrl);
    if (webEnv.unityAssetVersion) {
      launchUrl = appendQuery(launchUrl, "assetVersion", webEnv.unityAssetVersion);
    }
    if (effectivePhotonRealtimeAppId) {
      launchUrl = appendQuery(launchUrl, "photonAppIdRealtime", effectivePhotonRealtimeAppId);
      launchUrl = appendQuery(launchUrl, "photonUseNameServer", "1");
    }
    if (webEnv.photonAppIdChat) {
      launchUrl = appendQuery(launchUrl, "photonAppIdChat", webEnv.photonAppIdChat);
    }
    if (webEnv.photonAppIdVoice) {
      launchUrl = appendQuery(launchUrl, "photonAppIdVoice", webEnv.photonAppIdVoice);
    }
    if (effectivePhotonFixedRegion) {
      launchUrl = appendQuery(launchUrl, "photonFixedRegion", effectivePhotonFixedRegion);
    }
    if (walletSession?.token) {
      launchUrl = appendQuery(launchUrl, "walletSessionToken", walletSession.token);
    }
    return launchUrl;
  }, [
    activeProfileUrl,
    effectivePhotonFixedRegion,
    effectivePhotonRealtimeAppId,
    walletSession?.token,
  ]);

  useEffect(() => {
    let cancelled = false;

    if (!unityLaunchUrl) {
      setUnityBuildState("idle");
      setUnityBuildError(null);
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      try {
        setUnityBuildState("checking");
        setUnityBuildError(null);
        const checkUrl = appendQuery(webEnv.unityWebglUrl, "__unity_check", String(Date.now()));
        const response = await fetch(checkUrl, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`Unity build URL returned HTTP ${response.status}.`);
        }

        const html = await response.text();
        if (!looksLikeUnityWebglIndex(html)) {
          throw new Error(
            `No Unity WebGL loader detected at ${webEnv.unityWebglUrl}. Export Unity WebGL to apps/web/public/unity-webgl first.`,
          );
        }

        if (cancelled) {
          return;
        }

        setUnityBuildState("valid");
        setUnityBuildError(null);
      } catch (caught) {
        if (cancelled) {
          return;
        }

        const message =
          caught instanceof Error ? caught.message : "Unity build preflight check failed.";
        setUnityBuildState("invalid");
        setUnityBuildError(message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [unityLaunchUrl]);

  const authReady = !account?.address || walletSessionState === "ready";
  const canRenderUnityFrame =
    Boolean(unityLaunchUrl) && unityBuildState === "valid" && authReady;
  const unityFrameSrc = canRenderUnityFrame ? unityLaunchUrl ?? undefined : undefined;
  const runtimeHeroPreview = selectedPreviewUrl ?? "/marketing/match-ready.png";
  const selectedLaunchHref = selectedAvatar
    ? buildRuntimeHref(selectedAvatar.objectId, selectedAvatar.manifestBlobId)
    : null;
  const selectorStatusLabel =
    status === "searching"
      ? "Loading characters..."
      : unityBuildState === "checking"
        ? "Checking game build..."
        : walletSessionState === "verifying"
          ? "Verifying wallet..."
          : "Play Game";
  const canOpenGameScreen =
    !isRuntimeScreen &&
    Boolean(selectedAvatar) &&
    Boolean(selectedLaunchHref) &&
    canRenderUnityFrame;

  const openGameScreen = useCallback(() => {
    if (!selectedLaunchHref) {
      return;
    }

    window.location.assign(selectedLaunchHref);
  }, [selectedLaunchHref]);

  const enterFullscreen = useCallback(() => {
    if (typeof document === "undefined" || !document.documentElement.requestFullscreen) {
      return;
    }

    void document.documentElement.requestFullscreen().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!isRuntimeScreen || !requestedFullscreen) {
      return;
    }

    if (typeof document === "undefined" || document.fullscreenElement) {
      return;
    }

    void document.documentElement.requestFullscreen?.().catch(() => undefined);
  }, [isRuntimeScreen, requestedFullscreen]);

  return (
    isRuntimeScreen ? (
      <div className="runtime-immersive-shell">
        <div className="runtime-immersive-topbar">
          <a className="secondary-button" href="/unity">
            Back To Characters
          </a>
          <div className="runtime-immersive-actions">
            <span className="runtime-immersive-label">
              {selectedAvatar?.name ?? "Loading character"}
            </span>
            <button className="primary-button" onClick={enterFullscreen} type="button">
              Fullscreen
            </button>
          </div>
        </div>
        {canRenderUnityFrame ? (
          <iframe
            className="runtime-frame runtime-frame--immersive"
            src={unityFrameSrc}
            title="Pacific Unity Runtime"
            allow="fullscreen; autoplay; clipboard-read; clipboard-write"
          />
        ) : unityBuildState === "checking" ? (
          <div className="runtime-immersive-notice">Verifying game build.</div>
        ) : walletSessionState === "verifying" ? (
          <div className="runtime-immersive-notice">
            Verifying wallet session for the selected character.
          </div>
        ) : walletSessionState === "error" ? (
          <div className="runtime-immersive-notice runtime-immersive-notice--error">
            Wallet session failed. Go back to Play and reconnect the wallet.
          </div>
        ) : unityBuildState === "invalid" ? (
          <div className="runtime-immersive-notice runtime-immersive-notice--error">
            {unityBuildError}
          </div>
        ) : (
          <div className="runtime-immersive-notice">
            Open Play, choose a character, then launch the game again.
          </div>
        )}
      </div>
    ) : (
      <div className="app-shell app-shell--minimal">
        <header className="app-topbar">
          <div className="brand-lockup">
            <a className="brand-mark" href="/">
              Pacific
            </a>
            <p className="brand-subtitle">Runtime launcher</p>
          </div>
          <SiteTabs activeRoute="unity" />
          <div className="wallet-shell">
            <ConnectButton />
          </div>
        </header>

        <main className="experience-shell">
          <section className="screen-hero screen-hero--runtime">
            <div className="screen-hero-copy">
              <p className="eyebrow">Owned characters only</p>
              <h1>Load characters. Hit play.</h1>
              <p className="lede">
                Connect the wallet, wait for characters to load, pick one, then open the game.
              </p>
              <div className="hero-chip-row">
                <span className="hero-chip">
                  {status === "searching"
                    ? "Loading characters"
                    : selectedAvatar
                      ? "Character selected"
                      : "Waiting for character"}
                </span>
                <span className="hero-chip">
                  {walletSessionState === "ready" ? "Session verified" : "Session pending"}
                </span>
              </div>
            </div>
            <div className="screen-hero-art">
              <img src={runtimeHeroPreview} alt="Selected character preview" />
              <div className="hero-art-caption">
                <span className="panel-label">Selected character</span>
                <strong>{selectedAvatar?.name ?? "No character selected"}</strong>
                <p>{statusDetail}</p>
              </div>
            </div>
          </section>

          <section className="runtime-flow-layout runtime-flow-layout--selector">
            <article className="flow-card">
              <div className="section-head">
                <div>
                  <p className="eyebrow">Characters</p>
                  <h2>Choose one</h2>
                </div>
                <span className="section-badge">{avatars.length}</span>
              </div>
              {status === "searching" && account?.address ? (
                <div className="notice-callout">Loading characters.</div>
              ) : null}
              {!account?.address ? (
                <div className="notice-callout">
                  Connect wallet to load your owned characters.
                </div>
              ) : null}
              {error ? <div className="error-callout">{error}</div> : null}
              {walletSessionError ? <div className="error-callout">{walletSessionError}</div> : null}
              <div className="operator-list">
                {avatars.length > 0 ? (
                  avatars.map((avatar) => {
                    const isSelected = selectedAvatar?.objectId === avatar.objectId;
                    const avatarPreview =
                      avatar.previewBlobId && handoffMode === "api"
                        ? `${webEnv.apiBaseUrl}/asset/${encodeURIComponent(avatar.previewBlobId)}`
                        : null;

                    return (
                      <button
                        className={`operator-list-card${isSelected ? " active" : ""}`}
                        key={avatar.objectId}
                        onClick={() => {
                          setSelectedAvatar(avatar);
                          setError(null);
                          setStatus(handoffMode === "api" ? "ready" : "searching");
                          setStatusDetail(
                            handoffMode === "api"
                              ? `${avatar.name ?? avatar.objectId} selected. Press Play Game.`
                              : `${avatar.name ?? avatar.objectId} selected. Preparing local handoff.`,
                          );
                        }}
                        type="button"
                      >
                        <div className="operator-list-media">
                          {avatarPreview ? (
                            <img src={avatarPreview} alt={`${avatar.name ?? "Owned"} preview`} />
                          ) : (
                            <div className="operator-list-fallback" />
                          )}
                        </div>
                        <div className="operator-list-copy">
                          <strong>{avatar.name ?? "Unnamed operator"}</strong>
                          <p>{avatar.shooterCharacter?.label ?? "Unknown class"}</p>
                          <span>
                            W {avatar.shooterStats.wins} · L {avatar.shooterStats.losses} · HP {avatar.shooterStats.hp}
                          </span>
                        </div>
                      </button>
                    );
                  })
                ) : account?.address && status !== "searching" ? (
                  <div className="notice-callout">
                    No playable characters were found for this wallet.
                  </div>
                ) : null}
              </div>
            </article>

            <article className="flow-card runtime-stage-card">
              <div className="section-head">
                <div>
                  <p className="eyebrow">Play</p>
                  <h2>Open game</h2>
                </div>
                <span className="section-badge">{selectedAvatar ? "Ready" : "Waiting"}</span>
              </div>
              {unityBuildError ? <div className="error-callout">{unityBuildError}</div> : null}
              {selectedAvatar ? (
                <div className="launch-stage-panel">
                  <img
                    className="launch-stage-preview"
                    src={runtimeHeroPreview}
                    alt={`${selectedAvatar.name ?? "Selected operator"} preview`}
                  />
                  <div className="launch-stage-copy">
                    <strong>{selectedAvatar.name ?? "Unnamed operator"}</strong>
                    <p>Play opens the dedicated game screen.</p>
                  </div>
                  <button
                    className="primary-button primary-button--wide"
                    disabled={!canOpenGameScreen}
                    onClick={openGameScreen}
                    type="button"
                  >
                    {selectorStatusLabel}
                  </button>
                </div>
              ) : (
                <div className="notice-callout">Choose a character first.</div>
              )}
            </article>
          </section>
        </main>
      </div>
    )
  );
}
