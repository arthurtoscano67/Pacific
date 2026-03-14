import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";

import { DAppKitProvider } from "@mysten/dapp-kit-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App.tsx";
import { dAppKit } from "./dApp-kit.ts";
import { UnityPage } from "./pages/UnityPage.tsx";

const queryClient = new QueryClient();
const pathname = window.location.pathname.replace(/\/+$/, "") || "/";
const RootComponent =
  pathname === "/play" || pathname === "/world" || pathname === "/unity"
    ? UnityPage
    :
  App;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <DAppKitProvider dAppKit={dAppKit}>
        <RootComponent />
      </DAppKitProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
