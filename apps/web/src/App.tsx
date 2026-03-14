import { useCallback, useEffect, useMemo, useState } from "react";
import { CurrentAccountSigner } from "@mysten/dapp-kit-core";
import { useCurrentAccount, useCurrentClient, useDAppKit } from "@mysten/dapp-kit-react";
import { ConnectButton } from "@mysten/dapp-kit-react/ui";
import {
  READY_AVATAR_DEFAULT_EPOCHS,
  READY_AVATAR_MAX_EPOCHS,
  READY_AVATAR_MANIFEST_MIME,
  READY_AVATAR_NETWORK,
  READY_AVATAR_OBJECT_SCHEMA_VERSION,
  READY_AVATAR_PREVIEW_MIME,
  READY_AVATAR_SCHEMA,
  READY_AVATAR_TYPE,
  type ManifestRecord,
  type ReadyAvatarManifest,
  type ShooterCharacter,
  type WalrusAvatarStorage,
} from "@pacific/shared";
import { SiteTabs, type SiteRoute } from "./components/SiteTabs";
import { webEnv, webEnvLimits } from "./env";
import {
  extendAvatarWalrusStorage,
  findOwnedAvatarObjectId,
  mintAvatarObject,
  persistManifestRecord,
  syncWalrusStorageRecord,
} from "./lib/avatar-chain";
import {
  fetchOwnedAvatarsFromBackend,
  type BackendOwnedAvatar,
} from "./lib/backend-avatar";
import { persistLastPublishedAvatar } from "./lib/published-avatar";
import {
  createShooterPresetPreviewBlob,
  findShooterPresetById,
  SHOOTER_CHARACTER_PRESETS,
  type ShooterCharacterPreset,
} from "./lib/shooter-character-presets";
import { ensureWalletSession, isApiAvailable, type WalletSession } from "./lib/session";
import {
  describeWalrusRetention,
  fetchWalrusNetworkClock,
  summarizeWalrusStorage,
  type WalrusNetworkClock,
} from "./lib/walrus-storage";

type UploadResult = {
  blobId: string;
  blobObjectId: string;
  startEpoch: number | null;
  endEpoch: number | null;
  deletable: boolean | null;
};

type UploadedAsset = UploadResult & {
  filename: string;
  mime: string;
  size: number;
};

type MintStatus =
  | "idle"
  | "verifying wallet session"
  | "uploading source asset blob"
  | "uploading runtime character blob"
  | "preview loaded"
  | "uploading preview blob"
  | "uploading manifest blob"
  | "publishing avatar object"
  | "success"
  | "error";

type Phase =
  | "home"
  | "mint"
  | "choose-operator"
  | "identity"
  | "mint-operator"
  | "extend-operator"
  | "minted";

type GameMode = "shooter";
type WalletSessionState = "idle" | "verifying" | "ready" | "error";

type PublishState = {
  sourceAsset: UploadedAsset | null;
  runtimeAvatar: UploadedAsset;
  preview: UploadedAsset;
  manifestBlob: UploadResult;
  avatarObjectId: string;
  shooterCharacter: ShooterCharacter;
  manifestRecord: ManifestRecord;
  readyManifest: ReadyAvatarManifest;
  apiPersisted: boolean;
};

type RuntimeUploadInput = {
  body: Blob;
  filename: string;
  mime: string;
  source: ShooterCharacter["source"];
};

type MintReadinessItem = {
  id: string;
  label: string;
  ready: boolean;
  detail: string;
};

type ExtendOperatorCard = {
  objectId: string;
  name: string;
  role: string;
  prefabResource: string;
  previewUrl: string;
  walrusStorage: WalrusAvatarStorage | null;
  updatedAt: string | null;
};

const MINT_PHASE_ORDER: Phase[] = ["choose-operator", "identity", "mint-operator", "minted"];

function formatError(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string" && error) {
    return error;
  }

  return "An unexpected error occurred.";
}

function hasConfiguredAvatarPackageId(packageId: string) {
  return /^0x[0-9a-fA-F]+$/.test(packageId) && !/^0x0+$/.test(packageId);
}

function createAssetUrl(blobId: string) {
  return `${webEnv.apiBaseUrl}/asset/${encodeURIComponent(blobId)}`;
}

function formatLimitMb(limitMb: number) {
  return `${limitMb} MB`;
}

function formatFileMeta(file: File) {
  return `${file.name} (${(file.size / (1024 * 1024)).toFixed(1)} MB)`;
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

function formatWalletAddress(value: string | null) {
  if (!value) {
    return "Wallet not connected";
  }

  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function buildPhasePreview(preset: ShooterCharacterPreset | null, previewUrl: string | null) {
  return previewUrl ?? preset?.previewImagePath ?? "/marketing/mint-preview.png";
}

const shooterInitialStats = {
  wins: 0,
  losses: 0,
  hp: 100,
} as const;

const shooterMultiplayerDefaults = {
  maxPlayers: 64,
  maxConcurrentMatches: 512,
  tickRate: 30,
} as const;

const shooterRuntimeFormat = "mfps-character";

function buildShooterCharacterDescriptorBlob(
  preset: ShooterCharacterPreset,
  walletAddress: string,
) {
  const payload = {
    schema: "mfps-character-runtime/1.0",
    preset: {
      id: preset.id,
      label: preset.label,
      prefabResource: preset.prefabResource,
      role: preset.role,
      tagline: preset.tagline,
    },
    owner: walletAddress,
    generatedAt: new Date().toISOString(),
  };

  return new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
}

function buildRuntimeUploadInput(
  preset: ShooterCharacterPreset,
  walletAddress: string,
  characterAssetFile: File | null,
): RuntimeUploadInput {
  if (characterAssetFile) {
    return {
      body: characterAssetFile,
      filename: characterAssetFile.name,
      mime: characterAssetFile.type || "application/octet-stream",
      source: "uploaded-file",
    };
  }

  return {
    body: buildShooterCharacterDescriptorBlob(preset, walletAddress),
    filename: `${preset.id}.character.json`,
    mime: "application/json",
    source: "preset",
  };
}

function deriveExtendCardFromBackend(avatar: BackendOwnedAvatar): ExtendOperatorCard | null {
  const previewBlobId = avatar.walrusStorage?.preview?.blobId;
  const shooterCharacter = avatar.shooterCharacter;
  if (!previewBlobId || !shooterCharacter) {
    return null;
  }

  return {
    objectId: avatar.objectId,
    name: avatar.name ?? shooterCharacter.label,
    role: shooterCharacter.role ?? "Shooter",
    prefabResource: shooterCharacter.prefabResource,
    previewUrl: `${webEnv.apiBaseUrl}/asset/${encodeURIComponent(previewBlobId)}`,
    walrusStorage: avatar.walrusStorage,
    updatedAt: avatar.updatedAt,
  };
}

function App() {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const dAppKit = useDAppKit();
  const [session, setSession] = useState<WalletSession | null>(null);
  const [phase, setPhase] = useState<Phase>(() =>
    window.location.pathname === "/create" ? "mint" : "home",
  );
  const [name, setName] = useState(SHOOTER_CHARACTER_PRESETS[0]?.label ?? "MFPS Shooter Avatar");
  const [description, setDescription] = useState(
    "Wallet-owned operator for the Pacific shooter runtime.",
  );
  const [sourceAssetFile, setSourceAssetFile] = useState<File | null>(null);
  const [sourceAssetError, setSourceAssetError] = useState<string | null>(null);
  const [characterAssetFile, setCharacterAssetFile] = useState<File | null>(null);
  const [selectedShooterPresetId, setSelectedShooterPresetId] = useState<string>(
    SHOOTER_CHARACTER_PRESETS[0]?.id ?? "",
  );
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [apiAvailable, setApiAvailable] = useState<boolean | null>(null);
  const [apiNotice, setApiNotice] = useState<string | null>(null);
  const [walletSessionState, setWalletSessionState] = useState<WalletSessionState>("idle");
  const [walletSessionError, setWalletSessionError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [mintStatus, setMintStatus] = useState<MintStatus>("idle");
  const [mintDetail, setMintDetail] = useState(
    "Choose an operator, set the identity, finish every signature, then mint.",
  );
  const [publishState, setPublishState] = useState<PublishState | null>(null);
  const [walrusClock, setWalrusClock] = useState<WalrusNetworkClock | null>(null);
  const [renewBusyLabel, setRenewBusyLabel] = useState<string | null>(null);
  const [renewNotice, setRenewNotice] = useState<string | null>(null);
  const [renewError, setRenewError] = useState<string | null>(null);
  const [selectedGameMode, setSelectedGameMode] = useState<GameMode | null>(() => {
    const mode = new URLSearchParams(window.location.search).get("mode");
    return mode === "shooter" ? "shooter" : null;
  });
  const [extendOperators, setExtendOperators] = useState<ExtendOperatorCard[]>([]);
  const [extendLoading, setExtendLoading] = useState(false);
  const [selectedExtendObjectId, setSelectedExtendObjectId] = useState<string | null>(null);

  const walletAddress = account?.address ?? null;
  const signer = useMemo(
    () =>
      new CurrentAccountSigner(
        dAppKit as unknown as ConstructorParameters<typeof CurrentAccountSigner>[0],
      ),
    [dAppKit],
  );
  const packageConfigured = hasConfiguredAvatarPackageId(webEnv.avatarPackageId);
  const shooterSelected = selectedGameMode === "shooter";
  const selectedShooterPreset = useMemo(
    () => findShooterPresetById(selectedShooterPresetId),
    [selectedShooterPresetId],
  );
  const selectedPreviewArt = buildPhasePreview(selectedShooterPreset, previewUrl);

  const runtimeUploadPlan = useMemo(
    () =>
      characterAssetFile
        ? {
            source: "uploaded-file" as const,
            filename: characterAssetFile.name,
            mime: characterAssetFile.type || "application/octet-stream",
            size: characterAssetFile.size,
          }
        : selectedShooterPreset
          ? {
              source: "preset" as const,
              filename: `${selectedShooterPreset.id}.character.json`,
              mime: "application/json",
              size: null,
            }
          : null,
    [characterAssetFile, selectedShooterPreset],
  );

  const mintReadiness = useMemo<MintReadinessItem[]>(
    () => [
      {
        id: "wallet",
        label: "Wallet connected",
        ready: Boolean(walletAddress),
        detail: walletAddress ? "Wallet ready." : "Connect a Sui wallet.",
      },
      {
        id: "mode",
        label: "Shooter mode selected",
        ready: shooterSelected,
        detail: shooterSelected ? "Shooter path locked." : "Choose the shooter path.",
      },
      {
        id: "character",
        label: "MFPS operator selected",
        ready: Boolean(selectedShooterPreset),
        detail: selectedShooterPreset
          ? `${selectedShooterPreset.label} (${selectedShooterPreset.prefabResource}) selected.`
          : "Select an MFPS character preset.",
      },
      {
        id: "identity",
        label: "Operator identity set",
        ready: name.trim().length > 0 && description.trim().length > 0,
        detail:
          name.trim().length > 0 && description.trim().length > 0
            ? "Name and description are ready."
            : "Add a name and short description.",
      },
      {
        id: "preview",
        label: "Preview generated",
        ready: Boolean(previewBlob && previewUrl),
        detail:
          previewBlob && previewUrl
            ? "Preview image ready."
            : "Waiting for preview generation.",
      },
      {
        id: "runtime",
        label: "Runtime payload mapped",
        ready: Boolean(runtimeUploadPlan),
        detail: runtimeUploadPlan
          ? `${runtimeUploadPlan.source} -> ${runtimeUploadPlan.filename}`
          : "Runtime payload not resolved yet.",
      },
      {
        id: "package",
        label: "Avatar package configured",
        ready: packageConfigured,
        detail: packageConfigured
          ? `Using package ${webEnv.avatarPackageId}.`
          : "Set VITE_AVATAR_PACKAGE_ID to your published package.",
      },
    ],
    [
      description,
      name,
      packageConfigured,
      previewBlob,
      previewUrl,
      runtimeUploadPlan,
      selectedShooterPreset,
      shooterSelected,
      walletAddress,
    ],
  );

  const mintBlockingReasons = useMemo(
    () => mintReadiness.filter((item) => !item.ready).map((item) => item.detail),
    [mintReadiness],
  );
  const publishReady = mintBlockingReasons.length === 0;
  const readinessCount = mintReadiness.filter((item) => item.ready).length;
  const estimatedWalletPromptCount =
    3 + (sourceAssetFile ? 1 : 0) + 1 + (apiAvailable === false ? 0 : 1);
  const walrusEpochPlan = webEnv.walrusEpochs || READY_AVATAR_DEFAULT_EPOCHS;
  const mintedWalrusRetention = describeWalrusRetention(
    publishState?.manifestRecord.walrusStorage ?? null,
    walrusClock,
  );
  const activeRoute: SiteRoute = phase === "home" ? "start" : "create";
  const walletStatusLabel =
    walletSessionState === "ready"
      ? `Verified until ${formatIsoDate(session?.expiresAt)}`
      : walletSessionState === "verifying"
        ? "Waiting for wallet signature."
        : apiAvailable === false
          ? "Mint works, but online sync is offline."
          : walletAddress
            ? "Wallet session will be verified before save-back."
            : "Connect wallet to begin.";
  const selectedExtendOperator =
    extendOperators.find((avatar) => avatar.objectId === selectedExtendObjectId) ?? null;
  const currentMintStepIndex = MINT_PHASE_ORDER.indexOf(phase);
  const phaseSteps = [
    { key: "mint", label: "Mint Menu" },
    { key: "choose-operator", label: "Choose Operator" },
    { key: "identity", label: "Identity" },
    { key: "mint-operator", label: "Mint Operator" },
    { key: "minted", label: "Live" },
  ] as const;

  const updateMintStatus = useCallback(
    (nextStatus: MintStatus, detail: string, nextBusyLabel: string | null = null) => {
      setMintStatus(nextStatus);
      setMintDetail(detail);
      setBusyLabel(nextBusyLabel);
    },
    [],
  );

  const chooseShooterMode = useCallback(() => {
    setSelectedGameMode("shooter");
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("mode", "shooter");
    window.history.replaceState({}, "", `${nextUrl.pathname}${nextUrl.search}`);
    updateMintStatus("idle", "Shooter selected. Choose an operator and continue.");
  }, [updateMintStatus]);

  useEffect(() => {
    const nextPath = phase === "home" ? "/" : "/create";
    if (window.location.pathname !== nextPath) {
      const nextUrl = new URL(window.location.href);
      nextUrl.pathname = nextPath;
      window.history.replaceState({}, "", `${nextUrl.pathname}${nextUrl.search}`);
    }
  }, [phase]);

  useEffect(() => {
    if (phase !== "home" && !shooterSelected) {
      chooseShooterMode();
    }
  }, [chooseShooterMode, phase, shooterSelected]);

  const nextPhase = useCallback(() => {
    setPhase((current) => {
      switch (current) {
        case "mint":
          return "choose-operator";
        case "choose-operator":
          return "identity";
        case "identity":
          return "mint-operator";
        default:
          return current;
      }
    });
  }, []);

  const previousPhase = useCallback(() => {
    setPhase((current) => {
      switch (current) {
        case "mint":
          return "home";
        case "choose-operator":
          return "mint";
        case "identity":
          return "choose-operator";
        case "mint-operator":
          return "identity";
        case "extend-operator":
          return "mint";
        case "minted":
          return "mint";
        default:
          return current;
      }
    });
  }, []);

  const buildShooterLaunchHref = useCallback(
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

  const probeApiAvailability = useCallback(async () => {
    const available = await isApiAvailable();
    setApiAvailable(available);
    setApiNotice(
      available
        ? null
        : `Local API not detected at ${webEnv.apiBaseUrl}. Mint continues, but backend sync waits until the API is back.`,
    );
    return available;
  }, []);

  useEffect(() => {
    void probeApiAvailability();
  }, [probeApiAvailability]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const nextClock = await fetchWalrusNetworkClock(client);
        if (!cancelled) {
          setWalrusClock(nextClock);
        }
      } catch (caught) {
        console.warn("Failed to load Walrus epoch clock.", caught);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => {
    let cancelled = false;

    if (!walletAddress) {
      setSession(null);
      setWalletSessionState("idle");
      setWalletSessionError(null);
      return () => {
        cancelled = true;
      };
    }

    if (apiAvailable !== true) {
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
        const nextSession = await ensureWalletSession(dAppKit, walletAddress, session);
        if (cancelled) {
          return;
        }

        setSession(nextSession);
        setWalletSessionState("ready");
      } catch (caught) {
        if (cancelled) {
          return;
        }

        setSession(null);
        setWalletSessionState("error");
        setWalletSessionError(formatError(caught));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [apiAvailable, dAppKit, session, walletAddress]);

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  useEffect(() => {
    let disposed = false;

    if (!shooterSelected || !selectedShooterPreset) {
      return () => {
        disposed = true;
      };
    }

    (async () => {
      try {
        const generated = await createShooterPresetPreviewBlob(selectedShooterPreset);
        if (disposed) {
          URL.revokeObjectURL(generated.previewUrl);
          return;
        }

        setPreviewBlob(generated.previewBlob);
        setPreviewUrl((current) => {
          if (current) {
            URL.revokeObjectURL(current);
          }
          return generated.previewUrl;
        });
      } catch (caught) {
        setError(formatError(caught));
      }
    })();

    return () => {
      disposed = true;
    };
  }, [selectedShooterPreset, shooterSelected]);

  const ensureSession = useCallback(async () => {
    if (!walletAddress) {
      throw new Error("Connect a Sui wallet before persisting backend state.");
    }

    if (!(await probeApiAvailability())) {
      throw new Error("Local API is unavailable.");
    }

    if (
      session?.walletAddress === walletAddress &&
      new Date(session.expiresAt).getTime() > Date.now()
    ) {
      return session;
    }

    const nextSession = await ensureWalletSession(dAppKit, walletAddress, session);
    setSession(nextSession);
    return nextSession;
  }, [dAppKit, probeApiAvailability, session, walletAddress]);

  const syncManifestRecord = useCallback(
    async (manifest: ReadyAvatarManifest, record: ManifestRecord) => {
      try {
        const currentSession = await ensureSession();
        await persistManifestRecord(currentSession, manifest, record);
        setApiAvailable(true);
        setApiNotice(null);
        return true;
      } catch (caught) {
        setApiAvailable(false);
        setApiNotice(`Manifest persistence skipped: ${formatError(caught)}`);
        return false;
      }
    },
    [ensureSession],
  );

  useEffect(() => {
    let cancelled = false;

    if (phase !== "extend-operator") {
      return () => {
        cancelled = true;
      };
    }

    if (!walletAddress) {
      setExtendOperators(
        publishState
          ? [
              {
                objectId: publishState.avatarObjectId,
                name: publishState.shooterCharacter.label,
                role: publishState.shooterCharacter.role ?? "Shooter",
                prefabResource: publishState.shooterCharacter.prefabResource,
                previewUrl: selectedPreviewArt,
                walrusStorage: publishState.manifestRecord.walrusStorage ?? null,
                updatedAt: new Date().toISOString(),
              },
            ]
          : [],
      );
      setSelectedExtendObjectId(publishState?.avatarObjectId ?? null);
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      setExtendLoading(true);
      try {
        const result = await fetchOwnedAvatarsFromBackend(walletAddress, webEnv.avatarPackageId);
        if (cancelled) {
          return;
        }

        const backendCards = result.avatars
          .map((avatar) => deriveExtendCardFromBackend(avatar))
          .filter((avatar): avatar is ExtendOperatorCard => Boolean(avatar));

        const publishedCard =
          publishState?.manifestRecord.walrusStorage && selectedShooterPreset
            ? {
                objectId: publishState.avatarObjectId,
                name: publishState.shooterCharacter.label,
                role: publishState.shooterCharacter.role ?? "Shooter",
                prefabResource: publishState.shooterCharacter.prefabResource,
                previewUrl: selectedPreviewArt,
                walrusStorage: publishState.manifestRecord.walrusStorage ?? null,
                updatedAt: new Date().toISOString(),
              }
            : null;

        const merged = publishedCard
          ? [
              publishedCard,
              ...backendCards.filter((card) => card.objectId !== publishedCard.objectId),
            ]
          : backendCards;

        setExtendOperators(merged);
        setSelectedExtendObjectId((current) => current ?? merged[0]?.objectId ?? null);
      } catch (caught) {
        if (cancelled) {
          return;
        }

        if (publishState?.manifestRecord.walrusStorage && selectedShooterPreset) {
          setExtendOperators([
            {
              objectId: publishState.avatarObjectId,
              name: publishState.shooterCharacter.label,
              role: publishState.shooterCharacter.role ?? "Shooter",
              prefabResource: publishState.shooterCharacter.prefabResource,
              previewUrl: selectedPreviewArt,
              walrusStorage: publishState.manifestRecord.walrusStorage ?? null,
              updatedAt: new Date().toISOString(),
            },
          ]);
          setSelectedExtendObjectId(publishState.avatarObjectId);
        } else {
          setExtendOperators([]);
        }
        setApiNotice(`Extend lookup limited: ${formatError(caught)}`);
      } finally {
        if (!cancelled) {
          setExtendLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    phase,
    publishState,
    selectedPreviewArt,
    selectedShooterPreset,
    walletAddress,
  ]);

  const handleSourceAssetChange = useCallback((file: File | null) => {
    setPublishState(null);
    setSourceAssetError(null);
    setError(null);

    if (!file) {
      setSourceAssetFile(null);
      return;
    }

    if (file.size > webEnvLimits.maxSourceAssetBytes) {
      const message = `Source asset exceeds the ${formatLimitMb(webEnv.maxSourceAssetMb)} limit.`;
      setSourceAssetFile(null);
      setSourceAssetError(message);
      return;
    }

    setSourceAssetFile(file);
  }, []);

  const handleCharacterAssetChange = useCallback(
    (file: File | null) => {
      setCharacterAssetFile(file);
      setPublishState(null);
      setError(null);

      if (!file) {
        updateMintStatus("idle", "Using the selected preset runtime payload.");
        return;
      }

      if (file.size > webEnvLimits.maxRuntimeAvatarBytes) {
        const message = `Character asset exceeds the ${formatLimitMb(webEnv.maxRuntimeAvatarMb)} limit.`;
        setCharacterAssetFile(null);
        setError(message);
        updateMintStatus("error", message);
        return;
      }

      updateMintStatus(
        "preview loaded",
        `Attached runtime override: ${formatFileMeta(file)}. VRM uploads can take several minutes, so keep the tab open until mint completes.`,
      );
    },
    [updateMintStatus],
  );

  const uploadWalrusBlob = useCallback(
    async (file: Blob | Uint8Array, filename: string, mime: string) => {
      if (!walletAddress) {
        throw new Error("Connect a Sui wallet before uploading.");
      }

      const bytes =
        file instanceof Uint8Array ? file : new Uint8Array(await file.arrayBuffer());

      const result = await client.walrus.writeBlob({
        blob: bytes,
        deletable: false,
        epochs: webEnv.walrusEpochs || READY_AVATAR_DEFAULT_EPOCHS,
        signer,
        owner: walletAddress,
        attributes: {
          filename,
          mime,
        },
      });

      return {
        blobId: result.blobId,
        blobObjectId: result.blobObject.id,
        startEpoch: result.blobObject.storage.start_epoch,
        endEpoch: result.blobObject.storage.end_epoch,
        deletable: result.blobObject.deletable,
      };
    },
    [client.walrus, signer, walletAddress],
  );

  const handlePublish = useCallback(async () => {
    setError(null);
    setRenewNotice(null);
    setRenewError(null);

    if (!shooterSelected) {
      const message = "Choose the shooter flow first.";
      setError(message);
      updateMintStatus("error", message);
      return;
    }

    if (mintBlockingReasons.length > 0) {
      const message = `Mint blocked: ${mintBlockingReasons.join(" ")}`;
      setError(message);
      updateMintStatus("error", message);
      return;
    }

    if (!walletAddress || !selectedShooterPreset || !previewBlob || !previewUrl) {
      const message = "Mint requirements changed during validation. Reload and try again.";
      setError(message);
      updateMintStatus("error", message);
      return;
    }

    if (!packageConfigured) {
      const message =
        "Set VITE_AVATAR_PACKAGE_ID to the published Avatar Move package before minting.";
      setError(message);
      updateMintStatus("error", message);
      return;
    }

    try {
      const available = await probeApiAvailability();
      if (available) {
        updateMintStatus(
          "verifying wallet session",
          "Approve the wallet verification signature first. This links minting and save-back to your wallet.",
          "Waiting for wallet signature",
        );
        const nextSession = await ensureSession();
        setSession(nextSession);
        setWalletSessionState("ready");
        setWalletSessionError(null);
      }

      const sourceAssetUpload = sourceAssetFile
        ? await (async () => {
            updateMintStatus(
              "uploading source asset blob",
              "Approve the Walrus upload for the optional source asset. Large VRM and archive files can take several minutes. Do not close or leave.",
              "Uploading source asset",
            );
            return uploadWalrusBlob(
              sourceAssetFile,
              sourceAssetFile.name,
              sourceAssetFile.type || "application/octet-stream",
            );
          })()
        : null;

      const runtimeUploadInput = buildRuntimeUploadInput(
        selectedShooterPreset,
        walletAddress,
        characterAssetFile,
      );

      updateMintStatus(
        "uploading runtime character blob",
        "Approve the Walrus upload for the runtime payload. VRM uploads can take several minutes. Do not close or leave.",
        "Uploading runtime payload",
      );
      const runtimeUpload = await uploadWalrusBlob(
        runtimeUploadInput.body,
        runtimeUploadInput.filename,
        runtimeUploadInput.mime,
      );

      updateMintStatus(
        "uploading preview blob",
        "Approve the Walrus upload for the preview image.",
        "Uploading preview",
      );
      const previewUpload = await uploadWalrusBlob(
        previewBlob,
        "preview.png",
        READY_AVATAR_PREVIEW_MIME,
      );

      const shooterCharacter: ShooterCharacter = {
        id: selectedShooterPreset.id,
        label: selectedShooterPreset.label,
        prefabResource: selectedShooterPreset.prefabResource,
        role: selectedShooterPreset.role,
        source: runtimeUploadInput.source,
        runtimeAssetMime: runtimeUploadInput.mime,
        runtimeAssetFilename: runtimeUploadInput.filename,
      };

      const manifestDescription = description.trim() || selectedShooterPreset.tagline;
      const manifest: ReadyAvatarManifest = {
        schema: READY_AVATAR_SCHEMA,
        type: READY_AVATAR_TYPE,
        name,
        description: manifestDescription,
        owner: walletAddress,
        network: READY_AVATAR_NETWORK,
        sourceAsset: sourceAssetUpload
          ? {
              blobId: sourceAssetUpload.blobId,
              blobObjectId: sourceAssetUpload.blobObjectId,
              filename: sourceAssetFile?.name ?? "source-asset",
              mime: sourceAssetFile?.type || "application/octet-stream",
              size: sourceAssetFile?.size ?? 0,
            }
          : null,
        runtimeAvatar: {
          blobId: runtimeUpload.blobId,
          blobObjectId: runtimeUpload.blobObjectId,
          filename: runtimeUploadInput.filename,
          mime: runtimeUploadInput.mime,
          size:
            runtimeUploadInput.body instanceof File
              ? runtimeUploadInput.body.size
              : runtimeUploadInput.body.size,
          format: shooterRuntimeFormat,
        },
        preview: {
          blobId: previewUpload.blobId,
          blobObjectId: previewUpload.blobObjectId,
          filename: "preview.png",
          mime: READY_AVATAR_PREVIEW_MIME,
          size: previewBlob.size,
        },
        game: {
          mode: "shooter",
          package: "MFPS 2.0",
          character: shooterCharacter,
          multiplayer: { ...shooterMultiplayerDefaults },
          stats: { ...shooterInitialStats },
        },
      };

      updateMintStatus(
        "uploading manifest blob",
        "Approve the Walrus upload for the manifest. This binds the NFT to the operator, stats seed, and runtime metadata.",
        "Uploading manifest",
      );
      const manifestBuffer = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
      const manifestUpload = await uploadWalrusBlob(
        manifestBuffer,
        "manifest.json",
        READY_AVATAR_MANIFEST_MIME,
      );

      updateMintStatus(
        "publishing avatar object",
        "Approve the final Sui mint transaction. Do not close the wallet or leave until the transaction confirms.",
        "Waiting for mint signature",
      );
      const legacyRig = `${shooterRuntimeFormat}:${shooterCharacter.id}`;
      const mintResult = await mintAvatarObject(
        client,
        dAppKit,
        walletAddress,
        {
          name,
          description: manifestDescription,
          manifestBlobId: manifestUpload.blobId,
          previewBlobId: previewUpload.blobId,
          previewUrl: createAssetUrl(previewUpload.blobId),
          projectUrl: webEnv.projectUrl,
          schemaVersion: READY_AVATAR_OBJECT_SCHEMA_VERSION,
          legacyRig,
        },
      );

      const avatarObjectId =
        mintResult.avatarObjectId ??
        (await findOwnedAvatarObjectId(client, walletAddress, mintResult.digest));
      if (!avatarObjectId) {
        throw new Error(
          "Avatar mint succeeded but the Avatar object could not be located from transaction effects or owned-object lookup.",
        );
      }

      const transactionDigest = mintResult.digest;
      const walrusStorage = summarizeWalrusStorage({
        runtimeAvatar: runtimeUpload,
        preview: previewUpload,
        manifest: manifestUpload,
        sourceAsset: sourceAssetUpload,
        minimumEndEpoch: null,
        maximumEndEpoch: null,
      }) as WalrusAvatarStorage;

      const manifestRecord: ManifestRecord = {
        avatarBlobId: runtimeUpload.blobId,
        avatarBlobObjectId: runtimeUpload.blobObjectId,
        sourceAssetBlobId: sourceAssetUpload?.blobId ?? null,
        sourceAssetBlobObjectId: sourceAssetUpload?.blobObjectId ?? null,
        previewBlobId: previewUpload.blobId,
        previewBlobObjectId: previewUpload.blobObjectId,
        manifestBlobId: manifestUpload.blobId,
        manifestBlobObjectId: manifestUpload.blobObjectId,
        avatarObjectId,
        transactionDigest,
        epochs: webEnv.walrusEpochs || READY_AVATAR_DEFAULT_EPOCHS,
        walrusStorage,
        runtimeReady: true,
      };

      try {
        persistLastPublishedAvatar({
          avatarBlobId: runtimeUpload.blobId,
          sourceAssetBlobId: sourceAssetUpload?.blobId ?? null,
          previewBlobId: previewUpload.blobId,
          manifestBlobId: manifestUpload.blobId,
          avatarObjectId,
          txDigest: transactionDigest,
          publishedAt: new Date().toISOString(),
        });
      } catch (storageError) {
        console.warn("Failed to cache published avatar in localStorage.", storageError);
      }

      setPublishState({
        sourceAsset: sourceAssetUpload
          ? {
              ...sourceAssetUpload,
              filename: sourceAssetFile?.name ?? "source-asset",
              mime: sourceAssetFile?.type || "application/octet-stream",
              size: sourceAssetFile?.size ?? 0,
            }
          : null,
        runtimeAvatar: {
          ...runtimeUpload,
          filename: runtimeUploadInput.filename,
          mime: runtimeUploadInput.mime,
          size:
            runtimeUploadInput.body instanceof File
              ? runtimeUploadInput.body.size
              : runtimeUploadInput.body.size,
        },
        preview: {
          ...previewUpload,
          filename: "preview.png",
          mime: READY_AVATAR_PREVIEW_MIME,
          size: previewBlob.size,
        },
        manifestBlob: manifestUpload,
        avatarObjectId,
        shooterCharacter,
        manifestRecord,
        readyManifest: manifest,
        apiPersisted: false,
      });

      updateMintStatus("success", "Mint complete. Your operator is live and ready to launch.");
      setPhase("minted");

      void syncManifestRecord(manifest, manifestRecord).then((persisted) => {
        if (!persisted) {
          return;
        }

        setPublishState((current) =>
          current && current.manifestRecord.manifestBlobId === manifestRecord.manifestBlobId
            ? { ...current, apiPersisted: true }
            : current,
        );
      });
    } catch (caught) {
      const message = formatError(caught);
      setError(message);
      updateMintStatus("error", message);
    }
  }, [
    characterAssetFile,
    client,
    dAppKit,
    description,
    ensureSession,
    mintBlockingReasons,
    name,
    packageConfigured,
    previewBlob,
    previewUrl,
    probeApiAvailability,
    selectedShooterPreset,
    shooterSelected,
    sourceAssetFile,
    syncManifestRecord,
    updateMintStatus,
    uploadWalrusBlob,
    walletAddress,
  ]);

  const handleRenewExtendOperator = useCallback(async () => {
    if (!selectedExtendOperator?.walrusStorage) {
      setRenewError("Select an extendable operator first.");
      return;
    }

    setRenewBusyLabel("Renewing storage...");
    setRenewNotice(null);
    setRenewError(null);

    try {
      const renewed = await extendAvatarWalrusStorage({
        client,
        dAppKit,
        walrusStorage: selectedExtendOperator.walrusStorage,
        epochs: READY_AVATAR_MAX_EPOCHS,
      });

      let persisted = false;
      if (walletAddress) {
        try {
          const currentSession = await ensureSession();
          await syncWalrusStorageRecord(
            currentSession,
            selectedExtendOperator.objectId,
            renewed.walrusStorage,
          );
          persisted = true;
        } catch (caught) {
          setApiNotice(`Walrus renewal synced locally only: ${formatError(caught)}`);
        }
      }

      setExtendOperators((current) =>
        current.map((operator) =>
          operator.objectId === selectedExtendOperator.objectId
            ? {
                ...operator,
                walrusStorage: renewed.walrusStorage,
                updatedAt: new Date().toISOString(),
              }
            : operator,
        ),
      );

      if (publishState && publishState.avatarObjectId === selectedExtendOperator.objectId) {
        setPublishState((current) =>
          current
            ? {
                ...current,
                manifestRecord: {
                  ...current.manifestRecord,
                  walrusStorage: renewed.walrusStorage,
                },
                apiPersisted: current.apiPersisted || persisted,
              }
            : current,
        );
      }

      const retention = describeWalrusRetention(renewed.walrusStorage, walrusClock);
      setRenewNotice(
        `Operator extended (${renewed.digest}). ${retention.detail}${persisted ? " Backend cache synced." : ""}`,
      );
    } catch (caught) {
      setRenewError(formatError(caught));
    } finally {
      setRenewBusyLabel(null);
    }
  }, [client, dAppKit, ensureSession, publishState, selectedExtendOperator, walrusClock, walletAddress]);

  const openPlay = useCallback(() => {
    window.location.assign("/unity");
  }, []);

  const openMint = useCallback(() => {
    setPhase("mint");
    setRenewNotice(null);
    setRenewError(null);
  }, []);

  const launchMintOperator = useCallback(() => {
    setPhase("choose-operator");
    setRenewNotice(null);
    setRenewError(null);
  }, []);

  const launchExtendOperator = useCallback(() => {
    setPhase("extend-operator");
    setRenewNotice(null);
    setRenewError(null);
  }, []);

  const launchPublishedOperator = useCallback(() => {
    window.location.assign(
      buildShooterLaunchHref(
        publishState?.avatarObjectId ?? null,
        publishState?.manifestBlob.blobId ?? null,
      ),
    );
  }, [buildShooterLaunchHref, publishState?.avatarObjectId, publishState?.manifestBlob.blobId]);

  const renderPhasePanel = () => {
    if (phase === "home") {
      return (
        <section className="home-choice-grid">
          <button className="phase-choice-card" onClick={openMint} type="button">
            <div className="phase-choice-copy">
              <p className="eyebrow">Option 01</p>
              <h2>Mint</h2>
              <p>Create a new wallet-owned operator in a guided flow.</p>
            </div>
            <img src="/marketing/mint-preview.png" alt="Mint operator flow" />
          </button>
          <button className="phase-choice-card" onClick={openPlay} type="button">
            <div className="phase-choice-copy">
              <p className="eyebrow">Option 02</p>
              <h2>Play</h2>
              <p>Load owned operators only and jump straight into the game.</p>
            </div>
            <img src="/marketing/runtime-hub.png" alt="Play flow" />
          </button>
        </section>
      );
    }

    if (phase === "mint") {
      return (
        <section className="phase-card-grid">
          <button className="phase-action-card" onClick={launchMintOperator} type="button">
            <div className="phase-action-copy">
              <p className="eyebrow">Mint flow</p>
              <h2>Mint Operator</h2>
              <p>Choose an operator, set the identity, and mint the NFT.</p>
            </div>
            <span className="phase-action-tag">3 phases</span>
          </button>
          <button className="phase-action-card" onClick={launchExtendOperator} type="button">
            <div className="phase-action-copy">
              <p className="eyebrow">Storage flow</p>
              <h2>Extend Operator</h2>
              <p>Renew Walrus storage for an operator you already own.</p>
            </div>
            <span className="phase-action-tag">1 phase</span>
          </button>
        </section>
      );
    }

    if (phase === "choose-operator") {
      return (
        <section className="phase-screen">
          <div className="phase-head">
            <div>
              <p className="eyebrow">Phase 1</p>
              <h2>Choose operator</h2>
            </div>
            <span className="section-badge">{selectedShooterPreset?.role ?? "Preset"}</span>
          </div>
          <p className="section-copy">
            Pick the exact MFPS class this NFT will control in game.
          </p>
          <div className="operator-grid">
            {SHOOTER_CHARACTER_PRESETS.map((preset) => (
              <button
                className={`operator-card${preset.id === selectedShooterPresetId ? " active" : ""}`}
                key={preset.id}
                onClick={() => setSelectedShooterPresetId(preset.id)}
                type="button"
              >
                <img src={preset.previewImagePath} alt={`${preset.label} preview`} />
                <div className="operator-card-copy">
                  <strong>{preset.label}</strong>
                  <p>{preset.tagline}</p>
                  <span>
                    {preset.role} · {preset.prefabResource}
                  </span>
                </div>
              </button>
            ))}
          </div>
          <div className="action-row">
            <button className="secondary-button" onClick={previousPhase} type="button">
              Back
            </button>
            <button className="primary-button" onClick={nextPhase} type="button">
              Continue
            </button>
          </div>
        </section>
      );
    }

    if (phase === "identity") {
      return (
        <section className="phase-screen">
          <div className="phase-head">
            <div>
              <p className="eyebrow">Phase 2</p>
              <h2>Name and description</h2>
            </div>
            <span className="section-badge">Identity</span>
          </div>
          <p className="section-copy">
            Give the operator a name and a short story. Keep it tight.
          </p>
          <div className="form-stack">
            <label className="form-field">
              <span>Operator name</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="MPlayer 1"
              />
            </label>
            <label className="form-field">
              <span>Description</span>
              <input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Balanced assault loadout for Pacific strike matches."
              />
            </label>
          </div>
          <details className="mini-details">
            <summary>Optional files</summary>
            <div className="detail-stack">
              <label className="upload-field">
                <span>Source asset</span>
                <input
                  type="file"
                  accept=".vrm,.glb,.gltf,.fbx,.zip,.png,.jpg,.jpeg,.webp,.json,.txt"
                  onChange={(event) => handleSourceAssetChange(event.target.files?.[0] ?? null)}
                />
                <p>Attach a provenance file only if you want it saved with the NFT.</p>
                <small>
                  Max {webEnv.maxSourceAssetMb} MB
                  {sourceAssetFile ? ` · ${formatFileMeta(sourceAssetFile)}` : ""}
                </small>
              </label>
              <label className="upload-field">
                <span>Runtime override file</span>
                <input
                  type="file"
                  accept=".vrm,.glb,.gltf,.fbx,.json,.bin,.bytes"
                  onChange={(event) => handleCharacterAssetChange(event.target.files?.[0] ?? null)}
                />
                <p>Leave empty to use the built-in preset runtime payload.</p>
                <small>
                  Max {webEnv.maxRuntimeAvatarMb} MB. VRM uploads can take minutes. Do not close,
                  refresh, or leave.
                </small>
              </label>
            </div>
          </details>
          <div className="action-row">
            <button className="secondary-button" onClick={previousPhase} type="button">
              Back
            </button>
            <button
              className="primary-button"
              disabled={name.trim().length === 0 || description.trim().length === 0}
              onClick={nextPhase}
              type="button"
            >
              Continue
            </button>
          </div>
        </section>
      );
    }

    if (phase === "mint-operator") {
      return (
        <section className="phase-screen">
          <div className="phase-head">
            <div>
              <p className="eyebrow">Phase 3</p>
              <h2>Mint operator</h2>
            </div>
            <span className="section-badge">
              {readinessCount}/{mintReadiness.length} ready
            </span>
          </div>
          <p className="section-copy">{mintDetail}</p>
          <div className="summary-grid">
            <div className="summary-item">
              <span>Wallet</span>
              <strong>{formatWalletAddress(walletAddress)}</strong>
            </div>
            <div className="summary-item">
              <span>Operator</span>
              <strong>{selectedShooterPreset?.label ?? "Pending"}</strong>
            </div>
            <div className="summary-item">
              <span>Prefab</span>
              <strong>{selectedShooterPreset?.prefabResource ?? "Pending"}</strong>
            </div>
            <div className="summary-item">
              <span>Status</span>
              <strong>{walletStatusLabel}</strong>
            </div>
          </div>
          {!publishReady ? (
            <ul className="check-list">
              {mintBlockingReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : (
            <div className="success-strip">
              <strong>Ready to mint</strong>
              <span>{estimatedWalletPromptCount} wallet prompts expected.</span>
            </div>
          )}
          <details className="mini-details">
            <summary>Important before minting</summary>
            <div className="detail-stack">
              <ul className="check-list check-list--muted">
                <li>Finish every wallet prompt until minting is fully complete.</li>
                <li>VRM and large runtime uploads can take minutes.</li>
                <li>Do not close, refresh, or leave during upload or mint.</li>
                <li>
                  Character files are stored on Walrus for {walrusEpochPlan} epochs and can be
                  renewed later.
                </li>
              </ul>
            </div>
          </details>
          <div className="action-row">
            <button className="secondary-button" onClick={previousPhase} type="button">
              Back
            </button>
            <button
              className="primary-button primary-button--wide"
              disabled={Boolean(busyLabel) || !publishReady || !walletAddress}
              onClick={() => void handlePublish()}
              type="button"
            >
              {busyLabel ?? "Mint Operator"}
            </button>
          </div>
        </section>
      );
    }

    if (phase === "minted") {
      return (
        <section className="phase-screen">
          <div className="phase-head">
            <div>
              <p className="eyebrow">Live</p>
              <h2>Operator ready</h2>
            </div>
            <span className="section-badge">{mintedWalrusRetention.shortLabel}</span>
          </div>
          <p className="section-copy">
            Your NFT is live on Sui, the files are live on Walrus, and you can launch or extend
            from here.
          </p>
          {publishState ? (
            <div className="summary-grid">
              <div className="summary-item">
                <span>Operator</span>
                <strong>{publishState.shooterCharacter.label}</strong>
              </div>
              <div className="summary-item">
                <span>Storage</span>
                <strong>{mintedWalrusRetention.protectionLabel}</strong>
              </div>
              <div className="summary-item">
                <span>Save sync</span>
                <strong>{publishState.apiPersisted ? "Online" : "Local only"}</strong>
              </div>
              <div className="summary-item">
                <span>Mint status</span>
                <strong>{mintStatus}</strong>
              </div>
            </div>
          ) : null}
          <div className="action-row">
            <button className="primary-button" onClick={launchPublishedOperator} type="button">
              Launch Game
            </button>
            <button className="secondary-button" onClick={launchExtendOperator} type="button">
              Extend Operator
            </button>
          </div>
        </section>
      );
    }

    if (phase === "extend-operator") {
      return (
        <section className="phase-screen">
          <div className="phase-head">
            <div>
              <p className="eyebrow">Extend</p>
              <h2>Extend operator</h2>
            </div>
            <span className="section-badge">Walrus renewal</span>
          </div>
          <p className="section-copy">
            Select an owned operator and renew its storage window so it stays playable.
          </p>
          {!walletAddress ? (
            <div className="notice-callout">Connect the wallet that owns the operator first.</div>
          ) : extendLoading ? (
            <div className="notice-callout">Loading extendable operators.</div>
          ) : extendOperators.length > 0 ? (
            <div className="operator-grid">
              {extendOperators.map((operator) => {
                const isSelected = operator.objectId === selectedExtendObjectId;
                return (
                  <button
                    className={`operator-card${isSelected ? " active" : ""}`}
                    key={operator.objectId}
                    onClick={() => setSelectedExtendObjectId(operator.objectId)}
                    type="button"
                  >
                    <img src={operator.previewUrl} alt={`${operator.name} preview`} />
                    <div className="operator-card-copy">
                      <strong>{operator.name}</strong>
                      <p>{operator.role}</p>
                      <span>{operator.prefabResource}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="notice-callout">
              No extendable operator was found for this wallet yet.
            </div>
          )}
          {selectedExtendOperator?.walrusStorage ? (
            <div className="summary-grid">
              <div className="summary-item">
                <span>Time left</span>
                <strong>
                  {describeWalrusRetention(selectedExtendOperator.walrusStorage, walrusClock).shortLabel}
                </strong>
              </div>
              <div className="summary-item">
                <span>Expires</span>
                <strong>
                  {formatIsoDate(
                    describeWalrusRetention(selectedExtendOperator.walrusStorage, walrusClock)
                      .expiresAt,
                  )}
                </strong>
              </div>
            </div>
          ) : null}
          <div className="action-row">
            <button className="secondary-button" onClick={previousPhase} type="button">
              Back
            </button>
            <button
              className="primary-button"
              disabled={Boolean(renewBusyLabel) || !selectedExtendOperator?.walrusStorage}
              onClick={() => void handleRenewExtendOperator()}
              type="button"
            >
              {renewBusyLabel ?? "Extend Operator"}
            </button>
          </div>
        </section>
      );
    }

    return null;
  };

  return (
    <div className="app-shell app-shell--minimal">
      <header className="app-topbar">
        <div className="brand-lockup">
          <a className="brand-mark" href="/">
            Pacific
          </a>
          <p className="brand-subtitle">Sui operator app</p>
        </div>
        <SiteTabs activeRoute={activeRoute} />
        <div className="wallet-shell">
          <ConnectButton />
        </div>
      </header>

      <main className="experience-shell">
        {phase === "home" ? (
          <section className="screen-hero screen-hero--mint">
            <div className="screen-hero-copy">
              <p className="eyebrow">Operator hub</p>
              <h1>Mint or play.</h1>
              <p className="lede">
                Start with one decision. Mint a new operator or launch one you already own.
              </p>
              <div className="hero-chip-row">
                <span className="hero-chip">{walletAddress ? formatWalletAddress(walletAddress) : "Connect wallet"}</span>
                <span className="hero-chip">{selectedShooterPreset?.label ?? "Choose operator"}</span>
                <span className="hero-chip">Walrus {walrusEpochPlan} epochs</span>
              </div>
            </div>
            <div className="screen-hero-art">
              <img src={selectedPreviewArt} alt="Operator preview" />
              <div className="hero-art-caption">
                <span className="panel-label">Current preview</span>
                <strong>{selectedShooterPreset?.label ?? "MPlayer 1"}</strong>
                <p>{selectedShooterPreset?.tagline ?? "Pacific shooter runtime operator."}</p>
              </div>
            </div>
          </section>
        ) : (
          <section className="phase-layout">
            <aside className="phase-sidebar">
              <div className="phase-preview">
                <img src={selectedPreviewArt} alt="Selected operator preview" />
                <div className="phase-preview-copy">
                  <span className="panel-label">Operator</span>
                  <strong>{selectedShooterPreset?.label ?? "Choose an operator"}</strong>
                  <p>{selectedShooterPreset?.tagline ?? "Walk through the phases to mint."}</p>
                </div>
              </div>
              <div className="phase-progress">
                {phaseSteps.map((step, index) => {
                  const isActive = step.key === phase;
                  const isComplete =
                    currentMintStepIndex >= 0 &&
                    index <= currentMintStepIndex &&
                    phase !== "extend-operator";
                  return (
                    <div
                      className={`phase-progress-item${isActive ? " active" : ""}${isComplete ? " complete" : ""}`}
                      key={step.key}
                    >
                      <span className="phase-progress-index">{index + 1}</span>
                      <span className="phase-progress-label">{step.label}</span>
                    </div>
                  );
                })}
                <div className={`phase-progress-item${phase === "extend-operator" ? " active" : ""}`}>
                  <span className="phase-progress-index">E</span>
                  <span className="phase-progress-label">Extend</span>
                </div>
              </div>
              <div className="phase-sidebar-meta">
                <p>Wallet: {formatWalletAddress(walletAddress)}</p>
                <p>Status: {walletStatusLabel}</p>
                <p>Mint status: {mintStatus}</p>
              </div>
            </aside>
            <section className="phase-panel">{renderPhasePanel()}</section>
          </section>
        )}

        {phase === "home" ? renderPhasePanel() : null}

        {apiNotice ? <div className="notice-callout">{apiNotice}</div> : null}
        {walletSessionError ? (
          <div className="error-callout">Wallet verification error: {walletSessionError}</div>
        ) : null}
        {sourceAssetError ? <div className="error-callout">{sourceAssetError}</div> : null}
        {error ? <div className="error-callout">{error}</div> : null}
        {renewNotice ? <div className="notice-callout">{renewNotice}</div> : null}
        {renewError ? <div className="error-callout">{renewError}</div> : null}
      </main>
    </div>
  );
}

export default App;
