import { useCallback, useEffect, useMemo, useState } from "react";
import { CurrentAccountSigner } from "@mysten/dapp-kit-core";
import { useCurrentAccount, useCurrentClient, useDAppKit } from "@mysten/dapp-kit-react";
import { ConnectButton } from "@mysten/dapp-kit-react/ui";
import {
  READY_AVATAR_DEFAULT_EPOCHS,
  READY_AVATAR_MANIFEST_MIME,
  READY_AVATAR_NETWORK,
  READY_AVATAR_PREVIEW_MIME,
  READY_AVATAR_SCHEMA,
  READY_AVATAR_TYPE,
  type ShooterCharacter,
  type ManifestRecord,
  type ReadyAvatarManifest,
} from "@pacific/shared";
import { webEnv, webEnvLimits } from "./env";
import {
  ensureWalletSession,
  isApiAvailable,
  type WalletSession,
} from "./lib/session";
import {
  findOwnedAvatarObjectId,
  mintAvatarObject,
  persistManifestRecord,
} from "./lib/avatar-chain";
import { persistLastPublishedAvatar } from "./lib/published-avatar";
import {
  SHOOTER_CHARACTER_PRESETS,
  createShooterPresetPreviewBlob,
  findShooterPresetById,
  type ShooterCharacterPreset,
} from "./lib/shooter-character-presets";
import { SiteTabs } from "./components/SiteTabs";

type UploadResult = {
  blobId: string;
  blobObjectId: string;
};

type UploadedAsset = UploadResult & {
  filename: string;
  mime: string;
  size: number;
};

type WorkflowPhase =
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

function createWalrusUrl(blobId: string) {
  return `walrus://${blobId}`;
}

function formatLimitMb(limitMb: number) {
  return `${limitMb} MB`;
}

function formatFileMeta(file: File) {
  return `${file.name} (${(file.size / (1024 * 1024)).toFixed(1)} MB)`;
}

function formatBytes(value: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "n/a";
  }

  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
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

function App() {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const dAppKit = useDAppKit();
  const [session, setSession] = useState<WalletSession | null>(null);
  const [name, setName] = useState("MFPS Shooter Avatar");
  const [description, setDescription] = useState(
    "Pacific shooter NFT that launches into MFPS multiplayer.",
  );
  const [sourceAssetFile, setSourceAssetFile] = useState<File | null>(null);
  const [sourceAssetError, setSourceAssetError] = useState<string | null>(null);
  const [characterAssetFile, setCharacterAssetFile] = useState<File | null>(null);
  const [selectedShooterPresetId, setSelectedShooterPresetId] = useState<string>(
    SHOOTER_CHARACTER_PRESETS[0]?.id ?? "",
  );
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [activeManifestBlobId, setActiveManifestBlobId] = useState<string | null>(null);
  const [activeStatus, setActiveStatus] = useState("not-found");
  const [apiAvailable, setApiAvailable] = useState<boolean | null>(null);
  const [apiNotice, setApiNotice] = useState<string | null>(null);
  const [walletSessionState, setWalletSessionState] = useState<WalletSessionState>("idle");
  const [walletSessionError, setWalletSessionError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [workflowPhase, setWorkflowPhase] = useState<WorkflowPhase>("idle");
  const [workflowDetail, setWorkflowDetail] = useState(
    "Step 1: pick Shooter. Step 2: pick an MFPS character. Step 3: mint and launch.",
  );
  const [publishState, setPublishState] = useState<PublishState | null>(null);
  const [selectedGameMode, setSelectedGameMode] = useState<GameMode | null>(() => {
    const mode = new URLSearchParams(window.location.search).get("mode");
    return mode === "shooter" ? "shooter" : null;
  });

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
        detail: shooterSelected ? "Shooter mode ready." : "Choose Shooter mode.",
      },
      {
        id: "character",
        label: "MFPS character selected",
        ready: Boolean(selectedShooterPreset),
        detail: selectedShooterPreset
          ? `${selectedShooterPreset.label} (${selectedShooterPreset.prefabResource}) selected.`
          : "Select an MFPS character preset.",
      },
      {
        id: "preview",
        label: "Mint preview generated",
        ready: Boolean(previewBlob && previewUrl),
        detail:
          previewBlob && previewUrl
            ? "Preview image ready for manifest."
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
  const selectedOperatorLabel = selectedShooterPreset
    ? `${selectedShooterPreset.label} / ${selectedShooterPreset.prefabResource}`
    : "No operator selected";
  const heroPreviewImage =
    previewUrl ?? selectedShooterPreset?.previewImagePath ?? "/marketing/runtime-hub.png";
  const walletSessionSummary =
    walletSessionState === "ready"
      ? `Verified until ${formatIsoDate(session?.expiresAt)}`
      : walletSessionState === "verifying"
        ? "Waiting for wallet signature approval."
        : apiAvailable === false
          ? "API offline. Mint can continue, but backend sync will wait."
          : walletAddress
            ? "Session will be requested before final mint sync."
            : "Connect wallet to verify save-back session.";
  const walrusWriteCount = 3 + (sourceAssetFile ? 1 : 0);
  const estimatedWalletPromptCount =
    walrusWriteCount + 1 + (apiAvailable === false ? 0 : 1);
  const signatureChecklist = [
    apiAvailable === false
      ? "Backend session signature is skipped while the local API is offline."
      : "Approve the wallet session signature so minting and save-back are tied to your wallet.",
    `Approve ${walrusWriteCount} Walrus upload signature${
      walrusWriteCount === 1 ? "" : "s"
    } for runtime, preview, manifest${sourceAssetFile ? ", and source asset" : ""}.`,
    "Approve the final Sui transaction signature that mints the Avatar object on-chain.",
    "Do not close the tab, leave the page, or dismiss any remaining wallet prompt until the flow finishes.",
  ];
  const createStatusChips = [
    walletAddress ? "Wallet armed" : "Wallet offline",
    shooterSelected ? "Shooter pipeline" : "Mode pending",
    walletSessionState === "ready" ? "Session verified" : "Session pending",
    publishReady ? "Mint payload greenlit" : "Mint payload blocked",
  ];

  const updateWorkflow = useCallback(
    (phase: WorkflowPhase, detail: string, nextBusyLabel: string | null = null) => {
      setWorkflowPhase(phase);
      setWorkflowDetail(detail);
      setBusyLabel(nextBusyLabel);
    },
    [],
  );

  const chooseShooterMode = useCallback(() => {
    setSelectedGameMode("shooter");
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("mode", "shooter");
    window.history.replaceState({}, "", `${nextUrl.pathname}${nextUrl.search}`);
    updateWorkflow(
      "idle",
      "Shooter selected. Pick an MFPS character preset, mint, then launch multiplayer.",
    );
  }, [updateWorkflow]);

  const buildShooterLaunchHref = useCallback(
    (avatarObjectId?: string | null, manifestBlobId?: string | null) => {
      const url = new URL("/unity", window.location.origin);
      url.searchParams.set("mode", "shooter");
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
        : `Local API not detected at ${webEnv.apiBaseUrl}. Publish will continue without backend session, manifest caching, or active-avatar lookup.`,
    );
    return available;
  }, []);

  const refreshActiveAvatar = useCallback(async () => {
    if (!walletAddress) {
      setActiveManifestBlobId(null);
      setActiveStatus("not-found");
      return;
    }

    const available = apiAvailable ?? (await probeApiAvailability());
    if (!available) {
      return;
    }

    try {
      const response = await fetch(
        `${webEnv.apiBaseUrl}/avatar/${encodeURIComponent(walletAddress)}`,
      );
      if (!response.ok) {
        return;
      }

      const data = (await response.json()) as {
        manifestBlobId: string | null;
        status: string;
      };
      setActiveManifestBlobId(data.manifestBlobId);
      setActiveStatus(data.status);
      setApiAvailable(true);
      setApiNotice(null);
    } catch (caught) {
      setApiAvailable(false);
      setApiNotice(`Active-avatar lookup is unavailable: ${formatError(caught)}`);
    }
  }, [apiAvailable, probeApiAvailability, walletAddress]);

  useEffect(() => {
    void probeApiAvailability();
  }, [probeApiAvailability]);

  useEffect(() => {
    void refreshActiveAvatar();
  }, [refreshActiveAvatar]);

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
  }, [apiAvailable, dAppKit, walletAddress]);

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
        updateWorkflow(
          "idle",
          shooterSelected
            ? "Shooter selected. Pick a character preset and mint."
            : "Step 1: pick Shooter. Step 2: choose an MFPS character and mint.",
        );
        return;
      }

      if (file.size > webEnvLimits.maxRuntimeAvatarBytes) {
        const message = `Character asset exceeds the ${formatLimitMb(webEnv.maxRuntimeAvatarMb)} limit.`;
        setCharacterAssetFile(null);
        setError(message);
        updateWorkflow("error", message);
        return;
      }

      updateWorkflow(
        "preview loaded",
        `Attached shooter character override file: ${formatFileMeta(file)}. VRM uploads can take several minutes, so keep the tab open until mint completes.`,
      );
    },
    [shooterSelected, updateWorkflow],
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
        deletable: true,
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
      };
    },
    [client.walrus, signer, walletAddress],
  );

  const handlePublish = useCallback(async () => {
    setError(null);

    if (!shooterSelected) {
      const message = "Pick Shooter first, then mint.";
      setError(message);
      updateWorkflow("error", message);
      return;
    }

    if (mintBlockingReasons.length > 0) {
      const message = `Mint blocked: ${mintBlockingReasons.join(" ")}`;
      setError(message);
      updateWorkflow("error", message);
      return;
    }

    if (!walletAddress || !selectedShooterPreset || !previewBlob || !previewUrl) {
      const message = "Mint requirements changed during validation. Reload and try again.";
      setError(message);
      updateWorkflow("error", message);
      return;
    }

    if (!packageConfigured) {
      const message =
        "Set VITE_AVATAR_PACKAGE_ID to the published Avatar Move package before publishing. The app is still using the placeholder value 0x0.";
      setError(message);
      updateWorkflow("error", message);
      return;
    }

    try {
      const available = await probeApiAvailability();
      if (available) {
        updateWorkflow(
          "verifying wallet session",
          "Approve the wallet verification signature first. This links the mint pipeline and post-match save-back to your current wallet.",
          "Waiting for wallet signature",
        );
        const nextSession = await ensureSession();
        setSession(nextSession);
        setWalletSessionState("ready");
        setWalletSessionError(null);
      }

      const sourceAssetUpload = sourceAssetFile
        ? await (async () => {
            updateWorkflow(
              "uploading source asset blob",
              "Approve the Walrus upload signature for the archival source asset. Large VRM/source files can take several minutes. Do not close or leave.",
              "Awaiting source asset approval",
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

      updateWorkflow(
        "uploading runtime character blob",
        "Approve the Walrus upload signature for the runtime character payload. If this is a VRM, keep the page open until the upload finalizes.",
        "Awaiting runtime upload approval",
      );
      const runtimeUpload = await uploadWalrusBlob(
        runtimeUploadInput.body,
        runtimeUploadInput.filename,
        runtimeUploadInput.mime,
      );

      updateWorkflow(
        "uploading preview blob",
        "Approve the Walrus upload signature for the preview image.",
        "Awaiting preview approval",
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

      const manifest: ReadyAvatarManifest = {
        schema: READY_AVATAR_SCHEMA,
        type: READY_AVATAR_TYPE,
        name,
        description: description.trim() || undefined,
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

      updateWorkflow(
        "uploading manifest blob",
        "Approve the Walrus upload signature for the manifest. This binds the NFT to the operator, stats seed, and runtime metadata.",
        "Awaiting manifest approval",
      );
      const manifestBuffer = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
      const manifestUpload = await uploadWalrusBlob(
        manifestBuffer,
        "manifest.json",
        READY_AVATAR_MANIFEST_MIME,
      );

      updateWorkflow(
        "publishing avatar object",
        "Approve the final Sui mint transaction. Do not close the wallet, switch tabs, or leave until the transaction confirms.",
        "Awaiting on-chain mint signature",
      );
      const rigLabel = `${shooterRuntimeFormat}:${shooterCharacter.id}`;
      const mintResult = await mintAvatarObject(
        dAppKit,
        walletAddress,
        name,
        rigLabel,
        createWalrusUrl(manifestUpload.blobId),
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

      setActiveManifestBlobId(manifestUpload.blobId);
      setActiveStatus("playable");
      updateWorkflow(
        "success",
        "Mint complete. Loading MFPS shooter runtime with your minted character profile...",
      );

      window.setTimeout(() => {
        window.location.assign(buildShooterLaunchHref(avatarObjectId, manifestUpload.blobId));
      }, 450);

      void syncManifestRecord(manifest, manifestRecord).then((persisted) => {
        if (!persisted) {
          return;
        }

        setPublishState((current) =>
          current && current.manifestRecord.manifestBlobId === manifestRecord.manifestBlobId
            ? { ...current, apiPersisted: true }
            : current,
        );
        void refreshActiveAvatar();
      });
    } catch (caught) {
      const message = formatError(caught);
      setError(message);
      updateWorkflow("error", message);
    }
  }, [
    buildShooterLaunchHref,
    characterAssetFile,
    client,
    dAppKit,
    description,
    name,
    packageConfigured,
    mintBlockingReasons,
    previewBlob,
    previewUrl,
    refreshActiveAvatar,
    selectedShooterPreset,
    shooterSelected,
    sourceAssetFile,
    syncManifestRecord,
    updateWorkflow,
    uploadWalrusBlob,
    walletAddress,
  ]);

  return (
    <div className="app-shell app-shell--create">
      <header className="topbar">
        <div className="topbar-copy">
          <p className="eyebrow">Pacific Strike Network</p>
          <h1>Forge a wallet-owned operator and deploy it straight into MFPS.</h1>
          <p className="lede">
            This is a shooter command center now, not a crypto form. Connect your wallet, choose
            the operator, finish every signature, mint on Sui + Walrus, and jump directly into the
            verified runtime.
          </p>
          <SiteTabs activeRoute="create" />
        </div>
        <div className="wallet-shell">
          <ConnectButton />
        </div>
      </header>

      <section className="panel hero-banner create-hero-banner">
        <div className="hero-banner-copy">
          <span className="panel-label">Operator Foundry</span>
          <h2>Mint once. Own the operator. Launch the same NFT into multiplayer.</h2>
          <p>
            Sui proves ownership, Walrus stores the runtime package and manifest, and the Unity
            launcher injects the minted operator profile into MFPS. The critical path is now one
            clear flow instead of a stack of setup panels.
          </p>
          <div className="status-chip-row">
            {createStatusChips.map((chip) => (
              <span className="status-chip" key={chip}>
                {chip}
              </span>
            ))}
          </div>
          <div className="hero-stat-grid">
            <article className="stat-card">
              <span className="panel-label">Selected Operator</span>
              <strong>{selectedOperatorLabel}</strong>
              <p>Current live preset queued for mint and Unity handoff.</p>
            </article>
            <article className="stat-card">
              <span className="panel-label">Wallet Prompts</span>
              <strong>{estimatedWalletPromptCount}</strong>
              <p>
                Session verification, Walrus writes, and the final on-chain mint each need wallet
                approval.
              </p>
            </article>
            <article className="stat-card">
              <span className="panel-label">Save Session</span>
              <strong>{walletSessionState}</strong>
              <p>{walletSessionSummary}</p>
            </article>
            <article className="stat-card">
              <span className="panel-label">Mint Readiness</span>
              <strong>
                {readinessCount}/{mintReadiness.length}
              </strong>
              <p>Required checks green before the mint button can fire.</p>
            </article>
          </div>
          <div className="hero-action-row">
            <a className="primary-button" href="#mint-command">
              Open Mint Console
            </a>
            <a
              className="secondary-button"
              href={buildShooterLaunchHref(
                publishState?.avatarObjectId ?? null,
                publishState?.manifestBlob.blobId ?? null,
              )}
            >
              Open Runtime Hub
            </a>
          </div>
        </div>
        <div className="hero-banner-media">
          <div className="hero-media-frame">
            <img src={heroPreviewImage} alt="Selected operator preview" />
            <div className="hero-media-overlay">
              <span className="panel-label">Live Preview</span>
              <strong>{selectedShooterPreset?.label ?? "Awaiting operator selection"}</strong>
              <p>{selectedShooterPreset?.tagline ?? "Select a shooter preset to preview the mint."}</p>
            </div>
          </div>
        </div>
      </section>

      <main className="create-layout">
        <section className="create-left-rail">
          <section className="panel upload-panel command-panel" id="mint-command">
            <div className="panel-copy">
              <span className="panel-label">Mint Console</span>
              <h2>Connect, configure, sign, mint.</h2>
              <p>
                The mint button is the only action that matters here. Everything in this panel is
                structured to make that path obvious and hard to misread.
              </p>
            </div>

            <div className="step-grid">
              <article className="validation-card step-card">
                <span className="panel-label">Step 01</span>
                <strong>{shooterSelected ? "Shooter locked" : "Choose shooter mode"}</strong>
                <p>
                  This build only mints MFPS-ready shooter operators, so mode selection is fixed
                  before anything is uploaded.
                </p>
                <button
                  className="mode-select-button"
                  disabled={shooterSelected}
                  onClick={chooseShooterMode}
                >
                  {shooterSelected ? "Shooter Locked In" : "Choose Shooter"}
                </button>
              </article>
              <article className="validation-card step-card">
                <span className="panel-label">Step 02</span>
                <strong>Wallet verification</strong>
                <p>{walletSessionSummary}</p>
                <p className="helper-copy">
                  Wallet: {walletAddress ?? "Connect a Sui wallet to arm the mint flow."}
                </p>
              </article>
              <article className="validation-card step-card">
                <span className="panel-label">Step 03</span>
                <strong>{workflowPhase}</strong>
                <p>{workflowDetail}</p>
                <p className="helper-copy">Active manifest state: {activeStatus}</p>
              </article>
            </div>

            <div className="field-grid">
              <label className="field">
                <span>Operator name</span>
                <input
                  value={name}
                  disabled={!shooterSelected}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>

              <label className="field field--full">
                <span>Operator briefing</span>
                <textarea
                  rows={3}
                  value={description}
                  disabled={!shooterSelected}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
            </div>

            <div className="validation-card signature-panel">
              <div className="signature-panel-head">
                <div>
                  <span className="panel-label">Finish Every Signature</span>
                  <strong>Wallet prompts are part of the mint path.</strong>
                </div>
                <span className="signature-count">{estimatedWalletPromptCount} prompts expected</span>
              </div>
              <ul className="signature-list">
                {signatureChecklist.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>

            <div className="notice-callout critical-callout">
              VRM and large runtime uploads can take minutes. Do not close the tab, refresh,
              switch wallets, or leave this page until the mint finishes and the launcher moves you
              into the runtime.
            </div>

            <details
              className="intel-drawer"
              open={Boolean(sourceAssetFile || characterAssetFile)}
            >
              <summary>Optional creator files</summary>
              <div className="drawer-content">
                <label className="upload-drop">
                  <span>
                    Source Asset Archive
                    <span className="upload-help">
                      Optional archival/master file up to {formatLimitMb(webEnv.maxSourceAssetMb)}.
                    </span>
                  </span>
                  <input
                    type="file"
                    disabled={!shooterSelected}
                    onChange={(event) => handleSourceAssetChange(event.target.files?.[0] ?? null)}
                  />
                  <span className="upload-help">
                    Stored on Walrus for archival or import workflows. Shooter runtime uses the
                    minted manifest and runtime payload, not this source archive directly.
                  </span>
                </label>
                {sourceAssetFile ? (
                  <p className="upload-meta">Selected source asset: {formatFileMeta(sourceAssetFile)}</p>
                ) : (
                  <p className="upload-meta">No archival source asset attached. This is optional.</p>
                )}

                <label className="upload-drop">
                  <span>
                    Character Runtime Asset Override
                    <span className="upload-help">
                      Optional runtime file up to {formatLimitMb(webEnv.maxRuntimeAvatarMb)}.
                    </span>
                  </span>
                  <input
                    type="file"
                    disabled={!shooterSelected}
                    onChange={(event) => handleCharacterAssetChange(event.target.files?.[0] ?? null)}
                  />
                  <span className="upload-help">
                    Leave empty to mint the selected MFPS preset descriptor. Uploading a custom VRM
                    or character asset keeps the same Walrus flow, but the upload can take longer.
                  </span>
                </label>
                {characterAssetFile ? (
                  <p className="upload-meta">
                    Character override selected: {formatFileMeta(characterAssetFile)}
                  </p>
                ) : (
                  <p className="upload-meta">
                    Using selected MFPS preset descriptor for the minted runtime payload.
                  </p>
                )}
              </div>
            </details>

            <div className="cta-row">
              <button
                className="primary-button primary-button--wide"
                disabled={!publishReady || !!busyLabel}
                onClick={() => void handlePublish()}
              >
                {busyLabel ?? "Mint Shooter NFT on Walrus + Sui"}
              </button>
              <a
                className="secondary-button"
                href={buildShooterLaunchHref(
                  publishState?.avatarObjectId ?? null,
                  publishState?.manifestBlob.blobId ?? null,
                )}
              >
                Launch Shooter Multiplayer
              </a>
            </div>

            {!packageConfigured ? (
              <div className="notice-callout">
                Configure `VITE_AVATAR_PACKAGE_ID` with the published Avatar Move package before
                on-chain mint can succeed.
              </div>
            ) : null}
            {sourceAssetError ? <div className="error-callout">{sourceAssetError}</div> : null}
            {walletSessionError ? <div className="error-callout">{walletSessionError}</div> : null}
            {apiNotice ? <div className="notice-callout">{apiNotice}</div> : null}
            {error ? <div className="error-callout">{error}</div> : null}
          </section>
        </section>

        <aside className="create-right-rail">
          <section className="panel operator-selection-panel">
            <div className="panel-copy">
              <span className="panel-label">Operator Deck</span>
              <h2>Pick the operator players will actually see in MFPS.</h2>
              <p>
                These presets are the shooter characters mapped into the Unity runtime. The active
                selection drives the NFT preview, prefab mapping, and launch profile.
              </p>
            </div>

            <div className="shooter-character-grid">
              {SHOOTER_CHARACTER_PRESETS.map((preset) => {
                const active = preset.id === selectedShooterPreset?.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    className={`shooter-character-card${active ? " active" : ""}`}
                    disabled={!shooterSelected}
                    onClick={() => {
                      setSelectedShooterPresetId(preset.id);
                      setPublishState(null);
                      setError(null);
                    }}
                  >
                    <div className="shooter-character-thumb">
                      <img src={preset.previewImagePath} alt={`${preset.label} operator preview`} />
                    </div>
                    <strong>{preset.label}</strong>
                    <p>{preset.role}</p>
                    <p className="shooter-character-meta">{preset.prefabResource}</p>
                    <p className="shooter-character-meta">{preset.tagline}</p>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="panel runtime-panel operator-spotlight-panel">
            <div className="panel-copy">
              <span className="panel-label">Spotlight</span>
              <h2>{selectedShooterPreset?.label ?? "Choose an operator preset"}</h2>
              <p>
                This is the final operator card that feeds the mint preview, stats seed, and
                runtime payload descriptor.
              </p>
            </div>

            {previewUrl ? (
              <div className="mint-preview-image runtime-preview-panel">
                <img
                  src={previewUrl}
                  alt={`${selectedShooterPreset?.label ?? "Selected"} minted operator preview`}
                />
              </div>
            ) : (
              <div className="mint-preview-placeholder runtime-preview-panel">
                Preview pending. Select an operator and the mint preview will generate here.
              </div>
            )}

            <div className="stat-card-grid">
              <article className="stat-card">
                <span className="panel-label">Role</span>
                <strong>{selectedShooterPreset?.role ?? "n/a"}</strong>
                <p>Combat role baked into the launcher metadata.</p>
              </article>
              <article className="stat-card">
                <span className="panel-label">Runtime</span>
                <strong>{runtimeUploadPlan?.source ?? "n/a"}</strong>
                <p>{runtimeUploadPlan?.filename ?? "No runtime payload selected yet."}</p>
              </article>
              <article className="stat-card">
                <span className="panel-label">Stats Seed</span>
                <strong>
                  W {shooterInitialStats.wins} / L {shooterInitialStats.losses} / HP{" "}
                  {shooterInitialStats.hp}
                </strong>
                <p>Initial NFT-linked shooter profile stored with the manifest.</p>
              </article>
              <article className="stat-card">
                <span className="panel-label">Multiplayer Seed</span>
                <strong>{shooterMultiplayerDefaults.maxPlayers} players</strong>
                <p>
                  {shooterMultiplayerDefaults.maxConcurrentMatches} matches /{" "}
                  {shooterMultiplayerDefaults.tickRate}hz runtime budget.
                </p>
              </article>
            </div>

            <div className="validation-card mint-preview-card">
              <div className="mint-preview-head">
                <span className="panel-label">Mint Readiness</span>
                <strong>
                  {readinessCount === mintReadiness.length
                    ? "Payload greenlit"
                    : "Pending requirements"}
                </strong>
              </div>
              <ul className="mint-readiness-list">
                {mintReadiness.map((item) => (
                  <li key={item.id} className={item.ready ? "ready" : "missing"}>
                    <span>{item.label}</span>
                    <em>{item.ready ? "ready" : "missing"}</em>
                  </li>
                ))}
              </ul>
              <p className={`mint-readiness-note${mintBlockingReasons.length > 0 ? "" : " ready"}`}>
                {mintBlockingReasons.length > 0
                  ? `Mint is blocked until: ${mintBlockingReasons.join(" ")}`
                  : "Mint payload is complete and ready for Unity MFPS handoff."}
              </p>
            </div>

            <details className="intel-drawer">
              <summary>Minted object + relay intel</summary>
              <div className="drawer-content status-grid">
                <article>
                  <span className="panel-label">Live state</span>
                  <p>Workflow: {workflowPhase}</p>
                  <p>{workflowDetail}</p>
                  <p>Last active manifest blob: {activeManifestBlobId ?? "none"}</p>
                  <p>Wallet: {walletAddress ?? "not connected"}</p>
                </article>
                <article>
                  <span className="panel-label">Manifest payload</span>
                  <p>Character ID: {selectedShooterPreset?.id ?? "n/a"}</p>
                  <p>Prefab: {selectedShooterPreset?.prefabResource ?? "n/a"}</p>
                  <p>Runtime mime: {runtimeUploadPlan?.mime ?? "n/a"}</p>
                  <p>Runtime size: {formatBytes(runtimeUploadPlan?.size ?? null)}</p>
                </article>
                <article>
                  <span className="panel-label">Mint result</span>
                  {publishState ? (
                    <>
                      <p>Avatar object ID: {publishState.avatarObjectId}</p>
                      <p>Manifest blob ID: {publishState.manifestBlob.blobId}</p>
                      <p>Transaction: {publishState.manifestRecord.transactionDigest}</p>
                      <p>Backend persistence: {publishState.apiPersisted ? "synced" : "local-only"}</p>
                    </>
                  ) : (
                    <p>No on-chain mint has completed in this session yet.</p>
                  )}
                </article>
              </div>
            </details>
          </section>
        </aside>
      </main>
    </div>
  );
}

export default App;
