import { type useDAppKit } from "@mysten/dapp-kit-react";
import {
  READY_AVATAR_MAX_EPOCHS,
  type ManifestRecord,
  type ReadyAvatarManifest,
  type WalrusAvatarStorage,
} from "@pacific/shared";
import { Transaction } from "@mysten/sui/transactions";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { webEnv } from "../env";
import { readResponseError, type WalletSession } from "./session";
import { collectWalrusAssets, extendWalrusStorageWindow } from "./walrus-storage";

type DAppKitInstance = ReturnType<typeof useDAppKit>;
type WalrusEnabledClient = SuiGrpcClient & {
  walrus: {
    extendBlob(options: { blobObjectId: string; epochs: number }): (tx: Transaction) => Promise<void>;
  };
};
type TransactionResultWithEffects = Awaited<
  ReturnType<DAppKitInstance["signAndExecuteTransaction"]>
>;

const LEGACY_AVATAR_OBJECT_TYPE = `${webEnv.avatarPackageId}::simple_avatar::Avatar`;
const AVATAR_OBJECT_TYPE = `${webEnv.avatarPackageId}::avatar::Avatar`;
const LEGACY_AVATAR_MINT_TARGET = `${webEnv.avatarPackageId}::simple_avatar::mint`;
const AVATAR_MINT_TARGET = `${webEnv.avatarPackageId}::avatar::mint`;
const LEGACY_MANIFEST_PREFIX = "walrus://";

function ensureTransactionSucceeded(
  result: TransactionResultWithEffects,
  fallbackMessage: string,
) {
  if (result.$kind === "FailedTransaction") {
    throw new Error(result.FailedTransaction.status.error?.message ?? fallbackMessage);
  }

  return result.Transaction;
}

function extractCreatedOwnedObjectId(
  result: TransactionResultWithEffects,
  owner: string,
) {
  const transaction = ensureTransactionSucceeded(result, "Transaction execution failed.");
  const createdObject = transaction.effects?.changedObjects.find((object) =>
    object.idOperation === "Created" &&
    object.outputState === "ObjectWrite" &&
    object.outputOwner?.$kind === "AddressOwner" &&
    object.outputOwner.AddressOwner === owner,
  );

  return createdObject?.objectId ?? null;
}

async function listOwnedAvatarObjectIdsByType(
  client: SuiGrpcClient,
  owner: string,
  objectType: string,
) {
  const { response } = await client.stateService.listOwnedObjects({
    owner,
    objectType,
    readMask: {
      paths: ["object_id", "object_type", "previous_transaction"],
    },
  });

  return response.objects ?? [];
}

async function resolveMintTarget(client: unknown) {
  const packageInspector = client as {
    getNormalizedMoveModulesByPackage?: (input: {
      package: string;
    }) => Promise<Record<string, unknown>>;
  } | null;
  const modules = await packageInspector?.getNormalizedMoveModulesByPackage?.({
    package: webEnv.avatarPackageId,
  });

  if (modules && "avatar" in modules) {
    return "avatar" as const;
  }

  return "legacy" as const;
}

export async function findOwnedAvatarObjectId(
  client: SuiGrpcClient,
  owner: string,
  afterDigest?: string,
) {
  const [avatarObjects, legacyObjects] = await Promise.all([
    listOwnedAvatarObjectIdsByType(client, owner, AVATAR_OBJECT_TYPE),
    listOwnedAvatarObjectIdsByType(client, owner, LEGACY_AVATAR_OBJECT_TYPE),
  ]);
  const objects = [...avatarObjects, ...legacyObjects];
  if (afterDigest) {
    const exactMatch = objects.find((object) => object.previousTransaction === afterDigest);
    if (exactMatch?.objectId) {
      return exactMatch.objectId;
    }
  }

  return objects[0]?.objectId ?? null;
}

export async function mintAvatarObject(
  client: unknown,
  dAppKit: DAppKitInstance,
  owner: string,
  args: {
    name: string;
    description: string;
    manifestBlobId: string;
    previewBlobId: string;
    previewUrl: string;
    projectUrl: string;
    schemaVersion: number;
    legacyRig: string;
  },
): Promise<{
  digest: string;
  avatarObjectId: string | null;
}> {
  const mintTarget = await resolveMintTarget(client);
  const tx = new Transaction();
  if (mintTarget === "avatar") {
    tx.moveCall({
      target: AVATAR_MINT_TARGET,
      arguments: [
        tx.pure.string(args.name),
        tx.pure.string(args.description),
        tx.pure.string(args.manifestBlobId),
        tx.pure.string(args.previewBlobId),
        tx.pure.string(args.previewUrl),
        tx.pure.string(args.projectUrl),
        tx.pure.u64(args.schemaVersion),
      ],
    });
  } else {
    tx.moveCall({
      target: LEGACY_AVATAR_MINT_TARGET,
      arguments: [
        tx.pure.string(args.name),
        tx.pure.string(args.legacyRig),
        tx.pure.string(`${LEGACY_MANIFEST_PREFIX}${args.manifestBlobId}`),
      ],
    });
  }

  const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
  const transaction = ensureTransactionSucceeded(result, "Avatar publish failed.");

  return {
    digest: transaction.digest,
    avatarObjectId: extractCreatedOwnedObjectId(result, owner),
  };
}

export async function persistManifestRecord(
  session: WalletSession,
  manifest: ReadyAvatarManifest,
  record: ManifestRecord,
) {
  const response = await fetch(`${webEnv.apiBaseUrl}/avatar/manifest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.token}`,
    },
    body: JSON.stringify({
      ...record,
      manifest,
    }),
  });

  if (!response.ok) {
    throw new Error(await readResponseError(response, "Manifest persistence failed."));
  }

  return response.json();
}

export async function syncWalrusStorageRecord(
  session: WalletSession,
  avatarObjectId: string,
  walrusStorage: WalrusAvatarStorage,
) {
  const response = await fetch(`${webEnv.apiBaseUrl}/avatar/storage/sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.token}`,
    },
    body: JSON.stringify({
      avatarObjectId,
      walrusStorage,
    }),
  });

  if (!response.ok) {
    throw new Error(await readResponseError(response, "Walrus storage sync failed."));
  }

  return response.json();
}

export async function extendAvatarWalrusStorage(args: {
  client: WalrusEnabledClient;
  dAppKit: DAppKitInstance;
  walrusStorage: WalrusAvatarStorage;
  epochs?: number;
}) {
  const epochs = args.epochs ?? READY_AVATAR_MAX_EPOCHS;
  const assets = collectWalrusAssets(args.walrusStorage);
  if (assets.length === 0) {
    throw new Error("No Walrus assets are available to renew for this avatar.");
  }

  const transaction = new Transaction();
  for (const asset of assets) {
    transaction.add(
      args.client.walrus.extendBlob({
        blobObjectId: asset.blobObjectId,
        epochs,
      }),
    );
  }

  const result = await args.dAppKit.signAndExecuteTransaction({ transaction });
  const executed = ensureTransactionSucceeded(result, "Walrus renewal transaction failed.");
  const nextWalrusStorage = extendWalrusStorageWindow(args.walrusStorage, epochs);
  if (!nextWalrusStorage) {
    throw new Error("Walrus renewal succeeded but storage state could not be updated.");
  }

  return {
    digest: executed.digest,
    walrusStorage: nextWalrusStorage,
  };
}
