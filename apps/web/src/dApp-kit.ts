import { createDAppKit } from "@mysten/dapp-kit-react";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { walrus } from "@mysten/walrus";
import walrusWasmUrl from "@mysten/walrus-wasm/web/walrus_wasm_bg.wasm?url";
import { webEnv } from "./env";

export const dAppKit = createDAppKit({
  enableBurnerWallet: import.meta.env.DEV,
  networks: ["mainnet"],
  defaultNetwork: "mainnet",
  createClient(network) {
    return new SuiGrpcClient({
      network,
      baseUrl: webEnv.suiGrpcUrl,
    }).$extend(
      walrus({
        wasmUrl: walrusWasmUrl,
        storageNodeClientOptions: {
          timeout: webEnv.walrusRequestTimeoutMs,
        },
        uploadRelay: {
          host: webEnv.walrusUploadRelayUrl,
          timeout: webEnv.walrusRequestTimeoutMs,
          sendTip: {
            max: webEnv.walrusMaxTipMist,
          },
        },
      }),
    );
  },
});

// global type registration necessary for the hooks to work correctly
declare module "@mysten/dapp-kit-react" {
  interface Register {
    dAppKit: typeof dAppKit;
  }
}
