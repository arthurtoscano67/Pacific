import { type useDAppKit } from "@mysten/dapp-kit-react";
import type { ManifestRecord, ReadyAvatarManifest } from "@pacific/shared";
import { Transaction } from "@mysten/sui/transactions";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { webEnv } from "../env";
import { readResponseError, type WalletSession } from "./session";

type DAppKitInstance = ReturnType<typeof useDAppKit>;
type TransactionResultWithEffects = Awaited<
  ReturnType<DAppKitInstance["signAndExecuteTransaction"]>
>;

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

const AVATAR_OBJECT_TYPE = `${webEnv.avatarPackageId}::simple_avatar::Avatar`;
const AVATAR_MINT_TARGET = `${webEnv.avatarPackageId}::simple_avatar::mint`;

export async function findOwnedAvatarObjectId(
  client: SuiGrpcClient,
  owner: string,
  afterDigest?: string,
) {
  const { response } = await client.stateService.listOwnedObjects({
    owner,
    objectType: AVATAR_OBJECT_TYPE,
    readMask: {
      paths: ["object_id", "object_type", "previous_transaction"],
    },
  });

  const objects = response.objects ?? [];
  if (afterDigest) {
    const exactMatch = objects.find((object) => object.previousTransaction === afterDigest);
    if (exactMatch?.objectId) {
      return exactMatch.objectId;
    }
  }

  return objects[0]?.objectId ?? null;
}

export async function mintAvatarObject(
  dAppKit: DAppKitInstance,
  owner: string,
  name: string,
  rig: string,
  modelUrl: string,
): Promise<{
  digest: string;
  avatarObjectId: string | null;
}> {
  const tx = new Transaction();
  tx.moveCall({
    target: AVATAR_MINT_TARGET,
    arguments: [
      tx.pure.string(name),
      tx.pure.string(rig),
      tx.pure.string(modelUrl),
    ],
  });

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
