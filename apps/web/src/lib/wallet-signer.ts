import { type useDAppKit } from "@mysten/dapp-kit-react";
import {
  SIGNATURE_FLAG_TO_SCHEME,
  Signer,
  type PublicKey,
  type SignatureScheme,
} from "@mysten/sui/cryptography";
import { publicKeyFromSuiBytes } from "@mysten/sui/verify";
import { toBase64 } from "@mysten/utils";

type DAppKitInstance = ReturnType<typeof useDAppKit>;
type SignAndExecuteInput = Parameters<Signer["signAndExecuteTransaction"]>[0];
type SignAndExecuteOutput = Awaited<
  ReturnType<Signer["signAndExecuteTransaction"]>
>;

export class DAppKitSigner extends Signer {
  constructor(private readonly dAppKit: DAppKitInstance) {
    super();
  }

  override async sign(): Promise<Uint8Array<ArrayBuffer>> {
    throw new Error("DAppKitSigner does not support raw digest signing.");
  }

  override getPublicKey(): PublicKey {
    const account = this.dAppKit.stores.$connection.get().account;
    if (!account) {
      throw new Error("No wallet account is connected.");
    }

    return publicKeyFromSuiBytes(new Uint8Array(account.publicKey), {
      address: account.address,
    });
  }

  override getKeyScheme(): SignatureScheme {
    return SIGNATURE_FLAG_TO_SCHEME[
      this.getPublicKey().flag() as keyof typeof SIGNATURE_FLAG_TO_SCHEME
    ];
  }

  override async signTransaction(bytes: Uint8Array) {
    return this.dAppKit.signTransaction({
      transaction: toBase64(bytes),
    });
  }

  override async signPersonalMessage(bytes: Uint8Array) {
    return this.dAppKit.signPersonalMessage({
      message: bytes,
    });
  }

  override async signAndExecuteTransaction({
    transaction,
  }: SignAndExecuteInput): Promise<SignAndExecuteOutput> {
    const result = await this.dAppKit.signAndExecuteTransaction({ transaction });
    return ((result.$kind === "Transaction"
      ? result.Transaction
      : result.FailedTransaction) as unknown) as SignAndExecuteOutput;
  }
}
