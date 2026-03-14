Original prompt: we are building a new project, not attached to any others we already built called. Pacific. Codex, implement this exact product.

- Initialized isolated monorepo at `ready-avatar-platform/` with `apps/web`, `apps/api`, `apps/indexer`, `packages/move`, `packages/shared`, and `infra/walrus`.
- Web app scaffolded from Mysten `create-dapp` React client template and adapted to mainnet-only wallet + Walrus + VRM flow.
- Shared package contains manifest schemas and strict VRM validation that rejects generic `.glb` as an active playable avatar.
- API app implements wallet session verification, upload intent/manifest persistence, cached manifest reads, and asset gateway endpoints.
- Move package defines the `Avatar` object, update flow, display metadata, and dynamic child object field helpers/events.
- Rust indexer added for wallet-to-active-avatar and avatar history materialization.
- Fixed shared VRM validation so invalid/non-VRM uploads are classified as validation failures instead of throwing uncaught errors.
- Expanded runtime controller support with gamepad input plus deterministic `window.advanceTime(ms)` and `window.render_game_to_text()` hooks for browser testing.
- Verified `npm run typecheck`, `npm run build`, `sui move build`, and `cargo check` (with `CARGO_TARGET_DIR=/tmp/pacific_indexer_target_2` because Cargo-native deps fail when the target prefix contains spaces).
- Ran a Playwright screenshot pass against the web app shell via the `develop-web-game` client; screenshot captured at `/tmp/pacific_playwright/shot-0.png`.
- Added browser-local published-avatar persistence under `rpo:lastPublishedAvatar` and a `usePublishedAvatar` hook for runtime pages.
- Added `/play` route rendering `PlayPage` with a full-screen Three.js room, PointerLockControls mouse-look, third-person follow camera, WASD/Shift/Space controller, gravity, flat-ground detection, and room-bounds clamping.
- Added Walrus browser read utilities for `/play` that load `manifestBlobId` -> manifest JSON -> avatar blob bytes -> VRM via `GLTFLoader` + `@pixiv/three-vrm`, with no backend dependency on `localhost:3001`.
- Added publish-page `Open Play Test` button and publish-success localStorage write of avatar/preview/manifest/object/digest metadata.
- Verified `npm run typecheck` (workspace) and `npm run build -w @pacific/web` after `/play` routing/runtime changes.
- Ran `develop-web-game` Playwright client against `http://127.0.0.1:4173/play`; screenshots captured at `/tmp/pacific_playwright_play/shot-0.png` and `/tmp/pacific_playwright_play/shot-1.png` showing the expected empty state when no published-avatar localStorage record exists.
- Added on-chain avatar import utility for `/play`:
  - queries owned `Avatar` objects for connected wallet via `client.listOwnedObjects` with package-scoped type filters,
  - parses `manifest_blob_id` and `model_url` object fields,
  - sorts candidates by latest version and auto-loads the newest avatar.
- Refactored `/play` so chain-owned avatars are the primary import path; localStorage (`rpo:lastPublishedAvatar`) is now fallback only when zero on-chain avatars are found.
- Added `/play` HUD import status panel and a `Load My On-Chain Avatar` action button, plus multi-avatar picker UI (object ID + name + Load button).
- Extended Walrus runtime loader helpers to support:
  - manifest-based VRM loading,
  - direct `model_url` references (`walrus://blobId`, raw blob ID, or direct URL).
- Re-verified with `npm run typecheck -w @pacific/web`, `npm run build -w @pacific/web`, and `develop-web-game` Playwright run against `http://127.0.0.1:4174/play` (screenshot `/tmp/pacific_playwright_play_onchain/shot-0.png`).
- Reworked the product into a two-tier asset package:
  - optional `Source Asset` upload up to `VITE_MAX_SOURCE_ASSET_MB` (default 250 MB),
  - required `Playable VRM Avatar` upload up to `VITE_MAX_RUNTIME_AVATAR_MB` (default 100 MB).
- Upgraded shared manifest handling to `ready-player-avatar/2.0` / `avatar-package` and added normalized parsing so legacy `ready-avatar/1.0` manifests still load in runtime/play paths.
- Changed web publish order to:
  - upload optional source asset,
  - upload runtime VRM,
  - upload preview,
  - upload manifest v2 containing `sourceAsset`, `runtimeAvatar`, and `preview`,
  - mint `simple_avatar::Avatar` with `model_url = walrus://<manifestBlobId>`.
- Updated `/play` and runtime loaders so they only load `runtimeAvatar` from the manifest and never attempt to render `sourceAsset`.
- Updated API config/server compatibility for the new manifest shape and optional source asset expiry tracking, without making the browser import flow depend on `localhost:3001`.
- Verified after the two-tier change with:
  - `npm run typecheck`
  - `npm run build -w @pacific/shared`
  - `npm run build -w @pacific/web`
  - `develop-web-game` Playwright screenshots:
    - `/tmp/pacific_playwright_two_tier_play/shot-0.png`
    - `/tmp/pacific_playwright_two_tier_publish/shot-0.png`
- Added a real browser animation controller for `/play`:
  - one `THREE.AnimationMixer` per avatar,
  - a state machine driven by grounded state, horizontal speed, run intent, jump start, and vertical velocity,
  - transitions for `idle`, `walk`, `run`, and `jump`,
  - jump actions configured as one-shot clips with fade transitions.
- Added supported VRM animation loading via `@pixiv/three-vrm-animation`:
  - optional manifest animation references under `manifest.animations.idle|walk|run|jump`,
  - VRMA loading through `VRMAnimationLoaderPlugin` + `createVRMAnimationClip`,
  - manifest/model_url paths keep the resolved manifest so animation refs work even when `simple_avatar.model_url` points to a manifest blob.
- Added prepared retargeted humanoid fallback clips for `idle`, `walk`, `run`, and `jump` so the app no longer depends on the avatar file embedding locomotion clips.
- Added `/play` animation debug HUD fields:
  - current animation state,
  - grounded,
  - speed,
  - jump state,
  - animation issue / missing clips.
- Re-verified animation-controller work with:
  - `npm run typecheck`
  - `npm run build -w @pacific/shared`
  - `npm run build -w @pacific/web`
  - `develop-web-game` Playwright screenshots on `/play`:
    - `/tmp/pacific_playwright_animation_play/shot-0.png`
    - `/tmp/pacific_playwright_animation_play/shot-1.png`
  - browser-side controller validation against the official Pixiv sample VRM (`VRM1_Constraint_Twist_Sample.vrm`) using Playwright page evaluation:
    - observed state sequence: `idle -> walk -> run -> jump`
    - `missingStates: []`
    - `issues: []`
- Raised the Walrus browser request timeout to handle large uploads and reads:
  - added `VITE_WALRUS_REQUEST_TIMEOUT_MS` (default/local: `3600000`),
  - wired `storageNodeClientOptions.timeout` and `uploadRelay.timeout` through the web dApp client,
  - kept the higher local relay tip cap (`VITE_WALRUS_MAX_TIP_MIST=100000000`) for larger runtime/source files.

TODO:
- Full mainnet E2E still needs real values for API/database/Walrus/package-id env vars plus a published Move package on Sui mainnet.
- Runtime gameplay screenshot coverage still requires a real uploaded manifest/VRM pair so the scene can instantiate the avatar canvas path.
- Validate `/play` with a connected wallet that already owns one or more on-chain Avatar objects to confirm automatic import, multi-avatar picker behavior, and fallback behavior when no on-chain avatar exists.
- Run a real browser publish with:
  - a large source asset in the 100-250 MB range,
  - a valid runtime `.vrm`,
  - wallet confirmation,
  - then verify `/play` imports the manifest-backed runtime avatar from the connected wallet and ignores the source asset blob.
- Do one manual in-browser pass on `/play` with a real owned avatar to visually confirm fade quality, jump landing transitions, and camera-follow feel under the new animation controller.

2026-03-11 animation + movement + world polish pass:
- Fixed TypeScript build blockers in unfinished parkour scaffolding:
  - removed unused imports in `apps/web/src/components/ParkourWorldCanvas.tsx`,
  - fixed `GridHelper` material disposal typing in `apps/web/src/lib/parkour-course.ts`.
- Identified and fixed a core T-pose failure in `apps/web/src/lib/avatar-animation-controller.ts`:
  - previous behavior switched to `missing` state when *any* clip was missing, which disabled all playback.
  - new behavior uses available clips with ordered fallbacks (idle/walk/run/jump), so partial clip sets still animate.
- Re-tuned generated humanoid fallback clips in `apps/web/src/lib/prepared-humanoid-animation-clips.ts`:
  - stronger shoulder/arm-down posture in idle,
  - improved arm swing and pose continuity in walk/run/jump,
  - reduced default arms-out look on avatars that rely on prepared fallback clips.
- Improved legacy fallback clip generation in `apps/web/src/lib/avatar-runtime.ts` with arm-down shoulder tracks so runtime fallback no longer keeps T-pose shoulders.
- Replaced `apps/web/src/lib/player-controller.ts` with velocity-based locomotion:
  - acceleration/deceleration + drag,
  - stronger gravity and capped fall speed,
  - cleaner run gating and less skating/floaty motion.
- Upgraded `apps/web/src/pages/PlayPage.tsx` scene quality:
  - sky dome + fog,
  - tuned ambient/hemisphere/sun lighting with shadows,
  - spawn pad and environment props for depth,
  - avatar auto-rescale to target height and mesh shadow setup after load.
- Rebuilt `apps/web/src/components/AvatarRuntimeCanvas.tsx` to use:
  - the same movement + animation-controller pipeline (`idle/walk/run/jump`),
  - improved world lighting/background/decor,
  - runtime placeholder runner before VRM finishes loading,
  - manifest->runtimeAvatar loading path preserved (API first, Walrus fallback).
- Validation commands:
  - `npm run typecheck -w @pacific/web`
  - `npm run build -w @pacific/web`
  - both pass.
- Playwright (`develop-web-game`) checks:
  - `/play`: `node "$WEB_GAME_CLIENT" --url http://127.0.0.1:4173/play --actions-file "$WEB_GAME_ACTIONS" --iterations 1 --pause-ms 250 --screenshot-dir /tmp/pacific_playwright_animation_fix_play`
  - `/world`: `node "$WEB_GAME_CLIENT" --url http://127.0.0.1:4173/world --actions-file "$WEB_GAME_ACTIONS" --iterations 1 --pause-ms 250 --screenshot-dir /tmp/pacific_playwright_animation_fix_world`
  - screenshots generated, but no runtime state JSON because the test browser session was not wallet-connected and had no selected/published avatar manifest in storage.

Updated TODO:
- Run manual browser validation with a connected wallet and a real published avatar to confirm:
  - no T-pose at spawn,
  - idle/walk/run/jump state transitions,
  - world-page avatar visibility through manifest/Walrus load path.
- If any avatar still appears with high/arms-out shoulders, capture its manifest/object ID and add a per-avatar rest-pose correction layer (bone-offset profile) before clip playback.

2026-03-11 unified web + Unity bridge:
- Implemented API endpoint `GET /unity/profile/:wallet` in `apps/api/src/server.ts`:
  - selects active/newest cached avatar manifest for wallet (or query-selected `avatarObjectId`/`manifestBlobId`),
  - returns Unity-friendly avatar profile payload:
    - `walletAddress`, `avatarObjectId`, `manifestBlobId`, `avatarBlobId`, `previewBlobId`, `txDigest`, `runtimeState`,
    - `resolution.mode = "http"` + `resolution.httpUrl = <api>/asset/<runtimeAvatarBlobId>`,
    - `manifest.url = <api>/manifest/<manifestBlobId>`.
- Added robust helpers in API:
  - `parseManifestRuntimePointers(...)` for runtime/preview blob extraction from manifest payload,
  - `buildApiBaseUrl(request)` for generating absolute asset/manifest URLs (supports forwarded proto/host headers).
- Added Unity route to existing web app:
  - new page `apps/web/src/pages/UnityPage.tsx`,
  - new tab in `SiteTabs` (`Unity`),
  - route registration in `apps/web/src/main.tsx` (`/unity`),
  - styles in `apps/web/src/index.css` (`unity-layout`, `unity-frame`, responsive rules),
  - environment var support `VITE_UNITY_WEBGL_URL` in `apps/web/src/env.ts` + root `.env.example`.
- Unity runtime ingestion upgraded for real HTTP profile loading:
  - `UnityAvatarGame/Assets/Scripts/Networking/HttpAvatarProfileSource.cs` now fetches JSON via `UnityWebRequest` and parses `AvatarProfile`.
- Unity bootstrap now accepts web handoff query:
  - `UnityAvatarGame/Assets/Scripts/App/AppBootstrap.cs` reads `Application.absoluteURL`,
  - when `?profile=<url>` is present, it switches to HTTP profile mode and enables auto-start/auto-load.
- Added Unity WebGL export automation:
  - `UnityAvatarGame/Assets/Scripts/Editor/BuildProfileSetup.cs` now includes menu action `AvatarBridge/Build/WebGL For Ready Avatar Platform`,
  - outputs WebGL build directly to `ready-avatar-platform/apps/web/public/unity-webgl`.
- Updated `ready-avatar-platform/README.md` with unified `/unity` handoff flow and WebGL export instructions.
- Build/validation:
  - `npm run typecheck -w @pacific/api` ✅
  - `npm run build -w @pacific/api` ✅
  - `npm run build -w @pacific/web` ✅
  - Playwright smoke on `/unity` captured UI at `/tmp/pacific_playwright_unity_route/shot-0.png` ✅
  - API endpoint live test was not possible in this shell because `127.0.0.1:3001` was not running during the check.

Next TODO for full end-to-end Unity-in-site:
- Produce/export Unity WebGL build and host it at `VITE_UNITY_WEBGL_URL` (default `/unity-webgl/index.html`) under the web app static path.
- Start API server locally, connect wallet, publish avatar, open `/unity`, and verify:
  - Unity iframe launches,
  - `?profile=` reaches Unity bootstrap,
  - runtime VRM loads via API `/asset/:blobId` path.

2026-03-12 `/unity` fetch failure hardening:
- Root cause confirmed: API server was offline (`curl http://127.0.0.1:3001/health` connection refused), so `/unity` backend lookup failed with generic "Failed to fetch".
- Reworked `apps/web/src/pages/UnityPage.tsx`:
  - API-first owned-avatar lookup remains primary path.
  - Added automatic fallback to direct on-chain lookup (`queryOwnedOnChainAvatars`) when backend fetch fails.
  - Added local fallback handoff mode (`local-blob`) that:
    - resolves manifest/runtime blob IDs via Walrus in-browser,
    - builds object-URL runtime reference and object-URL profile JSON,
    - launches Unity with `?profile=<blob-url-profile>` so Unity can load without the local API process.
  - Added clearer status/debug fields in UI (`Handoff mode`, local profile/runtime URLs).
  - Added object URL lifecycle cleanup to avoid leaks when switching avatars/reloading.
- Validation:
  - `npm run typecheck -w @pacific/web` ✅
  - `npm run build -w @pacific/web` ✅
  - Playwright `/unity` smoke screenshot: `/tmp/pacific_playwright_unity_fallback/shot-0.png` ✅

2026-03-12 `/unity` runtime preflight tightening:
- Confirmed local API launch is blocked without required env (`DATABASE_URL` missing), which explains `http://127.0.0.1:3001` fetch failures in browser when API mode is expected.
- Tightened Unity build detector in `apps/web/src/pages/UnityPage.tsx`:
  - removed permissive fallback that matched generic `"unity"` text,
  - now accepts only real Unity WebGL markers (`createUnityInstance`, `unity-canvas`, `.loader.js`, `UnityLoader`, `UnityProgress`),
  - hard-rejects SPA shell pages containing `id="root"` to prevent embedding the React app inside the Unity iframe by mistake.
- Validation:
  - `npm run -w @pacific/web typecheck` ✅
  - `npm run -w @pacific/web build` ✅

2026-03-12 `/unity-webgl` deterministic placeholder:
- Added `apps/web/public/unity-webgl/index.html` as an explicit placeholder so missing Unity exports no longer resolve to the React SPA shell.
- Placeholder intentionally avoids Unity loader markers so `/unity` preflight stays in setup/error mode until a real WebGL export is copied in.
- Validation:
  - `curl http://127.0.0.1:4173/unity-webgl/index.html` now serves static placeholder HTML (not app shell) ✅
  - `npm run -w @pacific/web build` ✅

2026-03-12 Unity WebGL export unblocked and completed:
- Investigated Unity batch build failures with real logs:
  - `6000.3.10f1` CLI launch failed on macOS policy/code-sign validation for `libre2.0.dylib`.
  - `6000.5.0a8` launched but WebGL build failed initially with:
    - `Switching to WebGLSupport is disabled`
    - `InvalidOperationException: Failed to switch active build target to WebGL.`
- Root cause: WebGL module missing for the active Unity editor (`6000.5.0a8`).
- Installed module via Unity Hub CLI:
  - `Unity Hub -- --headless install-modules --version 6000.5.0a8 --module webgl`
  - install completed: `All Tasks Completed Successfully.`
- Re-ran automated export:
  - `Unity -batchmode -nographics -quit -projectPath ... -executeMethod AvatarBridgeUnity.Editor.BuildProfileSetup.BuildWebGLForReadyAvatarPlatform`
  - build completed successfully (`Build Finished, Result: Success`).
- Generated runtime files now exist at:
  - `apps/web/public/unity-webgl/index.html` (Unity-generated loader page),
  - `apps/web/public/unity-webgl/Build/unity-webgl.loader.js`,

2026-03-12 Unity wallet-avatar injection verification + runtime pose fix:
- Verified the `/unity` route is now using live API mode with the selected on-chain avatar:
  - wallet `0x91f8fbe4fdb5e0a074c1140b98a9085a7c7129963e2b85f01790eae3d24af0c0`
  - avatar object `0x6f66d3843d623a092250aca645c9c45a413031d3eba087cb409dfa2e108eaf35`
  - manifest blob `Th-Jr_WywH24O7tUw9Gp19gAQLIa9n1y5XEjcdSlyp0`
  - runtime blob `AuKBki2VPY7MdLSHLIJIv1ZjSJGMfcSiFg4AR8qKe8g`
- Confirmed API endpoints resolve the actual Sui/Walrus data end to end:
  - `GET /unity/profile/:wallet?...` returns the selected avatar profile with `resolution.httpUrl`
  - `GET /asset/AuKBki2VPY7MdLSHLIJIv1ZjSJGMfcSiFg4AR8qKe8g` returns HTTP 200 with the VRM payload.
- Inspected the downloaded VRM payload directly:
  - file `sui_avatar_ch45_v1.vrm`
  - full-body humanoid skeleton is present (`hips`, `leftUpperLeg`, `rightUpperLeg`, `feet`, `toes`)
  - geometry spans roughly `y=0` to `y=1.85`, so the wallet asset itself is not a bust-only model.
- Unity-side root cause found:
  - `ThirdPersonPlayerController.BindAvatar(...)` was auto-attaching `AvatarAnimationPlaceholderController` to imported runtime VRMs.
  - That generic placeholder Animator Controller deformed the live VRM into a broken half-body pose, making it look like the selected wallet character was not loading correctly.
- Fixes applied:
  - Skip placeholder animator attachment for real `Vrm10Instance` avatars.
  - Keep `applyRootMotion = false` for imported VRM animators.
  - Harden spawn fitting:
    - renderer/shadow setup for runtime meshes,
    - second fit pass after the first frame settles,
    - improved camera framing call path.
- Validation:
  - rebuilt WebGL after each change with `AvatarBridgeUnity.Editor.BuildProfileSetup.BuildWebGLForReadyAvatarPlatform`
  - direct WebGL profile test screenshots:
    - broken half-body pose before animator skip: `output/web-game-unity-runtime-4173-smr-fix/shot-4.png`
    - full selected wallet avatar visible after animator skip: `output/web-game-unity-runtime-4173-vrm-anim-skip/shot-4.png`

TODO:
- Runtime wallet avatars in Unity now load visibly and correctly from Sui/Walrus, but they are currently shown in rest pose because the generic placeholder locomotion controller is not safe for arbitrary imported VRMs.
- Next phase should replace the placeholder Animator path with a VRM-safe humanoid animation layer or a verified runtime-retargeted clip set for imported avatars.
  - `apps/web/public/unity-webgl/Build/unity-webgl.framework.js.gz`,
  - `apps/web/public/unity-webgl/Build/unity-webgl.wasm.gz`,
  - `apps/web/public/unity-webgl/Build/unity-webgl.data.gz`.
- Verified dev server headers:
  - `Content-Encoding: gzip` on `.wasm.gz` and `.data.gz`.

2026-03-12 Unity wallet-avatar injection repaired:
2026-03-13 MFPS offline fallback + operator preview hydration:
- Verified local API is live at `http://127.0.0.1:3001/health` with `database:false`; this explains why `/avatar/:wallet/owned` falls back to on-chain objects and initially returns `shooterCharacter: null`.
- Verified the authoritative shooter handoff payload is correct through:
  - `GET /unity/profile/0x91f8fbe4fdb5e0a074c1140b98a9085a7c7129963e2b85f01790eae3d24af0c0?...`
  - response includes `shooterCharacter = mplayer_1 / MPlayer [1]`, `previewBlobId`, stats, and runtime asset URL.
- Patched `UnityAvatarGame/Assets/MFPS/Scripts/Runtime/Network/Lobby/bl_Lobby.cs`:
  - removed the invalid offline `JoinLobby()` path that was firing while Photon stayed in `PeerCreated`,
  - added deterministic `CompleteOfflineLobbyFallback()` so missing `AppIdRealtime` now lands in the verified MFPS menu/lobby UI cleanly.
- Rebuilt verified MFPS WebGL runtime:
  - build log: `/tmp/unity-mfps-webgl-20260313-r10.log`
  - exported to `apps/web/public/unity-webgl`
- Updated web launcher/runtime UX:
  - `apps/web/src/pages/UnityPage.tsx`
    - hydrates `shooterCharacter` and `previewBlobId` from `/unity/profile/...`,
    - shows the selected minted operator preview in the Unity launcher card,
    - keeps local fallback profile aligned with the resolved preview/blob metadata.
  - `apps/web/src/App.tsx`
    - added the selected operator preview to the right-side "Minted shooter NFT handoff" panel so the mint flow visibly shows the exact MFPS operator being minted.
  - `apps/web/src/index.css`
    - styling for runtime/unity operator preview blocks.
- Cache-busted the launcher to `VITE_UNITY_ASSET_VERSION=mfps-r10` in `apps/web/.env.local`.
- Restarted Vite dev server after the asset-version bump.

Validation:
- `npm run -w @pacific/web typecheck` ✅
- `npm run -w @pacific/web build` ✅
- Direct WebGL runtime Playwright smoke:
  - no more Photon `JoinLobby` error in offline fallback
  - output dir: `/Users/arthurtoscano/Documents/New project/output/web-game-unity-runtime-direct-20260313-r10`
  - latest screenshot shows verified MFPS menu loaded: `/Users/arthurtoscano/Documents/New project/output/web-game-unity-runtime-direct-20260313-r10/shot-2.png`
- Direct WebGL console still shows one generic `NullReferenceException` during startup without a useful managed stack trace. The visible lobby/menu continues to load. If this needs to be fully eliminated, next step should be a temporary development WebGL build for stack-trace resolution before changing more runtime code.

Open blockers:
- Live cloud multiplayer still requires a real Photon Realtime/PUN App ID. Fixed region `usw` is configured, but `AppIdRealtime` is still empty in both:
  - `apps/web/.env.local`
  - `UnityAvatarGame/Assets/MFPS/Content/Required/Photon/PhotonUnityNetworking/Resources/PhotonServerSettings.asset`
- Without that credential, the launcher can only run the verified MFPS offline fallback path, not Photon cloud matchmaking.

2026-03-13 Photon multiplayer config UX:
- Confirmed via MFPS + Photon docs that MFPS 2.0 expects Photon PUN 2 / Realtime, not Fusion.
- Added a local launcher override in `apps/web/src/pages/UnityPage.tsx`:
  - accepts a Photon Realtime / PUN App ID directly in the `/unity` page,
  - accepts fixed region override,
  - persists both to localStorage so the launcher can inject them into Unity without requiring an env-file edit/restart.
- Updated launcher messaging so it now explicitly tells the user to create a Photon Realtime/PUN app and clarifies that Fusion is the wrong product for MFPS.
- Added small UI styling for the Photon config block in `apps/web/src/index.css`.
- Validation:
  - `npm run -w @pacific/web typecheck` ✅
  - `npm run -w @pacific/web build` ✅
- Root cause confirmed on the live path:
  - Unity WebGL was receiving either no runtime at all (API process offline) or a browser-only fallback not suitable for a stable HTTP runtime feed.
  - The API previously required `DATABASE_URL` at startup, so the read-side `/avatar/:wallet/owned` and `/unity/profile/:wallet` routes could not run unless Postgres was configured.
- Reworked API read path to support real wallet-owned avatar injection without Postgres:
  - `apps/api/src/config.ts`: `DATABASE_URL` is now optional; added optional `AVATAR_PACKAGE_ID`.
  - `apps/api/src/db.ts`: database init is now a no-op when no DB is configured.
  - `apps/api/src/walrus.ts`: Walrus reads/assets now work with or without DB cache.
  - Added `apps/api/src/avatar-lookup.ts`:
    - direct Sui owned-object lookup by package/type,
    - `walrus://...` manifest extraction,
    - newest-avatar ordering for fallback selection.
  - `apps/api/src/server.ts` now:
    - starts in read-only mode without Postgres,
    - keeps session/upload/persist routes DB-gated with a clear 503,
    - falls back to on-chain owned avatar lookup when cache rows are missing,
    - builds Unity profile payloads from on-chain avatar + Walrus manifest/runtime blob,
    - serves `/asset/:blobId` and `/manifest/:blobId` even without DB,
    - broadens local-dev CORS to allow `127.0.0.1` and `localhost` on 4173/5173.
- `apps/web/src/lib/backend-avatar.ts` now accepts backend source `on-chain` and forwards `packageId`.
- `apps/web/src/pages/UnityPage.tsx` now passes `packageId` into backend owned-avatar and Unity profile requests so the API can resolve the correct Move type even without a local `.env`.
- Live verification:
  - `GET /health` returns `{ ok: true, database: false }` with the API running without Postgres.
  - `GET /avatar/<wallet>/owned?packageId=<package>` returned real owned avatar objects from Sui for wallet `0x91f8...af0c0`.
  - `GET /unity/profile/<wallet>?packageId=<package>` returned a real runtime profile with:
    - avatar object `0x6f66...eaf35`
    - manifest blob `Th-Jr_WywH24O7tUw9Gp19gAQLIa9n1y5XEjcdSlyp0`
    - runtime avatar blob `AuKBki2VPY7MdLSHLIJIv1ZjSJGMfcSiFg4AR8qKe8g`
    - resolution URL `http://127.0.0.1:3001/asset/AuKBki2VPY7MdLSHLIJIv1ZjSJGMfcSiFg4AR8qKe8g`
  - Unity direct-load smoke showed the old blocker was CORS; after widening local-dev origins, the profile fetch path is valid for both localhost and 127.0.0.1.
- Commands verified:
  - `npm run typecheck -w @pacific/api` ✅
  - `npm run typecheck -w @pacific/web` ✅
  - `npm run build -w @pacific/api` ✅
  - `npm run build -w @pacific/web` ✅
  - `npm run dev:api` now boots without `DATABASE_URL` and serves read-only avatar lookup routes ✅
- Final Unity WebGL runtime blocker fixed:
  - `UnityAvatarGame/Assets/Scripts/Avatar/AvatarRuntimeLoader.cs` now uses `ImmediateCaller` on WebGL instead of forcing `RuntimeOnlyAwaitCaller`.
  - Real runtime verification after rebuild showed the prior behavior was hanging in `LoadingAvatar` after `/asset/<blobId>` completed.
  - After the await-caller change and WebGL rebuild, the same wallet profile reached:
    - `Load State: Ready`
    - `Appearance: Applied runtime avatar`
    - `Placeholder Active: No`
- Verified direct Unity runtime against real wallet profile on `127.0.0.1:4173`:
  - selected avatar object `0x6f66d3843d623a092250aca645c9c45a413031d3eba087cb409dfa2e108eaf35`
  - runtime blob `AuKBki2VPY7MdLSHLIJIv1ZjSJGMfcSiFg4AR8qKe8g`
  - screenshot after fix: `output/web-game-unity-runtime-4173-fixed/shot-4.png`

2026-03-12 shooter migration flow (`pick shooter -> mint -> launch shooter`) + NFT stats:
- Web mint flow updated in `apps/web/src/App.tsx`:
  - added required game-mode step (`Choose Shooter`) before mint is enabled,
  - preserved existing wallet connect + Walrus upload/mint pipeline,
  - manifest now includes optional shooter metadata (`game.mode`, multiplayer defaults, initial `wins/losses/hp`),
  - auto-launches Unity shooter runtime after successful mint with `avatarObjectId` + `manifestBlobId` query handoff.
- Removed old play/world path from active navigation:
  - `SiteTabs` now focuses on `Mint Shooter NFT` + `Shooter Runtime`,
  - `/play` and `/world` route mapping now point to the Unity shooter page in `apps/web/src/main.tsx`.
  - retired legacy pages by deleting `apps/web/src/pages/PlayPage.tsx` and `apps/web/src/pages/WorldPage.tsx`.
- Unity shooter page upgraded in `apps/web/src/pages/UnityPage.tsx`:
  - prefers handoff-selected avatar from query params,
  - shows NFT shooter stats and multiplayer capacity,
  - carries shooter context into Unity profile payload (`mode=shooter`, `game`, `shooterStats`, `multiplayer`, `endpoints`).
- Shared schema update in `packages/shared/src/manifest.ts`:
  - added optional shooter metadata schema and stats types for consistent typing across web/api.
- API shooter stats persistence and multiplayer sizing:
  - new env/config controls in `apps/api/src/config.ts` (`SHOOTER_MAX_PLAYERS_PER_MATCH`, `SHOOTER_MAX_CONCURRENT_MATCHES`, `SHOOTER_SERVER_TICK_RATE`, `SHOOTER_DEFAULT_HP`),
  - new DB tables in `apps/api/src/db.ts`:
    - `avatar_shooter_stats`,
    - `avatar_shooter_matches`,
  - `apps/api/src/server.ts` now:
    - persists initial shooter stats on `/avatar/manifest`,
    - returns shooter stats in `/avatar/:wallet`, `/avatar/:wallet/owned`, and `/unity/profile/:wallet`,
    - returns shooter capacity in `/health`,
    - adds `GET /shooter/stats/:wallet`,
    - adds `POST /shooter/match` (winner/loser result updates with `wins/losses/hp` mutation),
    - syncs updated stats back into cached manifest JSON for API-side NFT metadata reads.
- On-chain lookup parsing extended:
  - `apps/api/src/avatar-lookup.ts` and `apps/web/src/lib/on-chain-avatar.ts` now parse optional `wins/losses/hp` fields when present on-chain.
- Unity C# profile/runtime debug wiring:
  - `UnityAvatarGame/Assets/Scripts/Data/AvatarProfile.cs` now supports shooter stats, multiplayer config, and shooter endpoints in profile JSON,
  - `UnityAvatarGame/Assets/Scripts/UI/GameStateDebugPanel.cs` + `AvatarHudController.cs` display shooter stats/capacity in runtime debug panel,
  - `UnityAvatarGame/Assets/Scripts/App/AppBootstrap.cs` defaults gameplay scene selection to MFPS (`MainMenu` fallback `ExampleLevel`) for shooter mode.
- Env + docs:
  - added shooter env knobs to `ready-avatar-platform/.env.example`,
  - updated `ready-avatar-platform/README.md` with shooter flow and new API endpoints.

Validation run:
- `npm run typecheck` (workspace) ✅
- `npm run build` (workspace) ✅
- Playwright smoke (`develop-web-game` client) against `http://localhost:5173`:
  - screenshot: `/tmp/pacific_playwright_shooter_flow/shot-0.png` (shows required Shooter selection step before mint) ✅
  - console error snapshot: `/tmp/pacific_playwright_shooter_flow/errors-0.json` shows API offline fetch refusal in local test shell (expected when API is not running).

Next TODO:
- Wire Unity MFPS match-complete hooks to call `POST /shooter/match` automatically after each multiplayer round (winner + loser avatar IDs and HP).
- If strict on-chain stat storage is required (not API/cache-backed), extend Move `Avatar` schema and add on-chain update transaction flow.

2026-03-12 shooter-flow mint + MFPS handoff pass:
- Replaced `apps/web/src/App.tsx` with a shooter-only mint pipeline:
  - flow now enforces: choose shooter -> select MFPS character preset -> mint -> auto-redirect to `/unity`.
  - keeps wallet connect, Walrus upload, manifest upload, and Sui mint flow intact.
  - supports optional runtime override upload; default runtime payload is a generated shooter character descriptor JSON.
  - manifest now writes `game.mode = shooter`, `game.character`, multiplayer defaults, and initial shooter stats (`wins/losses/hp`).
- Added MFPS preset source file `apps/web/src/lib/shooter-character-presets.ts` usage in the mint UI, including generated preview image pipeline.
- Updated `apps/web/src/pages/UnityPage.tsx` to carry and display `shooterCharacter` through backend/on-chain/local fallback profile handoff.
- Updated shared/API metadata handling already in progress to support shooter character shape and non-VRM shooter runtime assets.
- Unity bridge updates in `UnityAvatarGame`:
  - `Assets/Scripts/App/AppBootstrap.cs`: `mode=shooter` now forces MFPS scene flow and disables old runtime avatar auto-load path.
  - `Assets/Scripts/Data/AvatarProfile.cs`: added shooter character model + resolver helper.
  - `Assets/Scripts/UI/AvatarHudController.cs` and `Assets/Scripts/UI/GameStateDebugPanel.cs`: now show selected shooter character in debug panel.
- UI polish updates:
  - added shooter character card-grid styling in `apps/web/src/index.css`.
  - added `apps/web/public/favicon.ico` to prevent browser 404 favicon noise.
- API CORS tweak:
  - `apps/api/src/server.ts` now also allows localhost/127.0.0.1 on port `5174` in addition to existing local dev ports.

Validation run:
- `npm run typecheck` (workspace) passed.
- `npm run build` (workspace) passed.
- `develop-web-game` Playwright loop executed on shooter mint route:
  - valid artifact set (no console error files):
    - `/Users/arthurtoscano/Documents/New project/output/web-game-shooter-flow-20260312-valid-4173/shot-0.png`
    - `/Users/arthurtoscano/Documents/New project/output/web-game-shooter-flow-20260312-valid-4173/shot-1.png`

TODO / next hardening:
- Wire shooter character prefab selection directly into MFPS player spawn/runtime model pipeline (currently character is handed off in profile + NFT metadata and shown in debug/status UI).
- Run a full wallet-connected in-browser mint + Unity runtime pass with real chain object IDs and a real shooter match report POST to verify NFT stats update loop (`wins/losses/hp`) end-to-end.

2026-03-13 verified MFPS 2.0 replacement + deterministic launch path:
- Confirmed old prototype runtime source folders are gone from `UnityAvatarGame/Assets`:
  - removed `Assets/Scenes`, `Assets/Scripts`, `Assets/Resources/AvatarBridge`, `Assets/StreamingAssets/AvatarBridge`.
- Verified Unity build is hard-pinned to MFPS scenes via `UnityAvatarGame/Assets/Editor/BuildProfileSetup.cs`:
  - `Assets/MFPS/Scenes/MainMenu.unity`
  - `Assets/MFPS/Scenes/ExampleLevel.unity`
  - `Assets/MFPS/Scenes/RoomUI.unity`
- Verified runtime profile handoff is now MFPS-specific via
  `UnityAvatarGame/Assets/MFPS/Scripts/Runtime/Integration/PacificMfpsProfileBootstrap.cs`:
  - reads `?mode=shooter&profile=...`,
  - applies minted avatar name/wallet to `bl_PhotonNetwork.NickName`,
  - maps NFT role/id to MFPS `PlayerClass`,
  - overrides local player prefab from minted `prefabResource` when valid.
- Verified active web launcher uses a single Unity URL target (`/unity-webgl/index.html`) and appends deterministic shooter params from `apps/web/src/pages/UnityPage.tsx`.
- Renamed Unity build profile assets to remove legacy bridge naming:
  - `UnityAvatarGame/Assets/Settings/BuildProfiles/MFPS Mac Development.asset`
  - `UnityAvatarGame/Assets/Settings/BuildProfiles/MFPS Mac Release.asset`
- Replaced legacy Unity prototype documentation with current MFPS bridge docs:
  - removed `UnityAvatarGame/README_AvatarBridge.md`
  - added `UnityAvatarGame/README_MFPSBridge.md`
- Removed stale prototype build artifact directory under `UnityAvatarGame/Builds/macOS/Development` (old desktop app payload).
- Verified Unity WebGL payload markers from `apps/web/public/unity-webgl/Build/unity-webgl.data.gz`:
  - present: `Assets/MFPS/Scenes/MainMenu.unity`, `ExampleLevel`, `RoomUI`
  - absent: `AvatarBridge`, `BootstrapScene`, `ForestPlayScene`, `AppBootstrap`
- Verified project builds/typechecks after integration:
  - `npm run -w @pacific/shared typecheck` ✅
  - `npm run -w @pacific/api typecheck` ✅
  - `npm run -w @pacific/web typecheck` ✅
 - `npm run -w @pacific/shared build` ✅
 - `npm run -w @pacific/api build` ✅
 - `npm run -w @pacific/web build` ✅

2026-03-13 Unity launcher + mint preview hardening:
- Verified the current `/unity` runtime stall is not the old prototype. The active WebGL build boots MFPS, plays menu audio, and applies the NFT profile, but the workspace is missing the required Photon multiplayer cloud config:
  - `UnityAvatarGame/Assets/MFPS/Content/Required/Photon/PhotonUnityNetworking/Resources/PhotonServerSettings.asset`
    has empty `AppIdRealtime`, `AppIdChat`, and `AppIdVoice`.
  - `ready-avatar-platform/.env.example` now documents:
    - `VITE_PHOTON_APP_ID_REALTIME`
    - `VITE_PHOTON_APP_ID_CHAT`
    - `VITE_PHOTON_APP_ID_VOICE`
    - `VITE_PHOTON_FIXED_REGION`
- Confirmed by direct Playwright console capture against the live WebGL build that:
  - MFPS loads,
  - `[MFPS Bridge] NFT profile applied. Nick='Arthur', Class='Assault', Prefab='MPlayer [1]'`,
  - but multiplayer lobby completion is blocked when Photon Realtime App ID is absent.
- Tightened launcher behavior in `apps/web/src/pages/UnityPage.tsx`:
  - runtime frame is now blocked when `VITE_PHOTON_APP_ID_REALTIME` is missing,
  - page surfaces an explicit multiplayer-config blocker instead of letting the user sit on a false loading screen.
- Verified mint preview/readiness UI on `/create` renders correctly:
  - screenshot: `/Users/arthurtoscano/Documents/New project/output/create-preview-20260313.png`
  - shows selected MFPS preset, preview art, prefab/resource mapping, runtime payload source, and readiness checklist.
- Added Unity-side bridge hardening:
  - `PacificMfpsProfileBootstrap.cs` now also pushes the NFT nickname into the MFPS player-name gate when that dialog is active.
  - `bl_Lobby.cs` now guards some lobby callback assumptions (room creator/loading screen/userId) so missing singleton refs do not immediately hard-crash the join path.

Current exact blocker:
- A valid Photon Realtime App ID is not present anywhere in the workspace, so the verified MFPS 2.0 multiplayer runtime cannot complete the cloud lobby flow by the book.
- Until that value exists, the web launcher should stay in explicit blocked state rather than pretending multiplayer is loading.

Latest validation:
- `npm run -w @pacific/web typecheck` ✅
- `npm run -w @pacific/web build` ✅
- Unity WebGL rebuilds after bridge/lobby changes:
  - `/tmp/unity-mfps-webgl-20260313-r4.log` ✅
  - `/tmp/unity-mfps-webgl-20260313-r5.log` ✅
  - `/tmp/unity-mfps-webgl-20260313-r6.log` ✅
  - `/tmp/unity-mfps-webgl-20260313-r7.log` ✅
- `/unity` launcher blocker screenshot:
  - `/Users/arthurtoscano/Documents/New project/output/unity-launcher-blocker-20260313.png`

Next TODO:
- Provide the real Photon App IDs for MFPS multiplayer (`Realtime`, optionally `Chat` and `Voice`) in env or directly in `PhotonServerSettings.asset`, then rerun `/unity` and confirm:
  - menu/lobby enters without blocker,
  - owned NFT operator name/class/prefab apply,
  - room list / host / quick play functions reach the actual multiplayer flow.

2026-03-13 mint player preview fix:
- Root cause confirmed: shooter preview generator only rendered text on a gradient (no operator image), so mint card looked "ready" but lacked a visual player preview.
- Added verified MFPS art assets to web public runtime:
  - `apps/web/public/mfps-previews/player-team-1-face.png`
  - `apps/web/public/mfps-previews/player-team-2-face.png`
  - `apps/web/public/mfps-previews/mfps-soldier.png`
- Updated `apps/web/src/lib/shooter-character-presets.ts`:
  - each preset now includes `previewImagePath`,
  - `createShooterPresetPreviewBlob(...)` now composes preview PNG with actual operator face art + metadata overlay.
- Updated `apps/web/src/App.tsx` character picker cards to render per-preset thumbnails.
- Updated `apps/web/src/index.css` with `.shooter-character-thumb` styles.
- Validation:
  - `npm run -w @pacific/web typecheck` ✅
  - `npm run -w @pacific/web build` ✅
  - screenshot: `/Users/arthurtoscano/Documents/New project/output/create-player-preview-fixed-20260313.png` shows both picker thumbnails and mint preview image.

2026-03-13 unity launcher unblock (Photon-missing fallback):
- Re-verified no valid Photon Realtime App ID exists anywhere in this workspace:
  - `apps/web/.env.local` has no `VITE_PHOTON_APP_ID_REALTIME`.
  - `UnityAvatarGame/.../PhotonServerSettings.asset` still has empty `AppIdRealtime/AppIdChat/AppIdVoice`.
- Updated `apps/web/src/pages/UnityPage.tsx` to stop hard-blocking iframe render when Photon is missing.
  - Launcher now renders verified MFPS WebGL runtime whenever Unity build preflight is valid.
  - UI clearly warns that cloud multiplayer is unavailable and runtime is in offline fallback mode until real Photon App ID is configured.
- This fixes the blank-right-panel blocker regression while preserving explicit multiplayer config warnings.
- Validation:
  - `npm run -w @pacific/web typecheck` ✅
  - `npm run -w @pacific/web build` ✅
  - Local dev server started at `http://127.0.0.1:5173/`.

2026-03-13 MFPS runtime stall fix (`CONNECTING TO THE SERVER...`):
- Root cause in MFPS lobby flow: when Photon Realtime App ID is missing, `bl_Lobby.ConnectToServer()` still followed connect path and could stall on the loading overlay.
- Updated Unity script:
  - `UnityAvatarGame/Assets/MFPS/Scripts/Runtime/Network/Lobby/bl_Lobby.cs`
  - added deterministic branch:
    - detect missing `AppIdRealtime`,
    - force `bl_PhotonNetwork.OfflineMode = true`,
    - attempt lobby join in offline mode,
    - timeout fallback opens MFPS home/lobby UI and clears loading screen instead of hanging.
- Rebuilt verified MFPS WebGL runtime after patch:
  - command: `Unity -batchmode -nographics -quit -projectPath ... -executeMethod Pacific.MFPS.Editor.BuildProfileSetup.BuildWebGLForReadyAvatarPlatform`
  - log: `/tmp/unity-mfps-webgl-20260313-r8.log`
  - result: `Build Finished, Result: Success` ✅
- Artifacts:
  - `/Users/arthurtoscano/Documents/New project/output/unity-webgl-direct-r8-20260313.png`
  - `/Users/arthurtoscano/Documents/New project/output/unity-webgl-direct-r8-20260313-console.log`

2026-03-13 Unity WebGL cache-bust for rebuilt runtime:
- Added web env support for Unity asset revision:
  - `apps/web/src/env.ts`: `unityAssetVersion` from `VITE_UNITY_ASSET_VERSION`.
  - `apps/web/src/pages/UnityPage.tsx`: appends `assetVersion` query param to Unity launch URL when set.
  - `.env.example`: added `VITE_UNITY_ASSET_VERSION=`.
  - `apps/web/.env.local`: set `VITE_UNITY_ASSET_VERSION=mfps-r8` for local deterministic refresh.
- Patched Unity WebGL loader page to apply the same version key to loader/data/framework/wasm URLs:
  - `apps/web/public/unity-webgl/index.html`
  - uses `assetVersion` query param and appends `?v=<assetVersion>` to Unity build files.
- Result: browser cache cannot silently keep serving stale Unity build artifacts after rebuild.
- Validation:
  - `npm run -w @pacific/web typecheck` ✅
  - `npm run -w @pacific/web build` ✅
  - web dev server restarted on `http://127.0.0.1:5173`.

2026-03-13 fixed region setup:
- Set deterministic Photon fixed region to `usw` in local launcher config:
  - `ready-avatar-platform/apps/web/.env.local`: `VITE_PHOTON_FIXED_REGION=usw`
- Enforced default fixed region in web env parser:
  - `ready-avatar-platform/apps/web/src/env.ts`
  - `photonFixedRegion` now defaults to `"usw"` and is normalized to lowercase.
- Set Unity Photon defaults to `usw`:
  - `UnityAvatarGame/Assets/MFPS/Content/Required/Photon/PhotonUnityNetworking/Resources/PhotonServerSettings.asset`
  - `AppSettings.FixedRegion: usw`
  - `DevRegion: usw`
- Validation:
  - `npm run -w @pacific/web typecheck` ✅
  - `npm run -w @pacific/web build` ✅
  - Vite dev server auto-restarted after `.env.local` update.
