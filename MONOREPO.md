# Convert-X monorepo

All three Convert-X surfaces now live in **one repo**:

| Surface | Path | Stack | In npm workspace? |
|---|---|---|---|
| **Desktop** | `packages/desktop` | Tauri v2 + Svelte 5 + Rust | ✅ yes |
| **Web** | `packages/web` | Svelte 5 + Vite + ffmpeg.wasm | ✅ yes |
| **Shared** | `packages/shared` | Svelte components, stores, + framework-agnostic `core/` | ✅ yes |
| **Android** | `packages/android` | Expo SDK 54 + React Native + Kotlin native modules | ❌ **no (intentional)** |

```
Convert-X/
├── package.json                 # workspace root: desktop + web + shared ONLY
├── MONOREPO.md                  # this file
├── .github/workflows/
│   ├── desktop-release.yml      # tag desktop-v*  -> MSI to Convert-X releases
│   ├── android-release.yml      # tag v*          -> APKs to Convert-X-Android-APK
│   ├── web-ci.yml               # push to main    -> builds packages/web
│   └── discord-notify.yml       # push/tags       -> Discord webhook
└── packages/
    ├── desktop/   src/  src-tauri/  build.bat  vite.config.js
    ├── web/       src/  vite.config.js  wrangler-related deploy
    ├── shared/    src/components/*.svelte  src/stores/  src/core/  (← @convertx/shared)
    └── android/   App.tsx  src/  modules/  android/  metro (Expo default)  (standalone)
```

## Why Android is NOT in the npm workspace

This is deliberate and load-bearing. **npm has no `nohoist`** (that's a Yarn feature). If Android were a workspace member, npm would hoist its Expo/React-Native deps into the root `node_modules`, which causes Metro's classic *duplicate-React / invalid-hook* crashes and breaks the dev-client flow.

So `packages/android` is excluded from the `workspaces` array. It keeps its **own `node_modules`, own `package-lock.json`, own install**, and Metro resolves exactly as it did in the standalone repo. The monorepo root is Svelte-only (no React), so there is nothing up the tree for Metro to collide with.

> If you ever add a React-based tool to the **root**, harden Android by adding `packages/android/metro.config.js`:
> ```js
> const { getDefaultConfig } = require('expo/metro-config');
> const path = require('path');
> const config = getDefaultConfig(__dirname);
> config.resolver.disableHierarchicalLookup = true;             // don't walk up into root node_modules
> config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')];
> module.exports = config;
> ```

---

## Day-to-day commands

### One-time install
```bash
# from repo root — installs desktop + web + shared (NOT android)
npm install

# android installs separately (keeps Metro isolated)
cd packages/android && npm install
```

### Web
```bash
npm run dev:web       # vite dev server (port 3000)
npm run build:web     # production build -> packages/web/dist
```

### Desktop
```bash
npm run tauri -- dev     # launch the Tauri app (runs vite under the hood)
npm run tauri -- build   # full MSI build
# or, from packages/desktop:  ./build.bat   (handles MSVC env + copies to release/)
npm run dev:desktop      # vite frontend only (no Tauri window)
```

### Android — including the Codespaces dev-client flow
```bash
cd packages/android
npx expo start                 # Metro bundler, local network
npx expo start --tunnel        # ← Codespaces / remote: serves JS over a tunnel
                               #   so the dev-client app on your phone connects
                               #   from anywhere (work laptop -> Codespaces -> phone)
npm run android                # native debug build to a connected device/emulator
npm run build:apk              # signed release APK -> packages/android/release/
```
Your dev-client + `--tunnel` workflow is unchanged by the consolidation — Android still builds from its own `node_modules` with the Expo default Metro config.

---

## Releases — three independent lines

| Surface | Trigger | Workflow | Artifacts land in |
|---|---|---|---|
| **Desktop** | push tag `desktop-v*` (e.g. `desktop-v0.2.0`) | `desktop-release.yml` | **Convert-X** GitHub Releases (MSI/EXE) |
| **Android** | push tag `v*` (e.g. `v0.6.15`) | `android-release.yml` | **Convert-X-Android-APK** Releases (per-ABI APKs) |
| **Web** | push to `main` | `web-ci.yml` | builds only; deploy via Cloudflare Pages |

```bash
# cut a desktop release
git tag desktop-v0.2.0 && git push origin desktop-v0.2.0

# cut an android release (bump packages/android/package.json version first)
git tag v0.6.15 && git push origin v0.6.15
```

### ⚠️ The two tag schemes are different on purpose
- **Android must stay `v*`.** The in-app updater (`packages/android/src/lib/updater.ts`) does `tag_name.replace(/^v/, '')` then semver-compares. A prefixed tag like `android-v0.6.15` would parse to `NaN` and the app would report "no update". So Android keeps the bare `v0.6.15` scheme.
- **Desktop uses `desktop-v*`** so it doesn't collide with Android in the same repo. (`v*` and `desktop-v*` are disjoint — different first letters.)

### The Android updater + cross-repo APK publishing
Already-installed Android apps poll `CedrickGD/Convert-X-Android-APK/releases/latest`. To avoid breaking those live users, `android-release.yml` **publishes the APKs cross-repo to `Convert-X-Android-APK`** (not to this monorepo), so `updater.ts` needs **zero changes**. That cross-repo publish needs a PAT (see secrets below).

Web deploy: `web-ci.yml` only *builds* `packages/web`. Actual deployment is Cloudflare Pages — either Cloudflare's own Git integration pointed at `packages/web`, or `wrangler` from that folder. (Web has no in-app updater; a reload is always the latest.)

---

## Required GitHub secrets (on `CedrickGD/Convert-X`)

The keystore secrets used to live on the old Android repo and **must be re-added here**:

| Secret | Used by | What |
|---|---|---|
| `RELEASE_KEYSTORE_BASE64` | android-release | `base64 -w 0 your-release.jks` (single line) |
| `RELEASE_KEYSTORE_PASSWORD` | android-release | keystore store password |
| `RELEASE_KEY_ALIAS` | android-release | key alias (e.g. `convert-x-release`) |
| `RELEASE_KEY_PASSWORD` | android-release | key password |
| `APK_RELEASE_TOKEN` | android-release | **NEW** — a PAT with `contents:write` on `Convert-X-Android-APK` (fine-grained, scoped to just that repo). Enables the cross-repo APK publish. |
| `PRIVAT_DC_NOTIFY` | discord-notify | Discord webhook URL |

Desktop release uses the built-in `GITHUB_TOKEN` (no extra secret).

---

## Shared code model

- **`@convertx/shared` (Svelte UI + stores)** — consumed by **web + desktop only**. This is why those two have feature parity: they share the *same* `.svelte` components. React Native cannot use these.
- **`@convertx/shared/core/*` (framework-agnostic logic)** — pure JS/TS with no Svelte/DOM/RN deps, consumable by **all three**. Seeded with `core/formats.js` (format catalog, compatibility, ext-normalization, edit-detection, + per-surface `FORMAT_SUPPORT` capability map). `stores/fileStore.js` re-exports it so existing imports are unchanged.

### Letting Android consume `core/` (deferred, on-device-validated)
Android still has its own `packages/android/src/lib/formats.ts`. To collapse it onto the shared core later:
1. `cd packages/android && npm install @convertx/shared@file:../shared`
2. add a Metro config that watches the shared folder:
   ```js
   const { getDefaultConfig } = require('expo/metro-config');
   const path = require('path');
   const projectRoot = __dirname;
   const sharedRoot = path.resolve(projectRoot, '../shared');
   const config = getDefaultConfig(projectRoot);
   config.watchFolders = [sharedRoot];
   config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')];
   config.resolver.disableHierarchicalLookup = true;
   module.exports = config;
   ```
3. replace `formats.ts` internals with `export * from '@convertx/shared/core/formats'`
4. **validate on a real device / via your tunnel dev-client before relying on it** — this is the only step that touches Metro's resolution.

---

## Feature parity — what's left

Closeable gaps now cheaper because the logic is (or can be) shared:
- **Android**: GIF settings panel + target-size auto-shrink, video resize in the Resize tab, crop overlay UI, richer FFprobe metadata, cross-surface promo card.
- **Web**: codec/bitrate/frame_rate via an `ffmpeg -i` probe pass.

Platform-locked (accept as idiomatic, not bugs):
- **Android** can't do WebM/MP3 (the lean ffmpeg-kit fork lacks libvpx-vp9 / libmp3lame).
- **Web** can't run the yt-dlp downloader (needs a server; browser sandbox forbids it).
- Save-to-Gallery (Android), reveal-in-folder (Desktop), blob-download (Web) are the same intent via different OS idioms.

---

## Rollback

Pre-consolidation backups (full history) are in `../_consolidation_backups/`:
- `Convert-X-backup.bundle`, `Convert-X-Android-backup.bundle`

All work is on the branch **`chore/consolidate-monorepo`**; `main` is untouched. To restore a repo from a bundle: `git clone _consolidation_backups/Convert-X-backup.bundle restored/`.
