import { useCallback, useEffect, useMemo, useState } from "react";
import { useCurrentAccount, useCurrentClient, useDAppKit } from "@mysten/dapp-kit-react";
import { ConnectButton } from "@mysten/dapp-kit-react/ui";
import type { ShooterCharacter, ShooterStats } from "@pacific/shared";
import { SiteTabs } from "../components/SiteTabs";
import {
  fetchOwnedAvatarsFromBackend,
  type BackendOwnedAvatar,
} from "../lib/backend-avatar";
import { queryOwnedOnChainAvatars } from "../lib/on-chain-avatar";
import { blobIdFromWalrusReference, loadManifestFromWalrus } from "../lib/play-world";
import { webEnv } from "../env";
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

const photonRealtimeAppIdStorageKey = "pacific:photonRealtimeAppId";
const photonFixedRegionStorageKey = "pacific:photonFixedRegion";

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
};

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

function formatIsoDate(value: string | null | undefined) {
  if (!value) {
    return "n/a";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString();
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

  // Avoid false positives from SPA shells/routes that mention "unity"
  // but are not an actual Unity WebGL index page.
  if (normalized.includes("id=\"root\"")) {
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
  };
}

export function UnityPage() {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const dAppKit = useDAppKit();
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
    "Connect wallet to load your shooter avatar into Unity.",
  );
  const [error, setError] = useState<string | null>(null);
  const [avatars, setAvatars] = useState<UnityAvatarOption[]>([]);
  const [selectedAvatar, setSelectedAvatar] = useState<UnityAvatarOption | null>(
    null,
  );
  const [handoffMode, setHandoffMode] = useState<UnityHandoffMode>("api");
  const [localProfileUrl, setLocalProfileUrl] = useState<string | null>(null);
  const [localPreviewUrl, setLocalPreviewUrl] = useState<string | null>(null);
  const [, setLocalRuntimeAssetUrl] = useState<string | null>(null);
  const [unityBuildState, setUnityBuildState] = useState<UnityBuildState>("idle");
  const [unityBuildError, setUnityBuildError] = useState<string | null>(null);
  const [multiplayerCapacity, setMultiplayerCapacity] = useState<MultiplayerCapacity>(
    defaultMultiplayerCapacity,
  );
  const [photonRealtimeAppIdOverride, setPhotonRealtimeAppIdOverride] = useState(() =>
    readStoredValue(photonRealtimeAppIdStorageKey),
  );
  const [photonFixedRegionOverride, setPhotonFixedRegionOverride] = useState(() =>
    readStoredValue(photonFixedRegionStorageKey) || webEnv.photonFixedRegion,
  );
  const [runtimeExpanded, setRuntimeExpanded] = useState(true);
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
      setStatusDetail("Connect wallet to load your shooter avatar into Unity.");
      setError(null);
      setAvatars([]);
      setSelectedAvatar(null);
      setHandoffMode("api");
      setMultiplayerCapacity(defaultMultiplayerCapacity);
      return;
    }

    setStatus("searching");
    setStatusDetail("Loading shooter-ready avatars from backend cache.");
    setError(null);
    clearLocalUrls();

    try {
      const result = await fetchOwnedAvatarsFromBackend(
        walletAddress,
        webEnv.avatarPackageId,
      );
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
        setStatusDetail(
          "No shooter avatar manifest is available yet. Mint and publish first, then return here.",
        );
        return;
      }

      setStatus("ready");
      setStatusDetail(
        "Shooter Unity handoff is ready via API profile endpoint.",
      );
      return;
    } catch (backendError) {
      try {
        const onChain = await queryOwnedOnChainAvatars(client, walletAddress);
        const nextAvatars = await hydrateShooterAvatarOptions(
          onChain
          .map((avatar) => ({
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
          }))
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
            `API unavailable at ${webEnv.apiBaseUrl}. No usable on-chain avatar was found for this wallet.`,
          );
          return;
        }

        setStatus("searching");
        setStatusDetail(
          `API unavailable at ${webEnv.apiBaseUrl}. Preparing local Unity handoff from Walrus.`,
        );
        return;
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
  }, [account?.address, dAppKit]);

  useEffect(() => {
    let cancelled = false;

    if (
      handoffMode !== "local-blob" ||
      !selectedAvatar ||
      !account?.address
    ) {
      clearLocalUrls();
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      try {
        setStatus("searching");
        setStatusDetail("Preparing local profile, operator metadata, and runtime blob for Unity.");
        setError(null);

        let resolvedManifestBlobId = selectedAvatar.manifestBlobId;
        let runtimeBlobId = selectedAvatar.runtimeAvatarBlobId;
        let runtimeMime = "model/vrm";
        let previewMime = "image/png";
        let runtimeUrl = selectedAvatar.modelUrl && /^https?:/i.test(selectedAvatar.modelUrl)
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
          resolvedMultiplayerCapacity = normalizeMultiplayerCapacity(
            manifest.game?.multiplayer,
          );
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
          const previewBytes = await client.walrus.readBlob({
            blobId: resolvedPreviewBlobId,
          });
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
            selectedAvatar.status ??
            (selectedAvatar.runtimeReady ? "playable" : "stored"),
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
        setStatusDetail(
          "API is offline, but shooter fallback profile is ready using local handoff.",
        );
      } catch (caught) {
        if (cancelled) {
          return;
        }

        const message =
          caught instanceof Error
            ? caught.message
            : "Failed to prepare local Unity handoff.";
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

    let url = `${webEnv.apiBaseUrl}/unity/profile/${encodeURIComponent(
      account.address,
    )}`;
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
        // Keep defaults; Unity profile endpoint might be unavailable in offline fallback scenarios.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [handoffMode, unityProfileEndpoint]);

  const selectedPreviewUrl = useMemo(() => {
    if (handoffMode === "local-blob" && localPreviewUrl) {
      return localPreviewUrl;
    }

    if (!selectedAvatar?.previewBlobId) {
      return null;
    }

    return `${webEnv.apiBaseUrl}/asset/${encodeURIComponent(selectedAvatar.previewBlobId)}`;
  }, [handoffMode, localPreviewUrl, selectedAvatar?.previewBlobId]);

  const activeProfileUrl = handoffMode === "api" ? unityProfileEndpoint : localProfileUrl;
  const effectivePhotonRealtimeAppId =
    photonRealtimeAppIdOverride.length > 0
      ? photonRealtimeAppIdOverride
      : webEnv.photonAppIdRealtime;
  const effectivePhotonFixedRegion =
    photonFixedRegionOverride.trim().toLowerCase() || webEnv.photonFixedRegion;
  const photonRealtimeConfigured = effectivePhotonRealtimeAppId.length > 0;

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
  }, [activeProfileUrl, effectivePhotonFixedRegion, effectivePhotonRealtimeAppId, walletSession?.token]);

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
        const checkUrl = appendQuery(
          webEnv.unityWebglUrl,
          "__unity_check",
          String(Date.now()),
        );
        const response = await fetch(checkUrl, {
          cache: "no-store",
        });
        if (!response.ok) {
          throw new Error(
            `Unity build URL returned HTTP ${response.status}.`,
          );
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
          caught instanceof Error
            ? caught.message
            : "Unity build preflight check failed.";
        setUnityBuildState("invalid");
        setUnityBuildError(message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [unityLaunchUrl]);

  const authReady =
    !account?.address || walletSessionState === "ready";
  const canRenderUnityFrame =
    Boolean(unityLaunchUrl) && unityBuildState === "valid" && authReady;
  const unityFrameSrc = canRenderUnityFrame ? unityLaunchUrl ?? undefined : undefined;
  const runtimeHeroPreview = selectedPreviewUrl ?? "/marketing/match-ready.png";
  const runtimeStatusChips = [
    selectedAvatar ? "Owned operator verified" : "No operator selected",
    walletSessionState === "ready" ? "Wallet session green" : "Wallet session pending",
    photonRealtimeConfigured ? "Photon live" : "Photon missing",
    unityBuildState === "valid" ? "WebGL ready" : "Build pending",
  ];
  const selectedOperatorSummary = selectedAvatar?.shooterCharacter
    ? `${selectedAvatar.shooterCharacter.label} / ${selectedAvatar.shooterCharacter.prefabResource}`
    : "No owned shooter NFT selected";
  const photonSummary = photonRealtimeConfigured
    ? `Realtime App ID armed${effectivePhotonFixedRegion ? ` in ${effectivePhotonFixedRegion}` : ""}.`
    : "No Photon Realtime / PUN App ID configured yet.";

  const savePhotonOverrides = useCallback(() => {
    const nextRealtime = photonRealtimeAppIdOverride.trim();
    const nextRegion = photonFixedRegionOverride.trim().toLowerCase() || "usw";

    if (nextRealtime) {
      window.localStorage.setItem(photonRealtimeAppIdStorageKey, nextRealtime);
    } else {
      window.localStorage.removeItem(photonRealtimeAppIdStorageKey);
    }

    window.localStorage.setItem(photonFixedRegionStorageKey, nextRegion);
    setPhotonRealtimeAppIdOverride(nextRealtime);
    setPhotonFixedRegionOverride(nextRegion);
  }, [photonFixedRegionOverride, photonRealtimeAppIdOverride]);

  const clearPhotonOverrides = useCallback(() => {
    window.localStorage.removeItem(photonRealtimeAppIdStorageKey);
    window.localStorage.removeItem(photonFixedRegionStorageKey);
    setPhotonRealtimeAppIdOverride("");
    setPhotonFixedRegionOverride(webEnv.photonFixedRegion);
  }, []);

  return (
    <div className="app-shell unity-page">
      <header className="topbar">
        <div className="topbar-copy">
          <p className="eyebrow">Pacific Strike Runtime</p>
          <h1>Deploy your wallet-owned operator into the live MFPS lobby.</h1>
          <p className="lede">
            This launcher is the bridge between Sui ownership, Walrus character metadata, and the
            actual MFPS runtime. Select an owned NFT operator, verify the wallet session, and open
            the game with the exact same operator profile injected into Unity.
          </p>
          <SiteTabs activeRoute="unity" />
        </div>
        <div className="wallet-shell">
          <ConnectButton />
        </div>
      </header>

      <section className="panel hero-banner runtime-hero-banner">
        <div className="hero-banner-copy">
          <span className="panel-label">Verified Runtime Bridge</span>
          <h2>Ownership, session auth, and MFPS launch all line up in one place.</h2>
          <p>
            The operator selected here is resolved from current wallet ownership, hydrated from
            Walrus metadata, then injected into the Unity runtime with the wallet session token
            needed for NFT-linked save-back.
          </p>
          <div className="status-chip-row">
            {runtimeStatusChips.map((chip) => (
              <span className="status-chip" key={chip}>
                {chip}
              </span>
            ))}
          </div>
          <div className="hero-stat-grid">
            <article className="stat-card">
              <span className="panel-label">Operator</span>
              <strong>{selectedOperatorSummary}</strong>
              <p>Current owned NFT operator queued for Unity injection.</p>
            </article>
            <article className="stat-card">
              <span className="panel-label">Wallet Session</span>
              <strong>{walletSessionState}</strong>
              <p>{walletSessionError ?? `Expires ${formatIsoDate(walletSession?.expiresAt)}`}</p>
            </article>
            <article className="stat-card">
              <span className="panel-label">Photon</span>
              <strong>{photonRealtimeConfigured ? "Realtime ready" : "Offline fallback"}</strong>
              <p>{photonSummary}</p>
            </article>
            <article className="stat-card">
              <span className="panel-label">Multiplayer Budget</span>
              <strong>{multiplayerCapacity.maxPlayers} players</strong>
              <p>
                {multiplayerCapacity.maxConcurrentMatches} matches / {multiplayerCapacity.tickRate}hz
                relay budget.
              </p>
            </article>
          </div>
          <div className="hero-action-row">
            <button className="primary-button" onClick={() => void loadOwnedAvatars()}>
              Reload Owned Operators
            </button>
            <button
              className="secondary-button"
              onClick={() => setRuntimeExpanded((current) => !current)}
              type="button"
            >
              {runtimeExpanded ? "Show Split View" : "Expand Runtime"}
            </button>
            {unityFrameSrc ? (
              <a
                className="secondary-button unity-runtime-link"
                href={unityFrameSrc}
                target="_blank"
                rel="noreferrer"
              >
                Open Full Runtime
              </a>
            ) : null}
          </div>
        </div>
        <div className="hero-banner-media">
          <div className="hero-media-frame">
            <img src={runtimeHeroPreview} alt="MFPS runtime preview" />
            <div className="hero-media-overlay">
              <span className="panel-label">Launch Target</span>
              <strong>{selectedAvatar?.name ?? "No owned operator selected"}</strong>
              <p>
                {statusDetail}
              </p>
            </div>
          </div>
        </div>
      </section>

      <main className={`unity-layout${runtimeExpanded ? " runtime-expanded" : ""}`}>
        <aside className="panel upload-panel runtime-sidebar">
          <div className="panel-copy unity-launch-copy">
            <span className="panel-label">Operator Dossier</span>
            <h2>Own it. Verify it. Launch it.</h2>
            <p>
              This left rail is the deployment board: who the operator is, whether the save session
              is valid, and which owned NFT options can be launched right now.
            </p>
          </div>

          <div className="unity-status-row">
            <span className={`unity-status-chip status-${status}`}>Profile {status}</span>
            <span className={`unity-status-chip build-${unityBuildState}`}>
              Build {unityBuildState}
            </span>
            <span className="unity-status-chip">Mode {handoffMode}</span>
          </div>

          <div className="validation-card workflow-card unity-launch-card">
            {selectedPreviewUrl ? (
              <div className="mint-preview-image unity-operator-preview">
                <img
                  src={selectedPreviewUrl}
                  alt={`${selectedAvatar?.name ?? "Selected"} operator preview`}
                />
              </div>
            ) : null}
            <p>Status: {status}</p>
            <p>{statusDetail}</p>
            <p>Wallet: {account?.address ?? "Not connected"}</p>
            <p>
              Launch profile:{" "}
              {handoffMode === "api" ? "API profile endpoint" : "Local Walrus fallback profile"}
            </p>
            <p>
              On-chain ownership:{" "}
              {selectedAvatar
                ? "verified from current Sui owned objects"
                : "waiting for owned NFT lookup"}
            </p>
            <p>Wallet session: {walletSessionState}</p>
            <p>Wallet session expires: {formatIsoDate(walletSession?.expiresAt)}</p>
            <p>
              Photon realtime:{" "}
              {photonRealtimeConfigured
                ? "configured for multiplayer"
                : "missing, launching offline fallback"}
            </p>
            <p>
              Multiplayer capacity: {multiplayerCapacity.maxPlayers} players/match,{" "}
              {multiplayerCapacity.maxConcurrentMatches} matches, {multiplayerCapacity.tickRate}hz
            </p>
            <p>
              NFT stats: W {selectedAvatar?.shooterStats.wins ?? 0} / L{" "}
              {selectedAvatar?.shooterStats.losses ?? 0} / HP{" "}
              {selectedAvatar?.shooterStats.hp ?? 100}
            </p>
            <p>
              Operator: {selectedAvatar?.shooterCharacter?.label ?? "n/a"} /{" "}
              {selectedAvatar?.shooterCharacter?.prefabResource ?? "n/a"}
            </p>
            <p>Avatar object: {selectedAvatar?.objectId ?? "n/a"}</p>
            <p>Manifest blob: {selectedAvatar?.manifestBlobId ?? "n/a"}</p>
            <p>Transaction: {selectedAvatar?.txDigest ?? "n/a"}</p>
            <p>Manifest updated: {formatIsoDate(selectedAvatar?.updatedAt)}</p>
          </div>
          {!photonRealtimeConfigured ? (
            <div className="error-callout">
              No Photon Realtime App ID is configured yet. Unity will launch in MFPS offline
              fallback mode until you save a valid Photon Realtime / PUN App ID.
            </div>
          ) : null}
          {unityBuildError ? <div className="error-callout">Unity build error: {unityBuildError}</div> : null}
          {walletSessionError ? (
            <div className="error-callout">Wallet verification error: {walletSessionError}</div>
          ) : null}
          {error ? <div className="error-callout">Profile error: {error}</div> : null}

          {avatars.length > 0 ? (
            <div className="play-picker unity-avatar-list">
              <p>Owned NFT operators</p>
              {avatars.map((avatar) => {
                const isSelected = selectedAvatar?.objectId === avatar.objectId;
                const avatarPreview =
                  avatar.previewBlobId && handoffMode === "api"
                    ? `${webEnv.apiBaseUrl}/asset/${encodeURIComponent(avatar.previewBlobId)}`
                    : null;

                return (
                  <button
                    className={`play-picker-item operator-roster-card${isSelected ? " active" : ""}`}
                    key={avatar.objectId}
                    onClick={() => {
                      setSelectedAvatar(avatar);
                      setError(null);
                      if (handoffMode === "api") {
                        setStatus("ready");
                        setStatusDetail(
                          `Selected operator ${avatar.objectId} for MFPS runtime.`,
                        );
                      } else {
                        setStatus("searching");
                        setStatusDetail(
                          `Selected operator ${avatar.objectId}. Preparing local MFPS handoff.`,
                        );
                      }
                    }}
                    type="button"
                  >
                    <div className="operator-roster-media">
                      {avatarPreview ? (
                        <img src={avatarPreview} alt={`${avatar.name ?? "Owned"} operator preview`} />
                      ) : (
                        <div className="operator-roster-fallback" />
                      )}
                    </div>
                    <div className="operator-roster-copy">
                      <strong>{avatar.name ?? "Unnamed operator"}</strong>
                      <p>{avatar.shooterCharacter?.label ?? "Unknown class"}</p>
                      <p>{avatar.shooterCharacter?.prefabResource ?? "No prefab"}</p>
                      <p>
                        NFT stats: W {avatar.shooterStats.wins} / L {avatar.shooterStats.losses} /
                        HP {avatar.shooterStats.hp}
                      </p>
                      <p>Runtime status: {avatar.status ?? "unknown"}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="notice-callout">
              No currently owned shooter NFT was found for this wallet. Mint one on the Create
              page, then reload this launcher.
            </div>
          )}

          <details className="intel-drawer">
            <summary>Photon relay controls</summary>
            <div className="drawer-content">
              <p>
                MFPS uses Photon PUN 2. Create a Photon Realtime / PUN app, not Fusion, then paste
                that Realtime App ID here.
              </p>
              <label className="upload-drop">
                <span>Photon Realtime App ID</span>
                <input
                  type="text"
                  placeholder="Paste Photon Realtime / PUN App ID"
                  value={photonRealtimeAppIdOverride}
                  onChange={(event) => setPhotonRealtimeAppIdOverride(event.target.value)}
                />
              </label>
              <label className="upload-drop">
                <span>Photon fixed region</span>
                <input
                  type="text"
                  placeholder="usw"
                  value={photonFixedRegionOverride}
                  onChange={(event) => setPhotonFixedRegionOverride(event.target.value)}
                />
              </label>
              <div className="unity-photon-actions">
                <button className="primary-button" onClick={savePhotonOverrides}>
                  Save Photon Config
                </button>
                <button className="secondary-button" onClick={clearPhotonOverrides}>
                  Clear Override
                </button>
              </div>
              <p>
                Effective App ID source:{" "}
                {photonRealtimeAppIdOverride.length > 0
                  ? "local launcher override"
                  : webEnv.photonAppIdRealtime
                    ? "environment"
                    : "missing"}
              </p>
            </div>
          </details>
        </aside>

        <section className="panel runtime-panel unity-runtime-panel">
          <div className="panel-copy">
            <span className="panel-label">Runtime Stage</span>
            <h2>MFPS 2.0 menu, lobby, and match entrypoint</h2>
            <p>
              The WebGL launcher sends `?mode=shooter&profile=` to the MFPS build.
              Entry point is the MFPS menu/lobby flow, then the first-person multiplayer match.
            </p>
          </div>
          <p className="runtime-status unity-runtime-hint">
            Expanded view gives the MFPS settings, loadout, and lobby screens enough room to feel
            like a game menu instead of a squeezed embed.
          </p>

          {!photonRealtimeConfigured ? (
            <div className="error-callout">
              Multiplayer cloud connection is unavailable until a Photon Realtime / PUN App ID is
              configured. The runtime is launching in MFPS offline fallback mode.
            </div>
          ) : null}
          {canRenderUnityFrame ? (
            <iframe
              className="unity-frame"
              src={unityFrameSrc}
              title="Pacific Unity Runtime"
              allow="fullscreen; autoplay; clipboard-read; clipboard-write"
            />
          ) : unityBuildState === "checking" ? (
            <div className="notice-callout">
              Verifying Unity WebGL build at {webEnv.unityWebglUrl}.
            </div>
          ) : walletSessionState === "verifying" ? (
            <div className="notice-callout">
              Verifying wallet session so Unity can save match results to the selected NFT profile.
            </div>
          ) : walletSessionState === "error" ? (
            <div className="error-callout">
              Wallet session failed. Unity launch is blocked until wallet ownership can be verified
              for save-back.
            </div>
          ) : unityBuildState === "invalid" ? (
            <div className="error-callout">
              {unityBuildError}
            </div>
          ) : (
            <div className="notice-callout">
              Connect wallet and choose a published avatar to launch Unity.
            </div>
          )}

          <div className="stat-card-grid runtime-stage-grid">
            <article className="stat-card">
              <span className="panel-label">Ownership Proof</span>
              <strong>{selectedAvatar ? "Current wallet owns selected avatar" : "Awaiting selection"}</strong>
              <p>
                The launcher only resolves playable operators from live owned-object reads, not a
                stale client list.
              </p>
            </article>
            <article className="stat-card">
              <span className="panel-label">Save-back Route</span>
              <strong>{walletSessionState === "ready" ? "Authenticated" : "Pending auth"}</strong>
              <p>
                Match results are posted back with the wallet session token tied to the selected
                NFT profile.
              </p>
            </article>
            <article className="stat-card">
              <span className="panel-label">Manifest Route</span>
              <strong>{handoffMode === "api" ? "API profile handoff" : "Local Walrus fallback"}</strong>
              <p>
                Runtime launch uses {handoffMode === "api" ? "server-authenticated JSON profile delivery." : "a local manifest blob profile fallback."}
              </p>
            </article>
            <article className="stat-card">
              <span className="panel-label">Selected NFT Stats</span>
              <strong>
                W {selectedAvatar?.shooterStats.wins ?? 0} / L {selectedAvatar?.shooterStats.losses ?? 0} / HP {selectedAvatar?.shooterStats.hp ?? 100}
              </strong>
              <p>Current launcher-visible profile data for the selected owned NFT.</p>
            </article>
          </div>
        </section>
      </main>
    </div>
  );
}
